import { invokeLLM, listLLMModels } from "../_core/llm";

export type PlannedStep = {
  title: string;
  description: string;
  capability: string;
  expectedEvidence: string;
  risk: "low" | "medium" | "high";
};

export type StructuredPlan = {
  taskSummary: string;
  executionRationale: string;
  steps: PlannedStep[];
};

export type ToolSelection = {
  planStep: number;
  capability: string;
  argumentSummary: string;
  expectedEvidence: string;
  requiresApproval: boolean;
};

export type ObservationInterpretation = {
  summary: string;
  evidenceSatisfied: boolean;
  nextIntent: "continue" | "verify" | "recover" | "block";
  reason: string;
};

export type VerificationResult = {
  passed: boolean;
  evidenceSummary: string;
  gaps: string[];
};

export type RecoveryDecision = {
  revisedApproach: string;
  nextIntent: "retry" | "change_strategy" | "request_approval" | "block";
  reason: string;
};

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    taskSummary: { type: "string" },
    executionRationale: { type: "string" },
    steps: {
      type: "array",
      minItems: 2,
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          capability: { type: "string" },
          expectedEvidence: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["title", "description", "capability", "expectedEvidence", "risk"],
        additionalProperties: false,
      },
    },
  },
  required: ["taskSummary", "executionRationale", "steps"],
  additionalProperties: false,
} as const;

const plannerSystemPrompt = `You are the planning component of a secure autonomous computer platform. Create an execution plan only; do not claim to execute any step. Use the available capability names exactly when possible: shell.exec, filesystem.read, filesystem.write, filesystem.list, process.start, process.stop, package.install, git.operation, artifact.pack, browser.navigate, browser.interact, http.request, secret.inject. Treat secrets as references only, never values. Mark any side-effecting, credential, local-computer, publishing, deletion, or submission activity as medium or high risk. Every step must state independently observable evidence.`;

const executiveSystemPrompt = `You are a secure agent-runtime reasoning component. Do not claim that any command, browser action, or external side effect occurred unless the observation explicitly proves it. Never request raw secrets; use only secret:// reference identifiers. Do not bypass policy, approval, budgets, or verification gates.`;

function toText(content: unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } =>
        Boolean(part && typeof part === "object" && "type" in part && (part as { type?: string }).type === "text")
      )
      .map(part => part.text)
      .join("\n");
  }
  return "";
}

export async function generatePlan(input: {
  goal: string;
  executionTarget: string;
  modelId?: string | null;
  maxSteps: number;
}): Promise<{ plan: StructuredPlan; modelId: string; usedTokens: number }> {
  const response = await invokeLLM({
    model: input.modelId || undefined,
    messages: [
      { role: "system", content: plannerSystemPrompt },
      {
        role: "user",
        content: `Goal:\n${input.goal}\n\nExecution target: ${input.executionTarget}\n\nMaximum steps: ${input.maxSteps}\n\nReturn a precise plan. Do not include secret values or executable credentials.`,
      },
    ],
    outputSchema: {
      name: "agent_computer_plan",
      strict: true,
      schema: PLAN_SCHEMA,
    },
  });

  const raw = toText(response.choices[0]?.message.content);
  if (!raw) throw new Error("The model returned an empty planning response.");

  const parsed = JSON.parse(raw) as StructuredPlan;
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error("The model returned an invalid plan without executable steps.");
  }

  return {
    plan: { ...parsed, steps: parsed.steps.slice(0, input.maxSteps) },
    modelId: response.model,
    usedTokens: response.usage?.total_tokens ?? 0,
  };
}

export async function getAvailableModels() {
  const result = await listLLMModels();
  return result.data.map(model => ({ id: model.id, owner: model.owned_by }));
}

async function invokeStructured<T>(input: {
  modelId?: string | null;
  schemaName: string;
  schema: Record<string, unknown>;
  prompt: string;
}) {
  const response = await invokeLLM({
    model: input.modelId || undefined,
    messages: [
      { role: "system", content: executiveSystemPrompt },
      { role: "user", content: input.prompt },
    ],
    outputSchema: { name: input.schemaName, strict: true, schema: input.schema },
  });
  const raw = toText(response.choices[0]?.message.content);
  if (!raw) throw new Error("The model returned an empty structured response.");
  return { value: JSON.parse(raw) as T, modelId: response.model, usedTokens: response.usage?.total_tokens ?? 0 };
}

export async function selectToolAction(input: {
  modelId?: string | null;
  taskGoal: string;
  plan: StructuredPlan;
  completedStepCount: number;
  observations: string[];
}) {
  return invokeStructured<ToolSelection>({
    modelId: input.modelId,
    schemaName: "agent_tool_selection",
    schema: {
      type: "object",
      properties: {
        planStep: { type: "integer", minimum: 1 },
        capability: { type: "string" },
        argumentSummary: { type: "string" },
        expectedEvidence: { type: "string" },
        requiresApproval: { type: "boolean" },
      },
      required: ["planStep", "capability", "argumentSummary", "expectedEvidence", "requiresApproval"],
      additionalProperties: false,
    },
    prompt: `Goal:\n${input.taskGoal}\n\nPlan:\n${JSON.stringify(input.plan)}\n\nCompleted steps: ${input.completedStepCount}\n\nLatest observations:\n${input.observations.join("\n") || "None"}\n\nSelect only the next safe action. Do not include raw secret values or claim execution.`,
  });
}

export async function interpretObservation(input: { modelId?: string | null; taskGoal: string; observation: string; expectedEvidence: string }) {
  return invokeStructured<ObservationInterpretation>({
    modelId: input.modelId,
    schemaName: "agent_observation_interpretation",
    schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        evidenceSatisfied: { type: "boolean" },
        nextIntent: { type: "string", enum: ["continue", "verify", "recover", "block"] },
        reason: { type: "string" },
      },
      required: ["summary", "evidenceSatisfied", "nextIntent", "reason"],
      additionalProperties: false,
    },
    prompt: `Goal:\n${input.taskGoal}\n\nExpected evidence:\n${input.expectedEvidence}\n\nObserved result:\n${input.observation}\n\nInterpret only what the observation proves.`,
  });
}

export async function verifyTaskResult(input: { modelId?: string | null; goal: string; evidence: string[] }) {
  return invokeStructured<VerificationResult>({
    modelId: input.modelId,
    schemaName: "agent_verification_result",
    schema: {
      type: "object",
      properties: {
        passed: { type: "boolean" },
        evidenceSummary: { type: "string" },
        gaps: { type: "array", items: { type: "string" } },
      },
      required: ["passed", "evidenceSummary", "gaps"],
      additionalProperties: false,
    },
    prompt: `Goal:\n${input.goal}\n\nEvidence:\n${input.evidence.join("\n---\n")}\n\nDecide whether the evidence independently satisfies the goal.`,
  });
}

export async function decideRecovery(input: { modelId?: string | null; goal: string; failedAction: string; observation: string; attempts: number }) {
  return invokeStructured<RecoveryDecision>({
    modelId: input.modelId,
    schemaName: "agent_recovery_decision",
    schema: {
      type: "object",
      properties: {
        revisedApproach: { type: "string" },
        nextIntent: { type: "string", enum: ["retry", "change_strategy", "request_approval", "block"] },
        reason: { type: "string" },
      },
      required: ["revisedApproach", "nextIntent", "reason"],
      additionalProperties: false,
    },
    prompt: `Goal:\n${input.goal}\n\nFailed action:\n${input.failedAction}\n\nObservation:\n${input.observation}\n\nEquivalent attempts: ${input.attempts}\n\nChoose a bounded recovery decision.`,
  });
}

export type CapabilityArguments = {
  command?: string;
  path?: string;
  content?: string;
  url?: string;
  /** http.request only. Defaults to GET when absent. */
  method?: string;
  /** http.request only, for methods that accept a body (not GET/HEAD). */
  body?: string;
  notes?: string;
};

/**
 * Turns a single planned step into the concrete, structured arguments the
 * execution adapter needs (e.g. an actual shell command, not a description
 * of one). This is distinct from selectToolAction, which only summarizes
 * intent — the adapter cannot act on a summary string.
 */
export async function selectCapabilityArguments(input: {
  modelId?: string | null;
  taskGoal: string;
  step: { title: string; description: string; capability: string; expectedEvidence: string };
  priorObservations: string[];
}) {
  return invokeStructured<CapabilityArguments>({
    modelId: input.modelId,
    schemaName: "agent_capability_arguments",
    schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] },
        body: { type: "string" },
        notes: { type: "string" },
      },
      additionalProperties: false,
    },
    prompt: `Goal:\n${input.taskGoal}\n\nStep to perform now:\nTitle: ${input.step.title}\nDescription: ${input.step.description}\nCapability: ${input.step.capability}\nExpected evidence: ${input.step.expectedEvidence}\n\nPrior observations:\n${input.priorObservations.join("\n") || "None"}\n\nReturn only the fields this specific capability needs (for example "command" for shell.exec/process.start/package.install/git.operation, or "path" and "content" for filesystem writes, or "path" for filesystem reads/listings, or "url" and optionally "method"/"body" for http.request — method defaults to GET, and body is only meaningful for POST/PUT/PATCH). Custom headers and authenticated requests are not supported yet: http.request cannot carry a secret:// reference, so never select it for a call that needs credentials. Never include a raw secret value. Leave unrelated fields absent.`,
  });
}

export async function summarizeTask(input: { modelId?: string | null; goal: string; events: string[] }) {
  return invokeStructured<{ summary: string; outcome: "completed" | "blocked" | "failed" | "cancelled" }>({
    modelId: input.modelId,
    schemaName: "agent_task_summary",
    schema: {
      type: "object",
      properties: { summary: { type: "string" }, outcome: { type: "string", enum: ["completed", "blocked", "failed", "cancelled"] } },
      required: ["summary", "outcome"],
      additionalProperties: false,
    },
    prompt: `Goal:\n${input.goal}\n\nExecution events:\n${input.events.join("\n")}\n\nSummarize only the documented result.`,
  });
}
