import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityRequest } from "./execution";

type CommandResult = { stdout: string; stderr: string; exitCode: number };

const state = vi.hoisted(() => ({
  commandCalls: [] as Array<{ command: string; opts?: unknown }>,
  fileWrites: [] as Array<{ path: string; data: string }>,
  storagePutCalls: [] as Array<{ key: string; contentType: string }>,
  sandboxCreateOpts: [] as Array<Record<string, unknown>>,
  commandResponder: (_command: string): { stdout: string; stderr: string; exitCode: number } => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  }),
  fileReadResponder: (_path: string): Uint8Array => new Uint8Array([1, 2, 3, 4]),
  dataApiCalls: [] as Array<{ apiId: string; query?: Record<string, unknown> }>,
  dataApiResponder: (_apiId: string, _query?: Record<string, unknown>): unknown => ({ results: [] }),
}));

// Fakes the `e2b` SDK entirely -- no real sandbox and no real credential
// reach the network. `sandboxFor()` still checks that *some* value is
// present in `E2B_API_KEY` before ever calling the (mocked) `Sandbox.create`,
// so a fake value is stubbed in below purely to satisfy that check -- it is
// never used to authenticate anything real.
// This is a real-execution test of the adapter's own control flow (argument
// validation, install caching, error surfacing, evidence assembly), not a
// test of Playwright/Chromium actually working inside a live sandbox --
// that can only be verified with a real E2B_API_KEY, which CI doesn't have.
vi.mock("e2b", () => ({
  Sandbox: {
    create: async (opts: Record<string, unknown>) => {
      state.sandboxCreateOpts.push(opts);
      return {
        sandboxId: "fake-sandbox",
        commands: {
          run: async (command: string, runOpts?: unknown) => {
            state.commandCalls.push({ command, opts: runOpts });
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

vi.mock("nanoid", () => ({ nanoid: () => "fixedid" }));

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

function successfulNavigate(overrides: Partial<{ finalUrl: string; title: string; status: number | null; textExcerpt: string; navigationError: string | null }> = {}): CommandResult {
  return {
    stdout: JSON.stringify({
      finalUrl: "https://example.com/",
      title: "Example Domain",
      status: 200,
      textExcerpt: "Example Domain text",
      navigationError: null,
      ...overrides,
    }),
    stderr: "",
    exitCode: 0,
  };
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
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("E2BCloudSandboxAdapter browser.navigate", () => {
  it("succeeds end to end and returns evidence with a screenshot URL", async () => {
    state.commandResponder = command =>
      command.includes("playwright install") ? successfulInstall() : successfulNavigate();

    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(baseRequest({}));

    expect(obs.outcome).toBe("completed");
    expect(obs.output).toContain("Navigated to https://example.com/");
    expect(obs.output).toContain("Example Domain");
    expect(obs.evidence.some(e => e.startsWith("screenshot:/manus-storage/agent-computer/task-1/browser-evidence/"))).toBe(true);
    expect(state.storagePutCalls).toHaveLength(1);
    expect(state.storagePutCalls[0].contentType).toBe("image/png");
  });

  it("creates the sandbox with a private-range denylist instead of the old blanket allowInternetAccess flag", async () => {
    state.commandResponder = command => (command.includes("playwright install") ? successfulInstall() : successfulNavigate());
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

  it("only installs the browser runtime once per task across multiple navigate calls", async () => {
    state.commandResponder = command => (command.includes("playwright install") ? successfulInstall() : successfulNavigate());
    const adapter = new E2BCloudSandboxAdapter();

    await adapter.execute(baseRequest({ taskId: "task-6" }));
    await adapter.execute(baseRequest({ taskId: "task-6", arguments: { url: "https://example.org" } }));

    const installCalls = state.commandCalls.filter(c => c.command.includes("playwright install"));
    expect(installCalls).toHaveLength(1);
  });

  it("reports a page navigation error as failed and skips the screenshot upload", async () => {
    state.commandResponder = command =>
      command.includes("playwright install")
        ? successfulInstall()
        : successfulNavigate({ finalUrl: "https://unreachable.example/", title: "", status: null, textExcerpt: "", navigationError: "net::ERR_NAME_NOT_RESOLVED" });

    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(baseRequest({ taskId: "task-7", arguments: { url: "https://unreachable.example" } }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("ERR_NAME_NOT_RESOLVED");
    expect(state.storagePutCalls).toHaveLength(0);
  });

  it("keeps browser.interact blocked, with a diagnostic pointing at the real schema gap", async () => {
    const adapter = new E2BCloudSandboxAdapter();
    const obs = await adapter.execute(baseRequest({ taskId: "task-8", capability: "browser.interact" }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("CapabilityArguments");
    expect(obs.output).toContain("selector");
  });

  it("leaves shell.exec behavior unchanged (regression check)", async () => {
    state.commandResponder = () => ({ stdout: "hello", stderr: "", exitCode: 0 });
    const adapter = new E2BCloudSandboxAdapter();

    const obs = await adapter.execute(baseRequest({ taskId: "task-9", capability: "shell.exec", arguments: { command: "echo hello" } }));

    expect(obs.outcome).toBe("completed");
    expect(obs.output).toBe("hello");
  });

  it("never interpolates the raw URL into the shell command it runs", async () => {
    state.commandResponder = command => (command.includes("playwright install") ? successfulInstall() : successfulNavigate());
    const adapter = new E2BCloudSandboxAdapter();
    const trickyUrl = 'https://example.com/?q=$(rm -rf /)"; touch pwned';

    await adapter.execute(baseRequest({ taskId: "task-10", arguments: { url: trickyUrl } }));

    const navCommand = state.commandCalls.find(c => c.command.startsWith("node "));
    expect(navCommand).toBeTruthy();
    expect(navCommand!.command).not.toContain("rm -rf");

    const argsWrite = state.fileWrites.find(w => w.path.endsWith(".args.json"));
    expect(argsWrite).toBeTruthy();
    // The URL constructor percent-encodes spaces/quotes on the way in, so
    // the dangerous substring survives only in encoded form -- that's the
    // correct, extra-safe outcome.
    expect(JSON.parse(argsWrite!.data).url).toContain("rm%20-rf");
  });

  it("returns a failed observation instead of throwing when sandbox creation itself fails", async () => {
    // Regression check for a real pre-existing bug found while fixing this
    // test's own missing E2B_API_KEY stub: sandboxFor() used to be called
    // outside execute()'s try/catch, so any failure here (bad credential,
    // an E2B API error, anything) propagated as an uncaught throw instead
    // of a clean failed observation -- and nothing upstream
    // (CapabilityBroker.dispatch, AgentLoop's run loop) catches it either.
    vi.stubEnv("E2B_API_KEY", "");
    const adapter = new E2BCloudSandboxAdapter();

    const obs = await adapter.execute(baseRequest({ taskId: "task-11" }));

    expect(obs.outcome).toBe("failed");
    expect(obs.output).toContain("E2B_API_KEY is not configured");
    expect(state.sandboxCreateOpts).toHaveLength(0);
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
    expect(obs.evidence).toContain("http_status:200");
    expect(obs.evidence).toContain("http_url:https://example.com/data");
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
    expect(obs.evidence).toContain("http_redirect_location:https://example.com/next");
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
    expect(obs.evidence).toContain("search_query:aegis computer platform");
    expect(obs.evidence).toContain("search_result_count:2");
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
    expect(obs.evidence).toContain("search_result_count:1");

    state.dataApiResponder = () => ({ webPages: { value: [{ name: "Bing-style title", url: "https://example.com/bing" }] } });
    obs = await adapter.execute(searchRequest({ taskId: "task-23b" }));
    expect(obs.outcome).toBe("completed");
    expect(obs.evidence).toContain("search_result_count:1");
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
    expect(obs.evidence).toContain("search_result_count:0");
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
