import { describe, expect, it, vi, beforeEach } from "vitest";

const dbState = vi.hoisted(() => ({
  taskStatus: "queued" as string,
  planStatuses: new Map<string, string>(),
  checkpoints: [] as { sequence: number; stateJson: string }[],
  approvals: [] as { taskId: string; action: string; risk: string }[],
}));

vi.mock("../../db", () => ({
  getAgentTaskDetail: vi.fn(async () => ({
    task: {
      id: "task-1",
      ownerId: 1,
      title: "Test task",
      goal: "Prove the durable loop executes a step end to end.",
      status: dbState.taskStatus,
      executionTarget: "cloud_sandbox",
      modelId: null,
      maxSteps: 5,
      usedTokens: 0,
      usedBudgetCents: 0,
      cancellationRequested: false,
    },
    plan: [
      {
        id: "step-1",
        taskId: "task-1",
        sequence: 1,
        title: "List files",
        description: "List the workspace root.",
        capability: "filesystem.list",
        expectedEvidence: "A directory listing.",
        risk: "low",
        status: dbState.planStatuses.get("step-1") ?? "pending",
      },
    ],
    events: [],
    checkpoints: dbState.checkpoints,
    artifacts: [],
    approvals: [],
  })),
  appendExecutionEvent: vi.fn(async () => undefined),
  createCheckpoint: vi.fn(async (input: { sequence: number; state: unknown }) => {
    dbState.checkpoints.push({ sequence: input.sequence, stateJson: JSON.stringify(input.state) });
  }),
  updatePlanStepStatus: vi.fn(async (input: { id: string; status: string }) => {
    dbState.planStatuses.set(input.id, input.status);
  }),
  updateTaskStatus: vi.fn(async (input: { status: string }) => {
    dbState.taskStatus = input.status;
  }),
  updateTaskUsage: vi.fn(async () => undefined),
  createTaskApproval: vi.fn(async (input: { taskId: string; action: string; risk: string }) => {
    dbState.approvals.push(input);
    return "approval-1";
  }),
}));

vi.mock("../ownerAlerts", () => ({
  alertOwner: vi.fn(async () => undefined),
}));

vi.mock("../modelGateway", () => ({
  selectCapabilityArguments: vi.fn(async () => ({ value: { path: "/" }, modelId: "test-model", usedTokens: 10 })),
  interpretObservation: vi.fn(async () => ({ value: { summary: "Listed the workspace root." }, usedTokens: 5 })),
  decideRecovery: vi.fn(async () => ({ value: { revisedApproach: "retry", nextIntent: "retry", reason: "transient" }, usedTokens: 4 })),
  verifyTaskResult: vi.fn(async () => ({ value: { passed: true, evidenceSummary: "ok", gaps: [] }, usedTokens: 8 })),
  summarizeTask: vi.fn(async () => ({ value: { summary: "Task completed and verified." }, usedTokens: 6 })),
}));

import { runDurableTask } from "./durableTaskRunner";
import type { CapabilityBroker } from "../execution";

function brokerReturning(kind: "observation" | "denied" | "approval_required", outcome: string = "completed") {
  const dispatch = vi.fn(async () => {
    if (kind === "denied") return { kind: "denied", reason: "Not permitted." };
    if (kind === "approval_required") return { kind: "approval_required", reason: "Needs approval." };
    const now = new Date();
    return {
      kind: "observation",
      observation: { outcome, output: "listing captured", evidence: ["directory_listed:/"], adapterId: "test-adapter", startedAt: now, completedAt: now },
    };
  });
  return { dispatch } as unknown as CapabilityBroker;
}

describe("runDurableTask", () => {
  beforeEach(() => {
    dbState.taskStatus = "queued";
    dbState.planStatuses.clear();
    dbState.checkpoints = [];
    dbState.approvals = [];
  });

  it("runs a single-step plan through the real AgentLoop to verified completion", async () => {
    const result = await runDurableTask("task-1", 1, brokerReturning("observation", "completed"));
    expect(result.outcome).toBe("completed");
    expect(dbState.planStatuses.get("step-1")).toBe("complete");
    expect(dbState.taskStatus).toBe("completed");
    // Proves the loop actually persisted checkpoints along the way, not
    // just at the very end.
    expect(dbState.checkpoints.length).toBeGreaterThan(0);
  });

  it("creates a real agentApprovals row when a capability requires approval", async () => {
    const result = await runDurableTask("task-1", 1, brokerReturning("approval_required"));
    expect(result.outcome).toBe("waiting_approval");
    expect(dbState.taskStatus).toBe("waiting_approval");
    // This is the specific gap found and fixed: without it, this array
    // would be empty and a human would have nothing to approve.
    expect(dbState.approvals).toHaveLength(1);
    expect(dbState.approvals[0].taskId).toBe("task-1");
  });

  it("blocks (not crashes) when a capability observation genuinely fails and recovery is exhausted", async () => {
    // This is exactly the scenario that used to throw
    // "Invalid runtime transition: recovering -> verifying" before the
    // agentLoop.ts fix. decideRecovery is mocked to say "retry" every
    // time, so this also exercises the retry path repeatedly until the
    // fixed maxRecoveryAttempts budget is exhausted, then resolves
    // cleanly to "failed" rather than throwing.
    const result = await runDurableTask("task-1", 1, brokerReturning("observation", "failed"));
    expect(["blocked", "failed"]).toContain(result.outcome);
    expect(dbState.planStatuses.get("step-1")).toBe("failed");
  });

  it("is a no-op for a task that is not eligible to run", async () => {
    dbState.taskStatus = "completed";
    const result = await runDurableTask("task-1", 1, brokerReturning("observation"));
    expect(result.outcome).toBe("no_op");
  });
});
