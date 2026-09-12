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
  reason: string;
};

const APPROVAL_CAPABILITIES = new Set<CapabilityName>([
  "process.stop",
  "package.install",
  "git.operation",
  "browser.interact",
  "secret.inject",
]);

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
      reason: "Raw secret values are never eligible for model or tool input. Use a secret reference instead.",
    };
  }

  if (input.target === "local_bridge") {
    return {
      allowed: true,
      requiresApproval: true,
      reason: "Local computer actions require explicit approval and local allowlist enforcement.",
    };
  }

  if (input.destructive || APPROVAL_CAPABILITIES.has(input.capability)) {
    return {
      allowed: true,
      requiresApproval: true,
      reason: "This capability has a material side effect and requires an approval before execution.",
    };
  }

  return {
    allowed: true,
    requiresApproval: false,
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
