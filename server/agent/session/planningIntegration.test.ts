import { describe, expect, it } from "vitest";
import { InMemoryTaskContextRepository } from "../context/taskContextRepository";
import { TaskContextStore } from "../context/taskContextStore";
import type { PlanPersistence } from "../planning/planningPersistence";
import type { PlannerStrategy } from "../planning/replanner";
import { AgentSession } from "./agentSession";
import { createPlanningSessionDependencies } from "./planningSessionComposition";

function persistence(): PlanPersistence {
  let saved: Awaited<ReturnType<PlanPersistence["load"]>>;
  return {
    async save(plan) { saved = structuredClone(plan); },
    async load() { return saved ? structuredClone(saved) : null; },
  };
}

describe("planning session composition", () => {
  it("routes bounded session context through durable planning and the existing orchestrator exactly once", async () => {
    const context = new TaskContextStore(new InMemoryTaskContextRepository());
    await context.save({ taskId: "task-1", goal: "Inspect workspace", currentStep: 0, facts: { scope: "repo" }, entries: [] });
    let planningContext: unknown;
    let executions = 0;
    const strategy: PlannerStrategy = {
      async propose(request) {
        planningContext = request.context;
        return {
          nodes: [{
            id: "n1",
            title: "Inspect workspace",
            description: "List the workspace.",
            dependencies: [],
            status: "pending",
            priority: 1,
            metadata: { capability: "filesystem.list", expectedEvidence: "listing", risk: "low" },
          }],
        };
      },
    };
    const dependencies = createPlanningSessionDependencies({
      context,
      plannerStrategy: strategy,
      planningPersistence: persistence(),
      executor: { async execute() { executions += 1; return { result: "listed" }; } },
      observer: { async observe() { return [{ kind: "result", value: "listed", source: "test" }]; } },
      verifier: { async verify() { return { status: "verified" }; } },
      orchestrationPlanner: { async next(_taskId, nodeId) { return { type: "continue", nodeId }; } },
    });

    const result = await new AgentSession(dependencies).run("task-1", { maxCycles: 2 });

    expect(result).toEqual({ status: "completed", taskId: "task-1" });
    expect(executions).toBe(1);
    expect(planningContext).toMatchObject({ goal: "Inspect workspace", facts: { scope: "repo" } });
    expect(planningContext).not.toHaveProperty("taskId");
    const entries = (await context.load("task-1"))?.entries ?? [];
    expect(entries.map(entry => entry.kind)).toEqual(expect.arrayContaining(["observation", "verification"]));
  });
});



describe("real model planning composition", () => {
  const modelPlan = {
    taskSummary: "Inspect and summarize the workspace",
    executionRationale: "Use two bounded, evidence-producing steps.",
    steps: [
      { title: "Inspect workspace", description: "List the workspace.", capability: "filesystem.list", expectedEvidence: "listing", risk: "low" as const },
      { title: "Summarize workspace", description: "Summarize the listing.", capability: "artifact.pack", expectedEvidence: "summary", risk: "low" as const },
    ],
  };

  it("uses the real ModelPlannerStrategy once and sends its durable nodes through the existing orchestrator", async () => {
    const context = new TaskContextStore(new InMemoryTaskContextRepository());
    await context.save({ taskId: "task-model", goal: "Inspect and summarize", currentStep: 0, facts: { scope: "repo" }, entries: [] });
    let providerCalls = 0;
    let providerInput: { goal: string } | undefined;
    let executions = 0;
    const dependencies = createPlanningSessionDependencies({
      context,
      modelPlannerOptions: {
        provider: async input => {
          providerCalls += 1;
          providerInput = input;
          return modelPlan;
        },
      },
      planningPersistence: persistence(),
      executor: { async execute() { executions += 1; return { result: "ok" }; } },
      observer: { async observe() { return [{ kind: "result", value: "ok", source: "deterministic-test" }]; } },
      verifier: { async verify() { return { status: "verified" }; } },
      orchestrationPlanner: { async next(_taskId, nodeId) { return { type: "complete", nodeId }; } },
    });

    await expect(new AgentSession(dependencies).run("task-model", { maxCycles: 2 }))
      .resolves.toEqual({ status: "completed", taskId: "task-model" });
    expect(providerCalls).toBe(1);
    expect(providerInput?.goal).toContain("Inspect and summarize");
    expect(providerInput?.goal).toContain("repo");
    expect(providerInput?.goal).not.toContain("secret-value");
    expect(executions).toBe(1);
  });

  it("turns a configured model-provider failure into one bounded session failure", async () => {
    const context = new TaskContextStore(new InMemoryTaskContextRepository());
    await context.save({ taskId: "task-model-failure", goal: "Model failure", currentStep: 0, facts: {}, entries: [] });
    let providerCalls = 0;
    const dependencies = createPlanningSessionDependencies({
      context,
      modelPlannerOptions: {
        provider: async () => {
          providerCalls += 1;
          throw new Error("configured provider unavailable");
        },
      },
      planningPersistence: persistence(),
      executor: { async execute() { return { result: "should-not-run" }; } },
      observer: { async observe() { return []; } },
      verifier: { async verify() { return { status: "verified" }; } },
      orchestrationPlanner: { async next(_taskId, nodeId) { return { type: "complete", nodeId }; } },
    });

    await expect(new AgentSession(dependencies).run("task-model-failure", { maxCycles: 3 }))
      .resolves.toEqual({ status: "failed", taskId: "task-model-failure", reason: "configured provider unavailable" });
    expect(providerCalls).toBe(1);
  });
});


describe("adaptive planning composition", () => {
  const adaptivePlan = {
    taskSummary: "Adaptive plan",
    executionRationale: "Use the selected model.",
    steps: [{ title: "Inspect workspace", description: "List the workspace.", capability: "filesystem.list", expectedEvidence: "listing", risk: "low" as const }],
  };

  function profile(id: string, tier: 1 | 2 | 3 = 1) {
    return {
      id,
      provider: "deterministic-provider",
      tier,
      contextWindowTokens: 16_000,
      domains: [{ domain: "planning" as const, score: 1 }],
      maximumRisk: "low" as const,
      structuredOutput: true,
      averageLatencyMs: 100,
      cost: { inputPerMillionTokensUsd: 1, outputPerMillionTokensUsd: 2 },
      reliabilityScore: 0.95,
      enabled: true,
    };
  }

  async function baseOptions(goal: string, provider: NonNullable<NonNullable<Parameters<typeof createPlanningSessionDependencies>[0]["modelPlannerOptions"]>["provider"]>, extra: Partial<Parameters<typeof createPlanningSessionDependencies>[0]> = {}) {
    const context = new TaskContextStore(new InMemoryTaskContextRepository());
    await context.save({ taskId: "adaptive-task", goal, currentStep: 0, facts: { bounded: "yes" }, entries: [] });
    return {
      context,
      modelPlannerOptions: { provider },
      planningPersistence: persistence(),
      executor: { async execute() { return { result: "ok" }; } },
      observer: { async observe() { return [{ kind: "result", value: "ok", source: "adaptive-test" }]; } },
      verifier: { async verify() { return { status: "verified" }; } },
      orchestrationPlanner: { async next(_taskId: string, nodeId: string) { return { type: "complete" as const, nodeId }; } },
      ...extra,
    };
  }

  it("uses the configured adaptive router once and forwards its selected model to the existing provider boundary", async () => {
    const registry = new (await import("../_archive/intelligence/modelRegistry")).ModelRegistry();
    registry.register(profile("adaptive-selected"));
    const baseRouter = new (await import("../_archive/intelligence/adaptiveModelRouter")).AdaptiveModelRouter(registry);
    let routeCalls = 0;
    const router = { route(input: Parameters<typeof baseRouter.route>[0]) { routeCalls += 1; return baseRouter.route(input); } };
    let providerModelId: string | null | undefined;
    const options = await baseOptions("Adaptive planning", async input => { providerModelId = input.modelId; return adaptivePlan; }, {
      adaptivePlanning: { enabled: true, router, policy: { complexity: 1, risk: "low" as const }, plannerOptions: undefined },
    });
    await expect(new AgentSession(createPlanningSessionDependencies(options)).run("adaptive-task", { maxCycles: 2 })).resolves.toEqual({ status: "completed", taskId: "adaptive-task" });
    expect(routeCalls).toBe(1);
    expect(providerModelId).toBe("adaptive-selected");
  });

  it("keeps explicit custom strategy authoritative and does not call the adaptive router", async () => {
    const registry = new (await import("../_archive/intelligence/modelRegistry")).ModelRegistry();
    registry.register(profile("should-not-route"));
    let routeCalls = 0;
    const router = { route() { routeCalls += 1; throw new Error("router should not be called"); } };
    const strategy: PlannerStrategy = { async propose() { return { nodes: [{ id: "n1", title: "Custom", description: "Custom", dependencies: [], status: "pending", priority: 1, metadata: { capability: "filesystem.list", expectedEvidence: "listing", risk: "low" } }] }; } };
    const options = await baseOptions("Custom planning", async () => adaptivePlan, { plannerStrategy: strategy, adaptivePlanning: { enabled: true, router, policy: { complexity: 1, risk: "low" as const } } });
    await expect(new AgentSession(createPlanningSessionDependencies(options)).run("adaptive-task", { maxCycles: 2 })).resolves.toEqual({ status: "completed", taskId: "adaptive-task" });
    expect(routeCalls).toBe(0);
  });

  it("fails closed on router errors without invoking the provider or executor", async () => {
    let providerCalls = 0;
    let executions = 0;
    const options = await baseOptions("Router failure", async () => { providerCalls += 1; return adaptivePlan; }, {
      adaptivePlanning: { enabled: true, router: { route() { throw new Error("no eligible model"); } }, policy: { complexity: 1, risk: "low" as const } },
      executor: { async execute() { executions += 1; return { result: "should-not-run" }; } },
    });
    await expect(new AgentSession(createPlanningSessionDependencies(options)).run("adaptive-task", { maxCycles: 2 })).resolves.toEqual({ status: "failed", taskId: "adaptive-task", reason: "no eligible model" });
    expect(providerCalls).toBe(0);
    expect(executions).toBe(0);
  });
});
