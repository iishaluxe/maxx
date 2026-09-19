import { describe, expect, it, vi } from "vitest";
import { CapabilityBroker, type EvidenceItem } from "../execution";
import { DurableAgentRuntime } from "./durableRuntime";
import { RuntimeExecutor } from "./executor";
import { AgentLoop } from "./agentLoop";

const request = {
  taskId: "task-1",
  capability: "filesystem" as const,
  target: "cloud_sandbox" as const,
  action: "read",
  arguments: { path: "/tmp/example" },
};

function setup(observation: unknown) {
  const runtime = new DurableAgentRuntime(
    { taskId: "task-1", ownerId: 1 },
    { maxSteps: 5, maxRecoveryAttempts: 2 },
  );
  const broker = {
    dispatch: vi.fn().mockResolvedValue({ kind: "observation", observation }),
  } as unknown as CapabilityBroker;
  vi.spyOn(runtime, "persistLatestEvent").mockResolvedValue();
  vi.spyOn(runtime, "persistCheckpoint").mockResolvedValue(
    {} as Awaited<ReturnType<DurableAgentRuntime["persistCheckpoint"]>>,
  );
  return { runtime, executor: new RuntimeExecutor(broker, runtime) };
}

const completed = (output: string, evidence: EvidenceItem[]) => ({
  outcome: "completed" as const,
  output,
  evidence,
  adapterId: "test",
  startedAt: new Date(),
  completedAt: new Date(),
});

describe("AgentLoop", () => {
  it("completes when planner has no remaining work", async () => {
    const { runtime, executor } = setup(completed("unused", []));
    const loop = new AgentLoop(runtime, executor, {
      planner: vi.fn().mockResolvedValue(null),
    });
    const result = await loop.run();
    expect(result.status).toBe("completed");
    expect(runtime.getState().status).toBe("completed");
    expect(runtime.getState().currentStep).toBe(1);
  });

  it("executes and verifies a successful plan", async () => {
    const { runtime, executor } = setup(completed("created", [{ kind: "file", value: "created" }]));
    const loop = new AgentLoop(runtime, executor, {
      planner: vi.fn().mockResolvedValue({
        request,
        verification: {
          requiredOutcome: "completed",
          requiredEvidence: ["file:created"],
          requiredOutputIncludes: ["created"],
        },
      }),
    });
    const result = await loop.run();
    expect(result.status).toBe("completed");
    expect(runtime.getEvents()).toContainEqual(
      expect.objectContaining({ type: "verification.passed" }),
    );
  });

  it("blocks when verification fails without recovery", async () => {
    const { runtime, executor } = setup(completed("unexpected", []));
    const loop = new AgentLoop(runtime, executor, {
      planner: vi.fn().mockResolvedValue({
        request,
        verification: { requiredEvidence: ["file:created"] },
      }),
    });
    const result = await loop.run();
    expect(result.status).toBe("blocked");
    expect(runtime.getState().status).toBe("blocked");
  });

  it("recovers and retries the planner", async () => {
    const runtime = new DurableAgentRuntime(
      { taskId: "task-1", ownerId: 1 },
      { maxSteps: 5, maxRecoveryAttempts: 2 },
    );
    let calls = 0;
    const broker = {
      dispatch: vi.fn().mockImplementation(async () => ({
        kind: "observation",
        observation: completed(
          ++calls === 1 ? "wrong" : "correct",
          calls === 1 ? [] : [{ kind: "fixed", value: "true" }],
        ),
      })),
    } as unknown as CapabilityBroker;
    vi.spyOn(runtime, "persistLatestEvent").mockResolvedValue();
    vi.spyOn(runtime, "persistCheckpoint").mockResolvedValue(
      {} as Awaited<ReturnType<DurableAgentRuntime["persistCheckpoint"]>>,
    );

    const planner = vi.fn()
      .mockResolvedValueOnce({ request, verification: { requiredEvidence: ["fixed:true"] } })
      .mockResolvedValueOnce({ request, verification: { requiredEvidence: ["fixed:true"] } });

    const loop = new AgentLoop(runtime, new RuntimeExecutor(broker, runtime), {
      planner,
      recovery: vi.fn().mockResolvedValue({ request, verification: { requiredEvidence: ["fixed:true"] } }),
      maxCycles: 2,
    });

    const result = await loop.run();
    expect(result.status).toBe("completed");
    expect(planner).toHaveBeenCalledTimes(2);
    expect(calls).toBe(2);
  });
});
