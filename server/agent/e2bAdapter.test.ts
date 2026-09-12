import { beforeEach, describe, expect, it, vi } from "vitest";
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
}));

// Fakes the `e2b` SDK entirely -- no real sandbox, no E2B_API_KEY needed.
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
  state.commandCalls = [];
  state.fileWrites = [];
  state.storagePutCalls = [];
  state.sandboxCreateOpts = [];
  state.commandResponder = () => ({ stdout: "", stderr: "", exitCode: 0 });
  state.fileReadResponder = () => new Uint8Array([1, 2, 3, 4]);
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
});
