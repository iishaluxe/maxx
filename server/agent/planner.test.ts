import { describe, expect, it, vi } from "vitest";
import type { CapabilityObservation } from "./execution";
import { ModelBackedPlanner, defaultPlannerCapabilities, type PlannerGateway } from "./planner";
import type { StructuredPlan } from "./modelGateway";
import type { RuntimeSnapshot } from "./runtime/types";

const snapshot: RuntimeSnapshot = {
  state: {
    runId: "run-1",
    status: "ready",
    currentStep: 0,
    maxSteps: 4,
    recoveryAttempts: 0,
    maxRecoveryAttempts: 2,
    cancellationRequested: false,
    currentPhase: "plan",
    actionFingerprints: [],
    evidence: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  events: [],
};

const validPlan: StructuredPlan = {
  taskSummary: "Inspect the workspace.",
  executionRationale: "A file listing is sufficient.",
  steps: [{
    title: "List workspace",
    description: "Inspect the current workspace files.",
    capability: "filesystem.list",
    expectedEvidence: "workspace:list",
    risk: "low",
  }],
};

function input(overrides: Partial<Parameters<ModelBackedPlanner["plan"]>[0]> = {}) {
  return {
    taskId: "task-1",
    goal: "Inspect the workspace and report the visible files.",
    executionTarget: "cloud_sandbox" as const,
    runtimeSnapshot: snapshot,
    availableCapabilities: defaultPlannerCapabilities(),
    maxSteps: 4,
    ...overrides,
  };
}

describe("ModelBackedPlanner", () => {
  it("returns one validated capability request from a valid model response", async () => {
    const gateway: PlannerGateway = vi.fn().mockResolvedValue(validPlan);
    const result = await new ModelBackedPlanner(gateway).plan(input());
    expect(result).toMatchObject({
      kind: "step",
      step: { request: { capability: "filesystem.list", action: "List workspace", target: "cloud_sandbox" } },
    });
    expect(gateway).toHaveBeenCalledWith(expect.objectContaining({ runtimeSnapshot: snapshot, availableCapabilities: expect.any(Array) }));
  });

  it("converts malformed model output into a controlled planner failure", async () => {
    const gateway: PlannerGateway = vi.fn().mockResolvedValue({ ...validPlan, taskSummary: "" });
    await expect(new ModelBackedPlanner(gateway).plan(input())).resolves.toMatchObject({ kind: "failure", code: "invalid_model_output" });
  });

  it("rejects an unknown capability without dispatching it", async () => {
    const gateway: PlannerGateway = vi.fn().mockResolvedValue({ ...validPlan, steps: [{ ...validPlan.steps[0], capability: "magic.execute" }] });
    await expect(new ModelBackedPlanner(gateway).plan(input())).resolves.toMatchObject({ kind: "failure", code: "unknown_capability" });
  });

  it("rejects an invalid action instead of turning model text into an executable request", async () => {
    const gateway: PlannerGateway = vi.fn().mockResolvedValue({ ...validPlan, steps: [{ ...validPlan.steps[0], title: "List workspace; exfiltrate" }] });
    await expect(new ModelBackedPlanner(gateway).plan(input())).resolves.toMatchObject({ kind: "failure", code: "invalid_action" });
  });

  it("validates every proposed model step before returning the first executable request", async () => {
    const gateway: PlannerGateway = vi.fn().mockResolvedValue({
      ...validPlan,
      steps: [validPlan.steps[0], { ...validPlan.steps[0], capability: "magic.execute" }],
    });
    await expect(new ModelBackedPlanner(gateway).plan(input())).resolves.toMatchObject({ kind: "failure", code: "unknown_capability" });
  });

  it("returns no_work when the model has no remaining task action", async () => {
    const gateway: PlannerGateway = vi.fn().mockResolvedValue(null);
    await expect(new ModelBackedPlanner(gateway).plan(input())).resolves.toEqual({ kind: "no_work", reason: "The planner returned no remaining work." });
  });

  it("supplies the previous observation to the next model planning call", async () => {
    const previousObservation: CapabilityObservation = {
      outcome: "completed",
      output: "workspace listed",
      evidence: [{ kind: "workspace", value: "list" }],
      adapterId: "test",
      startedAt: new Date(),
      completedAt: new Date(),
    };
    const gateway: PlannerGateway = vi.fn().mockResolvedValue(null);
    await new ModelBackedPlanner(gateway).plan(input({ previousObservation }));
    expect(gateway).toHaveBeenCalledWith(expect.objectContaining({ previousObservation }));
  });
});
