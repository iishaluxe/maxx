import { ModelRegistry } from "./_archive/intelligence/modelRegistry";
import { AdaptiveModelRouter } from "./_archive/intelligence/adaptiveModelRouter";
import { AdaptiveIntelligenceGateway } from "./_archive/intelligence/adaptiveIntelligenceGateway";
import type { ModelProfile } from "./_archive/intelligence/modelProfile";

// The model IDs below are real, current Claude models. The cost, latency,
// and reliability figures are illustrative placeholders — NOT verified
// real-world pricing — and must be replaced with actual current figures
// (see docs.claude.com) before this registry is used for any real
// budget-based routing decision. Domain scores are similarly a
// reasonable starting guess, not measured data.
const DEFAULT_MODEL_PROFILES: ModelProfile[] = [
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    tier: 1,
    contextWindowTokens: 200_000,
    domains: [
      { domain: "tool-use", score: 0.75 },
      { domain: "verification", score: 0.7 },
      { domain: "coding", score: 0.65 },
      { domain: "planning", score: 0.55 },
    ],
    maximumRisk: "medium",
    structuredOutput: true,
    averageLatencyMs: 900,
    cost: { inputPerMillionTokensUsd: 1, outputPerMillionTokensUsd: 5 },
    reliabilityScore: 0.9,
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    tier: 2,
    contextWindowTokens: 200_000,
    domains: [
      { domain: "tool-use", score: 0.9 },
      { domain: "verification", score: 0.88 },
      { domain: "coding", score: 0.9 },
      { domain: "planning", score: 0.85 },
    ],
    maximumRisk: "high",
    structuredOutput: true,
    averageLatencyMs: 2200,
    cost: { inputPerMillionTokensUsd: 3, outputPerMillionTokensUsd: 15 },
    reliabilityScore: 0.95,
  },
  {
    id: "claude-opus-5",
    provider: "anthropic",
    tier: 3,
    contextWindowTokens: 200_000,
    domains: [
      { domain: "tool-use", score: 0.95 },
      { domain: "verification", score: 0.95 },
      { domain: "coding", score: 0.95 },
      { domain: "planning", score: 0.97 },
    ],
    maximumRisk: "high",
    structuredOutput: true,
    averageLatencyMs: 4500,
    cost: { inputPerMillionTokensUsd: 15, outputPerMillionTokensUsd: 75 },
    reliabilityScore: 0.97,
  },
];

function buildRegistry(): ModelRegistry {
  const registry = new ModelRegistry();
  for (const profile of DEFAULT_MODEL_PROFILES) registry.register(profile);
  return registry;
}

/**
 * Single, process-wide gateway instance. Every call the live path makes
 * to modelGateway.ts's LLM functions should go through this instead of
 * calling modelGateway.ts directly, so model choice is actually driven
 * by domain/complexity/risk/budget rather than whatever task.modelId
 * happens to be set to (including null, the common case today).
 *
 * Policies below are a reasonable starting point, not tuned. "risk" here
 * mirrors the calling context's own risk (e.g. capability-argument
 * selection for a high-risk step should be willing to use a stronger
 * model), not the registry's own risk tolerance field.
 */
export const taskIntelligenceGateway = new AdaptiveIntelligenceGateway({
  router: new AdaptiveModelRouter(buildRegistry()),
  policies: {
    toolUse: { complexity: 2, risk: "medium" },
    capabilityArguments: { complexity: 2, risk: "medium" },
    observation: { complexity: 1, risk: "low" },
    verification: { complexity: 2, risk: "medium" },
    recovery: { complexity: 2, risk: "medium" },
    summary: { complexity: 1, risk: "low" },
    plan: { complexity: 3, risk: "medium" },
  },
});
