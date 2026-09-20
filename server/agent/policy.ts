import { capabilityRegistry, type RiskTier } from "./registry";

export const ACTIVE_TASK_STATUSES = [
  "planning",
  "queued",
  "executing",
  "waiting_approval",
  "verifying",
  "recovering",
] as const;

export const TERMINAL_TASK_STATUSES = ["completed", "blocked", "failed", "cancelled"] as const;

export type TaskStatus =
  | "draft"
  | (typeof ACTIVE_TASK_STATUSES)[number]
  | (typeof TERMINAL_TASK_STATUSES)[number];

export type CapabilityName =
  | "shell.exec"
  | "filesystem.read"
  | "filesystem.write"
  | "filesystem.list"
  | "process.start"
  | "process.stop"
  | "package.install"
  | "git.operation"
  | "artifact.pack"
  | "browser.navigate"
  | "browser.interact"
  | "http.request"
  | "search.query"
  | "secret.inject";

export type PolicyDecision = {
  allowed: boolean;
  requiresApproval: boolean;
  risk: RiskTier;
  reason: string;
};

const RISK_ORDER: RiskTier[] = ["low", "medium", "high", "critical"];

function escalate(tier: RiskTier): RiskTier {
  const index = RISK_ORDER.indexOf(tier);
  return RISK_ORDER[Math.min(index + 1, RISK_ORDER.length - 1)];
}

// Exported so callers that need a risk value outside the allow/deny
// decision itself (e.g. what to store on an approval record) can derive
// it from the same rules evaluateCapabilityPolicy uses internally,
// instead of re-deriving an ad-hoc "high"/"medium" string locally --
// which is what taskRunner.ts, durableTaskRunner.ts, and routers/agent.ts
// each did independently before this.
export function classifyRisk(input: {
  capability: CapabilityName;
  target: "auto" | "cloud_sandbox" | "persistent_workspace" | "local_bridge";
  destructive?: boolean;
}): RiskTier {
  const base = capabilityRegistry.find(entry => entry.name === input.capability)?.riskTier ?? "low";
  const tier = input.destructive ? escalate(base) : base;
  if (input.target === "local_bridge" && RISK_ORDER.indexOf(tier) < RISK_ORDER.indexOf("high")) {
    return "high";
  }
  return tier;
}

// Exported for callers combining a classified floor with a separately
// supplied risk (e.g. requestApproval's client-supplied risk) -- the
// higher of the two always wins, so a caller can escalate above the
// capability's floor but never quietly under-report below it.
export function maxRiskTier(a: RiskTier, b: RiskTier): RiskTier {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

export function evaluateCapabilityPolicy(input: {
  capability: CapabilityName;
  target: "auto" | "cloud_sandbox" | "persistent_workspace" | "local_bridge";
  hasRawSecret?: boolean;
  destructive?: boolean;
}): PolicyDecision {
  if (input.hasRawSecret) {
    return {
      allowed: false,
      requiresApproval: false,
      risk: "critical",
      reason: "Raw secret values are never eligible for model or tool input. Use a secret reference instead.",
    };
  }

  const risk = classifyRisk(input);

  if (input.target === "local_bridge") {
    return {
      allowed: true,
      requiresApproval: true,
      risk,
      reason: "Local computer actions require explicit approval and local allowlist enforcement.",
    };
  }

  if (risk !== "low") {
    return {
      allowed: true,
      requiresApproval: true,
      risk,
      reason: "This capability has a material side effect and requires an approval before execution.",
    };
  }

  return {
    allowed: true,
    requiresApproval: false,
    risk,
    reason: "The capability is permitted within the task workspace and active policy scope.",
  };
}

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ["planning", "cancelled"],
  planning: ["queued", "blocked", "failed", "cancelled"],
  queued: ["executing", "waiting_approval", "cancelled", "blocked"],
  executing: ["waiting_approval", "verifying", "recovering", "failed", "cancelled", "blocked"],
  waiting_approval: ["queued", "executing", "blocked", "cancelled"],
  verifying: ["completed", "recovering", "failed", "blocked", "cancelled"],
  recovering: ["queued", "executing", "waiting_approval", "failed", "blocked", "cancelled"],
  completed: [],
  blocked: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus) {
  return TRANSITIONS[from].includes(to);
}

export function assessBudget(input: {
  usedSteps: number;
  maxSteps: number;
  usedTokens: number;
  maxTokens: number;
  usedBudgetCents: number;
  maxBudgetCents: number;
}) {
  const exceeded =
    input.usedSteps > input.maxSteps ||
    input.usedTokens > input.maxTokens ||
    input.usedBudgetCents > input.maxBudgetCents;

  const nearing =
    input.usedSteps >= input.maxSteps * 0.85 ||
    input.usedTokens >= input.maxTokens * 0.85 ||
    input.usedBudgetCents >= input.maxBudgetCents * 0.85;

  return { exceeded, nearing };
}
