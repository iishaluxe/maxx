import { appendExecutionEvent, createCheckpoint, getAgentTaskDetail } from "../../db";
import type { RuntimeCheckpoint, RuntimeEvent, RuntimeState } from "./types";

export type RuntimePersistenceContext = {
  taskId: string;
  ownerId: number;
};

// loadLatestRuntimeCheckpoint below only ever checks `.kind` on these to
// skip past them -- it never reads a snapshot payload -- so this type
// intentionally carries no snapshot field. (It previously did, via a
// type-only import of context/taskContext.ts's TaskContextSnapshot, which
// backed three functions -- persistTaskContextSnapshot,
// loadPersistedTaskContextSnapshot, deletePersistedTaskContextSnapshot --
// that were never called from anywhere live. Removed along with that
// import as part of retiring the dead context/ cluster; if bounded task
// context persistence is ever built for real, it can be redesigned then
// rather than resurrecting this unused version.)
type TaskContextCheckpointState =
  | { kind: "task_context_snapshot" }
  | { kind: "task_context_deleted"; taskId: string };

function parseCheckpointState(stateJson: string): unknown {
  return JSON.parse(stateJson);
}

function isTaskContextCheckpointState(value: unknown): value is TaskContextCheckpointState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === "task_context_deleted" || candidate.kind === "task_context_snapshot";
}

async function checkpointsFor(context: RuntimePersistenceContext) {
  const detail = await getAgentTaskDetail(context.taskId, context.ownerId);
  if (!detail) throw new Error(`Task ${context.taskId} is not available to this persistence context.`);
  return detail.checkpoints;
}

function levelForEvent(type: RuntimeEvent["type"]): "info" | "success" | "warning" | "error" | "policy" {
  if (type.includes("failed")) return "error";
  if (type.includes("cancel")) return "warning";
  if (type.includes("completed") || type.includes("passed")) return "success";
  if (type.includes("blocked")) return "policy";
  return "info";
}

export async function persistRuntimeEvent(
  context: RuntimePersistenceContext,
  event: RuntimeEvent,
): Promise<void> {
  await appendExecutionEvent({
    taskId: context.taskId,
    kind: event.type,
    level: levelForEvent(event.type),
    title: event.type,
    content: JSON.stringify(event.payload),
    metadata: {
      runtimeEventId: event.id,
      runId: event.runId,
      sequence: event.sequence,
      timestamp: event.timestamp.toISOString(),
    },
  });
}

export async function persistRuntimeCheckpoint(
  context: RuntimePersistenceContext,
  checkpoint: RuntimeCheckpoint,
): Promise<void> {
  await createCheckpoint({
    taskId: context.taskId,
    sequence: checkpoint.sequence,
    summary: `Runtime checkpoint at step ${checkpoint.currentStep} (${checkpoint.status}).`,
    state: checkpoint,
  });
}

export async function loadLatestRuntimeCheckpoint(
  context: RuntimePersistenceContext,
): Promise<RuntimeCheckpoint | null> {
  const checkpoints = await checkpointsFor(context).catch(error => {
    if (error instanceof Error && error.message.includes("is not available")) return [];
    throw error;
  });

  for (const checkpoint of checkpoints) {
    const parsed = parseCheckpointState(checkpoint.stateJson);
    if (isTaskContextCheckpointState(parsed)) continue;

    const runtimeCheckpoint = parsed as RuntimeCheckpoint;
    if (!runtimeCheckpoint?.state?.runId) {
      throw new Error(`Malformed runtime checkpoint ${checkpoint.id}.`);
    }
    return runtimeCheckpoint;
  }

  return null;
}

export async function loadRuntimeState(
  context: RuntimePersistenceContext,
): Promise<RuntimeState | null> {
  const checkpoint = await loadLatestRuntimeCheckpoint(context);
  return checkpoint ? checkpoint.state : null;
}
