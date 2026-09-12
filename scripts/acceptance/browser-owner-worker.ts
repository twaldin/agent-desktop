/** Actual WorkerRuntime class with a controlled IPC client; never starts a process. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
const sourcePath = process.argv[2] ?? "apps/host/src/omp-workers/runtime.ts";
const source = await readFile(sourcePath, "utf8");
const selected = source.slice(source.indexOf("export class WorkerRuntime {"));
assert(selected.startsWith("export class WorkerRuntime {"));
const body = new Bun.Transpiler({ loader: "ts" }).transformSync(selected.replace("export class", "class"));
interface Init { mode: string; owner?: { id: string; cwd: string }; agentDir?: string }
interface Operation { operation: string; args?: Record<string, unknown> }
interface Owner {
  id: string; cwd: string; workerPid: number;
  getBrowserMetadata(): Promise<unknown>; createBrowserTab(name: string, initialUrl?: string): Promise<unknown>;
  getBrowserFrame(target: { workerPid: number }): Promise<unknown>; dispose(): Promise<void>;
}
interface Runtime { createBrowserOwner(input: { id: string; cwd: string }): Promise<Owner>; dispose(): Promise<void> }
function fixture(mode: "valid" | "foreign" | "session" | "cwd" | "failed" = "valid") {
  const calls: Operation[] = [], clients: Client[] = [];
  const failures: unknown[] = [];
  let initGate: Promise<void> | undefined;
  class Client {
    pid = 23456; failure = undefined;
    snapshot = mode === "session" ? { id: "unwanted-session" } : undefined;
    closes = 0;
    constructor(readonly options: unknown, readonly environment: unknown) { clients.push(this); }
    async request(message: Operation) {
      calls.push(message);
      if (message.operation === "init") {
        await initGate;
        if (mode === "failed") throw new Error("Native owner API missing");
        const init = message.args as unknown as Init;
        return {
          ownerId: mode === "foreign" ? "other-owner" : init.owner?.id,
          cwd: mode === "cwd" ? "/other-canonical" : init.owner?.cwd,
        };
      }
      if (message.operation === "getBrowserMetadata") return { availability: "running", workerPid: 999, tabs: [] };
      return { operation: message.operation };
    }
    async close() { this.closes++; }
    subscribeFailure() { return () => {}; }
  }
  const requireDirectory = async (cwd: string) => cwd === "/selected" ? "/canonical" : cwd;
  const Runtime = new Function("WorkerClient", "realpath", "requireDirectory", "path", `${body}\nreturn WorkerRuntime;`)(
    Client,
    async (cwd: string) => cwd,
    requireDirectory,
    path,
  ) as new (options: unknown) => Runtime;
  const environment = { SELECTED_NATIVE_PROFILE: "preserved" };
  return { runtime: new Runtime({ agentDir: "/configured-agent", environment, onWorkerFailure: (failure: unknown) => failures.push(failure) }), calls, clients, environment, failures,
    hold() { const gate = Promise.withResolvers<void>(); initGate = gate.promise; return gate; } };
}
const checks: string[] = [];
{
  const h = fixture(); const input = { id: "draft-one", cwd: "/selected" };
  const pending = h.runtime.createBrowserOwner(input); input.id = "later"; input.cwd = "/other";
  const owner = await pending;
  const observer = (h.clients[0]!.options as { onWorkerFailure(failure: unknown): void }).onWorkerFailure;
  observer({ type: "worker_failure", message: "controlled failure", pid: 23456 });
  assert.deepEqual(h.failures, [{ type: "worker_failure", message: "controlled failure", pid: 23456, browserOwnerId: "draft-one" }]);
  assert.deepEqual(h.calls[0], { operation: "init", args: { mode: "browser", owner: { id: "draft-one", cwd: "/canonical" }, agentDir: "/configured-agent" } });
  assert.deepEqual(h.clients[0]?.environment, h.environment);
  assert.equal(owner.id, "draft-one"); assert.equal(owner.cwd, "/canonical"); assert.equal(owner.workerPid, 23456);
  await owner.createBrowserTab("desktop-one", "about:blank");
  assert.deepEqual(h.calls[1], { operation: "createBrowserTab", args: { name: "desktop-one", initialUrl: "about:blank" } });
  assert.deepEqual(await owner.getBrowserMetadata(), { availability: "unavailable", reason: "Native browser metadata came from a stale worker." });
  const before = h.calls.length; await assert.rejects(owner.getBrowserFrame({ workerPid: 999 }), /stale worker/); assert.equal(h.calls.length, before);
  await owner.dispose(); await owner.dispose(); await h.runtime.dispose();
  assert.equal(h.clients[0]?.closes, 1);
  checks.push("explicit mode/captured canonical owner, unchanged configured environment, shared PID fences and one disposal");
}
for (const mode of ["foreign", "session", "cwd", "failed"] as const) {
  const h = fixture(mode);
  await assert.rejects(h.runtime.createBrowserOwner({ id: "draft-one", cwd: "/selected" }), mode === "failed" ? /API missing/ : /changed identity/);
  assert.equal(h.clients.length, 1); assert.equal(h.clients[0]?.closes, 1); assert.equal(h.calls.length, 1);
  await h.runtime.dispose(); assert.equal(h.clients[0]?.closes, 1);
  checks.push(`${mode} initialization rejected without a replacement or session fallback`);
}
{
  const h = fixture(), gate = h.hold();
  const starting = h.runtime.createBrowserOwner({ id: "draft-one", cwd: "/selected" }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(h.clients.length, 1);
  const closing = h.runtime.dispose(); gate.resolve();
  assert.match((await starting).error?.message ?? "", /disposed/); await closing;
  assert.equal(h.calls.length, 1); assert(h.clients[0]!.closes >= 1);
  checks.push("runtime retirement cannot publish an owner from held initialization");
}
console.log(JSON.stringify({ sourcePath, sourceSha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"), selectedSha256: new Bun.CryptoHasher("sha256").update(selected).digest("hex"), checks,
  limit: "Actual WorkerRuntime class with controlled client/canonical-path response; not process, native settings, IPC, browser, SDK or UI execution" }, null, 2));
