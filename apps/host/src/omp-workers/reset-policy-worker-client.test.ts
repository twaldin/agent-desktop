import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime, type WorkerResetPolicyOwner, type WorkerRuntimeOptions } from "./runtime";
import type { ResetPolicyWireRequest, ResetPolicyWireResult } from "./reset-policy-wire";

const workerPath = fileURLToPath(new URL("./fixtures/reset-policy-worker-client.ts", import.meta.url));

async function fixture(scenario = "normal", ownerDrainError = false) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-reset-worker-client-"));
  let cwd = path.join(root, "project"); const agentDir = path.join(root, "agent"), logPath = path.join(root, "worker.jsonl");
  await Promise.all([cwd, agentDir].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
  cwd = await realpath(cwd);
  const calls: Array<{ event: string; request?: ResetPolicyWireRequest }> = [];
  const contexts: Parameters<NonNullable<WorkerRuntimeOptions["createResetPolicyOwner"]>>[0][] = [];
  const runtime = new WorkerRuntime({ agentDir, workerPath, startupTimeoutMs: 10_000, shutdownTimeoutMs: 1_000,
    environment: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_DISABLE_DOTENV: "1",
      RESET_POLICY_WORKER_LOG: logPath, RESET_POLICY_WORKER_SCENARIO: scenario },
    createResetPolicyOwner: context => {
      contexts.push(context);
      const owner: WorkerResetPolicyOwner = {
        async handle(request): Promise<ResetPolicyWireResult> {
          calls.push({ event: `handle:${request.operation.kind}`, request });
          if (scenario === "owner-error" && request.operation.kind === "decision.bind") throw new Error("controlled owner handle failure");
          if (request.operation.kind === "decision.bind") return { kind: "decision.bound" };
          if (request.operation.kind === "complete") return { kind: "completed" };
          throw new Error(`unexpected controlled operation ${request.operation.kind}`);
        },
        beginClose() { calls.push({ event: "beginClose" }); },
        workerLost() { calls.push({ event: "workerLost" }); },
        workerExited() { calls.push({ event: "workerExited" }); },
        async drain() { calls.push({ event: "drain" }); if (ownerDrainError) throw new Error("controlled owner drain failure"); },
      };
      return owner;
    },
  });
  return { root, cwd, logPath, runtime, calls, contexts,
    logs: async () => (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    cleanup: async () => { await runtime.dispose().catch(() => {}); await rm(root, { recursive: true, force: true }); } };
}

test("actual WorkerClient refuses before activation then binds one validated owner through disposal", async () => {
  const f = await fixture();
  try {
    const session = await f.runtime.create({ cwd: f.cwd });
    expect(f.contexts).toHaveLength(1);
    expect(Object.isFrozen(f.contexts[0])).toBe(true);
    expect(f.contexts[0]).toMatchObject({ workerEpoch: expect.any(String), workerPid: session.workerPid,
      snapshot: { id: "reset-policy-root", cwd: f.cwd } });
    expect(f.calls).toEqual([]);
    expect(await f.logs()).toContainEqual({ event: "before-init-response", value: { ok: false,
      error: { name: "Error", message: "Reset-policy owner is unavailable" } } });

    await session.getMessages();
    expect(f.calls.map(call => call.event)).toEqual(["handle:decision.bind"]);
    const active = f.calls[0]!.request!;
    expect(active.binding).toEqual({ workerEpoch: f.contexts[0]!.workerEpoch, rootSessionId: "reset-policy-root" });
    await session.dispose();
    expect(f.calls.map(call => call.event)).toEqual([
      "handle:decision.bind", "beginClose", "handle:complete", "workerExited", "drain",
    ]);
    expect(await f.logs()).toEqual(expect.arrayContaining([
      { event: "active-response", value: { ok: true, result: { kind: "decision.bound" } } },
      { event: "settlement-response", value: { ok: true, result: { kind: "completed" } } },
      { event: "dispose-ack" },
    ]));
  } finally { await f.cleanup(); }
});

test("invalid initialization identity closes without ever constructing durable ownership", async () => {
  const f = await fixture("bad-identity");
  try {
    await expect(f.runtime.create({ cwd: f.cwd })).rejects.toThrow("changed working directory");
    expect(f.contexts).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(await f.logs()).toEqual(expect.arrayContaining([
      { event: "before-init-response", value: { ok: false, error: { name: "Error", message: "Reset-policy owner is unavailable" } } },
      { event: "settlement-response", value: { ok: false, error: { name: "Error", message: "Reset-policy owner is unavailable" } } },
      { event: "dispose-ack" },
    ]));
  } finally { await f.cleanup(); }
});

test("open binds a fresh epoch only after validating the captured native identity", async () => {
  const f = await fixture();
  try {
    const sessionFile = path.join(f.root, "existing.jsonl");
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "reset-policy-root", cwd: f.cwd })}\n`);
    const session = await f.runtime.open({ sessionFile });
    expect(f.contexts).toHaveLength(1);
    expect(f.contexts[0]).toMatchObject({ workerPid: session.workerPid,
      snapshot: { id: "reset-policy-root", cwd: f.cwd } });
    expect((await f.logs()).find(item => item.event === "init")?.value).toMatchObject({ mode: "open",
      resetPolicy: { workerEpoch: f.contexts[0]!.workerEpoch } });
    await session.dispose();
  } finally { await f.cleanup(); }
});

test("transport loss fences the owner before actual exit and never substitutes a clean disposal", async () => {
  const f = await fixture("loss");
  try {
    const session = await f.runtime.create({ cwd: f.cwd });
    await expect(session.getMessages()).rejects.toThrow(/disconnected|exited|worker/i);
    await session.dispose();
    const events = f.calls.map(call => call.event);
    expect(events).toContain("workerLost");
    expect(events).toContain("workerExited");
    expect(events.indexOf("workerLost")).toBeLessThan(events.indexOf("workerExited"));
    expect(events).not.toContain("handle:complete");
    expect(await f.logs()).toContainEqual({ event: "disconnect" });
  } finally { await f.cleanup(); }
});

test("owner operation and owner drain failures survive a clean child exit independently", async () => {
  const f = await fixture("owner-error", true);
  try {
    const session = await f.runtime.create({ cwd: f.cwd });
    await session.getMessages();
    const closing = await session.dispose().then(() => undefined, error => error);
    expect(closing).toBeInstanceOf(AggregateError);
    const text = inspectErrors(closing).join("\n");
    expect(text).toContain("controlled owner handle failure");
    expect(text).toContain("controlled owner drain failure");
    expect(f.calls.map(call => call.event)).toContain("workerExited");
  } finally { await f.cleanup(); }
});

test("discovery, MCP-owner and browser workers never create reset-policy ownership", async () => {
  const f = await fixture();
  try {
    expect(await f.runtime.listModels(f.cwd)).toEqual([]);
    const mcp = await f.runtime.createMcpOwner({ id: "mcp-owner", cwd: f.cwd });
    await mcp.dispose();
    const browser = await f.runtime.createBrowserOwner({ id: "browser-owner", cwd: f.cwd });
    await browser.dispose();
    expect(f.contexts).toEqual([]);
    const inits = (await f.logs()).filter(item => item.event === "init").map(item => item.value);
    expect(inits).toEqual(expect.arrayContaining([
      { mode: "discovery" }, { mode: "mcp-owner" }, { mode: "browser" },
    ]));
  } finally { await f.cleanup(); }
});

function inspectErrors(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  return [error.message, ...(error instanceof AggregateError ? error.errors.flatMap(inspectErrors) : []),
    ...(error.cause ? inspectErrors(error.cause) : [])];
}
