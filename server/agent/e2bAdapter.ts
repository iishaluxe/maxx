import { Sandbox } from "e2b";
import { nanoid } from "nanoid";
import { storagePut } from "../storage";
import type { CapabilityObservation, CapabilityRequest, ExecutionAdapter } from "./execution";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const BROWSER_INSTALL_TIMEOUT_MS = 3 * 60 * 1000;
const BROWSER_NAVIGATE_TIMEOUT_MS = 45_000;
const BROWSER_PAGE_TIMEOUT_MS = 30_000;

// Ranges a sandbox should never be able to reach directly, even once it has
// real internet access for browsing: RFC1918 private space, loopback,
// link-local (this also covers the common cloud-metadata endpoint at
// 169.254.169.254), CGNAT, and their IPv6 equivalents. Enforced at the
// network layer by E2B (see sandboxFor), not just checked in application
// code, so it can't be bypassed by a redirect or DNS trick after the fact.
const BLOCKED_EGRESS_CIDRS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

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

function assertNavigableUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http/https URLs can be navigated to (got "${parsed.protocol}").`);
  }
  return parsed;
}

// Runs inside the sandbox via `node <script> <argsFile>`. Arguments are read
// from a JSON file rather than argv/env so a URL containing quotes or shell
// metacharacters can never be interpreted by the shell that invokes it.
const NAVIGATE_SCRIPT = `
const fs = require("fs");
const { chromium } = require("playwright");

async function main() {
  const args = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    let response = null;
    let navigationError = null;
    try {
      response = await page.goto(args.url, { waitUntil: "networkidle", timeout: args.timeoutMs });
    } catch (err) {
      navigationError = err instanceof Error ? err.message : String(err);
    }
    const title = await page.title().catch(() => "");
    const finalUrl = page.url();
    const textExcerpt = await page
      .evaluate(() => (document.body ? document.body.innerText : ""))
      .catch(() => "");
    await page.screenshot({ path: args.screenshotPath }).catch(() => {});
    process.stdout.write(JSON.stringify({
      finalUrl,
      title,
      status: response ? response.status() : null,
      textExcerpt: textExcerpt.slice(0, 2000),
      navigationError,
    }));
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  process.stderr.write(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
`;

type NavigateResult = {
  finalUrl: string;
  title: string;
  status: number | null;
  textExcerpt: string;
  navigationError: string | null;
};

export class E2BCloudSandboxAdapter implements ExecutionAdapter {
  readonly id = "e2b-cloud-sandbox";
  readonly target = "cloud_sandbox" as const;
  private readonly sandboxes = new Map<string, Sandbox>();
  private readonly browserRuntimeReady = new Set<string>();

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
      network: { denyOut: BLOCKED_EGRESS_CIDRS },
      metadata: { aegisTaskId: taskId, runtime: "aegis-computer" },
    });
    this.sandboxes.set(taskId, sandbox);
    return sandbox;
  }

  // Installs Playwright + a Chromium binary the first time a task calls
  // browser.navigate. This is a real, potentially slow (60-180s) network
  // operation on cold start; cached per taskId so it happens at most once
  // per sandbox lifetime. See INSTRUCTIONS.md for the operational
  // assumptions this makes about the sandbox's base image.
  private async ensureBrowserRuntime(sandbox: Sandbox, taskId: string) {
    if (this.browserRuntimeReady.has(taskId)) return;
    const result = await sandbox.commands.run(
      "npm install --no-save --no-audit --no-fund playwright && npx --yes playwright install --with-deps chromium",
      { timeoutMs: BROWSER_INSTALL_TIMEOUT_MS }
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not install the browser runtime in the sandbox: ${commandOutput(result) || `exit code ${result.exitCode}`}`
      );
    }
    this.browserRuntimeReady.add(taskId);
  }

  private async navigate(sandbox: Sandbox, request: CapabilityRequest): Promise<{ output: string; evidence: string[] }> {
    const url = assertNavigableUrl(requireString(request.arguments, "url"));
    await this.ensureBrowserRuntime(sandbox, request.taskId);

    const runId = nanoid();
    const scriptPath = `/tmp/aegis_navigate_${runId}.js`;
    const argsPath = `/tmp/aegis_navigate_${runId}.args.json`;
    const screenshotPath = `/tmp/aegis_navigate_${runId}.png`;

    await sandbox.files.write(scriptPath, NAVIGATE_SCRIPT);
    await sandbox.files.write(
      argsPath,
      JSON.stringify({ url: url.toString(), screenshotPath, timeoutMs: BROWSER_PAGE_TIMEOUT_MS })
    );

    const result = await sandbox.commands.run(`node ${scriptPath} ${argsPath}`, {
      timeoutMs: BROWSER_NAVIGATE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Browser navigation failed: ${commandOutput(result) || `exit code ${result.exitCode}`}`);
    }

    let parsed: NavigateResult;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error(`Browser navigation returned an unexpected result: ${result.stdout.slice(0, 500)}`);
    }

    if (parsed.navigationError) {
      throw new Error(`Navigation to ${url.toString()} did not complete: ${parsed.navigationError}`);
    }

    const screenshotBytes = await sandbox.files.read(screenshotPath, { format: "bytes" });
    const screenshotKey = `agent-computer/${request.taskId}/browser-evidence/${runId}.png`;
    const { url: screenshotUrl } = await storagePut(screenshotKey, screenshotBytes, "image/png");

    const output = [
      `Navigated to ${parsed.finalUrl} (status ${parsed.status ?? "unknown"}).`,
      `Title: ${parsed.title || "(none)"}`,
      parsed.textExcerpt ? `Page text (excerpt): ${parsed.textExcerpt.slice(0, 500)}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      output,
      evidence: [`final_url:${parsed.finalUrl}`, `http_status:${parsed.status ?? "unknown"}`, `screenshot:${screenshotUrl}`],
    };
  }

  async execute(request: CapabilityRequest): Promise<CapabilityObservation> {
    const startedAt = new Date();
    let sandbox: Sandbox | undefined;

    try {
      sandbox = await this.sandboxFor(request.taskId);
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
        case "browser.navigate": {
          const navResult = await this.navigate(sandbox, request);
          output = navResult.output;
          evidence = [...evidence, ...navResult.evidence];
          break;
        }
        case "process.stop":
        case "artifact.pack":
        case "secret.inject":
          throw new Error(`${request.capability} is not yet implemented by the E2B adapter.`);
        case "browser.interact":
          throw new Error(
            "browser.interact is not implemented: CapabilityArguments (server/agent/modelGateway.ts) has no field for a target selector, interaction type, or value -- only command/path/content/url/notes, and the structured-output schema forbids extra fields. Extend that schema and the selectCapabilityArguments prompt before wiring this case."
          );
        default:
          throw new Error(`Unsupported capability ${request.capability}.`);
      }

      return { outcome: "completed", output, evidence, adapterId: this.id, startedAt, completedAt: new Date() };
    } catch (error) {
      // sandbox may be undefined here if sandboxFor() itself is what threw
      // (missing/invalid credential, E2B API error, etc.) -- that must still
      // produce a clean failed observation, not an uncaught throw, since
      // nothing upstream (CapabilityBroker.dispatch, AgentLoop.run) wraps
      // this call in its own try/catch.
      return {
        outcome: "failed",
        output: error instanceof Error ? error.message : "The sandbox adapter returned an unknown error.",
        evidence: sandbox ? [`sandbox:${sandbox.sandboxId}`, "adapter_error"] : ["adapter_error"],
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
      this.browserRuntimeReady.delete(taskId);
    }
  }
}
