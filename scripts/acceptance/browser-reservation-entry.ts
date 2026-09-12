/** Actual child dispatch/disposal and parent handle bodies with controlled IPC.
 * No child process, native import, real timer or browser is started. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WORKER_PROTOCOL_VERSION } from "../../apps/host/src/omp-workers/protocol";
import { NativeBrowserOwner, type BrowserEvaluationReservation } from "../../apps/host/src/omp-browser/owner";
import { WorkerBrowserReservations, requestWorkerBrowserReservation, type WorkerBrowserReservationStatus } from "../../apps/host/src/omp-browser/reservation";
import { WorkerBrowserEvaluationChannels } from "../../apps/host/src/omp-browser/evaluation";
import type { BrowserFrameTarget } from "../../packages/shared/src/browser";

const entry = await readFile("apps/host/src/omp-workers/entry.ts", "utf8");
const parentPath = path.resolve(process.env.WORKER_RESERVATION_PARENT ?? "apps/host/src/omp-workers/runtime.ts");
const parent = await readFile(parentPath, "utf8");
const selected: Record<string, string> = {};
function section(name: string, source: string, begin: string, end?: string): string {
  const start = source.indexOf(begin), finish = end ? source.indexOf(end, start) : source.length;
  assert(start >= 0 && finish > start, name); return selected[name] = source.slice(start, finish);
}
const creation = section("entryReservation", entry, "const browserReservations =", "let nativeDisposal");
const disposal = section("entryDisposal", entry, "function disposeNativeOwners()", "async function shutdown(");
const dispatch = section("entryRequest", entry, "async function request(", 'process.on("message"');
const runtimeBody = section("WorkerRuntime", parent, "export class WorkerRuntime {");
const clientBody = section("WorkerClient", parent, "export class WorkerClient {", "/** One native OMP process");
const transpile = (value: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(value);
const target = { workerPid: 710, name: "desktop-original", targetId: "target-original" };
type Operation = { operation: "reserveBrowserEvaluation" | "inspectBrowserEvaluationReservation"; args: { target: BrowserFrameTarget; operationId: string } } | { operation: "dispose" };
interface Response { id: string; ok: boolean; value?: unknown; error?: { message: string } }
interface Child {
  request(message: Operation & { type: "request"; id: string }): Promise<void>;
  disposeNativeOwners(): Promise<void>;
  pending(): { exitCode: number } | undefined;
}
const ticks = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
const passed: string[] = [], failures: { name: string; error: string }[] = [];
async function scenario(name: string, run: () => Promise<void>) {
  try { await run(); passed.push(name); } catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
}
function harness(failCleanup = false, absentOwner = false) {
  const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>();
  const events: string[] = [], responses: Response[] = [];
  let calls = 0;
  const owner = new NativeBrowserOwner({ id: "original-owner", cwd: "/canonical" }, async () => ({
    create: async () => { throw new Error("Unexpected native creation"); },
    reserveEvaluation: (request, operationId): BrowserEvaluationReservation => {
      calls++; events.push("reserve"); entered.resolve();
      return { ...request, ownerSessionId: "original-owner", operationId, ready: ready.promise, assertCurrent() {},
        dispose: async options => { assert.equal(options?.kill, true); events.push("resource-dispose"); await cleanup.promise; if (failCleanup) throw new Error("native cleanup failure"); },
      };
    },
    release: async () => { events.push("owner-release"); },
  }));
  const child = new Function("owner", "WorkerBrowserReservations", "WorkerBrowserEvaluationChannels", "send", "snapshot", "remoteError", "process", "setTimeout", transpile(`
    let browserOwner = owner, session, runtime, nativeDisposal, commitAbort, commitGeneration, pendingDispose;
    let stopping = false, activeRequests = 0, promotionInFlight = false, promotedOwnerRetired = false;
    const browserCloses = { dispose: async () => {} }, browserObservations = { dispose: async () => {} };
    ${creation}
    ${disposal}
    ${dispatch}
    return { request, disposeNativeOwners, pending: () => pendingDispose };
  `))(absentOwner ? undefined : owner, WorkerBrowserReservations, WorkerBrowserEvaluationChannels, (message: Response) => responses.push(message), () => undefined,
    (error: Error) => ({ message: error.message }), { pid: target.workerPid, exit: () => { throw new Error("No actual process exit"); } }, () => 1) as Child;
  return { owner, child, entered, ready, cleanup, events, responses, calls: () => calls };
}

await scenario("actual entry registers original-owner reservation and lookup never creates another", async () => {
  const h = harness();
  const pending = h.child.request({ type: "request", id: "reserve", operation: "reserveBrowserEvaluation", args: { target, operationId: "op" } });
  await h.entered.promise;
  await h.child.request({ type: "request", id: "status", operation: "inspectBrowserEvaluationReservation", args: { target, operationId: "op" } });
  assert.equal((h.responses[0]?.value as WorkerBrowserReservationStatus).phase, "pending"); assert.equal(h.calls(), 1);
  h.ready.resolve(); await pending;
  assert.deepEqual(h.responses.find(x => x.id === "reserve")?.value, { ...target, ownerId: "original-owner", operationId: "op", phase: "ready" });
  await h.child.request({ type: "request", id: "retry", operation: "reserveBrowserEvaluation", args: { target, operationId: "op" } });
  assert.equal(h.calls(), 1); h.cleanup.resolve(); await h.child.disposeNativeOwners();
});

for (const failure of [false, true]) await scenario(`actual entry disposal joins held reservation and ${failure ? "retains native failure" : "then acknowledges"}`, async () => {
  const h = harness(failure);
  const pending = h.child.request({ type: "request", id: "reserve", operation: "reserveBrowserEvaluation", args: { target, operationId: "op" } });
  await h.entered.promise;
  const disposed = h.child.request({ type: "request", id: "dispose", operation: "dispose" });
  await ticks(); assert(h.events.includes("resource-dispose")); assert.equal(h.responses.length, 0);
  h.ready.resolve(); await pending; await ticks();
  assert.equal((h.responses.find(x => x.id === "reserve")?.value as WorkerBrowserReservationStatus).phase, "failed");
  assert.equal(h.responses.some(x => x.id === "dispose"), false);
  h.cleanup.resolve(); await disposed;
  assert.equal(h.responses.find(x => x.id === "dispose")?.ok, !failure); assert.equal(h.child.pending()?.exitCode, failure ? 1 : 0);
  assert.equal(h.events.filter(x => x === "resource-dispose").length, 1); assert.equal(h.events.filter(x => x === "owner-release").length, 1);
});

await scenario("actual entry refuses non-browser owners and foreign workers before reservation", async () => {
  for (const absent of [false, true]) {
    const h = harness(false, absent);
    await h.child.request({ type: "request", id: "invalid", operation: "reserveBrowserEvaluation", args: { target: absent ? target : { ...target, workerPid: 9 }, operationId: "op" } });
    assert.equal(h.responses[0]?.ok, false); assert.equal(h.calls(), 0);
    await h.child.disposeNativeOwners(); await h.owner.dispose();
  }
});

interface Handle {
  reserveBrowserEvaluation(target: BrowserFrameTarget, operationId: string): Promise<WorkerBrowserReservationStatus>;
  inspectBrowserEvaluationReservation(target: BrowserFrameTarget, operationId: string): Promise<WorkerBrowserReservationStatus | null>;
  dispose(): Promise<void>;
}
await scenario("actual parent handle routes reservation and status to the same child without replay", async () => {
  const h = harness(); let requests = 0;
  class Client {
    pid = target.workerPid; snapshot = undefined;
    async request(operation: Operation | { operation: "init"; args: { owner: { id: string; cwd: string } } }): Promise<unknown> {
      if (operation.operation === "init") return { ownerId: operation.args.owner.id, cwd: operation.args.owner.cwd };
      const id = String(++requests); await h.child.request({ ...operation, type: "request", id });
      const response = h.responses.find(x => x.id === id)!;
      if (!response.ok) throw new Error(response.error?.message); return response.value;
    }
    async close() { h.cleanup.resolve(); await h.child.disposeNativeOwners(); }
    subscribeFailure() { return () => {}; }
  }
  const Runtime = new Function("WorkerClient", "requireDirectory", "path", "requestWorkerBrowserReservation", transpile(runtimeBody.replace("export class", "class")) + "\nreturn WorkerRuntime;")(
    Client, async () => "/canonical", path, requestWorkerBrowserReservation,
  ) as new (options: unknown) => { createBrowserOwner(value: { id: string; cwd: string }): Promise<Handle>; dispose(): Promise<void> };
  const runtime = new Runtime({}), handle = await runtime.createBrowserOwner({ id: "original-owner", cwd: "/canonical" });
  const input = { ...target }, pending = handle.reserveBrowserEvaluation(input, "op"); input.targetId = "changed";
  await h.entered.promise;
  assert.equal((await handle.inspectBrowserEvaluationReservation(target, "op"))?.phase, "pending");
  h.ready.resolve(); assert.equal((await pending).phase, "ready");
  assert.equal((await handle.reserveBrowserEvaluation(target, "op")).phase, "ready"); assert.equal(h.calls(), 1);
  const before = requests;
  await assert.rejects(handle.reserveBrowserEvaluation({ ...target, workerPid: 9 }, "foreign"), /invalid|stale/);
  assert.equal(requests, before); await handle.dispose(); await runtime.dispose();
});

interface ControlledClient {
  readonly pid: number;
  request(operation: { operation: string; args?: unknown }): Promise<unknown>;
  close(options?: { requireAcknowledgement?: boolean }): Promise<void>;
}
function clientHarness() {
  const sent: { type: string; id: string; operation?: string; args?: unknown }[] = [];
  const exited = Promise.withResolvers<number>();
  let receive!: (message: unknown) => void;
  let exit!: (child: { pid: number }, code: number, signal: null) => void;
  let kills = 0;
  const child = { pid: target.workerPid, exitCode: null as number | null, signalCode: null,
    exited: exited.promise,
    send(message: (typeof sent)[number]) {
      sent.push(message);
      if (message.type === "disposeAck") { child.exitCode = 0; exit(child, 0, null); exited.resolve(0); }
    },
    kill() { kills++; child.exitCode = 1; exit(child, 1, null); exited.resolve(1); },
  };
  const fakeBun = { spawn(options: { ipc: typeof receive; onExit: typeof exit }) { receive = options.ipc; exit = options.onExit; return child; } };
  const Client = new Function("Bun", "path", "fileURLToPath", "getBundledRuntimeRoot", "assertBundledRuntime", "setTimeout", "clearTimeout", "WORKER_PROTOCOL_VERSION",
    transpile(clientBody.replace("export class", "class").replaceAll("import.meta.url", JSON.stringify(pathToFileURL(path.resolve("apps/host/src/omp-workers/runtime.ts")).href))) + "\nreturn WorkerClient;")(
    fakeBun, path, fileURLToPath, () => undefined, () => { throw new Error("Unexpected bundled runtime"); }, () => ({ unref() {} }), () => {}, WORKER_PROTOCOL_VERSION,
  ) as new(options: { executablePath: string; environment: Record<string, string> }) => ControlledClient;
  const client = new Client({ executablePath: "/controlled/bun", environment: {} });
  receive({ type: "ready", version: WORKER_PROTOCOL_VERSION });
  return { client, sent, kills: () => kills, respond(id: string, value?: unknown) { receive({ type: "response", id, ok: true, value }); } };
}

await scenario("actual WorkerClient admits one disposal over a full ordinary queue and waits for acknowledgement", async () => {
  const h = clientHarness();
  const requests = Array.from({ length: 128 }, () => h.client.request({ operation: "getBrowserMetadata" }).then(() => "resolved", () => "retired"));
  await ticks(); assert.equal(h.sent.length, 128);
  await assert.rejects(h.client.request({ operation: "getBrowserMetadata" }), /limit/);
  let closed = false;
  const closing = h.client.close({ requireAcknowledgement: true }).then(() => { closed = true; return undefined; }, error => error);
  await ticks();
  const dispose = h.sent.find(message => message.operation === "dispose");
  assert(dispose); assert.equal(closed, false); assert.equal(h.kills(), 0);
  await assert.rejects(h.client.request({ operation: "dispose" }), /already/);
  assert.equal(h.sent.filter(message => message.operation === "dispose").length, 1);
  h.respond(dispose.id); await closing;
  assert.equal(h.sent.filter(message => message.type === "disposeAck").length, 1);
  assert.equal(h.kills(), 0); assert.deepEqual(await Promise.all(requests), Array(128).fill("retired"));
});

await scenario("actual WorkerClient keeps status and disposal available during 160 same-operation callers", async () => {
  const h = clientHarness();
  const callers = Array.from({ length: 160 }, () => requestWorkerBrowserReservation(h.client, "original-owner", target, "op"));
  await ticks(); assert.equal(h.sent.filter(message => message.operation === "reserveBrowserEvaluation").length, 1);
  const inspection = requestWorkerBrowserReservation(h.client, "original-owner", target, "op", true);
  await ticks(); const status = h.sent.find(message => message.operation === "inspectBrowserEvaluationReservation"); assert(status);
  h.respond(status.id, { ...target, ownerId: "original-owner", operationId: "op", phase: "pending" });
  assert.equal((await inspection)?.phase, "pending");
  const request = h.sent.find(message => message.operation === "reserveBrowserEvaluation"); assert(request);
  h.respond(request.id, { ...target, ownerId: "original-owner", operationId: "op", phase: "ready" });
  assert((await Promise.all(callers)).every(value => value?.phase === "ready"));
  const closing = h.client.close({ requireAcknowledgement: true }); await ticks();
  const dispose = h.sent.find(message => message.operation === "dispose"); assert(dispose);
  h.respond(dispose.id); await closing; assert.equal(h.kills(), 0);
});

console.log(JSON.stringify({ counts: { pass: passed.length, fail: failures.length }, passed, failures,
  selected: Object.fromEntries(Object.entries(selected).map(([name, source]) => [name, { sha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"), bytes: Buffer.byteLength(source) }])),
  limits: "Actual selected entry setup/request/disposal and parent WorkerRuntime; actual reservation module and NativeBrowserOwner, injected native backend/client/IPC/clock. No SDK, native worker/process/target, host HTTP, real IPC, first-Send or physical cleanup proof.",
}, null, 2));
if (failures.length) process.exitCode = 1;
