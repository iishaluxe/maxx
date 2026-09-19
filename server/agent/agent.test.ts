import { describe, expect, it } from "vitest";
import { CapabilityBroker, ExecutionRouter, type ExecutionAdapter } from "./execution";
import { actionFingerprint, isStuck, nextLoopDirective } from "./orchestrator";
import { assessBudget, canTransition, evaluateCapabilityPolicy } from "./policy";

describe("Agent Computer policy engine", () => {
  it("rejects raw secrets before a model or capability can receive them", () => {
    expect(
      evaluateCapabilityPolicy({
        capability: "secret.inject",
        target: "cloud_sandbox",
        hasRawSecret: true,
      })
    ).toMatchObject({ allowed: false, requiresApproval: false });
  });

  it("requires approval for local computer actions", () => {
    expect(
      evaluateCapabilityPolicy({ capability: "filesystem.read", target: "local_bridge" })
    ).toMatchObject({ allowed: true, requiresApproval: true });
  });

  it("enforces lifecycle transitions and hard budget limits", () => {
    expect(canTransition("executing", "verifying")).toBe(true);
    expect(canTransition("completed", "executing")).toBe(false);
    expect(
      assessBudget({
        usedSteps: 11,
        maxSteps: 10,
        usedTokens: 100,
        maxTokens: 1000,
        usedBudgetCents: 1,
        maxBudgetCents: 100,
      }).exceeded
    ).toBe(true);
  });

  it("routes safe capabilities through an execution adapter and intercepts approval-sensitive calls", async () => {
    let wasCalled = false;
    const adapter: ExecutionAdapter = {
      id: "test-cloud",
      target: "cloud_sandbox",
      isConfigured: () => true,
      execute: async () => {
        wasCalled = true;
        const now = new Date();
        return { outcome: "completed", output: "ok", evidence: [{ kind: "command", value: "0" }], adapterId: "test-cloud", startedAt: now, completedAt: now };
      },
      cancel: async () => undefined,
    };
    const broker = new CapabilityBroker(new ExecutionRouter([adapter]));
    const safe = await broker.dispatch({ taskId: "task", target: "cloud_sandbox", capability: "filesystem.read", action: "Read manifest", arguments: {} });
    expect(safe.kind).toBe("observation");
    expect(wasCalled).toBe(true);

    wasCalled = false;
    const sensitive = await broker.dispatch({ taskId: "task", target: "cloud_sandbox", capability: "package.install", action: "Install package", arguments: {} });
    expect(sensitive.kind).toBe("approval_required");
    expect(wasCalled).toBe(false);
  });

  it("detects repeated actions and blocks an unconfigured execution target", () => {
    const fingerprint = actionFingerprint({ capability: "shell.exec", action: "npm test", arguments: { cwd: "/workspace" } });
    expect(isStuck([fingerprint, fingerprint, fingerprint])).toBe(true);
    expect(
      nextLoopDirective({
        state: { phase: "act", stepsTaken: 1, maxSteps: 8, actionFingerprints: [fingerprint], cancellationRequested: false, evidenceSatisfied: false },
        observation: { outcome: "connection_required", output: "missing", evidence: [], adapterId: "none", startedAt: new Date(), completedAt: new Date() },
      })
    ).toMatchObject({ kind: "block" });
  });

  it("allows a previously approved sensitive action to reach the adapter", async () => {
    let wasCalled = false;
    const adapter: ExecutionAdapter = {
      id: "approved-test-cloud",
      target: "cloud_sandbox",
      isConfigured: () => true,
      execute: async () => {
        wasCalled = true;
        const now = new Date();
        return { outcome: "completed", output: "installed", evidence: [{ kind: "exit_code", value: "0" }], adapterId: "approved-test-cloud", startedAt: now, completedAt: now };
      },
      cancel: async () => undefined,
    };
    const broker = new CapabilityBroker(new ExecutionRouter([adapter]));
    const result = await broker.dispatch({ taskId: "task", target: "cloud_sandbox", capability: "package.install", action: "Install package", arguments: { command: "npm install" }, approvalGranted: true });
    expect(result.kind).toBe("observation");
    expect(wasCalled).toBe(true);
  });
});
