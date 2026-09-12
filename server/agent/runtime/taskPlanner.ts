import type { CapabilityObservation, CapabilityRequest } from "../execution";
import { getAgentTaskDetail, updatePlanStepStatus } from "../../db";
import { taskIntelligenceGateway } from "../intelligenceRouting";
import type { AgentPlanner, AgentRecovery } from "./agentLoop";

export type TaskPlannerContext = {
  taskId: string;
  ownerId: number;
  goal: string;
  modelId?: string | null;
};

function toCapabilityArgs(value: { command?: string; path?: string; content?: string; url?: string; method?: string; body?: string }) {
  const args: Record<string, unknown> = {};
  if (value.command !== undefined) args.command = value.command;
  if (value.path !== undefined) args.path = value.path;
  if (value.content !== undefined) args.content = value.content;
  if (value.url !== undefined) args.url = value.url;
  if (value.method !== undefined) args.method = value.method;
  if (value.body !== undefined) args.body = value.body;
  return args;
}

/**
 * Bridges the generic, durable AgentLoop (which only knows about a
 * request/observation cycle count, not persisted plan rows) to the
 * live, DB-backed plan already produced by modelGateway.generatePlan
 * and stored in agentPlanSteps. This is the only file that needs to
 * know both worlds exist.
 *
 * Each planner call:
 *   1. Reconciles the PREVIOUS cycle's step status in the DB, if any
 *      (the loop calls the planner again before the caller sees a
 *      final result, so this is the only place that observation is
 *      available to persist).
 *   2. Selects the next pending step by sequence.
 *   3. Asks the model for concrete capability arguments (same function
 *      taskRunner.ts already uses).
 *   4. Marks that step "active" and returns it as the loop's next
 *      request.
 *
 * The active step id lives in closure state, not the DB, because the
 * generic runtime has nowhere to put it — the DB is only reconciled
 * at the start of the *next* planner call or inside recovery.
 */
export function createTaskPlanner(context: TaskPlannerContext): {
  planner: AgentPlanner;
  recovery: AgentRecovery;
  /** The plan step currently in flight, if any — needed by the caller to
   *  create a real agentApprovals row when the loop reports "waiting",
   *  since the generic runtime only tracks that pause in its own state. */
  getActiveStep: () => { id: string; title: string; capability: string; risk: string } | null;
} {
  let activeStepId: string | null = null;
  let activeStepInfo: { id: string; title: string; capability: string; risk: string } | null = null;
  const observationSummaries: string[] = [];

  async function reconcile(previousObservation?: CapabilityObservation) {
    if (!activeStepId || !previousObservation) return;
    const id = activeStepId;
    activeStepId = null;
    activeStepInfo = null;

    if (previousObservation.outcome === "completed") {
      await updatePlanStepStatus({ id, taskId: context.taskId, status: "complete" });
      try {
        const interpretation = await taskIntelligenceGateway.interpretObservation({
          modelId: context.modelId,
          taskGoal: context.goal,
          observation: previousObservation.output,
          expectedEvidence: "",
        });
        observationSummaries.push(interpretation.value.summary);
      } catch {
        observationSummaries.push(previousObservation.output.slice(0, 500));
      }
    } else if (previousObservation.outcome === "cancelled") {
      await updatePlanStepStatus({ id, taskId: context.taskId, status: "skipped" });
    } else {
      // "failed" or "connection_required" — recovery (if any) already ran
      // via the AgentRecovery callback before the loop asks the planner
      // again, so by the time we get here the step is genuinely done for.
      await updatePlanStepStatus({ id, taskId: context.taskId, status: "failed" });
    }
  }

  const planner: AgentPlanner = async ({ previousObservation }) => {
    await reconcile(previousObservation);

    const detail = await getAgentTaskDetail(context.taskId, context.ownerId);
    if (!detail) return { kind: "failure", reason: "Task is no longer available." };

    const next = detail.plan
      .filter(step => step.status === "pending")
      .sort((a, b) => a.sequence - b.sequence)[0];

    if (!next) return { kind: "no_work", reason: "All plan steps have been run." };

    let args;
    try {
      args = await taskIntelligenceGateway.selectCapabilityArguments({
        modelId: context.modelId,
        taskGoal: context.goal,
        step: next,
        priorObservations: observationSummaries,
      });
    } catch (error) {
      return {
        kind: "failure",
        reason: error instanceof Error ? error.message : `Could not prepare arguments for "${next.title}".`,
      };
    }

    await updatePlanStepStatus({ id: next.id, taskId: context.taskId, status: "active" });
    activeStepId = next.id;
    activeStepInfo = { id: next.id, title: next.title, capability: next.capability, risk: next.risk };

    return {
      request: {
        taskId: context.taskId,
        capability: next.capability as CapabilityRequest["capability"],
        target: "cloud_sandbox",
        action: next.title,
        arguments: toCapabilityArgs(args.value),
        destructive: next.risk === "high",
      },
    };
  };

  const recovery: AgentRecovery = async ({ reason }) => {
    if (!activeStepId) return null;
    const stepId = activeStepId;

    const detail = await getAgentTaskDetail(context.taskId, context.ownerId);
    const step = detail?.plan.find(p => p.id === stepId);
    if (!step) return null;

    let decision;
    try {
      decision = await taskIntelligenceGateway.decideRecovery({
        modelId: context.modelId,
        goal: context.goal,
        failedAction: step.title,
        observation: reason,
        attempts: 1,
      });
    } catch {
      return null;
    }

    if (decision.value.nextIntent !== "retry") return null;

    // AgentLoop only uses this return value as a truthy/falsy gate — it
    // does not dispatch the request below itself. The actual "what runs
    // next" decision comes entirely from the *next* planner() call, and
    // that call only picks up steps whose DB status is "pending". Since
    // previousObservation is cleared to undefined right after a
    // successful recovery (see agentLoop.ts), reconcile() has nothing to
    // act on next time — so without this explicit reset, a retried step
    // would stay stuck at "active" forever and the planner would
    // wrongly report "no work left" on the very next call.
    await updatePlanStepStatus({ id: stepId, taskId: context.taskId, status: "pending" });
    activeStepId = null;
    activeStepInfo = null;

    let args;
    try {
      args = await taskIntelligenceGateway.selectCapabilityArguments({
        modelId: context.modelId,
        taskGoal: context.goal,
        step,
        priorObservations: observationSummaries,
      });
    } catch {
      return null;
    }

    return {
      request: {
        taskId: context.taskId,
        capability: step.capability as CapabilityRequest["capability"],
        target: "cloud_sandbox",
        action: step.title,
        arguments: toCapabilityArgs(args.value),
        destructive: step.risk === "high",
      },
    };
  };

  return { planner, recovery, getActiveStep: () => activeStepInfo };
}
