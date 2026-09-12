/** Controlled entry-level browser evaluation coverage. It executes selected child
 * request/disposal/inbox bodies with actual worker channel and reservation
 * classes, but never starts a child process, SDK, native browser, or timer. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { NativeBrowserOwner, type BrowserEvaluationReservation } from "../../apps/host/src/omp-browser/owner";
import { WorkerBrowserReservations } from "../../apps/host/src/omp-browser/reservation";
import { WorkerBrowserEvaluationChannels } from "../../apps/host/src/omp-browser/evaluation";
import type { BrowserEvaluationBinding, BrowserEvaluationFrame, NativeCdpEvaluation, NativeCmuxEvaluation } from "../../apps/host/src/omp-browser/evaluation-wire";

const entryPath = "apps/host/src/omp-workers/entry.ts";
const entry = await readFile(entryPath, "utf8");
const selected: Record<string, string> = {};
function part(name: string, begin: string, end: string) {
  const start = entry.indexOf(begin), finish = entry.indexOf(end, start);
  assert(start >= 0 && finish > start, `missing ${name}`); return selected[name] = entry.slice(start, finish);
}
const disposal = part("entry.disposeNativeOwners", "function disposeNativeOwners()", "async function shutdown(");
const request = part("entry.request", "async function request(", 'process.on("message"');
const inbox = part("entry.inbox", 'process.on("message"', 'process.on("disconnect"');
const transpile = (value: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(value);
const target = { workerPid: 719, name: "desktop-original", targetId: "target-original" };
const binding = (backend: "cdp" | "cmux", operationId: string): BrowserEvaluationBinding => ({ ...target, ownerId: "owner-original", operationId, backend });
const ticks = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

type Response = { type: "response"; id: string; ok: boolean; value?: unknown; error?: { message: string }; evaluation?: { binding: BrowserEvaluationBinding; sequence: number } };
type Frame = { type: "browserEvaluationFrame"; binding: BrowserEvaluationBinding; frame: BrowserEvaluationFrame };
interface Child { request(value: { type: "request"; id: string; operation: string; args?: unknown }): Promise<void>; dispose(): Promise<void>; inbox(value: unknown): void; events: Array<Response | Frame>; }

function harness(options: { readonly failingDispose?: boolean } = {}) {
  let cdpPost: (frame: BrowserEvaluationFrame) => void = () => {}, cmuxResolve!: (value: Record<string, unknown>) => void;
  const cmuxPending = new Promise<Record<string, unknown>>(resolve => { cmuxResolve = resolve; });
  const received: BrowserEvaluationFrame[] = [], events: Array<Response | Frame> = []; let releases = 0, nativeDisposals = 0;
  const cdp: NativeCdpEvaluation = { descriptor: { version: 1, channel: "channel-original", targetId: target.targetId, activateForScreenshot: true }, start(post) { cdpPost = post; post({ type: "worker-cdp", channel: "channel-original", kind: "data", sequence: 1, data: "sync" }); }, receive(frame) { received.push(frame); }, async dispose() { nativeDisposals++; if (options.failingDispose) throw new Error("native dispose failure"); } };
  const cmux: NativeCmuxEvaluation = { state: { version: 1, surfaceId: target.targetId, url: "https://original.invalid", viewport: { width: 1, height: 1 }, elementRefs: [] }, async request() { return cmuxPending; }, async dispose() { nativeDisposals++; if (options.failingDispose) throw new Error("native dispose failure"); } };
  const owner = new NativeBrowserOwner({ id: "owner-original", cwd: "/controlled" }, async () => ({
    create: async () => { throw new Error("Unexpected browser creation"); },
    reserveEvaluation: (item, operationId): BrowserEvaluationReservation => ({ ...item, ownerSessionId: "owner-original", operationId, ready: Promise.resolve(), assertCurrent() {}, async dispose() {} }),
    openCdpEvaluation: async () => cdp, openCmuxEvaluation: () => cmux,
    release: async () => { releases++; },
  }));
  const handlers = new Map<string, (value: unknown) => void>();
  const process = { pid: target.workerPid, connected: true, env: {}, send(value: Response | Frame) { events.push(value); }, exit() {}, on(name: string, handler: (value: unknown) => void) { handlers.set(name, handler); } };
  const ChildEntry = new Function("owner", "WorkerBrowserReservations", "WorkerBrowserEvaluationChannels", "process", "setTimeout", "clearTimeout", "remoteError", "snapshot", transpile(`
    let browserOwner = owner, session, runtime, nativeDisposal, commitAbort, commitGeneration, pendingDispose;
    let stopping = false, activeRequests = 0, promotionInFlight = false, promotedOwnerRetired = false;
    const browserCloses = { dispose: async () => {} }, browserObservations = { dispose: async () => {} };
    const browserReservations = new WorkerBrowserReservations(process.pid, () => { if (!browserOwner) throw new Error("Reservation requires original owner"); return browserOwner; });
    const browserEvaluations = new WorkerBrowserEvaluationChannels(browserReservations, () => { if (!browserOwner) throw new Error("Evaluation requires original owner"); return browserOwner; }, (binding, frame) => send({ type: "browserEvaluationFrame", binding, frame }));
    function send(value) { process.send(value); }
    ${disposal}
    ${request}
    ${inbox}
    return { request, dispose: disposeNativeOwners };
  `))(owner, WorkerBrowserReservations, WorkerBrowserEvaluationChannels, process, () => ({ unref() {} }), () => {}, (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }), () => undefined) as Omit<Child, "events" | "inbox">;
  return { child: { ...ChildEntry, events, inbox(value: unknown) { handlers.get("message")?.(value); } }, owner, cdpPost: (frame: BrowserEvaluationFrame) => cdpPost(frame), cmuxResolve, received, count: () => ({ releases, nativeDisposals }) };
}

const passed: string[] = [], failures: Array<{ name: string; error: string }> = [];
async function scenario(name: string, body: () => Promise<void>) { try { await body(); passed.push(name); } catch (error) { failures.push({ name, error: error instanceof Error ? error.message : String(error) }); } }

await scenario("entry routes ready reservation through one original CMUX opening, response acknowledgement, and channel-only disposal", async () => {
  const h = harness(), value = binding("cmux", "cmux-entry");
  await h.child.request({ type: "request", id: "reserve", operation: "reserveBrowserEvaluation", args: { target, operationId: value.operationId } });
  await h.child.request({ type: "request", id: "open", operation: "openBrowserEvaluation", args: { binding: value, timeoutMs: 500 } });
  const pending = h.child.request({ type: "request", id: "request", operation: "requestBrowserEvaluation", args: { binding: value, sequence: 1, method: "opaque.native.method", params: {}, options: undefined } });
  await ticks(); h.cmuxResolve({ exact: true }); await pending;
  const response = h.child.events.find(item => item.type === "response" && item.id === "request") as Response | undefined;
  assert.equal(response?.ok, true); assert.deepEqual(response?.evaluation, { binding: value, sequence: 1 });
  h.child.inbox({ type: "browserEvaluationAck", binding: value, sequence: 1 });
  await h.child.request({ type: "request", id: "close", operation: "disposeBrowserEvaluation", args: { binding: value } });
  assert.equal(h.count().releases, 0); assert.equal(h.count().nativeDisposals, 1);
  await h.owner.dispose();
});

await scenario("entry routes CDP synchronous frames, parent ack, and terminal close/drained while stopping", async () => {
  const h = harness(), value = binding("cdp", "cdp-entry");
  await h.child.request({ type: "request", id: "reserve", operation: "reserveBrowserEvaluation", args: { target, operationId: value.operationId } });
  await h.child.request({ type: "request", id: "open", operation: "openBrowserEvaluation", args: { binding: value, timeoutMs: 500 } });
  await h.child.request({ type: "request", id: "start", operation: "startBrowserEvaluation", args: { binding: value } });
  assert.equal(h.child.events.filter(item => item.type === "browserEvaluationFrame").length, 1);
  h.child.inbox({ type: "browserEvaluationFrame", binding: value, frame: { type: "worker-cdp", channel: "channel-original", kind: "ack", sequence: 1 } });
  assert.equal(h.received.length, 1);
  const disposing = h.child.request({ type: "request", id: "dispose", operation: "dispose", args: {} }); await ticks();
  h.cdpPost({ type: "worker-cdp", channel: "channel-original", kind: "close", errors: [] });
  h.cdpPost({ type: "worker-cdp", channel: "channel-original", kind: "drained", errors: [] });
  await disposing; assert(h.child.events.some(item => item.type === "response" && item.id === "dispose"));
});

await scenario("entry retains a native evaluation cleanup failure through worker disposal", async () => {
  const h = harness({ failingDispose: true }), value = binding("cdp", "failing-dispose");
  await h.child.request({ type: "request", id: "reserve", operation: "reserveBrowserEvaluation", args: { target, operationId: value.operationId } });
  await h.child.request({ type: "request", id: "open", operation: "openBrowserEvaluation", args: { binding: value, timeoutMs: 500 } });
  await h.child.request({ type: "request", id: "dispose", operation: "dispose", args: {} });
  const response = h.child.events.find(item => item.type === "response" && item.id === "dispose") as Response | undefined;
  assert.equal(response?.ok, false); assert.match(response?.error?.message ?? "", /native dispose failure/);
});

console.log(JSON.stringify({ sources: { entry: { path: entryPath, sha256: hash(entry), bytes: Buffer.byteLength(entry) } }, selected: Object.fromEntries(Object.entries(selected).map(([name, value]) => [name, { sha256: hash(value), bytes: Buffer.byteLength(value) }])), counts: { pass: passed.length, fail: failures.length }, passed, failures, limits: "Controlled selected entry request/disposal/inbox blocks with actual worker reservation/evaluation classes and NativeBrowserOwner. No native SDK, child process, host runtime, session, browser target, or physical IPC executes." }, null, 2));
if (failures.length) process.exitCode = 1;
