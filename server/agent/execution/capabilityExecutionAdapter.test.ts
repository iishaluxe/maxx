import { describe, expect, it } from "vitest";
import type { CapabilityRequest } from "../execution";
import { CapabilityExecutionAdapter, CapabilityExecutionAdapterError } from "./capabilityExecutionAdapter";

const capabilityInput = {
  capability: "shell" as CapabilityRequest["capability"],
  target: "cloud_sandbox" as const,
  arguments: { command: "echo safe" },
};

describe("CapabilityExecutionAdapter", () => {
  it("forwards one normalized request through the injected RuntimeExecutor boundary", async () => {
    const calls: CapabilityRequest[] = [];
    const adapter = new CapabilityExecutionAdapter({
      async execute(request) {
        calls.push(request);
        const now = new Date();
        return { kind: "observation", observation: {
          outcome: "completed" as const,
          output: "ok",
          evidence: [{ kind: "done", value: "" }],
          adapterId: "runtime-executor",
          startedAt: now,
          completedAt: now,
        } };
      },
    });
    const signal = new AbortController().signal;

    await expect(adapter.execute({
      taskId: "t",
      nodeId: "n",
      action: "run-safe-command",
      input: capabilityInput,
      attempt: 1,
    }, signal)).resolves.toMatchObject({ outcome: "completed", output: "ok" });
    expect(calls).toEqual([{
      taskId: "t",
      action: "run-safe-command",
      ...capabilityInput,
    }]);
  });

  it("preserves existing authorization outcomes instead of treating them as success", async () => {
    const adapter = new CapabilityExecutionAdapter({
      async execute() { return { kind: "denied" as const, reason: "policy" }; },
    });
    await expect(adapter.execute({ taskId: "t", nodeId: "n", action: "work", input: capabilityInput, attempt: 1 }, new AbortController().signal))
      .rejects.toThrow(CapabilityExecutionAdapterError);
  });

  it("does not dispatch a pre-cancelled request when the protected boundary has no cancel API", async () => {
    let calls = 0;
    const adapter = new CapabilityExecutionAdapter({
      async execute() { calls += 1; throw new Error("should not execute"); },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.execute({ taskId: "t", nodeId: "n", action: "work", input: capabilityInput, attempt: 1 }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });
});
