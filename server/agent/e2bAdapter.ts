import { randomUUID } from "node:crypto";
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

const ALLOWED_HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const HTTP_METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const HTTP_RESPONSE_BODY_LIMIT = 8000;
const HTTP_REQUEST_TIMEOUT_MS = 20_000;

type HttpScriptResult = {
  status?: number;
  contentType?: string;
  location?: string | null;
  body?: string;
  truncated?: boolean;
  error?: string;
};

/**
 * Builds a standalone CommonJS script (run inside the sandbox via `node`,
 * not evaluated on the host) that performs the actual outbound request.
 *
 * This has to run inside the sandbox, not on the host, for two reasons:
 * 1. Isolation — the host process is trusted infrastructure; agent-directed
 *    outbound requests must originate from the disposable, already-isolated
 *    sandbox, never from the platform's own network position.
 * 2. Correctness — the private/loopback/link-local check below resolves
 *    DNS and inspects the resolved address. That resolution has to happen
 *    in the same network namespace the request will actually be sent from.
 *    A host-side-only DNS check could pass while the sandbox's own
 *    resolution (different DNS, different routing) reaches something else.
 *
 * This is deliberately a *second*, independent layer on top of the
 * sandbox-level `network.denyOut` CIDR block already applied in
 * sandboxFor(): that layer is enforced by E2B itself and is immune to a
 * DNS-rebinding race between this check and the actual `fetch()` call
 * below (which re-resolves DNS itself); this in-script check exists so
 * the failure is attributed clearly to the request itself in evidence,
 * not just silently dropped at the network layer.
 *
 * `redirect: "manual"` is deliberate: auto-following redirects would let a
 * server respond 302 to a private address and bypass the check entirely.
 * The redirect target is reported as evidence instead of being followed.
 *
 * Values are embedded via JSON.stringify (valid JS string-literal syntax),
 * not string interpolation into a shell command, so there is no shell- or
 * script-injection path from an attacker-influenced url/body.
 */
function buildHttpRequestScript(input: { url: string; method: string; body?: string }): string {
  const includeBody = HTTP_METHODS_WITH_BODY.has(input.method) && input.body !== undefined;
  return `
"use strict";
const dns = require("node:dns").promises;

const TARGET_URL = ${JSON.stringify(input.url)};
const METHOD = ${JSON.stringify(input.method)};
const BODY = ${includeBody ? JSON.stringify(input.body) : "undefined"};
const RESPONSE_LIMIT = ${HTTP_RESPONSE_BODY_LIMIT};
const TIMEOUT_MS = ${HTTP_REQUEST_TIMEOUT_MS};

function isPrivateAddress(address, family) {
  if (family === 4 || (address.indexOf(":") === -1 && address.indexOf(".") !== -1)) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
    const a = parts[0], b = parts[1];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // includes cloud metadata (169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    return false;
  }
  const a = address.toLowerCase();
  if (a === "::1" || a === "::") return true;
  if (/^fe[89ab]/.test(a)) return true; // link-local fe80::/10
  if (a.startsWith("fc") || a.startsWith("fd")) return true; // unique local fc00::/7
  if (a.startsWith("::ffff:")) return isPrivateAddress(a.slice(7), 4);
  return false;
}

async function main() {
  let url;
  try {
    url = new URL(TARGET_URL);
  } catch {
    throw new Error("The url argument could not be parsed as a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are permitted.");
  }

  let resolved;
  try {
    resolved = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new Error("Could not resolve the target host: " + ((error && error.message) || error));
  }
  if (!resolved.length) throw new Error("The target host did not resolve to any address.");
  for (const entry of resolved) {
    if (isPrivateAddress(entry.address, entry.family)) {
      throw new Error("Refusing to request a private, loopback, or link-local address.");
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: METHOD, body: BODY, redirect: "manual", signal: controller.signal });
    const text = await response.text();
    process.stdout.write(JSON.stringify({
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      location: response.headers.get("location") || null,
      body: text.slice(0, RESPONSE_LIMIT),
      truncated: text.length > RESPONSE_LIMIT,
    }));
  } finally {
    clearTimeout(timer);
  }
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ error: (error && error.message) || String(error) }));
  process.exitCode = 1;
});
`.trim();
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
        case "http.request": {
          const url = requireString(request.arguments, "url");
          const method = typeof request.arguments.method === "string" ? request.arguments.method.toUpperCase() : "GET";
          if (!ALLOWED_HTTP_METHODS.has(method)) {
            throw new Error(`Unsupported HTTP method "${method}".`);
          }
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(url);
          } catch {
            throw new Error("The url argument could not be parsed as a valid URL.");
          }
          if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            throw new Error("Only http:// and https:// URLs are permitted for http.request.");
          }
          const body = typeof request.arguments.body === "string" ? request.arguments.body : undefined;

          const scriptPath = `/tmp/aegis-http-${randomUUID()}.cjs`;
          await sandbox.files.write(scriptPath, buildHttpRequestScript({ url, method, body }));
          const result = await sandbox.commands.run(`node ${scriptPath}`, { timeoutMs: HTTP_REQUEST_TIMEOUT_MS + 5_000 });

          let parsed: HttpScriptResult | null = null;
          try {
            parsed = JSON.parse(result.stdout.trim()) as HttpScriptResult;
          } catch {
            parsed = null;
          }

          evidence = [...evidence, `http_url:${url}`, `http_method:${method}`];
          if (!parsed || parsed.error) {
            return {
              outcome: "failed",
              output: parsed?.error || commandOutput(result) || "The http.request script produced no parsable output.",
              evidence,
              adapterId: this.id,
              startedAt,
              completedAt: new Date(),
            };
          }

          evidence = [...evidence, `http_status:${parsed.status}`];
          if (parsed.location) evidence = [...evidence, `http_redirect_location:${parsed.location}`];

          const summaryLines = [
            `HTTP ${parsed.status} (${parsed.contentType || "unknown content type"})`,
            parsed.location ? `Response was a redirect to ${parsed.location} — not followed automatically.` : "",
            parsed.truncated ? `Response body truncated to ${HTTP_RESPONSE_BODY_LIMIT} characters.` : "",
            "",
            parsed.body || "",
          ].filter(line => line !== "").join("\n").trim();

          return {
            outcome: "completed",
            output: summaryLines,
            evidence,
            adapterId: this.id,
            startedAt,
            completedAt: new Date(),
          };
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
