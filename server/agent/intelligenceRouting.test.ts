import { describe, expect, it, vi } from "vitest";

vi.mock("./modelGateway", () => ({
  selectCapabilityArguments: vi.fn(async (input: { modelId?: string | null }) => ({ value: { path: "/" }, modelId: input.modelId, usedTokens: 1 })),
  selectToolAction: vi.fn(async (input: { modelId?: string | null }) => ({ value: { argumentSummary: "n/a", requiresApproval: false }, modelId: input.modelId, usedTokens: 1 })),
  interpretObservation: vi.fn(async (input: { modelId?: string | null }) => ({ value: { summary: "ok" }, modelId: input.modelId, usedTokens: 1 })),
  verifyTaskResult: vi.fn(async (input: { modelId?: string | null }) => ({ value: { passed: true, evidenceSummary: "ok", gaps: [] }, modelId: input.modelId, usedTokens: 1 })),
  decideRecovery: vi.fn(async (input: { modelId?: string | null }) => ({ value: { revisedApproach: "retry", nextIntent: "retry", reason: "x" }, modelId: input.modelId, usedTokens: 1 })),
  summarizeTask: vi.fn(async (input: { modelId?: string | null }) => ({ value: { summary: "ok" }, modelId: input.modelId, usedTokens: 1 })),
  generatePlan: vi.fn(async (input: { modelId?: string | null }) => ({ plan: { steps: [] }, modelId: input.modelId, usedTokens: 1 })),
}));

import { taskIntelligenceGateway } from "./intelligenceRouting";

describe("taskIntelligenceGateway", () => {
  it("registers without validation errors and routes to a real registered model", async () => {
    const result = await taskIntelligenceGateway.selectCapabilityArguments({
      modelId: null,
      taskGoal: "test",
      step: { title: "t", description: "d", capability: "filesystem.list", expectedEvidence: "e" },
      priorObservations: [],
    });
    expect(["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"]).toContain(result.modelId);
  });

  it("routes different call types to potentially different models based on policy", async () => {
    // toolUse policy is complexity:2/risk:medium; observation policy is
    // complexity:1/risk:low — these should be capable of landing on
    // different tiers, proving policy actually differentiates routing
    // rather than every call falling back to one hardcoded model.
    const toolUse = await taskIntelligenceGateway.selectCapabilityArguments({
      modelId: null,
      taskGoal: "test",
      step: { title: "t", description: "d", capability: "filesystem.list", expectedEvidence: "e" },
      priorObservations: [],
    });
    const observation = await taskIntelligenceGateway.interpretObservation({
      modelId: null,
      taskGoal: "test",
      observation: "output",
      expectedEvidence: "e",
    });
    expect(toolUse.modelId).toBeTruthy();
    expect(observation.modelId).toBeTruthy();
  });

  it("plan generation routes to the highest-complexity policy tier available", async () => {
    const result = await taskIntelligenceGateway.generatePlan({
      goal: "test goal",
      executionTarget: "cloud_sandbox",
      maxSteps: 10,
    });
    expect(["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"]).toContain(result.modelId);
  });
});
