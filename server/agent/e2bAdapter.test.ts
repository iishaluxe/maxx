import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityRequest } from "./execution";

type CommandResult = { stdout: string; stderr: string; exitCode: number };

const state = vi.hoisted(() => ({
  commandCalls: [] as Array<{ command: string; opts?: unknown }>,
  fileWrites: [] as Array<{ path: string; data: string }>,
  storagePutCalls: [] as Array<{ key: string; contentType: string }>,
  sandboxCreateOpts: [] as Array<Record<string, unknown>>,
  commandResponder: (_command: string): CommandResult => ({ stdout: "", stderr: "", exitCode: 0 }),
  fileReadResponder: (_path: string): Uint8Array => new Uint8Array([1, 2, 3, 4]),
  dataApiCalls: [] as Array<{ apiId: string; query?: Record<string, unknown> }>,
  dataApiResponder: (_apiId: string, _query?: Record<string, unknown>): unknown => ({ results: [] }),
  // browser.navigate/browser.interact both talk to a persistent in-sandbox
  // server via a tiny client script; the mock inspects the args file each
  // client-script command references to figure out which endpoint
  // (/health, /navigate, /interact, /screenshot) is being called, and
  // hands off to this responder. browserServerCalls is recorded
  // automatically (not by the test's own responder) so tests can assert
  // on which endpoints were actually hit regardless of what they return.
  browserServerCalls: [] as Array<{ path: string; body: unknown }>,
  browserServerResponder: (path: string, _body: unknown): unknown => {
    if (path === "/health") return { ok: true };
    if (path === "/screenshot") return { screenshotBase64: Buffer.from([1, 2, 3, 4]).toString("base64") };
    return { ok: true };
  },
}));

// Fakes the `e2b` SDK entirely -- no real sandbox and no real credential
// reach the network. `sandboxFor()` still checks that *some* value is
// present in `E2B_API_KEY` before ever calling the (mocked) `Sandbox.create`,
// so a fake value is stubbed in below purely to satisfy that check -- it is
// never used to authenticate anything real.
// This is a real-execution test of the adapter's own control flow (argument
// validation, install/server-startup caching, error surfacing, evidence
// assembly), not a test of Playwright/Chromium actually working inside a
// live sandbox -- that can only be verified with a real E2B_API_KEY, which
// CI doesn't have.
vi.mock("e2b", () => ({
  Sandbox: {
    create: async (opts: Record<string, unknown>) => {
      state.sandboxCreateOpts.push(opts);
      return {
        sandboxId: "fake-sandbox",
        commands: {
          run: async (command: string, runOpts?: unknown) => {
            state.commandCalls.push({ command, opts: runOpts });

            // Client-script calls look like: node <CLIENT_PATH> <argsPath>.
            // The args file (written just before this command runs) carries
            // {method, path, body} -- that's where the real request lives,
            // not in the command string, which never contains anything
            // derived from a url/selector/value at all.
            if (command.startsWith("node ") && command.includes("aegis_browser_client")) {
              const argsPath = command.trim().split(" ")[2];
              const write = [...state.fileWrites].reverse().find(w => w.path === argsPath);
              const args = write ? (JSON.parse(write.data) as { path: string; body?: unknown }) : { path: "", body: undefined };
              state.browserServerCalls.push({ path: args.path, body: args.body });
              const responseBody = state.browserServerResponder(args.path, args.body);
              return { stdout: JSON.stringify(responseBody), stderr: "", exitCode: 0 };
            }

            return state.commandResponder(command);
          },
        },
        files: {
          write: async (path: string, data: string) => {
            state.fileWrites.push({ path, data });
          },
          read: async (path: string) => state.fileReadResponder(path),
          list: async () => [],
        },
        kill: async () => {},
      };
    },
  },
}));

vi.mock("../_core/dataApi", () => ({
  callDataApi: async (apiId: string, options: { query?: Record<string, unknown> }) => {
    state.dataApiCalls.push({ apiId, query: options.query });
    return state.dataApiResponder(apiId, options.query);
  },
}));

vi.mock("../storage", () => ({
  storagePut: async (key: string, _data: Uint8Array | string, contentType: string) => {
    state.storagePutCalls.push({ key, contentType });
    return { key, url: `/manus-storage/${key}` };
  },
}));

import { E2BCloudSandboxAdapter } from "./e2bAdapter";

function baseRequest(overrides: Partial<CapabilityRequest>): CapabilityRequest {
  return {
    taskId: "task-1",
    capability: "browser.navigate",
    target: "cloud_sandbox",
    action: "Navigate",
    arguments: { url: "https://example.com" },
    ...overrides,
  };
}

function successfulInstall(): CommandResult {
  return { stdout: "chromium installed", stderr: "", exitCode: 0 };
}

beforeEach(() => {
  // sandboxFor() throws before ever touching the (mocked) Sandbox.create if
  // this isn't set -- unrelated to whether a real E2B account exists.
  vi.stubEnv("E2B_API_KEY", "test-key-for-mocked-adapter");
  state.commandCalls = [];
  state.fileWrites = [];
  state.storagePutCalls = [];
  state.sandboxCreateOpts = [];
  state.commandResponder = () => ({ stdout: "", stderr: "", exitCode: 0 });
  state.fileReadResponder = () => new Uint8Array([1, 2, 3, 4]);
  state.dataApiCalls = [];
  state.dataApiResponder = () => ({ results: [] });
  state.browserServerCalls = [];
  state.browserServerResponder = path => {
    if (path === "/health") return { ok: true };
    if (path === "/screenshot") return { screenshotBase64: Buffer.from([1, 2, 3, 4]).toString("base64") };
    return { ok: true };
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("E2BCloudSandboxAdapter browser.navigate", () => {
  function navigateResponder(overrides: Partial<{ finalUrl: string; title: string; status: number | null; textExcerpt: string; navigationError: string | null }> = {}) {
    return (path: string) => {
      if (path === "/navigate") {
        return {
          finalUrl: "https://example.com/",
          title: "Example Domain",
          status: 200,
          textExcerpt: "Example Domain text",
          navigationError: null,
          ...overrides,
        };
      }
      if (path === "/health") return { ok: true };
      if (path === "/screenshot") return { screenshotBase64: Buffer.from([1, 2, 3, 4]).toString("base64") };
      return { ok: true };
    };
  }

  it("succeeds end to end and returns evidence with a screenshot URL", async () => {
    state.commandResponder = command => (command.includes("playwright install") ? successfulInstall() : { stdout: "", stderr: "", exitCode: 0 });
    state.browserServerResponder = navigateResponder();

    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(baseRequest({}));

    expect(obs.outcome).toBe("completed");
    expect(obs.output).toContain("Navigated to https://example.com/");
    expect(obs.output).toContain("Example Domain");
    expect(obs.evidence.some(e => e.kind === "screenshot" && e.value.startsWith("/manus-storage/agent-computer/task-1/browser-evidence/"))).toBe(true);
    expect(state.storagePutCalls).toHaveLength(1);
    expect(state.storagePutCalls[0].contentType).toBe("image/png");
  });

  it("starts the persistent browser server as a background process, once, and waits for it to report healthy", async () => {
    state.commandResponder = command => (command.includes("playwright install") ? successfulInstall() : { stdout: "", stderr: "", exitCode: 0 });
    state.browserServerResponder = navigateResponder();

    const adapter = new E2BCloudSandboxAdapter();
    await adapter.execute(baseRequest({ taskId: "task-1b" }));

    const serverStart = state.commandCalls.find(c => c.command.includes("aegis_browser_server.js") && c.command.startsWith("node"));
    expect(serverStart).toBeTruthy();
    expect((serverStart!.opts as { background?: boolean })?.background).toBe(true);

    const healthChecks = state.browserServerCalls.filter(c => c.path === "/health");
    expect(healthChecks.length).toBeGreaterThanOrEqual(1);
  });

  it("creates the sandbox with a private-range denylist instead of the old blanket allowInternetAccess flag", async () => {
    state.commandResponder = command => (command.includes("playwright install") ? successfulInstall() : { stdout: "", stderr: "", exitCode: 0 });
    state.browserServerResponder = navigateResponder();
    const adapter = new E2BCloudSandboxAdapter();

    await adapter.execute(baseRequest({ taskId: "task-2" }));

    const opts = state.sandboxCreateOpts[0] as { allowInternetAccess?: boolean; network?: { denyOut?: string[] } };
    expect(opts.allowInternetAccess).toBeUndefined();
    expect(opts.network?.denyOut).toEqual(expect.arrayContaining(["10.0.0.0/8", "169.254.0.0/16", "127.0.0.0/8"]));
  });

  it("fails cleanly when url is missing, without touching the sandbox", async () => {
    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(baseRequest({ taskId: "task-3", arguments: {} }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("url is required");
    expect(state.commandCalls).toHaveLength(0);
  });

  it("rejects a non-http(s) scheme without running any sandbox command", async () => {
    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(baseRequest({ taskId: "task-4", arguments: { url: "file:///etc/passwd" } }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("Only http/https URLs");
    expect(state.commandCalls).toHaveLength(0);
  });

  it("surfaces the sandbox's own install error instead of a generic message", async () => {
    state.commandResponder = command =>
      command.includes("playwright install")
        ? { stdout: "", stderr: "E: Unable to locate package libnss3", exitCode: 100 }
        : { stdout: "", stderr: "", exitCode: 0 };

    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(baseRequest({ taskId: "task-5" }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("libnss3");
  });

  it("times out with a diagnosable message if the server never reports healthy", async () => {
    state.commandResponder = command => (command.includes("playwright install") ? successfulInstall() : { stdout: "", stderr: "", exitCode: 0 });
    state.browserServerResponder = path => (path === "/health" ? { ok: false } : { ok: true });
    state.fileReadResponder = path => (path.endsWith(".log") ? new TextEncoder().encode("Error: listen EADDRINUSE") : new Uint8Array());

    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(baseRequest({ taskId: "task-5b" }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("did not become ready");
  }, 20_000);

  it("only installs the browser runtime and starts the server once per task across multiple navigate calls", async () => {
    state.commandResponder = command => (command.includes("playwright install") ? successfulInstall() : { stdout: "", stderr: "", exitCode: 0 });
    state.browserServerResponder = navigateResponder();
    const adapter = new E2BCloudSandboxAdapter();

    await adapter.execute(baseRequest({ taskId: "task-6" }));
    await adapter.execute(baseRequest({ taskId: "task-6", arguments: { url: "https://example.org" } }));

    const installCalls = state.commandCalls.filter(c => c.command.includes("playwright install"));
    expect(installCalls).toHaveLength(1);
    const serverStarts = state.commandCalls.filter(c => c.command.includes("aegis_browser_server.js") && c.command.startsWith("node"));
    expect(serverStarts).toHaveLength(1);
  });

  it("reports a page navigation error as failed and skips the screenshot capture entirely", async () => {
    state.commandResponder = command => (command.includes("playwright install") ? successfulInstall() : { stdout: "", stderr: "", exitCode: 0 });
    state.browserServerResponder = navigateResponder({
      finalUrl: "https://unreachable.example/",
      title: "",
      status: null,
      textExcerpt: "",
      navigationError: "net::ERR_NAME_NOT_RESOLVED",
    });

    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(baseRequest({ taskId: "task-7", arguments: { url: "https://unreachable.example" } }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("ERR_NAME_NOT_RESOLVED");
    expect(state.storagePutCalls).toHaveLength(0);
    expect(state.browserServerCalls.some(c => c.path === "/screenshot")).toBe(false);
  });

  it("leaves shell.exec behavior unchanged (regression check)", async () => {
    state.commandResponder = () => ({ stdout: "hello", stderr: "", exitCode: 0 });
    const adapter = new E2BCloudSandboxAdapter();

    const obs = await adapter.execute(baseRequest({ taskId: "task-9", capability: "shell.exec", arguments: { command: "echo hello" } }));

    expect(obs.outcome).toBe("completed");
    expect(obs.output).toBe("hello");
  });

  it("never puts the url anywhere in the shell command string it runs, not even encoded", async () => {
    state.commandResponder = command => (command.includes("playwright install") ? successfulInstall() : { stdout: "", stderr: "", exitCode: 0 });
    state.browserServerResponder = navigateResponder();
    const adapter = new E2BCloudSandboxAdapter();
    const trickyUrl = 'https://example.com/?q=$(rm -rf /)"; touch pwned';

    await adapter.execute(baseRequest({ taskId: "task-10", arguments: { url: trickyUrl } }));

    const clientCommands = state.commandCalls.filter(c => c.command.includes("aegis_browser_client"));
    expect(clientCommands.length).toBeGreaterThan(0);
    for (const c of clientCommands) {
      expect(c.command).not.toContain("rm -rf");
      expect(c.command).not.toContain("example.com");
    }

    const navigateArgsWrite = [...state.fileWrites].reverse().find(w => {
      try {
        return JSON.parse(w.data).path === "/navigate";
      } catch {
        return false;
      }
    });
    expect(navigateArgsWrite).toBeTruthy();
    // The URL constructor percent-encodes spaces/quotes on the way in, so
    // the dangerous substring survives only in encoded form in the args
    // file -- never in a command string, and it's the correct, extra-safe
    // outcome either way.
    const navigateBody = JSON.parse(navigateArgsWrite!.data).body as { url: string };
    expect(navigateBody.url).toContain("rm%20-rf");
  });

  it("returns a failed observation instead of throwing when sandbox creation itself fails", async () => {
    // Regression check for a real pre-existing bug found in an earlier
    // round: sandboxFor() used to be called outside execute()'s try/catch,
    // so any failure here (bad credential, an E2B API error, anything)
    // propagated as an uncaught throw instead of a clean failed
    // observation -- and nothing upstream (CapabilityBroker.dispatch,
    // AgentLoop's run loop) catches it either.
    vi.stubEnv("E2B_API_KEY", "");
    const adapter = new E2BCloudSandboxAdapter();

    const obs = await adapter.execute(baseRequest({ taskId: "task-11" }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("E2B_API_KEY is not configured");
    expect(state.sandboxCreateOpts).toHaveLength(0);
  });
});

describe("E2BCloudSandboxAdapter browser.interact", () => {
  function interactRequest(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
    return baseRequest({
      capability: "browser.interact",
      arguments: { selector: "#submit", interaction: "click" },
      ...overrides,
    });
  }

  it("performs the interaction against the already-open page and returns evidence with a screenshot", async () => {
    state.commandResponder = command => (command.includes("playwright install") ? successfulInstall() : { stdout: "", stderr: "", exitCode: 0 });
    state.browserServerResponder = path => {
      if (path === "/interact") return { ok: true, finalUrl: "https://example.com/thanks", title: "Thanks" };
      if (path === "/screenshot") return { screenshotBase64: Buffer.from([1, 2, 3, 4]).toString("base64") };
      return { ok: true };
    };

    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(interactRequest({ taskId: "task-28" }));

    expect(obs.outcome).toBe("completed");
    expect(obs.output).toContain('Performed "click" on "#submit"');
    expect(obs.output).toContain("https://example.com/thanks");
    expect(obs.evidence).toContainEqual({ kind: "interaction", value: "click" });
    expect(obs.evidence).toContainEqual({ kind: "selector", value: "#submit" });
    expect(obs.evidence.some(e => e.kind === "screenshot")).toBe(true);
    expect(state.storagePutCalls).toHaveLength(1);
  });

  it("shares the same browser runtime install/server-startup caching as browser.navigate on the same task", async () => {
    state.commandResponder = command => (command.includes("playwright install") ? successfulInstall() : { stdout: "", stderr: "", exitCode: 0 });
    state.browserServerResponder = path => {
      if (path === "/navigate") return { finalUrl: "https://example.com/", title: "Example", status: 200, textExcerpt: "", navigationError: null };
      if (path === "/interact") return { ok: true, finalUrl: "https://example.com/", title: "Example" };
      if (path === "/screenshot") return { screenshotBase64: Buffer.from([1]).toString("base64") };
      return { ok: true };
    };
    const adapter = new E2BCloudSandboxAdapter();

    await adapter.execute(baseRequest({ taskId: "task-29", capability: "browser.navigate", arguments: { url: "https://example.com" } }));
    await adapter.execute(interactRequest({ taskId: "task-29" }));

    const installCalls = state.commandCalls.filter(c => c.command.includes("playwright install"));
    expect(installCalls).toHaveLength(1);
    const serverStarts = state.commandCalls.filter(c => c.command.includes("aegis_browser_server.js") && c.command.startsWith("node"));
    expect(serverStarts).toHaveLength(1);
  });

  it("fails cleanly when selector is missing", async () => {
    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(interactRequest({ taskId: "task-30", arguments: { interaction: "click" } }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("selector is required");
    expect(state.commandCalls).toHaveLength(0);
  });

  it("fails cleanly when interaction is missing", async () => {
    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(interactRequest({ taskId: "task-31", arguments: { selector: "#submit" } }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("interaction is required");
    expect(state.commandCalls).toHaveLength(0);
  });

  it("passes the value through for a type interaction", async () => {
    state.commandResponder = command => (command.includes("playwright install") ? successfulInstall() : { stdout: "", stderr: "", exitCode: 0 });
    state.browserServerResponder = path => {
      if (path === "/interact") return { ok: true, finalUrl: "https://example.com/", title: "Example" };
      if (path === "/screenshot") return { screenshotBase64: Buffer.from([1]).toString("base64") };
      return { ok: true };
    };
    const adapter = new E2BCloudSandboxAdapter();

    await adapter.execute(interactRequest({ taskId: "task-32", arguments: { selector: "#email", interaction: "type", value: "user@example.com" } }));

    const interactCall = state.browserServerCalls.find(c => c.path === "/interact");
    expect(interactCall).toBeTruthy();
    expect((interactCall!.body as { value?: string }).value).toBe("user@example.com");
  });

  it("surfaces the in-sandbox interaction error as a failed observation (e.g. selector not found)", async () => {
    state.commandResponder = command => (command.includes("playwright install") ? successfulInstall() : { stdout: "", stderr: "", exitCode: 0 });
    state.browserServerResponder = path => (path === "/interact" ? { ok: false, error: "Timeout 10000ms exceeded waiting for selector \"#missing\"" } : { ok: true });

    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(interactRequest({ taskId: "task-33", arguments: { selector: "#missing", interaction: "click" } }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("#missing");
    expect(state.storagePutCalls).toHaveLength(0);
  });

  it("requires approval by policy (approvalSensitive), unlike browser.navigate", async () => {
    // Not exercised through the adapter (policy enforcement happens in
    // policy.ts/the router, upstream of the adapter) -- this just pins
    // down the registry fact the rest of this capability's safety
    // argument depends on, so a future change to registry.ts that
    // silently drops this flag gets caught here too.
    const { capabilityRegistry } = await import("./registry");
    const entry = capabilityRegistry.find(c => c.name === "browser.interact");
    expect(entry?.approvalSensitive).toBe(true);
  });
});

describe("E2BCloudSandboxAdapter http.request", () => {
  function httpRequest(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
    return baseRequest({ capability: "http.request", arguments: { url: "https://example.com" }, ...overrides });
  }

  it("uses the same private-range denylist as every other capability (no per-capability network config)", async () => {
    state.commandResponder = () => ({
      stdout: JSON.stringify({ status: 200, contentType: "text/plain", location: null, body: "hello", truncated: false }),
      stderr: "",
      exitCode: 0,
    });
    const adapter = new E2BCloudSandboxAdapter();

    await adapter.execute(httpRequest({ taskId: "task-12" }));

    const opts = state.sandboxCreateOpts[0] as { allowInternetAccess?: boolean; network?: { denyOut?: string[] } };
    expect(opts.allowInternetAccess).toBeUndefined();
    expect(opts.network?.denyOut).toEqual(expect.arrayContaining(["10.0.0.0/8", "169.254.0.0/16"]));
  });

  it("rejects an unparseable url before touching the sandbox", async () => {
    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(httpRequest({ taskId: "task-13", arguments: { url: "not a url" } }));

    expect(obs.outcome).toBe("failed");
    expect(state.commandCalls).toHaveLength(0);
  });

  it("rejects a non-http(s) scheme before touching the sandbox", async () => {
    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(httpRequest({ taskId: "task-14", arguments: { url: "file:///etc/passwd" } }));

    expect(obs.outcome).toBe("failed");
    expect(state.commandCalls).toHaveLength(0);
  });

  it("rejects an unsupported HTTP method before touching the sandbox", async () => {
    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(httpRequest({ taskId: "task-15", arguments: { url: "https://example.com", method: "TRACE" } }));

    expect(obs.outcome).toBe("failed");
    expect(state.commandCalls).toHaveLength(0);
  });

  it("runs a generated script in the sandbox and reports a completed observation", async () => {
    state.commandResponder = () => ({
      stdout: JSON.stringify({ status: 200, contentType: "text/plain", location: null, body: "hello", truncated: false }),
      stderr: "",
      exitCode: 0,
    });
    const adapter = new E2BCloudSandboxAdapter();

    const obs = await adapter.execute(httpRequest({ taskId: "task-16", arguments: { url: "https://example.com/data" } }));

    expect(obs.outcome).toBe("completed");
    expect(obs.evidence).toContainEqual({ kind: "http_status", value: "200" });
    expect(obs.evidence).toContainEqual({ kind: "http_url", value: "https://example.com/data" });
    expect(obs.output).toContain("hello");

    const scriptCommand = state.commandCalls.find(c => c.command.startsWith("node "));
    expect(scriptCommand?.command).toMatch(/^node \/tmp\/aegis-http-.*\.cjs$/);

    const scriptWrite = state.fileWrites.find(w => w.path.endsWith(".cjs"));
    expect(scriptWrite).toBeTruthy();
    expect(scriptWrite!.data).toContain('redirect: "manual"');
    expect(scriptWrite!.data).toContain("https://example.com/data");
  });

  it("does not embed a body for GET even if one is supplied", async () => {
    state.commandResponder = () => ({
      stdout: JSON.stringify({ status: 200, contentType: "text/plain", location: null, body: "", truncated: false }),
      stderr: "",
      exitCode: 0,
    });
    const adapter = new E2BCloudSandboxAdapter();

    await adapter.execute(httpRequest({ taskId: "task-17", arguments: { url: "https://example.com", method: "GET", body: "ignored" } }));

    const scriptWrite = state.fileWrites.find(w => w.path.endsWith(".cjs"));
    expect(scriptWrite!.data).toContain("const BODY = undefined;");
  });

  it("embeds a body for POST", async () => {
    state.commandResponder = () => ({
      stdout: JSON.stringify({ status: 201, contentType: "application/json", location: null, body: "{}", truncated: false }),
      stderr: "",
      exitCode: 0,
    });
    const adapter = new E2BCloudSandboxAdapter();

    await adapter.execute(httpRequest({ taskId: "task-18", arguments: { url: "https://example.com/items", method: "POST", body: '{"name":"a"}' } }));

    const scriptWrite = state.fileWrites.find(w => w.path.endsWith(".cjs"));
    expect(scriptWrite!.data).toContain(JSON.stringify('{"name":"a"}'));
  });

  it("reports the redirect target as evidence instead of following it", async () => {
    state.commandResponder = () => ({
      stdout: JSON.stringify({ status: 302, contentType: "", location: "https://example.com/next", body: "", truncated: false }),
      stderr: "",
      exitCode: 0,
    });
    const adapter = new E2BCloudSandboxAdapter();

    const obs = await adapter.execute(httpRequest({ taskId: "task-19", arguments: { url: "https://example.com/start" } }));

    expect(obs.outcome).toBe("completed");
    expect(obs.evidence).toContainEqual({ kind: "http_redirect_location", value: "https://example.com/next" });
    expect(obs.output).toContain("not followed automatically");
  });

  it("surfaces an in-sandbox safety rejection (e.g. a private address) as a failed observation", async () => {
    state.commandResponder = () => ({
      stdout: JSON.stringify({ error: "Refusing to request a private, loopback, or link-local address." }),
      stderr: "",
      exitCode: 1,
    });
    const adapter = new E2BCloudSandboxAdapter();

    const obs = await adapter.execute(httpRequest({ taskId: "task-20", arguments: { url: "http://169.254.169.254/latest/meta-data" } }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("private, loopback, or link-local");
  });

  it("falls back to raw command output when the script produces no parsable JSON", async () => {
    state.commandResponder = () => ({ stdout: "not json", stderr: "some stderr", exitCode: 1 });
    const adapter = new E2BCloudSandboxAdapter();

    const obs = await adapter.execute(httpRequest({ taskId: "task-21" }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("not json");
  });
});

describe("E2BCloudSandboxAdapter search.query", () => {
  function searchRequest(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
    return baseRequest({ capability: "search.query", arguments: { query: "aegis computer platform" }, ...overrides });
  }

  it("calls Forge's data API with the query and returns normalized results", async () => {
    state.dataApiResponder = () => ({
      results: [
        { title: "Aegis Computer", url: "https://example.com/aegis", snippet: "An autonomous agent platform." },
        { title: "Aegis docs", url: "https://example.com/aegis/docs", snippet: "Documentation." },
      ],
    });
    const adapter = new E2BCloudSandboxAdapter();

    const obs = await adapter.execute(searchRequest({ taskId: "task-22" }));

    expect(obs.outcome).toBe("completed");
    expect(obs.evidence).toContainEqual({ kind: "search_query", value: "aegis computer platform" });
    expect(obs.evidence).toContainEqual({ kind: "search_result_count", value: "2" });
    expect(obs.output).toContain("Aegis Computer");
    expect(obs.output).toContain("https://example.com/aegis/docs");
    expect(state.dataApiCalls).toHaveLength(1);
    expect(state.dataApiCalls[0].query).toEqual({ q: "aegis computer platform" });
  });

  it("recognizes several plausible response shapes (items, organic, webPages.value), not just 'results'", async () => {
    const adapter = new E2BCloudSandboxAdapter();

    state.dataApiResponder = () => ({ items: [{ name: "Item title", link: "https://example.com/item" }] });
    let obs = await adapter.execute(searchRequest({ taskId: "task-23a" }));
    expect(obs.outcome).toBe("completed");
    expect(obs.evidence).toContainEqual({ kind: "search_result_count", value: "1" });

    state.dataApiResponder = () => ({ webPages: { value: [{ name: "Bing-style title", url: "https://example.com/bing" }] } });
    obs = await adapter.execute(searchRequest({ taskId: "task-23b" }));
    expect(obs.outcome).toBe("completed");
    expect(obs.evidence).toContainEqual({ kind: "search_result_count", value: "1" });
  });

  it("does not touch the sandbox's command or file APIs at all (runs on the host, not in the sandbox)", async () => {
    state.dataApiResponder = () => ({ results: [{ title: "x", url: "https://example.com" }] });
    const adapter = new E2BCloudSandboxAdapter();

    await adapter.execute(searchRequest({ taskId: "task-24" }));

    expect(state.commandCalls).toHaveLength(0);
    expect(state.fileWrites).toHaveLength(0);
  });

  it("fails cleanly when query is missing", async () => {
    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(searchRequest({ taskId: "task-25", arguments: {} }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("query is required");
    expect(state.dataApiCalls).toHaveLength(0);
  });

  it("falls back to raw JSON instead of crashing when the response shape doesn't match any known format", async () => {
    state.dataApiResponder = () => ({ somethingUnexpected: true });
    const adapter = new E2BCloudSandboxAdapter();

    const obs = await adapter.execute(searchRequest({ taskId: "task-26" }));

    expect(obs.outcome).toBe("completed");
    expect(obs.evidence).toContainEqual({ kind: "search_result_count", value: "0" });
    expect(obs.output).toContain("somethingUnexpected");
  });

  it("surfaces callDataApi's own error as a failed observation (e.g. Forge not configured, or the apiId is wrong)", async () => {
    state.dataApiResponder = () => {
      throw new Error("BUILT_IN_FORGE_API_URL is not configured");
    };
    const adapter = new E2BCloudSandboxAdapter();

    const obs = await adapter.execute(searchRequest({ taskId: "task-27" }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("BUILT_IN_FORGE_API_URL is not configured");
  });
});
