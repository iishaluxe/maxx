import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  appendExecutionEvent,
  cancelAllActiveTasks,
  createAgentArtifact,
  createAgentTask,
  createCheckpoint,
  createTaskApproval,
  decideTaskApproval,
  getAgentTask,
  getAgentTaskDetail,
  listAgentTasks,
  listPendingApprovals,
  replaceAgentPlan,
  requestTaskCancellation,
  updateTaskStatus,
  updateTaskUsage,
} from "../db";
import { alertOwner } from "../agent/ownerAlerts";
import { CapabilityBroker, ExecutionRouter } from "../agent/execution";
import { E2BCloudSandboxAdapter } from "../agent/e2bAdapter";
import { getAvailableModels } from "../agent/modelGateway";
import { assessBudget, canTransition, evaluateCapabilityPolicy, type TaskStatus } from "../agent/policy";
import { capabilityRegistry, executionTargets } from "../agent/registry";
import { runDurableTask } from "../agent/runtime/durableTaskRunner";
import { taskIntelligenceGateway } from "../agent/intelligenceRouting";
import { notifyOwner } from "../_core/notification";
import { protectedProcedure, router } from "../_core/trpc";
import { storagePut } from "../storage";

const targetSchema = z.enum(["auto", "cloud_sandbox", "persistent_workspace", "local_bridge"]);
const activeStatusSchema = z.enum(["draft", "planning", "queued", "executing", "waiting_approval", "verifying", "recovering", "completed", "blocked", "failed", "cancelled"]);

const e2bAdapter = new E2BCloudSandboxAdapter();
const capabilityBroker = new CapabilityBroker(new ExecutionRouter([e2bAdapter]));

const taskInputSchema = z.object({
  title: z.string().trim().min(3).max(240).optional(),
  goal: z.string().trim().min(12).max(20_000),
  executionTarget: targetSchema.default("auto"),
  modelId: z.string().trim().max(160).optional(),
  maxSteps: z.number().int().min(2).max(100).default(24),
  maxRuntimeSeconds: z.number().int().min(60).max(28_800).default(1800),
  maxTokens: z.number().int().min(1000).max(2_000_000).default(120_000),
  maxBudgetCents: z.number().int().min(1).max(100_000).default(500),
});

function ensureTransition(current: TaskStatus, next: TaskStatus) {
  if (!canTransition(current, next)) {
    throw new TRPCError({ code: "CONFLICT", message: `Task cannot transition from ${current} to ${next}.` });
  }
}

export const agentRouter = router({
  overview: protectedProcedure.query(async ({ ctx }) => {
    const tasks = await listAgentTasks(ctx.user.id);
    const approvals = await listPendingApprovals(ctx.user.id);
    const activeCount = tasks.filter(task => ["planning", "queued", "executing", "waiting_approval", "verifying", "recovering"].includes(task.status)).length;
    return { tasks, approvals, activeCount, capabilities: capabilityRegistry, targets: executionTargets };
  }),

  models: protectedProcedure.query(async () => getAvailableModels()),

  create: protectedProcedure.input(taskInputSchema).mutation(async ({ ctx, input }) => {
    const title = input.title || input.goal.split(/[.!?\n]/)[0]?.slice(0, 120) || "Untitled agent task";
    const task = await createAgentTask({ ownerId: ctx.user.id, title, ...input });
    if (!task) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Task could not be created." });
    return task;
  }),

  detail: protectedProcedure.input(z.object({ taskId: z.string().min(1) })).query(async ({ ctx, input }) => {
    const detail = await getAgentTaskDetail(input.taskId, ctx.user.id);
    if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "Task was not found." });
    return detail;
  }),

  generatePlan: protectedProcedure.input(z.object({ taskId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    const task = await getAgentTask(input.taskId, ctx.user.id);
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task was not found." });
    ensureTransition(task.status as TaskStatus, "planning");
    await updateTaskStatus({ taskId: task.id, ownerId: ctx.user.id, status: "planning", currentPhase: "Generating a bounded execution plan" });
    await appendExecutionEvent({ taskId: task.id, kind: "planner.started", level: "info", title: "Planner started", content: "The model gateway is generating a structured plan without executing any capability." });

    try {
      const result = await taskIntelligenceGateway.generatePlan({
        goal: task.goal,
        executionTarget: task.executionTarget,
        modelId: task.modelId,
        maxSteps: task.maxSteps,
      });
      await replaceAgentPlan(
        task.id,
        result.plan.steps.map((step, index) => ({
          sequence: index + 1,
          title: step.title,
          description: step.description,
          capability: step.capability,
          expectedEvidence: step.expectedEvidence,
          risk: step.risk,
          status: "pending",
        }))
      );
      await createCheckpoint({
        taskId: task.id,
        sequence: 1,
        summary: "Plan generated and persisted before execution.",
        state: { plan: result.plan, modelId: result.modelId, usedTokens: result.usedTokens },
      });

      const planPayload = JSON.stringify({ taskId: task.id, generatedAt: new Date().toISOString(), ...result.plan }, null, 2);
      const stored = await storagePut(`agent-computer/${ctx.user.id}/${task.id}/plans/${nanoid()}.json`, planPayload, "application/json");
      await createAgentArtifact({
        taskId: task.id,
        kind: "report",
        name: "execution-plan.json",
        objectKey: stored.key,
        objectUrl: stored.url,
        contentType: "application/json",
        checksum: createHash("sha256").update(planPayload).digest("hex"),
        sourceCapability: "artifact.pack",
        provenanceJson: JSON.stringify({ generatedBy: "model_gateway", modelId: result.modelId, verified: false, taskPhase: "planning" }),
      });
      await updateTaskStatus({ taskId: task.id, ownerId: ctx.user.id, status: "queued", currentPhase: "Plan ready — waiting for an eligible execution adapter", modelId: result.modelId, usedTokens: result.usedTokens });
      await appendExecutionEvent({ taskId: task.id, kind: "planner.completed", level: "success", title: "Plan checkpointed", content: "The plan, checkpoint, and provenance-backed plan artifact are ready for controlled execution.", metadata: { modelId: result.modelId, steps: result.plan.steps.length } });
      return { plan: result.plan, modelId: result.modelId };
    } catch (error) {
      await updateTaskStatus({ taskId: task.id, ownerId: ctx.user.id, status: "blocked", currentPhase: "Planning requires attention" });
      await appendExecutionEvent({ taskId: task.id, kind: "planner.failed", level: "error", title: "Planner blocked", content: error instanceof Error ? error.message : "The planner could not produce a structured result." });
      await alertOwner({ kind: "failure", taskId: task.id, taskTitle: task.title, detail: "Planning could not produce a valid structured plan." });
      throw new TRPCError({ code: "BAD_GATEWAY", message: "The model gateway could not produce a safe structured plan." });
    }
  }),

  runTask: protectedProcedure.input(z.object({ taskId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    const task = await getAgentTask(input.taskId, ctx.user.id);
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task was not found." });
    if (!["queued", "executing", "recovering"].includes(task.status)) {
      throw new TRPCError({ code: "CONFLICT", message: `Task cannot be run from status "${task.status}".` });
    }
    return runDurableTask(task.id, ctx.user.id, capabilityBroker);
  }),

  requestApproval: protectedProcedure.input(z.object({
    taskId: z.string().min(1),
    capability: z.enum(["shell.exec", "filesystem.read", "filesystem.write", "filesystem.list", "process.start", "process.stop", "package.install", "git.operation", "artifact.pack", "browser.navigate", "browser.interact", "http.request", "secret.inject"]),
    action: z.string().min(3).max(240),
    rationale: z.string().min(3).max(5000),
    risk: z.enum(["medium", "high", "critical"]),
  })).mutation(async ({ ctx, input }) => {
    const task = await getAgentTask(input.taskId, ctx.user.id);
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task was not found." });
    const decision = evaluateCapabilityPolicy({ capability: input.capability, target: task.executionTarget, destructive: input.risk !== "medium" });
    if (!decision.allowed) throw new TRPCError({ code: "FORBIDDEN", message: decision.reason });
    const approvalId = await createTaskApproval({ taskId: task.id, action: input.action, rationale: input.rationale, risk: input.risk, context: { capability: input.capability, policyReason: decision.reason } });
    if (task.status === "queued" || task.status === "executing" || task.status === "recovering") {
      await updateTaskStatus({ taskId: task.id, ownerId: ctx.user.id, status: "waiting_approval", currentPhase: "Waiting for a sensitive-action approval" });
    }
    await appendExecutionEvent({ taskId: task.id, kind: "approval.requested", level: "policy", title: "Approval required", content: input.rationale, metadata: { approvalId, capability: input.capability, risk: input.risk } });
    await alertOwner({ kind: "approval", taskId: task.id, taskTitle: task.title, detail: `${input.action} requires ${input.risk}-risk approval.` });
    return { approvalId, decision };
  }),

  decideApproval: protectedProcedure.input(z.object({ taskId: z.string().min(1), approvalId: z.string().min(1), approved: z.boolean() })).mutation(async ({ ctx, input }) => {
    const task = await getAgentTask(input.taskId, ctx.user.id);
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task was not found." });
    await decideTaskApproval({ id: input.approvalId, taskId: input.taskId, approved: input.approved });
    const nextStatus = input.approved ? "queued" : "blocked";
    if (task.status === "waiting_approval") await updateTaskStatus({ taskId: task.id, ownerId: ctx.user.id, status: nextStatus, currentPhase: input.approved ? "Approval granted — ready to resume" : "Blocked by rejected approval" });
    await appendExecutionEvent({ taskId: task.id, kind: "approval.decided", level: input.approved ? "success" : "warning", title: input.approved ? "Approval granted" : "Approval rejected", content: input.approved ? "The task may resume within its policy scope." : "The task remains blocked until its plan is changed." });
    return { success: true };
  }),

  reportUsage: protectedProcedure.input(z.object({ taskId: z.string().min(1), usedSteps: z.number().int().nonnegative(), usedTokens: z.number().int().nonnegative(), usedBudgetCents: z.number().int().nonnegative() })).mutation(async ({ ctx, input }) => {
    const task = await updateTaskUsage({ ownerId: ctx.user.id, ...input });
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task was not found." });
    const budget = assessBudget(task);
    if (budget.exceeded) {
      if (["planning", "queued", "executing", "waiting_approval", "verifying", "recovering"].includes(task.status)) {
        await updateTaskStatus({ taskId: task.id, ownerId: ctx.user.id, status: "blocked", currentPhase: "Budget limit reached" });
      }
      await appendExecutionEvent({ taskId: task.id, kind: "budget.exceeded", level: "warning", title: "Budget limit reached", content: "Execution was blocked before another action could exceed the task budget." });
      await alertOwner({ kind: "budget", taskId: task.id, taskTitle: task.title, detail: "The task exceeded a configured step, token, or monetary budget." });
    }
    return { budget };
  }),

  executeCapability: protectedProcedure.input(z.object({
    taskId: z.string().min(1),
    capability: z.enum(["shell.exec", "filesystem.read", "filesystem.write", "filesystem.list", "process.start", "process.stop", "package.install", "git.operation", "artifact.pack", "browser.navigate", "browser.interact", "http.request", "secret.inject"]),
    action: z.string().min(3).max(240),
    arguments: z.record(z.string(), z.unknown()),
    destructive: z.boolean().default(false),
    approvalGranted: z.boolean().default(false),
  })).mutation(async ({ ctx, input }) => {
    const task = await getAgentTask(input.taskId, ctx.user.id);
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task was not found." });
    if (!["queued", "executing", "recovering"].includes(task.status)) {
      throw new TRPCError({ code: "CONFLICT", message: "Only queued, executing, or recovering tasks may dispatch an execution capability." });
    }
    if (task.cancellationRequested) throw new TRPCError({ code: "CONFLICT", message: "This task was cancelled before execution could begin." });
    if (task.executionTarget !== "cloud_sandbox" && task.executionTarget !== "auto") {
      throw new TRPCError({ code: "CONFLICT", message: "The selected task target is not yet connected to a production adapter." });
    }

    if (task.status !== "executing") {
      await updateTaskStatus({ taskId: task.id, ownerId: ctx.user.id, status: "executing", currentPhase: `Executing ${input.capability}` });
    }
    const dispatch = await capabilityBroker.dispatch({
      taskId: task.id,
      target: "cloud_sandbox",
      capability: input.capability,
      action: input.action,
      arguments: input.arguments,
      destructive: input.destructive,
      approvalGranted: input.approvalGranted,
    });

    if (dispatch.kind === "denied") {
      await appendExecutionEvent({ taskId: task.id, kind: "policy.denied", level: "policy", title: "Capability denied", content: dispatch.reason });
      throw new TRPCError({ code: "FORBIDDEN", message: dispatch.reason });
    }
    if (dispatch.kind === "approval_required") {
      const approvalId = await createTaskApproval({ taskId: task.id, action: input.action, rationale: dispatch.reason, risk: input.destructive ? "high" : "medium", context: { capability: input.capability, arguments: input.arguments } });
      await updateTaskStatus({ taskId: task.id, ownerId: ctx.user.id, status: "waiting_approval", currentPhase: "Waiting for an execution approval" });
      await appendExecutionEvent({ taskId: task.id, kind: "approval.requested", level: "policy", title: "Execution paused for approval", content: dispatch.reason, metadata: { approvalId, capability: input.capability } });
      await alertOwner({ kind: "approval", taskId: task.id, taskTitle: task.title, detail: `${input.action} requires approval before the cloud adapter can run it.` });
      return { kind: dispatch.kind, approvalId, reason: dispatch.reason };
    }

    const observation = dispatch.observation;
    const usedSteps = task.usedSteps + 1;
    await updateTaskUsage({ taskId: task.id, ownerId: ctx.user.id, usedSteps, usedTokens: task.usedTokens, usedBudgetCents: task.usedBudgetCents });
    const eventLevel = observation.outcome === "completed" ? "success" : observation.outcome === "connection_required" ? "warning" : "error";
    await appendExecutionEvent({ taskId: task.id, kind: `capability.${input.capability}`, level: eventLevel, title: input.action, content: observation.output, metadata: { evidence: observation.evidence, adapterId: observation.adapterId } });
    await createCheckpoint({ taskId: task.id, sequence: usedSteps + 1, summary: `Captured ${observation.outcome} observation for ${input.capability}.`, state: { capability: input.capability, action: input.action, observation } });

    if (observation.outcome === "connection_required") {
      await updateTaskStatus({ taskId: task.id, ownerId: ctx.user.id, status: "blocked", currentPhase: "Execution adapter connection required" });
    } else if (observation.outcome === "failed") {
      await updateTaskStatus({ taskId: task.id, ownerId: ctx.user.id, status: "recovering", currentPhase: "Observation failed — recovery decision required" });
    } else {
      await updateTaskStatus({ taskId: task.id, ownerId: ctx.user.id, status: "executing", currentPhase: "Observation recorded — selecting next step" });
    }
    return { kind: dispatch.kind, observation };
  }),

  completeVerified: protectedProcedure.input(z.object({ taskId: z.string().min(1), evidenceSummary: z.string().min(10).max(10_000) })).mutation(async ({ ctx, input }) => {
    const task = await getAgentTask(input.taskId, ctx.user.id);
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task was not found." });
    if (task.status !== "verifying") throw new TRPCError({ code: "CONFLICT", message: "Only a task in verification may be completed." });
    await updateTaskStatus({ taskId: task.id, ownerId: ctx.user.id, status: "completed", currentPhase: "Verified artifact ready" });
    await appendExecutionEvent({ taskId: task.id, kind: "verification.completed", level: "success", title: "Verification passed", content: input.evidenceSummary });
    await alertOwner({ kind: "completion", taskId: task.id, taskTitle: task.title, detail: "Independent verification passed and an artifact is ready for review." });
    return { success: true };
  }),

  failUnrecoverably: protectedProcedure.input(z.object({ taskId: z.string().min(1), reason: z.string().min(10).max(10_000) })).mutation(async ({ ctx, input }) => {
    const task = await getAgentTask(input.taskId, ctx.user.id);
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task was not found." });
    if (["completed", "blocked", "failed", "cancelled"].includes(task.status)) throw new TRPCError({ code: "CONFLICT", message: "A terminal task cannot be failed again." });
    await updateTaskStatus({ taskId: task.id, ownerId: ctx.user.id, status: "failed", currentPhase: "Unrecoverable execution failure" });
    await appendExecutionEvent({ taskId: task.id, kind: "recovery.exhausted", level: "error", title: "Recovery exhausted", content: input.reason });
    await alertOwner({ kind: "failure", taskId: task.id, taskTitle: task.title, detail: input.reason });
    return { success: true };
  }),

  cancel: protectedProcedure.input(z.object({ taskId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    const task = await getAgentTask(input.taskId, ctx.user.id);
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task was not found." });
    if (["completed", "blocked", "failed", "cancelled"].includes(task.status)) return { success: true, alreadyTerminal: true };
    await e2bAdapter.cancel(task.id);
    await requestTaskCancellation(task.id, ctx.user.id);
    return { success: true, alreadyTerminal: false };
  }),

  killAll: protectedProcedure.mutation(async ({ ctx }) => {
    const tasks = await listAgentTasks(ctx.user.id);
    const active = tasks.filter(task => ["planning", "queued", "executing", "waiting_approval", "verifying", "recovering"].includes(task.status));
    await Promise.all(active.map(task => e2bAdapter.cancel(task.id)));
    return { cancelled: await cancelAllActiveTasks(ctx.user.id) };
  }),

  notifyOwner: protectedProcedure.input(z.object({ title: z.string().min(1).max(1200), content: z.string().min(1).max(20_000) })).mutation(async ({ input }) => ({ success: await notifyOwner(input) })),
});
