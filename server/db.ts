import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { nanoid } from "nanoid";
import {
  agentApprovals,
  agentArtifacts,
  agentCheckpoints,
  agentExecutionEvents,
  agentPlanSteps,
  agentTasks,
  InsertUser,
  users,
  type AgentArtifact,
  type AgentExecutionEvent,
  type AgentPlanStep,
  type AgentTask,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let database: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!database && process.env.DATABASE_URL) {
    database = drizzle(process.env.DATABASE_URL);
  }
  return database;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database is not available.");
  return db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: InsertUser = { openId: user.openId, lastSignedIn: user.lastSignedIn ?? new Date() };
  const updateSet: Record<string, unknown> = { lastSignedIn: values.lastSignedIn };
  for (const field of ["name", "email", "loginMethod"] as const) {
    if (user[field] !== undefined) {
      values[field] = user[field] ?? null;
      updateSet[field] = user[field] ?? null;
    }
  }
  values.role = user.role ?? (user.openId === ENV.ownerOpenId ? "admin" : "user");
  updateSet.role = values.role;
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export type NewTaskInput = {
  ownerId: number;
  title: string;
  goal: string;
  executionTarget: "auto" | "cloud_sandbox" | "persistent_workspace" | "local_bridge";
  modelId?: string;
  maxSteps: number;
  maxRuntimeSeconds: number;
  maxTokens: number;
  maxBudgetCents: number;
};

export async function createAgentTask(input: NewTaskInput) {
  const db = await requireDb();
  const id = nanoid();
  await db.insert(agentTasks).values({ id, ...input, status: "draft", currentPhase: "Goal captured" });
  await appendExecutionEvent({
    taskId: id,
    kind: "task.created",
    level: "info",
    title: "Task created",
    content: "The task is stored with budgets and an execution target. Planning can now begin.",
  });
  return getAgentTask(id, input.ownerId);
}

export async function listAgentTasks(ownerId: number) {
  const db = await requireDb();
  return db.select().from(agentTasks).where(eq(agentTasks.ownerId, ownerId)).orderBy(desc(agentTasks.updatedAt)).limit(50);
}

export async function getAgentTask(id: string, ownerId: number) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(agentTasks)
    .where(and(eq(agentTasks.id, id), eq(agentTasks.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAgentTaskDetail(id: string, ownerId: number) {
  const db = await requireDb();
  const task = await getAgentTask(id, ownerId);
  if (!task) return null;

  const [plan, events, checkpoints, artifacts, approvals] = await Promise.all([
    db.select().from(agentPlanSteps).where(eq(agentPlanSteps.taskId, id)).orderBy(agentPlanSteps.sequence),
    db.select().from(agentExecutionEvents).where(eq(agentExecutionEvents.taskId, id)).orderBy(desc(agentExecutionEvents.createdAt)).limit(120),
    db.select().from(agentCheckpoints).where(eq(agentCheckpoints.taskId, id)).orderBy(desc(agentCheckpoints.sequence)),
    db.select().from(agentArtifacts).where(eq(agentArtifacts.taskId, id)).orderBy(desc(agentArtifacts.createdAt)),
    db.select().from(agentApprovals).where(eq(agentApprovals.taskId, id)).orderBy(desc(agentApprovals.requestedAt)),
  ]);
  return { task, plan, events, checkpoints, artifacts, approvals };
}

export async function appendExecutionEvent(input: {
  taskId: string;
  kind: string;
  level: "info" | "success" | "warning" | "error" | "policy";
  title: string;
  content: string;
  metadata?: unknown;
}) {
  const db = await requireDb();
  const event: typeof agentExecutionEvents.$inferInsert = {
    id: nanoid(),
    taskId: input.taskId,
    kind: input.kind,
    level: input.level,
    title: input.title,
    content: input.content,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
  };
  await db.insert(agentExecutionEvents).values(event);
}

export async function updateTaskStatus(input: {
  taskId: string;
  ownerId: number;
  status: AgentTask["status"];
  currentPhase: string;
  modelId?: string;
  usedTokens?: number;
}) {
  const db = await requireDb();
  const terminal = ["completed", "blocked", "failed", "cancelled"].includes(input.status);
  await db
    .update(agentTasks)
    .set({
      status: input.status,
      currentPhase: input.currentPhase,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(typeof input.usedTokens === "number" ? { usedTokens: input.usedTokens } : {}),
      ...(input.status === "executing" ? { startedAt: new Date() } : {}),
      ...(terminal ? { completedAt: new Date() } : {}),
    })
    .where(and(eq(agentTasks.id, input.taskId), eq(agentTasks.ownerId, input.ownerId)));
}

// Atomically claims a task for execution: the status-eligibility check and
// the write happen in one guarded UPDATE, so two concurrent callers (a
// double-click, two open tabs, a client retry racing the original call)
// can't both read "queued" and both proceed. Only the caller whose UPDATE
// actually matched a row -- affectedRows > 0 -- won the claim; the other
// sees 0 rows affected and must not start execution. This replaces the
// read-then-branch status checks that used to sit in runTask's router
// mutation and at the top of runDurableTask, neither of which closed the
// race since a status read and a later write are never atomic together.
export async function claimTaskForExecution(input: {
  taskId: string;
  ownerId: number;
  eligibleStatuses: AgentTask["status"][];
}): Promise<boolean> {
  const db = await requireDb();
  const [result] = await db
    .update(agentTasks)
    .set({ status: "executing", currentPhase: "Claimed for execution", startedAt: new Date() })
    .where(and(
      eq(agentTasks.id, input.taskId),
      eq(agentTasks.ownerId, input.ownerId),
      inArray(agentTasks.status, input.eligibleStatuses),
    ));
  return result.affectedRows > 0;
}

export async function replaceAgentPlan(taskId: string, steps: Omit<AgentPlanStep, "id" | "taskId" | "createdAt" | "updatedAt">[]) {
  const db = await requireDb();
  await db.delete(agentPlanSteps).where(eq(agentPlanSteps.taskId, taskId));
  if (steps.length > 0) {
    await db.insert(agentPlanSteps).values(
      steps.map(step => ({ id: nanoid(), taskId, ...step }))
    );
  }
}

export async function createCheckpoint(input: { taskId: string; sequence: number; summary: string; state: unknown }) {
  const db = await requireDb();
  await db.insert(agentCheckpoints).values({
    id: nanoid(),
    taskId: input.taskId,
    sequence: input.sequence,
    summary: input.summary,
    stateJson: JSON.stringify(input.state),
  });
}

export async function createAgentArtifact(input: Omit<AgentArtifact, "id" | "createdAt">) {
  const db = await requireDb();
  const id = nanoid();
  await db.insert(agentArtifacts).values({ id, ...input });
  return id;
}

export async function requestTaskCancellation(taskId: string, ownerId: number) {
  const db = await requireDb();
  await db
    .update(agentTasks)
    .set({ cancellationRequested: true, status: "cancelled", currentPhase: "Cancelled by kill switch", completedAt: new Date() })
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.ownerId, ownerId)));
  await appendExecutionEvent({
    taskId,
    kind: "task.cancelled",
    level: "warning",
    title: "Kill switch activated",
    content: "The control plane has cancelled this task and issued a cancellation signal to eligible execution adapters.",
  });
}

export async function cancelAllActiveTasks(ownerId: number) {
  const tasks = await listAgentTasks(ownerId);
  const active = tasks.filter(task => ["planning", "queued", "executing", "waiting_approval", "verifying", "recovering"].includes(task.status));
  await Promise.all(active.map(task => requestTaskCancellation(task.id, ownerId)));
  return active.length;
}

export async function createTaskApproval(input: {
  taskId: string;
  action: string;
  rationale: string;
  risk: "medium" | "high" | "critical";
  context: unknown;
}) {
  const db = await requireDb();
  const id = nanoid();
  await db.insert(agentApprovals).values({
    id,
    taskId: input.taskId,
    action: input.action,
    rationale: input.rationale,
    risk: input.risk,
    contextJson: JSON.stringify(input.context),
  });
  return id;
}

export async function decideTaskApproval(input: { id: string; taskId: string; approved: boolean }) {
  const db = await requireDb();
  await db
    .update(agentApprovals)
    .set({ status: input.approved ? "approved" : "rejected", decidedAt: new Date() })
    .where(and(eq(agentApprovals.id, input.id), eq(agentApprovals.taskId, input.taskId)));
}

export async function listPendingApprovals(ownerId: number) {
  const db = await requireDb();
  const tasks = await listAgentTasks(ownerId);
  if (tasks.length === 0) return [];
  return db
    .select()
    .from(agentApprovals)
    .where(and(inArray(agentApprovals.taskId, tasks.map(task => task.id)), eq(agentApprovals.status, "pending")))
    .orderBy(desc(agentApprovals.requestedAt));
}

export async function updateTaskUsage(input: {
  taskId: string;
  ownerId: number;
  usedSteps: number;
  usedTokens: number;
  usedBudgetCents: number;
}) {
  const db = await requireDb();
  await db
    .update(agentTasks)
    .set({ usedSteps: input.usedSteps, usedTokens: input.usedTokens, usedBudgetCents: input.usedBudgetCents })
    .where(and(eq(agentTasks.id, input.taskId), eq(agentTasks.ownerId, input.ownerId)));
  return getAgentTask(input.taskId, input.ownerId);
}

export async function updatePlanStepStatus(input: {
  id: string;
  taskId: string;
  status: AgentPlanStep["status"];
}) {
  const db = await requireDb();
  await db
    .update(agentPlanSteps)
    .set({ status: input.status })
    .where(and(eq(agentPlanSteps.id, input.id), eq(agentPlanSteps.taskId, input.taskId)));
}
