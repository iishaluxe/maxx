import {
  decideRecovery,
  generatePlan,
  interpretObservation,
  selectCapabilityArguments,
  selectToolAction,
  summarizeTask,
  verifyTaskResult,
} from "../../modelGateway";
import type { AdaptiveModelRouter } from "./adaptiveModelRouter";
import type { ComplexityTier, IntelligenceDomain, RiskLevel, RoutingDecision, RoutingRequest } from "./routingTypes";

export type AdaptiveIntelligencePolicy = {
  complexity: ComplexityTier;
  risk: RiskLevel;
  budgetUsd?: number;
  latencyBudgetMs?: number;
};

export type AdaptiveIntelligenceGatewayPort = {
  selectToolAction: typeof selectToolAction;
  selectCapabilityArguments: typeof selectCapabilityArguments;
  interpretObservation: typeof interpretObservation;
  verifyTaskResult: typeof verifyTaskResult;
  decideRecovery: typeof decideRecovery;
  summarizeTask: typeof summarizeTask;
  generatePlan: typeof generatePlan;
};

export type AdaptiveIntelligenceGatewayOptions = {
  router: AdaptiveModelRouter;
  policies: {
    toolUse: AdaptiveIntelligencePolicy;
    capabilityArguments: AdaptiveIntelligencePolicy;
    observation: AdaptiveIntelligencePolicy;
    verification: AdaptiveIntelligencePolicy;
    recovery: AdaptiveIntelligencePolicy;
    summary: AdaptiveIntelligencePolicy;
    plan: AdaptiveIntelligencePolicy;
  };
  gateway?: AdaptiveIntelligenceGatewayPort;
};

type RoutedInput = {
  domain: IntelligenceDomain;
  policy: AdaptiveIntelligencePolicy;
  serializedInput: unknown;
  estimatedOutputTokens: number;
};

function estimateInputTokens(value: unknown): number {
  const serialized = JSON.stringify(value);
  return Math.max(1, Math.ceil(serialized.length / 4));
}

function buildRequest(input: RoutedInput): RoutingRequest {
  return {
    domain: input.domain,
    complexity: input.policy.complexity,
    risk: input.policy.risk,
    estimatedInputTokens: estimateInputTokens(input.serializedInput),
    estimatedOutputTokens: input.estimatedOutputTokens,
    budgetUsd: input.policy.budgetUsd,
    latencyBudgetMs: input.policy.latencyBudgetMs,
    constraints: { requiredStructuredOutput: true },
  };
}

export class AdaptiveIntelligenceGateway {
  private readonly gateway: AdaptiveIntelligenceGatewayPort;

  constructor(private readonly options: AdaptiveIntelligenceGatewayOptions) {
    this.gateway = options.gateway ?? {
      selectToolAction,
      selectCapabilityArguments,
      interpretObservation,
      verifyTaskResult,
      decideRecovery,
      summarizeTask,
      generatePlan,
    };
  }

  async selectToolAction(input: Parameters<typeof selectToolAction>[0]): Promise<Awaited<ReturnType<typeof selectToolAction>>> {
    const routing = this.route({
      domain: "tool-use",
      policy: this.options.policies.toolUse,
      serializedInput: input,
      estimatedOutputTokens: 220,
    });
    return this.gateway.selectToolAction({ ...input, modelId: routing.modelId });
  }

  async selectCapabilityArguments(
    input: Parameters<typeof selectCapabilityArguments>[0],
  ): Promise<Awaited<ReturnType<typeof selectCapabilityArguments>>> {
    const routing = this.route({
      domain: "tool-use",
      policy: this.options.policies.capabilityArguments,
      serializedInput: input,
      estimatedOutputTokens: 220,
    });
    return this.gateway.selectCapabilityArguments({ ...input, modelId: routing.modelId });
  }

  async interpretObservation(input: Parameters<typeof interpretObservation>[0]): Promise<Awaited<ReturnType<typeof interpretObservation>>> {
    const routing = this.route({
      domain: "verification",
      policy: this.options.policies.observation,
      serializedInput: input,
      estimatedOutputTokens: 180,
    });
    return this.gateway.interpretObservation({ ...input, modelId: routing.modelId });
  }

  async verifyTaskResult(input: Parameters<typeof verifyTaskResult>[0]): Promise<Awaited<ReturnType<typeof verifyTaskResult>>> {
    const routing = this.route({
      domain: "verification",
      policy: this.options.policies.verification,
      serializedInput: input,
      estimatedOutputTokens: 180,
    });
    return this.gateway.verifyTaskResult({ ...input, modelId: routing.modelId });
  }

  async decideRecovery(input: Parameters<typeof decideRecovery>[0]): Promise<Awaited<ReturnType<typeof decideRecovery>>> {
    const routing = this.route({
      domain: "verification",
      policy: this.options.policies.recovery,
      serializedInput: input,
      estimatedOutputTokens: 180,
    });
    return this.gateway.decideRecovery({ ...input, modelId: routing.modelId });
  }

  async summarizeTask(input: Parameters<typeof summarizeTask>[0]): Promise<Awaited<ReturnType<typeof summarizeTask>>> {
    const routing = this.route({
      domain: "verification",
      policy: this.options.policies.summary,
      serializedInput: input,
      estimatedOutputTokens: 180,
    });
    return this.gateway.summarizeTask({ ...input, modelId: routing.modelId });
  }

  async generatePlan(input: Parameters<typeof generatePlan>[0]): Promise<Awaited<ReturnType<typeof generatePlan>>> {
    const routing = this.route({
      domain: "planning",
      policy: this.options.policies.plan,
      serializedInput: input,
      estimatedOutputTokens: 900,
    });
    return this.gateway.generatePlan({ ...input, modelId: routing.modelId });
  }

  private route(input: RoutedInput): RoutingDecision {
    return this.options.router.route(buildRequest(input));
  }
}
