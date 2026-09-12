import type { CapabilityName } from "./policy";

export type CapabilityDefinition = {
  name: CapabilityName;
  label: string;
  description: string;
  category: "computer" | "workspace" | "browser" | "network" | "trust" | "delivery";
  approvalSensitive: boolean;
};

export const capabilityRegistry: CapabilityDefinition[] = [
  { name: "shell.exec", label: "Shell", description: "Run a bounded command and capture its result.", category: "computer", approvalSensitive: false },
  { name: "filesystem.read", label: "Read files", description: "Inspect files within the approved workspace scope.", category: "workspace", approvalSensitive: false },
  { name: "filesystem.write", label: "Write files", description: "Create or modify files within the approved workspace scope.", category: "workspace", approvalSensitive: false },
  { name: "filesystem.list", label: "List files", description: "Discover workspace paths and metadata.", category: "workspace", approvalSensitive: false },
  { name: "process.start", label: "Start process", description: "Start a managed process with time and resource limits.", category: "computer", approvalSensitive: false },
  { name: "process.stop", label: "Stop process", description: "Stop a managed process or long-running job.", category: "computer", approvalSensitive: true },
  { name: "package.install", label: "Install package", description: "Install a package inside an isolated workspace.", category: "computer", approvalSensitive: true },
  { name: "git.operation", label: "Git", description: "Inspect repositories and make scoped repository changes.", category: "workspace", approvalSensitive: true },
  { name: "artifact.pack", label: "Package artifact", description: "Create an evidence-backed deliverable and provenance record.", category: "delivery", approvalSensitive: false },
  { name: "browser.navigate", label: "Browser navigation", description: "Navigate through a structured browser session.", category: "browser", approvalSensitive: false },
  { name: "browser.interact", label: "Browser interaction", description: "Perform a state-changing browser interaction with evidence capture.", category: "browser", approvalSensitive: true },
  { name: "http.request", label: "HTTP request", description: "Make an outbound HTTP request from inside the sandbox and capture the response.", category: "network", approvalSensitive: false },
  { name: "search.query", label: "Web search", description: "Search the web via a configured provider and return ranked results with titles, URLs, and snippets.", category: "network", approvalSensitive: false },
  { name: "secret.inject", label: "Secret reference", description: "Inject an approved secret reference at execution time without returning its raw value.", category: "trust", approvalSensitive: true },
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
