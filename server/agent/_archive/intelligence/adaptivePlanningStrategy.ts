import type { PlannerStrategy, ReplanRequest, PlanProposal } from "../../planning/replanner";
import { ModelPlannerStrategy, type ModelPlannerStrategyOptions } from "../../planning/modelPlannerStrategy";
import type { AdaptiveModelRouter } from "./adaptiveModelRouter";
import type { RoutingDecision } from "./routingTypes";

export type AdaptivePlanningPolicy = {
  complexity: 1 | 2 | 3;
  risk: "low" | "medium" | "high";
  budgetUsd?: number;
  latencyBudgetMs?: number;
};

export class AdaptivePlanningStrategy implements PlannerStrategy {
  // Expose last routing decision for diagnostics only — does not change PlanProposal shape.
  public lastRouting?: RoutingDecision;

  constructor(
    private readonly plannerOptions: ModelPlannerStrategyOptions = {},
    private readonly router: AdaptiveModelRouter,
    private readonly policy: AdaptivePlanningPolicy,
  ) {}

  async propose(request: ReplanRequest): Promise<PlanProposal> {
    const estimatedInputTokens = this.estimateInputTokens(request);
    const estimatedOutputTokens = this.estimateOutputTokens(this.policy.complexity);

    const routingRequest = {
      domain: "planning" as const,
      complexity: this.policy.complexity,
      risk: this.policy.risk,
      estimatedInputTokens,
      estimatedOutputTokens,
      budgetUsd: this.policy.budgetUsd,
      latencyBudgetMs: this.policy.latencyBudgetMs,
      constraints: {
        requiredStructuredOutput: true,
      },
    };

    // Call router exactly once, synchronously. Propagate any routing error.
    const routing = this.router.route(routingRequest);
    this.lastRouting = routing;

    // Instantiate a ModelPlannerStrategy configured with the selected modelId.
    const modelPlanner = new ModelPlannerStrategy({ ...(this.plannerOptions ?? {}), modelId: routing.modelId });

    // Delegate to the existing ModelPlannerStrategy path — it performs validation and all existing semantics.
    return modelPlanner.propose(request);
  }

  private estimateInputTokens(request: ReplanRequest): number {
    const serialized = JSON.stringify({
      goal: request.goal,
      context: request.context,
      previousPlan: request.previousPlan ?? null,
    });
    // conservative deterministic estimate: ~4 characters per token
    const tokens = Math.max(1, Math.ceil(serialized.length / 4));
    return tokens;
  }

  private estimateOutputTokens(complexity: 1 | 2 | 3): number {
    const perStep = 180;
    const maximumSteps = complexity === 1 ? 4 : complexity === 2 ? 8 : 12;
    return maximumSteps * perStep;
  }
}
