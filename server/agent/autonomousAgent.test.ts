import { describe, expect, it, vi } from "vitest";

vi.mock("./runtime/persistence", () => ({
  persistRuntimeEvent: vi.fn().mockResolvedValue(undefined),
  persistRuntimeCheckpoint: vi.fn().mockResolvedValue(undefined),
  loadLatestRuntimeCheckpoint: vi.fn().mockResolvedValue(null),
}));

import { AutonomousAgent } from "./autonomousAgent";
import type { CapabilityBroker } from "./execution";
import type { AutonomousAgentOptions } from "./autonomousAgent";

function makeBroker(): CapabilityBroker {
  return {
    dispatch: vi.fn().mockResolvedValue({
      kind: "observation",
      observation: {
        outcome: "completed",
        output: "done",
        evidence: [{ kind: "verified", value: "true" }],
        adapterId: "test",
        startedAt: new Date(),
        completedAt: new Date(),
      },
    }),
  } as unknown as CapabilityBroker;
}

describe("AutonomousAgent", () => {
  it("runs planner -> executor -> broker -> verification -> planner", async () => {
    const planner = {
      plan: vi.fn()
        .mockResolvedValueOnce({
          kind: "step",
          rationale: "inspect",
          step: {
            request: {
              taskId: "task-1",
              capability: "filesystem.list",
              target: "cloud_sandbox",
              action: "List workspace",
              arguments: { description: "List files", expectedEvidence: "verified" },
              destructive: false,
            },
            verification: { requiredOutcome: "completed", requiredEvidence: ["verified:true"] },
          },
        })
        .mockResolvedValueOnce({ kind: "no_work", reason: "Nothing remains." }),
    } as AutonomousAgentOptions["planner"];

    const agent = new AutonomousAgent(makeBroker(), { planner });
    const result = await agent.run({
      taskId: "task-1",
      ownerId: 1,
      goal: "Inspect workspace",
      executionTarget: "cloud_sandbox",
      maxSteps: 2,
    });

    expect(result.status).toBe("completed");
    expect(result.cycles).toBe(1);
    expect(planner?.plan).toHaveBeenCalledTimes(2);
  });

  it("turns model/planner failure into a controlled blocked result", async () => {
    const planner = {
      plan: vi.fn().mockResolvedValue({
        kind: "failure",
        code: "model_unavailable",
        message: "Model unavailable",
      }),
    } as AutonomousAgentOptions["planner"];

    const result = await new AutonomousAgent(makeBroker(), { planner }).run({
      taskId: "task-2",
      ownerId: 1,
      goal: "Do something",
      executionTarget: "cloud_sandbox",
      maxSteps: 2,
    });

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("Model unavailable");
  });
});
