import type { CapabilityBroker } from "../execution";
import {
  createTaskApproval,
  getAgentTaskDetail,
  updatePlanStepStatus,
  updateTaskStatus,
  updateTaskUsage,
} from "../../db";
import { alertOwner } from "../ownerAlerts";
import { summarizeTask, verifyTaskResult } from "../modelGateway";
import { DurableAgentRuntime } from "./durableRuntime";
import { RuntimeExecutor } from "./executor";
import { AgentLoop } from "./agentLoop";
import { createTaskPlanner } from "./taskPlanner";

export type DurableTaskRunResult = {
  outcome: "completed" | "blocked" | "failed" | "waiting_approval" | "cancelled" | "no_op";
  cycles: number;
  message: string;
};

// Not yet part of the persisted task config (agentTasks has no
// recovery-attempt column). Fixed for now; a real per-task value belongs
// in a future schema change, not invented here.
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;

/**
 * The durable counterpart to taskRunner.ts's runAgentTask. Same
 * eligibility rules, same DB-backed plan, same modelGateway calls via
 * taskPlanner.ts — but execution is driven by the real, checkpointed
 * AgentLoop/DurableAgentRuntime engine instead of an inline loop, so a
 * task can resume from its last checkpoint after a process restart.
 *
 * taskRunner.ts is left in place, untouched, and still has its own
 * passing tests. This function is the new live path; it does not call
 * or depend on taskRunner.ts.
 */
export async function runDurableTask(
  taskId: string,
  ownerId: number,
  broker: CapabilityBroker,
): Promise<DurableTaskRunResult> {
  const detail = await getAgentTaskDetail(taskId, ownerId);
  if (!detail) return { outcome: "no_op", cycles: 0, message: "Task was not found." };

  const { task } = detail;
  if (!["queued", "executing", "recovering"].includes(task.status)) {
    return { outcome: "no_op", cycles: 0, message: `Task is in status "${task.status}" and is not eligible to run.` };
  }
  if (task.cancellationRequested) {
    return { outcome: "no_op", cycles: 0, message: "Task was cancelled before it could run." };
  }
  if (task.executionTarget !== "cloud_sandbox" && task.executionTarget !== "auto") {
    return { outcome: "no_op", cycles: 0, message: "The selected execution target is not yet connected to a production adapter." };
  }

  const runtime = new DurableAgentRuntime(
    { taskId: task.id, ownerId },
    { runId: task.id, maxSteps: task.maxSteps, maxRecoveryAttempts: DEFAULT_MAX_RECOVERY_ATTEMPTS },
  );
  const resumed = await runtime.restoreLatestCheckpoint();

  // The router only allows this call when agentTasks.status is queued,
  // executing, or recovering — which is exactly the DB-level signal that
  // an approval was granted (or this is a fresh/retried run). The
  // runtime's own persisted checkpoint has no way to know that on its
  // own: it only sees its last checkpointed status, which for a
  // previously-paused task is still "waiting". Without this bridge,
  // AgentLoop.run() would see "waiting" and return immediately every
  // time, and an approved task would never actually resume.
  if (resumed && runtime.getState().status === "waiting") {
    runtime.resume();
    await runtime.persistLatestEvent();
  }

  await updateTaskStatus({
    taskId: task.id,
    ownerId,
    status: "executing",
    currentPhase: resumed ? "Resuming from last checkpoint" : "Executing plan steps",
  });

  const executor = new RuntimeExecutor(broker, runtime);
  const { planner, recovery, getActiveStep } = createTaskPlanner({
    taskId: task.id,
    ownerId,
    goal: task.goal,
    modelId: task.modelId,
  });

  const result = await new AgentLoop(runtime, executor, {
    planner,
    recovery,
    maxCycles: task.maxSteps,
  }).run();

  await updateTaskUsage({
    taskId: task.id,
    ownerId,
    usedSteps: runtime.getState().currentStep,
    usedTokens: task.usedTokens,
    usedBudgetCents: task.usedBudgetCents,
  });

  if (result.status === "waiting") {
    const pending = getActiveStep();
    const approvalId = await createTaskApproval({
      taskId: task.id,
      action: pending?.title ?? "Pending capability",
      rationale: result.reason ?? "Execution paused for approval.",
      risk: pending?.risk === "high" ? "high" : "medium",
      context: pending ? { capability: pending.capability, stepId: pending.id } : {},
    });
    await updateTaskStatus({ taskId: task.id, ownerId, status: "waiting_approval", currentPhase: "Waiting for an execution approval" });
    await alertOwner({ kind: "approval", taskId: task.id, taskTitle: task.title, detail: result.reason ?? `"${pending?.title ?? "A step"}" requires approval.` });
    return { outcome: "waiting_approval", cycles: result.cycles, message: result.reason ?? "Paused for approval." };
  }

  if (result.status === "cancelled") {
    await updateTaskStatus({ taskId: task.id, ownerId, status: "cancelled", currentPhase: "Cancelled during execution" });
    return { outcome: "cancelled", cycles: result.cycles, message: "Task was cancelled during execution." };
  }

  if (result.status === "blocked" || result.status === "failed") {
    // AgentLoop can terminate straight from a recovery decision without
    // ever calling the planner again — which means taskPlanner's
    // reconcile() never ran for whichever step was active when it gave
    // up. Left alone, that step would stay "active" in the DB forever,
    // even though the task itself is now terminal. Close that out here,
    // the one place that knows about both the runtime and the DB plan.
    const dangling = getActiveStep();
    if (dangling) {
      await updatePlanStepStatus({ id: dangling.id, taskId: task.id, status: "failed" });
    }
    await updateTaskStatus({ taskId: task.id, ownerId, status: result.status, currentPhase: result.reason ?? "Execution stopped" });
    if (result.status === "failed") {
      await alertOwner({ kind: "failure", taskId: task.id, taskTitle: task.title, detail: result.reason ?? "The task failed and is now blocked for review." });
    }
    return { outcome: result.status, cycles: result.cycles, message: result.reason ?? `Stopped: ${result.status}.` };
  }

  // result.status === "completed" — the per-step verifyObservation calls
  // inside AgentLoop only checked each capability's own evidence
  // requirements. A holistic pass against the task's actual goal still
  // needs to happen once, same as taskRunner.ts does at the end.
  await updateTaskStatus({ taskId: task.id, ownerId, status: "verifying", currentPhase: "Verifying evidence against the goal" });

  const finalState = runtime.getState();
  try {
    const verification = await verifyTaskResult({ modelId: task.modelId, goal: task.goal, evidence: finalState.evidence });

    if (!verification.value.passed) {
      await updateTaskStatus({ taskId: task.id, ownerId, status: "blocked", currentPhase: "Verification found unmet evidence" });
      await alertOwner({ kind: "failure", taskId: task.id, taskTitle: task.title, detail: "All plan steps ran, but verification found the evidence did not satisfy the goal." });
      return { outcome: "blocked", cycles: result.cycles, message: "Stopped: verification did not pass." };
    }

    const summary = await summarizeTask({ modelId: task.modelId, goal: task.goal, events: finalState.evidence });
    await updateTaskStatus({ taskId: task.id, ownerId, status: "completed", currentPhase: "Completed and verified" });
    await alertOwner({ kind: "completion", taskId: task.id, taskTitle: task.title, detail: summary.value.summary });
    return { outcome: "completed", cycles: result.cycles, message: summary.value.summary };
  } catch (error) {
    await updateTaskStatus({ taskId: task.id, ownerId, status: "blocked", currentPhase: "Verification requires attention" });
    return { outcome: "blocked", cycles: result.cycles, message: error instanceof Error ? error.message : "Verification could not run." };
  }
}
