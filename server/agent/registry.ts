import type { CapabilityName } from "./policy";

export type RiskTier = "low" | "medium" | "high" | "critical";

export type CapabilityDefinition = {
  name: CapabilityName;
  label: string;
  description: string;
  category: "computer" | "workspace" | "browser" | "network" | "trust" | "delivery";
  // Static base risk tier for this capability, independent of any
  // particular invocation. policy.ts's classifyRisk() escalates this per
  // request (destructive: true, target: "local_bridge") -- this is the
  // floor, not the whole picture. Previously an `approvalSensitive`
  // boolean lived here *and* a separately-maintained set in policy.ts
  // duplicated the same true/false split with no structural link between
  // them; this field is now the single source both read from.
  riskTier: RiskTier;
};

export const capabilityRegistry: CapabilityDefinition[] = [
  { name: "shell.exec", label: "Shell", description: "Run a bounded command and capture its result.", category: "computer", riskTier: "low" },
  { name: "filesystem.read", label: "Read files", description: "Inspect files within the approved workspace scope.", category: "workspace", riskTier: "low" },
  { name: "filesystem.write", label: "Write files", description: "Create or modify files within the approved workspace scope.", category: "workspace", riskTier: "low" },
  { name: "filesystem.list", label: "List files", description: "Discover workspace paths and metadata.", category: "workspace", riskTier: "low" },
  { name: "process.start", label: "Start process", description: "Start a managed process with time and resource limits.", category: "computer", riskTier: "low" },
  { name: "process.stop", label: "Stop process", description: "Stop a managed process or long-running job.", category: "computer", riskTier: "medium" },
  { name: "package.install", label: "Install package", description: "Install a package inside an isolated workspace.", category: "computer", riskTier: "high" },
  { name: "git.operation", label: "Git", description: "Inspect repositories and make scoped repository changes.", category: "workspace", riskTier: "high" },
  { name: "artifact.pack", label: "Package artifact", description: "Create an evidence-backed deliverable and provenance record.", category: "delivery", riskTier: "low" },
  { name: "browser.navigate", label: "Browser navigation", description: "Navigate through a structured browser session.", category: "browser", riskTier: "low" },
  { name: "browser.interact", label: "Browser interaction", description: "Perform a state-changing browser interaction with evidence capture.", category: "browser", riskTier: "medium" },
  { name: "http.request", label: "HTTP request", description: "Make an outbound HTTP request from inside the sandbox and capture the response.", category: "network", riskTier: "low" },
  { name: "search.query", label: "Web search", description: "Search the web via a configured provider and return ranked results with titles, URLs, and snippets.", category: "network", riskTier: "low" },
  { name: "secret.inject", label: "Secret reference", description: "Inject an approved secret reference at execution time without returning its raw value.", category: "trust", riskTier: "critical" },
];

export const executionTargets = [
  {
    id: "auto",
    label: "Auto",
    description: "Route the task to the best eligible execution adapter.",
    readiness: "ready",
  },
  {
    id: "cloud_sandbox",
    label: "Cloud Sandbox",
    description: "Disposable, isolated computer for bounded autonomous work.",
    readiness: process.env.E2B_API_KEY ? "ready" : "connection-required",
  },
  {
    id: "persistent_workspace",
    label: "Persistent",
    description: "Long-lived workspace with resumable checkpoints and state.",
    readiness: "connection-required",
  },
  {
    id: "local_bridge",
    label: "Local",
    description: "Explicitly authorized local connector with allowlists and approvals.",
    readiness: "approval-required",
  },
] as const;
