import {
  appendExecutionEvent,
  createCheckpoint,
  createTaskApproval,
  getAgentTaskDetail,
  updatePlanStepStatus,
  updateTaskStatus,
  updateTaskUsage,
} from "../db";
import { alertOwner } from "./ownerAlerts";
import { CapabilityBroker, formatEvidenceItem, type CapabilityRequest } from "./execution";
import { assessBudget, classifyRisk } from "./policy";
import {
  decideRecovery,
  interpretObservation,
  selectCapabilityArguments,
  summarizeTask,
  verifyTaskResult,
} from "./modelGateway";

export type TaskRunResult = {
  outcome: "completed" | "blocked" | "failed" | "waiting_approval" | "no_op";
  stepsRun: number;
  message: string;
};

const MAX_RETRIES_PER_STEP = 1;

function toCapabilityArgs(args: { command?: string; path?: string; content?: string; url?: string }): Record<string, unknown> {
  // Adapters read specific keys (e.g. "command", "path", "content"); pass them through as-is.
  const record: Record<string, unknown> = {};
  if (args.command !== undefined) record.command = args.command;
  if (args.path !== undefined) record.path = args.path;
  if (args.content !== undefined) record.content = args.content;
  if (args.url !== undefined) record.url = args.url;
  return record;
}

/**
 * Runs a task's already-generated, already-persisted plan to completion (or
 * to the first blocking condition: cancellation, exceeded budget, denied
 * capability, or an approval requirement). This function owns exactly one
 * concern: turning a stored plan into real capability dispatches. It does
 * not plan, replan, or invent new steps — that stays the job of the
 * `generatePlan` mutation that runs before this.
 *
 * This runs inline within a single request, not as a background worker.
 * Long-running tasks (many steps, slow sandbox commands) will hold the
 * request open for that whole duration — see the accompanying instructions
 * for why that trade-off was made deliberately rather than silently.
 */
export async function runAgentTask(
  taskId: string,
  ownerId: number,
  broker: CapabilityBroker
): Promise<TaskRunResult> {
  const detail = await getAgentTaskDetail(taskId, ownerId);
  if (!detail) return { outcome: "no_op", stepsRun: 0, message: "Task was not found." };

  const { task } = detail;
  if (!["queued", "executing", "recovering"].includes(task.status)) {
    return { outcome: "no_op", stepsRun: 0, message: `Task is in status "${task.status}" and is not eligible to run.` };
  }
  if (task.cancellationRequested) {
    return { outcome: "no_op", stepsRun: 0, message: "Task was cancelled before it could run." };
  }
  if (task.executionTarget !== "cloud_sandbox" && task.executionTarget !== "auto") {
    return { outcome: "no_op", stepsRun: 0, message: "The selected execution target is not yet connected to a production adapter." };
  }

  const pendingSteps = detail.plan
    .filter(step => step.status === "pending" || step.status === "active")
    .sort((a, b) => a.sequence - b.sequence);

  if (pendingSteps.length === 0) {
    return { outcome: "no_op", stepsRun: 0, message: "There are no pending plan steps to run." };
  }

  await updateTaskStatus({ taskId: task.id, ownerId, status: "executing", currentPhase: "Executing plan steps" });

  let usedSteps = task.usedSteps;
  let usedTokens = task.usedTokens;
  const usedBudgetCents = task.usedBudgetCents;
  const evidenceLog: string[] = [];
  const observationSummaries: string[] = [];
  let stepsRun = 0;

  for (const step of pendingSteps) {
    const budget = assessBudget({ usedSteps, maxSteps: task.maxSteps, usedTokens, maxTokens: task.maxTokens, usedBudgetCents, maxBudgetCents: task.maxBudgetCents });
    if (budget.exceeded) {
      await updateTaskStatus({ taskId: task.id, ownerId, status: "blocked", currentPhase: "Budget limit reached" });
      await appendExecutionEvent({ taskId: task.id, kind: "budget.exceeded", level: "warning", title: "Budget limit reached", content: "Execution stopped before another step could exceed the task budget." });
      await alertOwner({ kind: "budget", taskId: task.id, taskTitle: task.title, detail: "The task exceeded a configured step, token, or monetary budget." });
      return { outcome: "blocked", stepsRun, message: "Stopped: budget limit reached." };
    }

    let attempt = 0;
    let stepResolved = false;

    while (!stepResolved) {
      attempt += 1;
      await updatePlanStepStatus({ id: step.id, taskId: task.id, status: "active" });

      let argsResult;
      try {
        argsResult = await selectCapabilityArguments({
          modelId: task.modelId,
          taskGoal: task.goal,
          step,
          priorObservations: observationSummaries,
        });
      } catch (error) {
        await updatePlanStepStatus({ id: step.id, taskId: task.id, status: "failed" });
        await appendExecutionEvent({ taskId: task.id, kind: "step.failed", level: "error", title: `Could not prepare arguments for "${step.title}"`, content: error instanceof Error ? error.message : "The model gateway could not produce arguments for this step." });
        await updateTaskStatus({ taskId: task.id, ownerId, status: "blocked", currentPhase: "Step preparation requires attention" });
        return { outcome: "blocked", stepsRun, message: `Stopped: could not prepare step "${step.title}".` };
      }
      usedTokens += argsResult.usedTokens;

      const request: CapabilityRequest = {
        taskId: task.id,
        capability: step.capability as CapabilityRequest["capability"],
        target: "cloud_sandbox",
        action: step.title,
        arguments: toCapabilityArgs(argsResult.value),
        destructive: step.risk === "high",
      };

      const dispatch = await broker.dispatch(request);

      if (dispatch.kind === "denied") {
        await updatePlanStepStatus({ id: step.id, taskId: task.id, status: "failed" });
        await appendExecutionEvent({ taskId: task.id, kind: "policy.denied", level: "policy", title: "Capability denied", content: dispatch.reason });
        await updateTaskStatus({ taskId: task.id, ownerId, status: "blocked", currentPhase: "Blocked by policy" });
        return { outcome: "blocked", stepsRun, message: `Stopped: "${step.title}" was denied by policy.` };
      }

      if (dispatch.kind === "approval_required") {
        const approvalId = await createTaskApproval({
          taskId: task.id,
          action: step.title,
          rationale: dispatch.reason,
          risk: classifyRisk({ capability: step.capability as CapabilityRequest["capability"], target: request.target, destructive: request.destructive }) as "medium" | "high" | "critical",
          context: { capability: step.capability, stepId: step.id },
        });
        await updateTaskStatus({ taskId: task.id, ownerId, status: "waiting_approval", currentPhase: "Waiting for an execution approval" });
        await appendExecutionEvent({ taskId: task.id, kind: "approval.requested", level: "policy", title: "Execution paused for approval", content: dispatch.reason, metadata: { approvalId, capability: step.capability, stepId: step.id } });
        await alertOwner({ kind: "approval", taskId: task.id, taskTitle: task.title, detail: `"${step.title}" requires approval before it can run.` });
        return { outcome: "waiting_approval", stepsRun, message: `Paused: "${step.title}" requires approval.` };
      }

      const observation = dispatch.observation;
      usedSteps += 1;
      stepsRun += 1;
      await updateTaskUsage({ taskId: task.id, ownerId, usedSteps, usedTokens, usedBudgetCents });
      const eventLevel = observation.outcome === "completed" ? "success" : observation.outcome === "connection_required" ? "warning" : "error";
      await appendExecutionEvent({ taskId: task.id, kind: `capability.${step.capability}`, level: eventLevel, title: step.title, content: observation.output, metadata: { evidence: observation.evidence, adapterId: observation.adapterId, stepId: step.id } });
      await createCheckpoint({ taskId: task.id, sequence: usedSteps + 1, summary: `Captured ${observation.outcome} observation for "${step.title}".`, state: { stepId: step.id, capability: step.capability, observation } });

      if (observation.outcome === "connection_required") {
        await updatePlanStepStatus({ id: step.id, taskId: task.id, status: "failed" });
        await updateTaskStatus({ taskId: task.id, ownerId, status: "blocked", currentPhase: "Execution adapter connection required" });
        return { outcome: "blocked", stepsRun, message: "Stopped: no execution adapter is connected." };
      }

      if (observation.outcome === "cancelled") {
        await updatePlanStepStatus({ id: step.id, taskId: task.id, status: "skipped" });
        return { outcome: "blocked", stepsRun, message: "Stopped: task was cancelled during execution." };
      }

      if (observation.outcome === "failed") {
        if (attempt <= MAX_RETRIES_PER_STEP) {
          const recovery = await decideRecovery({
            modelId: task.modelId,
            goal: task.goal,
            failedAction: step.title,
            observation: observation.output,
            attempts: attempt,
          });
          usedTokens += recovery.usedTokens;
          await appendExecutionEvent({ taskId: task.id, kind: "recovery.decided", level: "warning", title: `Recovery decision for "${step.title}"`, content: `${recovery.value.reason} (${recovery.value.nextIntent})` });
          if (recovery.value.nextIntent === "retry") {
            await updateTaskStatus({ taskId: task.id, ownerId, status: "recovering", currentPhase: `Retrying "${step.title}"` });
            continue; // retry this same step once
          }
        }
        await updatePlanStepStatus({ id: step.id, taskId: task.id, status: "failed" });
        await updateTaskStatus({ taskId: task.id, ownerId, status: "blocked", currentPhase: `"${step.title}" failed and needs review` });
        await alertOwner({ kind: "failure", taskId: task.id, taskTitle: task.title, detail: `"${step.title}" failed after ${attempt} attempt(s) and the task is now blocked for review.` });
        return { outcome: "blocked", stepsRun, message: `Stopped: "${step.title}" failed after ${attempt} attempt(s).` };
      }

      // outcome === "completed"
      await updatePlanStepStatus({ id: step.id, taskId: task.id, status: "complete" });
      evidenceLog.push(...observation.evidence.map(formatEvidenceItem), observation.output);

      try {
        const interpretation = await interpretObservation({
          modelId: task.modelId,
          taskGoal: task.goal,
          observation: observation.output,
          expectedEvidence: step.expectedEvidence,
        });
        usedTokens += interpretation.usedTokens;
        observationSummaries.push(interpretation.value.summary);
      } catch {
        observationSummaries.push(observation.output.slice(0, 500));
      }

      stepResolved = true;
    }
  }

  // All pending steps resolved without blocking — verify before declaring completion.
  await updateTaskStatus({ taskId: task.id, ownerId, status: "verifying", currentPhase: "Verifying evidence against the goal" });
  try {
    const verification = await verifyTaskResult({ modelId: task.modelId, goal: task.goal, evidence: evidenceLog });
    usedTokens += verification.usedTokens;
    await updateTaskUsage({ taskId: task.id, ownerId, usedSteps, usedTokens, usedBudgetCents });

    if (!verification.value.passed) {
      await appendExecutionEvent({ taskId: task.id, kind: "verification.failed", level: "warning", title: "Verification did not pass", content: `${verification.value.evidenceSummary}\nGaps: ${verification.value.gaps.join("; ") || "unspecified"}` });
      await updateTaskStatus({ taskId: task.id, ownerId, status: "blocked", currentPhase: "Verification found unmet evidence" });
      await alertOwner({ kind: "failure", taskId: task.id, taskTitle: task.title, detail: "All plan steps ran, but verification found the evidence did not satisfy the goal." });
      return { outcome: "blocked", stepsRun, message: "Stopped: verification did not pass." };
    }

    const summary = await summarizeTask({ modelId: task.modelId, goal: task.goal, events: observationSummaries });
    usedTokens += summary.usedTokens;
    await updateTaskUsage({ taskId: task.id, ownerId, usedSteps, usedTokens, usedBudgetCents });
    await appendExecutionEvent({ taskId: task.id, kind: "task.completed", level: "success", title: "Task verified complete", content: summary.value.summary });
    await updateTaskStatus({ taskId: task.id, ownerId, status: "completed", currentPhase: "Completed and verified" });
    await alertOwner({ kind: "completion", taskId: task.id, taskTitle: task.title, detail: summary.value.summary });
    return { outcome: "completed", stepsRun, message: summary.value.summary };
  } catch (error) {
    await updateTaskStatus({ taskId: task.id, ownerId, status: "blocked", currentPhase: "Verification requires attention" });
    await appendExecutionEvent({ taskId: task.id, kind: "verification.error", level: "error", title: "Verification could not run", content: error instanceof Error ? error.message : "The model gateway could not verify this task." });
    return { outcome: "blocked", stepsRun, message: "Stopped: verification step failed to run." };
  }
}
