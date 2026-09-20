import { generatePlan, type PlannedStep, type StructuredPlan } from "./modelGateway";
import type { CapabilityObservation, CapabilityRequest, ExecutionTarget } from "./execution";
import { capabilityRegistry, type CapabilityDefinition } from "./registry";
import type { AgentPlanStep } from "./runtime/agentLoop";
import type { RuntimeSnapshot } from "./runtime/types";
import type { VerificationRequirement } from "./runtime/verification";

export type PlannerFailureCode =
  | "invalid_input"
  | "model_unavailable"
  | "invalid_model_output"
  | "unknown_capability"
  | "invalid_action";

export type PlannerFailure = {
  kind: "failure";
  code: PlannerFailureCode;
  message: string;
};

export type PlannerDecision =
  | { kind: "step"; step: AgentPlanStep; rationale: string }
  | { kind: "no_work"; reason: string }
  | PlannerFailure;

export type ModelPlannerInput = {
  taskId: string;
  goal: string;
  executionTarget: ExecutionTarget;
  runtimeSnapshot: RuntimeSnapshot;
  previousObservation?: CapabilityObservation;
  availableCapabilities: CapabilityDefinition[];
  modelId?: string | null;
  maxSteps: number;
};

export type PlannerGatewayInput = {
  goal: string;
  executionTarget: ExecutionTarget;
  modelId?: string | null;
  maxSteps: number;
  runtimeSnapshot: RuntimeSnapshot;
  previousObservation?: CapabilityObservation;
  availableCapabilities: CapabilityDefinition[];
};

export type PlannerGateway = (input: PlannerGatewayInput) => Promise<StructuredPlan | null>;

const unsafeActionCharacters = /[\r\n;&|`$<>]/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateAction(value: unknown): value is string {
  return isNonEmptyString(value) && value.trim().length <= 160 && !unsafeActionCharacters.test(value);
}

function controlledFailure(code: PlannerFailureCode, error: unknown): PlannerFailure {
  return {
    kind: "failure",
    code,
    message: error instanceof Error ? error.message : "The planner returned an unknown failure.",
  };
}

function capabilityNames(capabilities: CapabilityDefinition[]) {
  const registeredCapabilities = new Set(capabilityRegistry.map(capability => capability.name));
  return new Set(
    capabilities
      .map(capability => capability.name)
      .filter(capability => registeredCapabilities.has(capability)),
  );
}

function sanitizeSnapshot(snapshot: RuntimeSnapshot) {
  return {
    runId: snapshot.state.runId,
    status: snapshot.state.status,
    currentStep: snapshot.state.currentStep,
    maxSteps: snapshot.state.maxSteps,
    recoveryAttempts: snapshot.state.recoveryAttempts,
    maxRecoveryAttempts: snapshot.state.maxRecoveryAttempts,
    currentPhase: snapshot.state.currentPhase,
    evidence: snapshot.state.evidence,
  };
}

function enrichGoal(input: PlannerGatewayInput) {
  const capabilities = input.availableCapabilities.map(capability => ({
    name: capability.name,
    label: capability.label,
    description: capability.description,
    riskTier: capability.riskTier,
  }));

  return [
    input.goal,
    "Runtime snapshot:",
    JSON.stringify(sanitizeSnapshot(input.runtimeSnapshot)),
    "Previous observation:",
    input.previousObservation ? JSON.stringify(input.previousObservation) : "None",
    "Available capabilities:",
    JSON.stringify(capabilities),
    "Return a plan using only the available capability names. Do not return executable shell commands, raw secrets, or unstructured instructions.",
  ].join("\n\n");
}

const defaultGateway: PlannerGateway = async input => {
  const result = await generatePlan({
    goal: enrichGoal(input),
    executionTarget: input.executionTarget,
    modelId: input.modelId,
    maxSteps: input.maxSteps,
  });
  return result.plan;
};

function validateStep(step: unknown, index: number, allowedCapabilities: Set<string>) {
  if (!step || typeof step !== "object") {
    throw new Error(`Planner returned an invalid step at index ${index}.`);
  }
  const candidate = step as Record<string, unknown>;
  if (!validateAction(candidate.title)) {
    throw new Error(`Planner step ${index + 1} contains an invalid action.`);
  }
  if (!isNonEmptyString(candidate.description)) {
    throw new Error(`Planner step ${index + 1} is missing description.`);
  }
  if (!isNonEmptyString(candidate.capability) || !allowedCapabilities.has(candidate.capability)) {
    throw new Error(`Planner step ${index + 1} contains an unknown capability.`);
  }
  if (!isNonEmptyString(candidate.expectedEvidence)) {
    throw new Error(`Planner step ${index + 1} is missing expected evidence.`);
  }
  if (!["low", "medium", "high"].includes(candidate.risk as string)) {
    throw new Error(`Planner step ${index + 1} contains an invalid risk level.`);
  }

  return {
    title: candidate.title.trim(),
    description: candidate.description.trim(),
    capability: candidate.capability as CapabilityRequest["capability"],
    expectedEvidence: candidate.expectedEvidence.trim(),
    risk: candidate.risk as PlannedStep["risk"],
  };
}

export function validateStructuredPlan(
  plan: StructuredPlan,
  input: Pick<ModelPlannerInput, "maxSteps" | "availableCapabilities">,
) {
  if (!plan || typeof plan !== "object") throw new Error("Planner returned an invalid plan.");
  if (!isNonEmptyString(plan.taskSummary)) throw new Error("Planner returned a plan without a task summary.");
  if (!isNonEmptyString(plan.executionRationale)) throw new Error("Planner returned a plan without execution rationale.");
  if (!Array.isArray(plan.steps)) throw new Error("Planner returned an invalid steps collection.");
  if (plan.steps.length === 0) return null;
  if (plan.steps.length > input.maxSteps) throw new Error(`Planner returned ${plan.steps.length} steps; maximum is ${input.maxSteps}.`);

  const steps = plan.steps.map((step, index) => validateStep(step, index, capabilityNames(input.availableCapabilities)));
  return { summary: plan.taskSummary.trim(), rationale: plan.executionRationale.trim(), step: steps[0] };
}

function toCapabilityRequest(input: Pick<ModelPlannerInput, "taskId" | "executionTarget">, step: ReturnType<typeof validateStep>): CapabilityRequest {
  return {
    taskId: input.taskId,
    capability: step.capability,
    target: input.executionTarget,
    action: step.title,
    // The model is deliberately limited to a declarative description. It never supplies
    // an executable command, browser selector, raw secret, or adapter-specific argument.
    arguments: { description: step.description, expectedEvidence: step.expectedEvidence },
    destructive: step.risk !== "low",
  };
}

function toVerificationRequirement(step: ReturnType<typeof validateStep>): VerificationRequirement {
  return { requiredOutcome: "completed", requiredEvidence: [step.expectedEvidence] };
}

export class ModelBackedPlanner {
  constructor(private readonly gateway: PlannerGateway = defaultGateway) {}

  async plan(input: ModelPlannerInput): Promise<PlannerDecision> {
    if (!isNonEmptyString(input.taskId) || !isNonEmptyString(input.goal)) {
      return controlledFailure("invalid_input", new Error("taskId and goal are required."));
    }
    if (!Number.isInteger(input.maxSteps) || input.maxSteps < 1) {
      return controlledFailure("invalid_input", new Error("maxSteps must be a positive integer."));
    }
    if (!Array.isArray(input.availableCapabilities) || input.availableCapabilities.length === 0) {
      return controlledFailure("invalid_input", new Error("At least one available capability is required."));
    }

    let plan: StructuredPlan | null;
    try {
      plan = await this.gateway(input);
    } catch (error) {
      return controlledFailure("model_unavailable", error);
    }

    if (plan === null) return { kind: "no_work", reason: "The planner returned no remaining work." };

    try {
      const validated = validateStructuredPlan(plan, input);
      if (!validated) return { kind: "no_work", reason: "The planner returned an empty structured plan." };
      const request = toCapabilityRequest(input, validated.step);
      return {
        kind: "step",
        rationale: validated.rationale,
        step: { request, verification: toVerificationRequirement(validated.step) },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Planner output could not be validated.";
      const code: PlannerFailureCode = /unknown capability/.test(message)
        ? "unknown_capability"
        : /invalid action/.test(message)
          ? "invalid_action"
          : "invalid_model_output";
      return controlledFailure(code, error);
    }
  }
}

export function createDefaultModelBackedPlanner() {
  return new ModelBackedPlanner();
}

export function defaultPlannerCapabilities() {
  return capabilityRegistry;
}
