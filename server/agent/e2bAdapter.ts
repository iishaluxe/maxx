import { randomUUID } from "node:crypto";
import { Sandbox } from "e2b";
import { storagePut } from "../storage";
import { callDataApi } from "../_core/dataApi";
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

// -----------------------------------------------------------------------
// search.query
//
// UNLIKE http.request and browser.navigate, this does NOT run inside the
// sandbox. It calls callDataApi() directly from the host (Aegis server
// process) -- the same process that already calls storagePut() for
// screenshot evidence. That's deliberate, not an inconsistency: Forge
// credentials (BUILT_IN_FORGE_API_URL/KEY) are a trusted, platform-level
// secret in the same class as DATABASE_URL -- they must never be written
// into the sandbox's filesystem or environment, since shell.exec runs
// arbitrary agent-directed commands in that same sandbox and could
// exfiltrate or misuse a credential that leaked into it. The sandbox
// still gets acquired via sandboxFor() before this runs (see execute()),
// for evidence consistency with every other capability, but its network
// access is never involved in the actual search call.
//
// NEEDS LIVE CONFIRMATION: the only confirmed Forge Data API precedent
// anywhere in this codebase is the "Youtube/search" example in
// server/_core/dataApi.ts's docstring. There is no documentation here of
// a general web-search apiId. "Google/search" below is a best guess
// following that Provider/action naming convention -- it has not been
// tested against a real Forge account (no network access in this
// authoring environment). If it's wrong, every search.query call will
// fail cleanly (a normal `failed` observation with Forge's real error
// message surfaced, not a crash) until this one constant is corrected.
// Test it live and fix this line if needed -- that's the only unverified
// piece of this capability.
const FORGE_SEARCH_API_ID = "Google/search";

type NormalizedSearchResult = { title: string; url: string; snippet: string };

// Defensive on purpose: the real response shape for FORGE_SEARCH_API_ID
// is unconfirmed (see above), so this tries several plausible shapes
// rather than assuming one. If none match, it falls back to returning
// the raw payload as text instead of throwing -- a search.query call
// should never crash just because the response parser's guess about the
// shape was wrong; the model can still work from raw JSON text.
function normalizeSearchResults(payload: unknown): { results: NormalizedSearchResult[]; raw?: string } {
  const candidates: unknown[] = [];
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["results", "items", "organic", "organic_results", "webPages"]) {
      const value = key === "webPages" ? (obj.webPages as Record<string, unknown> | undefined)?.value : obj[key];
      if (Array.isArray(value)) candidates.push(...value);
    }
  } else if (Array.isArray(payload)) {
    candidates.push(...payload);
  }

  const results: NormalizedSearchResult[] = [];
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title = [row.title, row.name, row.heading].find((v): v is string => typeof v === "string") || "";
    const url = [row.url, row.link, row.href].find((v): v is string => typeof v === "string") || "";
    const snippet = [row.snippet, row.description, row.summary].find((v): v is string => typeof v === "string") || "";
    if (url) results.push({ title, url, snippet });
  }

  if (results.length > 0) return { results };
  return { results: [], raw: JSON.stringify(payload).slice(0, 2000) };
}

async function queryForgeSearch(query: string): Promise<{ output: string; evidence: string[] }> {
  const payload = await callDataApi(FORGE_SEARCH_API_ID, { query: { q: query } });
  const normalized = normalizeSearchResults(payload);

  if (normalized.results.length === 0) {
    const output = normalized.raw
      ? `No structured results could be parsed from the search response. Raw response (truncated):\n${normalized.raw}`
      : "The search returned no results.";
    return { output, evidence: [`search_query:${query}`, `search_result_count:0`] };
  }

  const output = normalized.results
    .slice(0, 10)
    .map((r, i) => `${i + 1}. ${r.title || "(untitled)"}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
    .join("\n\n");

  return {
    output,
    evidence: [`search_query:${query}`, `search_result_count:${normalized.results.length}`],
  };
}

// -----------------------------------------------------------------------
// browser.navigate / browser.interact
//
// Both share ONE persistent browser session per task, not a fresh
// browser per call. That's a deliberate change from the first
// browser.navigate delivery (which launched and closed a browser inside
// a single one-shot script per call): a real interaction flow -- navigate
// to a page, fill a field, click submit -- needs the page to still be
// open and in the same state for step 2 as it was at the end of step 1.
// A stateless per-call browser would silently lose everything between
// calls, making browser.interact useless for anything but a single
// isolated action against a fresh page.
//
// The session lives as a small persistent HTTP server, started as an
// E2B background process (`commands.run(..., { background: true })`,
// confirmed against current docs.e2b.dev -- returns immediately, keeps
// running after the SDK call returns, killed automatically when the
// sandbox itself is killed). It owns one Playwright browser + page
// instance for the lifetime of the sandbox. Each navigate/interact call
// from the adapter is a lightweight HTTP request from a short-lived
// script to that already-running server on 127.0.0.1 -- not a new
// browser launch.
const BROWSER_SERVER_PORT = 39217;
const BROWSER_SERVER_SCRIPT_PATH = "/tmp/aegis_browser_server.js";
const BROWSER_CLIENT_SCRIPT_PATH = "/tmp/aegis_browser_client.js";
const BROWSER_SERVER_STARTUP_TIMEOUT_MS = 15_000;
const BROWSER_SERVER_STARTUP_POLL_MS = 500;

const BROWSER_SERVER_SCRIPT = `
const http = require("http");
const { chromium } = require("playwright");

let browserPromise = null;
let pagePromise = null;

async function getPage() {
  if (!browserPromise) browserPromise = chromium.launch();
  const browser = await browserPromise;
  if (!pagePromise) pagePromise = browser.newPage({ viewport: { width: 1280, height: 800 } });
  return pagePromise;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });

    if (req.method === "POST" && req.url === "/navigate") {
      const { url, timeoutMs } = JSON.parse(await readBody(req));
      const page = await getPage();
      let response = null;
      let navigationError = null;
      try {
        response = await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs || 30000 });
      } catch (err) {
        navigationError = err instanceof Error ? err.message : String(err);
      }
      const title = await page.title().catch(() => "");
      const textExcerpt = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
      return send(res, 200, {
        finalUrl: page.url(),
        title,
        status: response ? response.status() : null,
        textExcerpt: textExcerpt.slice(0, 2000),
        navigationError,
      });
    }

    if (req.method === "POST" && req.url === "/interact") {
      const { action, selector, value, timeoutMs } = JSON.parse(await readBody(req));
      const page = await getPage();
      const effectiveTimeout = timeoutMs || 10000;
      try {
        const locator = page.locator(selector).first();
        if (action === "click") await locator.click({ timeout: effectiveTimeout });
        else if (action === "type") await locator.fill(value !== undefined ? value : "", { timeout: effectiveTimeout });
        else if (action === "select") await locator.selectOption(value !== undefined ? value : "", { timeout: effectiveTimeout });
        else if (action === "check") await locator.check({ timeout: effectiveTimeout });
        else if (action === "uncheck") await locator.uncheck({ timeout: effectiveTimeout });
        else if (action === "hover") await locator.hover({ timeout: effectiveTimeout });
        else return send(res, 200, { ok: false, error: "Unsupported interaction \\"" + action + "\\". Use click, type, select, check, uncheck, or hover." });

        const title = await page.title().catch(() => "");
        return send(res, 200, { ok: true, finalUrl: page.url(), title });
      } catch (err) {
        return send(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === "GET" && req.url === "/screenshot") {
      const page = await getPage();
      const buffer = await page.screenshot();
      return send(res, 200, { screenshotBase64: buffer.toString("base64") });
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(${BROWSER_SERVER_PORT}, "127.0.0.1");
`;

// Tiny, reusable client: reads {method, path, body} from an args file
// (never argv -- same shell-injection reasoning as buildHttpRequestScript
// above) and relays it to the already-running server on localhost.
const BROWSER_CLIENT_SCRIPT = `
const fs = require("fs");
async function main() {
  const args = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const res = await fetch("http://127.0.0.1:${BROWSER_SERVER_PORT}" + args.path, {
    method: args.method,
    headers: { "content-type": "application/json" },
    body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
  });
  const json = await res.json();
  process.stdout.write(JSON.stringify(json));
}
main().catch(err => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
`;

type BrowserServerRequest = { method: "GET" | "POST"; path: string; body?: unknown };

type NavigateResult = {
  finalUrl: string;
  title: string;
  status: number | null;
  textExcerpt: string;
  navigationError: string | null;
};

type InteractResult = { ok: boolean; finalUrl?: string; title?: string; error?: string };

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

  // Installs Playwright + a Chromium binary, then starts the persistent
  // browser server, the first time a task calls browser.navigate or
  // browser.interact. Both steps are real, potentially slow (installing
  // can take 60-180s on cold start) network/process operations; cached
  // per taskId so they happen at most once per sandbox lifetime. See
  // INSTRUCTIONS.md for the operational assumptions this makes about the
  // sandbox's base image. The server is a background process
  // (commands.run(..., { background: true })) -- it keeps running after
  // this call returns, and is killed automatically when the sandbox
  // itself is killed (see cancel()); no separate process handle needs to
  // be tracked for cleanup.
  private async ensureBrowserRuntime(sandbox: Sandbox, taskId: string) {
    if (this.browserRuntimeReady.has(taskId)) return;

    const installResult = await sandbox.commands.run(
      "npm install --no-save --no-audit --no-fund playwright && npx --yes playwright install --with-deps chromium",
      { timeoutMs: BROWSER_INSTALL_TIMEOUT_MS }
    );
    if (installResult.exitCode !== 0) {
      throw new Error(
        `Could not install the browser runtime in the sandbox: ${commandOutput(installResult) || `exit code ${installResult.exitCode}`}`
      );
    }

    await sandbox.files.write(BROWSER_SERVER_SCRIPT_PATH, BROWSER_SERVER_SCRIPT);
    await sandbox.files.write(BROWSER_CLIENT_SCRIPT_PATH, BROWSER_CLIENT_SCRIPT);
    await sandbox.commands.run(`node ${BROWSER_SERVER_SCRIPT_PATH} > /tmp/aegis_browser_server.log 2>&1`, {
      background: true,
      timeoutMs: 0,
    });

    const deadline = Date.now() + BROWSER_SERVER_STARTUP_TIMEOUT_MS;
    let healthy = false;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const health = await this.callBrowserServer(sandbox, { method: "GET", path: "/health" });
        if ((health as { ok?: boolean }).ok) {
          healthy = true;
          break;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise(resolve => setTimeout(resolve, BROWSER_SERVER_STARTUP_POLL_MS));
    }
    if (!healthy) {
      const log = await sandbox.files.read("/tmp/aegis_browser_server.log").catch(() => "");
      throw new Error(
        `The browser server did not become ready within ${BROWSER_SERVER_STARTUP_TIMEOUT_MS}ms.${lastError ? ` Last error: ${lastError}.` : ""}${log ? ` Server log: ${log}` : ""}`
      );
    }

    this.browserRuntimeReady.add(taskId);
  }

  private async callBrowserServer(sandbox: Sandbox, request: BrowserServerRequest): Promise<unknown> {
    const argsPath = `/tmp/aegis_browser_client_${randomUUID()}.args.json`;
    await sandbox.files.write(argsPath, JSON.stringify(request));
    const result = await sandbox.commands.run(`node ${BROWSER_CLIENT_SCRIPT_PATH} ${argsPath}`, {
      timeoutMs: BROWSER_NAVIGATE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Browser server request failed: ${commandOutput(result) || `exit code ${result.exitCode}`}`);
    }
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      throw new Error(`Browser server returned an unparsable response: ${result.stdout.slice(0, 500)}`);
    }
  }

  private async captureScreenshotEvidence(sandbox: Sandbox, taskId: string): Promise<string> {
    const shot = (await this.callBrowserServer(sandbox, { method: "GET", path: "/screenshot" })) as {
      screenshotBase64?: string;
      error?: string;
    };
    if (!shot.screenshotBase64) {
      throw new Error(shot.error || "The browser server did not return a screenshot.");
    }
    const screenshotKey = `agent-computer/${taskId}/browser-evidence/${randomUUID()}.png`;
    const { url } = await storagePut(screenshotKey, Buffer.from(shot.screenshotBase64, "base64"), "image/png");
    return url;
  }

  private async navigate(sandbox: Sandbox, request: CapabilityRequest): Promise<{ output: string; evidence: string[] }> {
    const url = assertNavigableUrl(requireString(request.arguments, "url"));
    await this.ensureBrowserRuntime(sandbox, request.taskId);

    const parsed = (await this.callBrowserServer(sandbox, {
      method: "POST",
      path: "/navigate",
      body: { url: url.toString(), timeoutMs: BROWSER_PAGE_TIMEOUT_MS },
    })) as NavigateResult;

    if (parsed.navigationError) {
      throw new Error(`Navigation to ${url.toString()} did not complete: ${parsed.navigationError}`);
    }

    const screenshotUrl = await this.captureScreenshotEvidence(sandbox, request.taskId);

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

  private async interact(sandbox: Sandbox, request: CapabilityRequest): Promise<{ output: string; evidence: string[] }> {
    const selector = requireString(request.arguments, "selector");
    const action = requireString(request.arguments, "interaction").toLowerCase();
    const value = typeof request.arguments.value === "string" ? request.arguments.value : undefined;
    await this.ensureBrowserRuntime(sandbox, request.taskId);

    const result = (await this.callBrowserServer(sandbox, {
      method: "POST",
      path: "/interact",
      body: { action, selector, value, timeoutMs: BROWSER_PAGE_TIMEOUT_MS },
    })) as InteractResult;

    if (!result.ok) {
      throw new Error(result.error || `The "${action}" interaction on "${selector}" failed for an unknown reason.`);
    }

    const screenshotUrl = await this.captureScreenshotEvidence(sandbox, request.taskId);

    const output = [
      `Performed "${action}" on "${selector}".`,
      `Page is now at ${result.finalUrl} (${result.title || "no title"}).`,
    ].join("\n");

    return {
      output,
      evidence: [`interaction:${action}`, `selector:${selector}`, `final_url:${result.finalUrl}`, `screenshot:${screenshotUrl}`],
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
        case "browser.interact": {
          const interactResult = await this.interact(sandbox, request);
          output = interactResult.output;
          evidence = [...evidence, ...interactResult.evidence];
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
        case "search.query": {
          const query = requireString(request.arguments, "query");
          const searchResult = await queryForgeSearch(query);
          output = searchResult.output;
          evidence = [...evidence, ...searchResult.evidence];
          break;
        }
        case "process.stop":
        case "artifact.pack":
        case "secret.inject":
          throw new Error(`${request.capability} is not yet implemented by the E2B adapter.`);
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
