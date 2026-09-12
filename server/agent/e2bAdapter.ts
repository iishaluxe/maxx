import { Sandbox } from "e2b";
import type { CapabilityObservation, CapabilityRequest, ExecutionAdapter } from "./execution";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function requireString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required for this capability.`);
  }
  return value;
}

function commandOutput(result: { stdout: string; stderr: string; exitCode: number; error?: string }) {
  return [result.stdout, result.stderr, result.error].filter(Boolean).join("\n").trim();
}

export class E2BCloudSandboxAdapter implements ExecutionAdapter {
  readonly id = "e2b-cloud-sandbox";
  readonly target = "cloud_sandbox" as const;
  private readonly sandboxes = new Map<string, Sandbox>();

  isConfigured() {
    return Boolean(process.env.E2B_API_KEY);
  }

  private async sandboxFor(taskId: string) {
    const existing = this.sandboxes.get(taskId);
    if (existing) return existing;
    const apiKey = process.env.E2B_API_KEY;
    if (!apiKey) throw new Error("E2B_API_KEY is not configured.");
    const sandbox = await Sandbox.create({
      apiKey,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      secure: true,
      allowInternetAccess: false,
      metadata: { aegisTaskId: taskId, runtime: "aegis-computer" },
    });
    this.sandboxes.set(taskId, sandbox);
    return sandbox;
  }

  async execute(request: CapabilityRequest): Promise<CapabilityObservation> {
    const startedAt = new Date();
    const sandbox = await this.sandboxFor(request.taskId);

    try {
      let output = "";
      let evidence: string[] = [`sandbox:${sandbox.sandboxId}`];
      switch (request.capability) {
        case "shell.exec":
        case "process.start":
        case "package.install":
        case "git.operation": {
          const command = requireString(request.arguments, "command");
          const result = await sandbox.commands.run(command, { timeoutMs: 120_000 });
          output = commandOutput(result);
          evidence = [...evidence, `exit_code:${result.exitCode}`];
          return {
            outcome: result.exitCode === 0 ? "completed" : "failed",
            output: output || `Command finished with exit code ${result.exitCode}.`,
            evidence,
            adapterId: this.id,
            startedAt,
            completedAt: new Date(),
          };
        }
        case "filesystem.read": {
          const path = requireString(request.arguments, "path");
          output = await sandbox.files.read(path);
          evidence = [...evidence, `file_read:${path}`];
          break;
        }
        case "filesystem.write": {
          const path = requireString(request.arguments, "path");
          const content = requireString(request.arguments, "content");
          await sandbox.files.write(path, content);
          output = `Wrote ${content.length} bytes to ${path}.`;
          evidence = [...evidence, `file_written:${path}`];
          break;
        }
        case "filesystem.list": {
          const path = typeof request.arguments.path === "string" ? request.arguments.path : "/";
          output = JSON.stringify(await sandbox.files.list(path));
          evidence = [...evidence, `directory_listed:${path}`];
          break;
        }
        case "process.stop":
        case "artifact.pack":
        case "browser.navigate":
        case "browser.interact":
        case "secret.inject":
          throw new Error(`${request.capability} is not yet implemented by the E2B adapter.`);
        default:
          throw new Error(`Unsupported capability ${request.capability}.`);
      }

      return { outcome: "completed", output, evidence, adapterId: this.id, startedAt, completedAt: new Date() };
    } catch (error) {
      return {
        outcome: "failed",
        output: error instanceof Error ? error.message : "The sandbox adapter returned an unknown error.",
        evidence: [`sandbox:${sandbox.sandboxId}`, "adapter_error"],
        adapterId: this.id,
        startedAt,
        completedAt: new Date(),
      };
    }
  }

  async cancel(taskId: string) {
    const sandbox = this.sandboxes.get(taskId);
    if (!sandbox) return;
    try {
      await sandbox.kill();
    } finally {
      this.sandboxes.delete(taskId);
    }
  }
}
