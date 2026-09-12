/** Controlled actual host/channel and supervisor acquisition bodies. Never starts a Worker or imports the SDK. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const [hostPath, channelPath, supervisorPath] = process.argv.slice(2);
if (!hostPath || !channelPath || !supervisorPath) throw new Error("Expected host, channel and supervisor source paths");
const sources = await Promise.all([hostPath, channelPath, supervisorPath].map(path => readFile(path, "utf8")));
const transform = (source: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace(/^import\b[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""));
const { ParentWorkerCdpChannel } = new Function(`${transform(sources[1]!)};return {ParentWorkerCdpChannel}`)();
type Frame = { type: string; [key: string]: any };
type Handle = { assertActive(): void; send(frame: Frame): void; terminate(): Promise<void>; abort(error: Error): Promise<void>; onMessage(fn: (frame: Frame) => void): () => void; readonly createdTargetId?: string; readonly physicalExitConfirmed: boolean };
const ticks = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const flatten = (error: unknown): string[] => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error instanceof Error ? error.message : String(error)];
function outcome(promise: Promise<unknown>) { let value: { ok: boolean; errors: string[] } | undefined; void promise.then(() => value = { ok: true, errors: [] }, e => value = { ok: false, errors: flatten(e) }); return () => value; }
function harness() {
  const drain = Promise.withResolvers<void>(), forced = Promise.withResolvers<void>();
  let holdDrain = false, holdForce = false, forceError: Error | undefined;
  let postError: ((frame: Frame) => boolean) | undefined, onForce = () => {}, removalFailure = false;
  const posts: Frame[] = [], removed: string[] = [], callbacks = new Map<string, Set<(event: any) => void>>();
  let constructions = 0, forces = 0, drains = 0;
  class ControlledWorker {
    constructor() { constructions++; }
    postMessage(frame: Frame) { posts.push(structuredClone(frame)); if (postError?.(frame)) throw new Error("Original worker port write failed"); }
    addEventListener(kind: string, fn: (event: any) => void) { if (!callbacks.has(kind)) callbacks.set(kind, new Set()); callbacks.get(kind)!.add(fn); }
    removeEventListener(kind: string, fn: (event: any) => void) { removed.push(kind); callbacks.get(kind)?.delete(fn); if (removalFailure && kind === "message") throw new Error("Message listener removal failed"); }
    terminate() { forces++; onForce(); return holdForce ? forced.promise : undefined; }
  }
  const upstream = { startupCreations: [], finishStartup() {}, onmessage: undefined as ((raw: string) => void) | undefined, onclose: undefined as (() => void) | undefined, send(_raw: string) {}, close() { throw new Error("Dispose must be joined"); }, async dispose() { drains++; if (holdDrain) await drain.promise; } };
  const inlineOrder: string[] = [];
  class ControlledCore {
    constructor(readonly transport: any) { transport.onMessage((frame: Frame) => { inlineOrder.push(frame.type); if (frame.type === "close") transport.send({ type: "closed" }); }); }
    async retire() { inlineOrder.push("retire"); this.transport.send({ type: "closed" }); }
    async abort() { inlineOrder.push("abort"); }
  }
  const injected = { ParentWorkerCdpChannel, Worker: ControlledWorker, workerHostEntry: () => undefined, logger: { warn() {} }, loadWorker: async () => ({ WorkerCore: ControlledCore }) };
  const host = sources[0]!.replace('import.meta.url', JSON.stringify(`file://${hostPath}`)).replace('import("./tab-worker")', 'loadWorker()');
  const module = new Function(...Object.keys(injected), `${transform(host)};return {spawnTabWorker,spawnInlineWorker}`)(...Object.values(injected));
  const emit = (kind: string, event: any) => { for (const fn of [...callbacks.get(kind) ?? []]) fn(event); };
  return {
    spawn: (id = "attempt-A") => module.spawnTabWorker(upstream, id) as Promise<Handle>,
    inline: () => module.spawnInlineWorker(upstream, "inline-A") as Promise<Handle>,
    message: (frame: Frame) => emit("message", { data: frame }),
    error: () => emit("error", { error: new Error("Physical worker error") }),
    configure(options: { holdDrain?: boolean; holdForce?: boolean; removalFailure?: boolean; postError?: (frame: Frame) => boolean; onForce?: () => void; forceError?: Error }) {
      holdDrain = options.holdDrain ?? holdDrain; holdForce = options.holdForce ?? holdForce; removalFailure = options.removalFailure ?? removalFailure;
      postError = options.postError ?? postError; onForce = options.onForce ?? onForce; forceError = options.forceError ?? forceError;
    },
    release() { drain.resolve(); forceError ? forced.reject(forceError) : forced.resolve(); },
    posts, removed, inlineOrder, upstream,
    state: () => ({ forces, drains, constructions, listeners: [...callbacks.values()].reduce((sum, values) => sum + values.size, 0) }),
  };
}
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, body: () => Promise<void>) => tests.push([name, body]);
test("parent drain write failure joins original disposal without a fake child receipt", async () => {
  const h = harness(); h.configure({ holdDrain: true, postError: frame => frame.type === "worker-cdp" && frame.kind === "drained" });
  const worker = await h.spawn(); worker.send({ type: "init", payload: { cdpChannel: "attempt-A" } });
  h.message({ type: "worker-cdp", channel: "attempt-A", kind: "close" });
  const result = outcome(worker.terminate()); await ticks(); const pending = result(); h.release(); await ticks();
  assert.equal(pending, undefined); assert.equal(result()?.ok, false); assert.ok(result()?.errors.some(s => s.includes("port write failed")));
  assert.equal(h.state().forces, 1); assert.equal(h.state().drains, 1); assert.equal(h.state().listeners, 0);
});
test("graceful physical termination reserves one force across reentrant error", async () => {
  const h = harness(); h.configure({ holdForce: true, onForce: () => h.error(), forceError: new Error("Physical termination failed") });
  const worker = await h.spawn(); h.message({ type: "closed" }); const result = outcome(worker.terminate());
  await ticks(); const before = h.state(), pending = result(); h.release(); await ticks();
  assert.equal(pending, undefined); assert.equal(before.forces, 1); assert.equal(h.state().forces, 1);
  assert.equal(result()?.ok, false); assert.ok(result()?.errors.includes("Physical termination failed"));
});
test("listener removal attempts every original handler even after an error", async () => {
  const h = harness(); h.configure({ removalFailure: true }); const worker = await h.spawn();
  h.message({ type: "closed" }); const result = outcome(worker.terminate()); await ticks();
  assert.deepEqual(h.removed, ["message", "error", "messageerror"]); assert.equal(h.state().listeners, 0);
  assert.equal(result()?.ok, false); assert.ok(result()?.errors.some(s => s.includes("listener removal")));
});
test("late page creation remains available while retiring and ready is suppressed", async () => {
  const h = harness(), worker = await h.spawn(), received: string[] = [];
  worker.onMessage(frame => received.push(frame.type)); const closing = worker.terminate();
  h.message({ type: "page-created", targetId: "original-target" }); h.message({ type: "ready", targetId: "late" });
  h.message({ type: "closed" }); await closing;
  assert.equal(worker.createdTargetId, "original-target"); assert.deepEqual(received, ["page-created", "closed"]);
  assert.equal(worker.physicalExitConfirmed, false, "void terminate is not physical exit evidence");
});
test("normal inline close is delivered before retirement", async () => {
  const h = harness(), worker = await h.inline(); worker.send({ type: "close" }); await worker.terminate();
  assert.deepEqual(h.inlineOrder.slice(0, 2), ["close", "retire"]); assert.equal(h.state().drains, 1);
});
test("invalid channel is rejected before worker allocation", async () => {
  const h = harness(); await assert.rejects(h.spawn(""), /channel identity/); assert.equal(h.state().constructions, 0);
});
function acquisition(loseAt: "temporary-release" | "outer-release" | "none", replace = false, elapsedAtRelease = 0) {
  const tabs = new Map<string, any>(), calls: string[] = []; let valid = true, releases = 0, now = 0;
  const browser = { kind: { kind: "headless" }, refCount: 0 }, original = { browser, backend: "worker", state: "alive", dialogPolicy: false };
  if (loseAt === "temporary-release") tabs.set("tab", original);
  const worker = { startupCreations: [], finishStartup() {}, assertActive() {}, createdTargetId: "new-page", onMessage() {}, async terminate() { calls.push("terminate"); } };
  const owner = { assertCurrent() { if (!valid) throw new Error("Original owner lost"); }, async closeTarget(id: string) { calls.push(`close:${id}`); } };
  const replacement = { replacement: true };
  const deps: Record<string, any> = {
    tabs, acquireChains: new Map(), killedTabs: new Map(), workerPageTargets: new WeakMap(), tabObservations: new WeakMap(), GRACE_MS: 100,
    ToolError: Error, ToolAbortError: Error, BrowserTabCreateRejected: Error,
    performance: {now: () => now}, initBudgetExhausted: (budget: number, start: number) => now - start >= budget,
    captureWorkerConnection: () => owner,
    holdBrowser() { browser.refCount++; },
    async releaseBrowser() { releases++; now = elapsedAtRelease; browser.refCount--; if (loseAt !== "none") { valid = false; if (replace) tabs.set("tab", replacement); } },
    async releaseTab() { tabs.delete("tab"); },
    async captureTabObservation() { return { assertCurrent: owner.assertCurrent }; },
    async buildInitPayload() { return { mode: "headless" }; },
    async initializeOwnedAttempt() { return { worker, info: { targetId: "new-page" } }; },
    rememberTabObservation() {}, handleTabMessage() {}, sharedScopeOf: () => undefined,
    async cleanupTab(tab: any, cleanup: () => Promise<void>) { calls.push("cleanup-original"); await cleanup(); },
    async releaseTabSession(tab: any) { calls.push("release-original"); if (tabs.get("tab") === tab) tabs.delete("tab"); browser.refCount--; },
  };
  const source = sources[2]!.slice(sources[2]!.indexOf("export function acquireTab("), sources[2]!.indexOf("\ntype WorkerPageInit ="));
  const cleanup = sources[2]!.slice(sources[2]!.indexOf("async function closeUnpublishedWorkerTargets("), sources[2]!.indexOf("/** Retain one authenticated cmux connection"));
  const { acquireTab } = new Function(...Object.keys(deps), `${transform(source + cleanup)};return { acquireTab }`)(...Object.values(deps));
  return { run: () => acquireTab("tab", browser, { timeoutMs: 1000, dialogs: true }), calls, tabs, replacement, state: () => ({ refs: browser.refCount, releases }) };
}
test("temporary hold release invalidation drains unpublished worker and its page", async () => {
  const h = acquisition("temporary-release"); await assert.rejects(h.run(), /Original owner lost/);
  assert.deepEqual(h.calls, ["terminate", "close:new-page"]); assert.equal(h.tabs.has("tab"), false); assert.equal(h.state().refs, 0);
});
test("outer hold release invalidation removes only acquisition-created original", async () => {
  const h = acquisition("outer-release"); await assert.rejects(h.run(), /Original owner lost/);
  assert.deepEqual(h.calls, ["cleanup-original", "release-original"]); assert.equal(h.tabs.has("tab"), false); assert.equal(h.state().refs, 0);
});
test("outer release cannot delete a replacement", async () => {
  const h = acquisition("outer-release", true); await assert.rejects(h.run(), /Original owner lost/);
  assert.deepEqual(h.calls, ["cleanup-original", "release-original"]); assert.equal(h.tabs.get("tab"), h.replacement); assert.equal(h.state().refs, 0);
});
test("valid original publishes with retained hold", async () => {
  const h = acquisition("none"), result = await h.run(); assert.equal(result.created, true); assert.equal(h.tabs.get("tab"), result.tab); assert.equal(h.state().refs, 1);
});

test("outer hold release cannot publish after the original deadline", async () => {
  const h = acquisition("none", false, 1101); await assert.rejects(h.run(), /deadline expired before publication/);
  assert.deepEqual(h.calls, ["cleanup-original", "release-original"]); assert.equal(h.tabs.has("tab"), false); assert.equal(h.state().refs, 0);
});

function startup(options: { holdAllocation?: boolean; holdDrain?: boolean; cleanupError?: boolean; reported?: boolean; inline?: boolean; receipts?: Array<{requestId: number; status: string; targetId?: string}>; lostMessage?: boolean } = {}) {
  let valid = true, now = 0, allocations = 0, setups = 0;
  const calls: string[] = [], payloads: any[] = [], ids: string[] = [], budgets: number[] = [];
  const allocation = Promise.withResolvers<void>(), drain = Promise.withResolvers<void>();
  const failed = new Error("Worker startup failed");
  const owner = {
    assertCurrent() { if (!valid) throw new Error("Original connection lost"); },
    async open(budget: number) { allocations++; budgets.push(budget); calls.push(`open:${allocations}`); if (options.holdAllocation) await allocation.promise; return { async dispose() { calls.push("dispose-allocation"); } }; },
    async closeTarget(target: string) { calls.push(`orphan:${target}`); if (options.cleanupError) throw new Error("Original target cleanup failed"); },
  };
  const spawn = async (_transport: any, id: string, mode: string) => { ids.push(id); return { mode, startupCreations: options.receipts ?? [], finishStartup() {}, assertActive() {}, createdTargetId: setups === 0 && !options.lostMessage ? "created-A" : undefined, async abort() { calls.push("abort-A"); if (options.holdDrain) await drain.promise; }, async terminate() { calls.push("retire-A"); if (options.holdDrain) await drain.promise; } }; };
  const deps = {
    performance: { now: () => now }, crypto: { randomUUID: () => `fresh-${ids.length + 1}` },
    ToolError: Error, ToolAbortError: Error, workerPageTargets: new WeakMap(), logger: { warn() {} },
    spawnTabWorker: (transport: any, id: string) => spawn(transport, id, options.inline ? "inline" : "worker"),
    spawnInlineWorker: (transport: any, id: string) => spawn(transport, id, "inline"),
    async initializeTabWorker(_worker: any, payload: any, budget: number, start: number) { payloads.push({ payload, budget, start }); if (++setups === 1) throw failed; return { targetId: "new-B" }; },
    isReportedInitFailure: (error: unknown) => options.reported && error === failed,
    initBudgetExhausted: (budget: number, start: number) => now - start >= budget,
  };
  const source = sources[2]!.slice(sources[2]!.indexOf("async function initializeOwnedAttempt("), sources[2]!.indexOf("/** Retain one authenticated cmux connection"));
  const { initializeOwnedAttempt } = new Function(...Object.keys(deps), `${transform(source)};return {initializeOwnedAttempt}`)(...Object.values(deps));
  return { run: () => initializeOwnedAttempt(owner, { mode: "headless" }, 1000, 0), calls, ids, payloads, budgets,
    release() { allocation.resolve(); drain.resolve(); }, lose() { valid = false; }, time(value: number) { now = value; }, state: () => ({ allocations, setups }) };
}
test("fallback awaits original attempt and target cleanup then allocates a fresh channel", async () => {
  const h = startup({ holdDrain: true }), result = outcome(h.run()); await ticks(); const before = h.state(); h.time(400); h.release(); await ticks();
  assert.deepEqual(before, { allocations: 1, setups: 1 }); assert.equal(result()?.ok, true);
  assert.deepEqual(h.calls, ["open:1", "abort-A", "orphan:created-A", "open:2"]);
  assert.deepEqual(h.ids, ["fresh-1", "fresh-2"]); assert.deepEqual(h.budgets, [1000, 600]);
  assert.deepEqual(h.payloads.map(x => [x.budget, x.start, x.payload.browserWSEndpoint]), [[1000, 0, undefined], [1000, 0, undefined]]);
});
test("allocation owner loss drains original transport before any worker startup", async () => {
  const h = startup({ holdAllocation: true }), result = outcome(h.run()); await ticks(); h.lose(); h.release(); await ticks();
  assert.equal(result()?.ok, false); assert.deepEqual(h.state(), { allocations: 1, setups: 0 }); assert.deepEqual(h.calls, ["open:1", "dispose-allocation"]);
});
test("elapsed original deadline forbids fallback after held cleanup", async () => {
  const h = startup({ holdDrain: true }), result = outcome(h.run()); await ticks(); h.time(1001); h.release(); await ticks();
  assert.equal(result()?.ok, false); assert.equal(h.state().allocations, 1); assert.deepEqual(h.calls, ["open:1", "abort-A", "orphan:created-A"]);
});
test("unclean orphan drain forbids fallback and retains both errors", async () => {
  const h = startup({ cleanupError: true }), result = outcome(h.run()); await ticks();
  assert.equal(result()?.ok, false); assert.deepEqual(result()?.errors, ["Worker startup failed", "Original target cleanup failed"]); assert.equal(h.state().allocations, 1);
});
test("reported initialization failure retires without replay", async () => {
  const h = startup({ reported: true }), result = outcome(h.run()); await ticks(); assert.equal(result()?.ok, false);
  assert.deepEqual(h.calls, ["open:1", "retire-A", "orphan:created-A"]); assert.equal(h.state().allocations, 1);
});

test("captured owner closes only original connection and confirms a concurrent absence", async () => {
  let confirm = false, absent = false; const calls: string[] = [];
  const original = { connected: true, _connection: { _closed: false, async send(method: string, params: any) {
    calls.push(method); if (method === "Target.closeTarget") { assert.equal(params.targetId, "original-page"); return { success: confirm }; }
    return { targetInfos: absent ? [] : [{ targetId: "original-page" }] };
  } } }, handle = { browser: original, kind: { kind: "headless" } };
  const deps = { ToolError: Error, DEFAULT_TAB_CLOSE_TIMEOUT_MS: 1000 };
  const source = sources[2]!.slice(sources[2]!.indexOf("function captureWorkerConnection("), sources[2]!.indexOf("async function initializeOwnedAttempt("));
  const capture = new Function(...Object.keys(deps), `${transform(source)};return captureWorkerConnection`)(...Object.values(deps));
  const owner = capture(handle); await assert.rejects(owner.closeTarget("original-page"), /not confirmed/);
  confirm = true; await owner.closeTarget("original-page"); assert.deepEqual(calls, ["Target.closeTarget", "Target.getTargets", "Target.closeTarget"]);
  confirm = false; absent = true; await owner.closeTarget("original-page"); assert.equal(calls.length, 5);
  handle.browser = { ...original, _connection: { ...original._connection } };
  await assert.rejects(owner.closeTarget("original-page"), /Original worker browser connection/); assert.equal(calls.length, 5);
});
test("held orphan close never performs a fallback read on a replacement connection", async () => {
  const gate = Promise.withResolvers<{success: boolean}>(), calls: string[] = [];
  const connection = { _closed: false, async send(method: string) { calls.push(method); return await gate.promise; } };
  const browser = { connected: true, _connection: connection }, handle = {browser, kind: {kind: "headless"}};
  const source = sources[2]!.slice(sources[2]!.indexOf("function captureWorkerConnection("), sources[2]!.indexOf("async function initializeOwnedAttempt("));
  const capture = new Function("ToolError", "DEFAULT_TAB_CLOSE_TIMEOUT_MS", `${transform(source)};return captureWorkerConnection`)(Error, 1000);
  const result = outcome(capture(handle).closeTarget("original-page")); await ticks();
  browser._connection = {_closed: false, async send(method: string) { calls.push(`REPLACEMENT:${method}`); return {success: true}; }};
  gate.resolve({success: false}); await ticks();
  assert.equal(result()?.ok, false); assert.deepEqual(calls, ["Target.closeTarget"]);
});
test("parent creation receipt closes an orphan even without a worker page-created message", async () => {
  const h = startup({ lostMessage: true, receipts: [{requestId: 7, status: "created", targetId: "parent-known"}] });
  const result = outcome(h.run()); await ticks(); assert.equal(result()?.ok, true);
  assert.deepEqual(h.calls, ["open:1", "abort-A", "orphan:parent-known", "open:2"]);
});
test("unknown creation prevents retry while known sibling target still drains", async () => {
  const h = startup({ lostMessage: true, receipts: [{requestId: 7, status: "unknown"}, {requestId: 8, status: "created", targetId: "known-sibling"}] });
  const result = outcome(h.run()); await ticks(); assert.equal(result()?.ok, false);
  assert.ok(result()?.errors.some(error => error.includes("replay is not allowed")));
  assert.equal(h.state().allocations, 1); assert.deepEqual(h.calls, ["open:1", "abort-A", "orphan:known-sibling"]);
});
test("retired original attempt cannot be published again", async () => {
  const h = harness(), worker = await h.spawn(); worker.assertActive(); h.message({ type: "closed" });
  assert.throws(() => worker.assertActive(), /retired/); await worker.terminate(); assert.throws(() => worker.assertActive(), /retired/);
});

function deadlineCase(start: number, afterSetup: number, afterReady: number, subscriptionClock?: number) {
  let now = start, sent = 0, removed = 0, registered = 0;
  const budgets: number[] = []; let receive: ((frame: Frame) => void) | undefined;
  const worker = {
    onMessage(callback: (frame: Frame) => void) { registered++; receive = callback; if (subscriptionClock !== undefined) now = subscriptionClock; return () => { removed++; }; },
    onError(_callback: (error: Error) => void) { registered++; return () => { removed++; }; },
    send() { sent++; receive?.({ type: "setup" }); receive?.({ type: "ready", info: { targetId: "original-page" } }); },
  };
  const deps = {
    performance: { now: () => now }, ToolError: Error, ToolAbortError: Error,
    SETUP_BUDGET_FLOOR_MS: 2000, SETUP_BUDGET_CAP_MS: 10000, READY_BUDGET_FLOOR_MS: 500,
    workerPageTargets: new WeakMap(), markReportedInitFailure: (e: Error) => e, errorFromPayload: () => new Error("init failed"), logWorkerMessage() {},
    async raceWithTimeout(promise: Promise<any>, budget: number) { budgets.push(budget); const result = await promise; now = budgets.length === 1 ? afterSetup : afterReady; return result; },
  };
  const source = sources[2]!.slice(sources[2]!.indexOf("async function initializeTabWorker("), sources[2]!.indexOf("/**\n * True once the caller's init budget"));
  const init = new Function(...Object.keys(deps), `${transform(source)};return initializeTabWorker`)(...Object.values(deps));
  return { run: () => init(worker, { mode: "headless", cdpChannel: "deadline" }, 1000, 0), budgets, state: () => ({ sent, removed, registered }) };
}
test("setup and ready floors cannot extend the original remaining deadline", async () => {
  const h = deadlineCase(900, 950, 990); assert.equal((await h.run()).targetId, "original-page");
  assert.deepEqual(h.budgets, [100, 50]); assert.deepEqual(h.state(), { sent: 1, registered: 2, removed: 2 });
});
test("expired initial deadline does not subscribe or dispatch", async () => {
  const h = deadlineCase(1000, 1001, 1002); await assert.rejects(h.run(), /deadline expired/);
  assert.deepEqual(h.state(), { sent: 0, registered: 0, removed: 0 }); assert.deepEqual(h.budgets, []);
});
test("subscription replay cannot dispatch beyond the original deadline", async () => {
  const h = deadlineCase(0, 1001, 1002, 1000); await assert.rejects(h.run(), /deadline expired/);
  assert.deepEqual(h.state(), { sent: 0, registered: 2, removed: 2 }); assert.deepEqual(h.budgets, []);
});
test("setup consuming the deadline cannot start a fresh ready wait", async () => {
  const h = deadlineCase(0, 1000, 1001); await assert.rejects(h.run(), /deadline expired/);
  assert.deepEqual(h.budgets, [1000]); assert.equal(h.state().removed, 2);
});
test("ready delivered after the deadline cannot publish", async () => {
  const h = deadlineCase(0, 400, 1000); await assert.rejects(h.run(), /deadline expired/);
  assert.deepEqual(h.budgets, [1000, 600]); assert.equal(h.state().removed, 2);
});
function recycleCase(holdAt?: "old-drain" | "new-init") {
  const gate = Promise.withResolvers<void>(), calls: string[] = [], payloads: any[] = [];
  let valid = true, now = 10;
  const original = {async terminate() {calls.push("old-retire"); if (holdAt === "old-drain") await gate.promise;}};
  const next = {startupCreations: [{requestId: 1, status: "created", targetId: "new-owned-page"}],
    finishStartup() {calls.push("finish-startup");}, async terminate() {calls.push("new-retire");}, onMessage() {calls.push("new-listener");}};
  const owner = {assertCurrent() {if (!valid) throw new Error("Original connection lost");}, async closeTarget(id: string) {calls.push(`close:${id}`);}};
  const tab = {name: "original", worker: original as unknown, targetId: "original-adopted", state: "alive", connectionOwner: owner, dialogPolicy: "dismiss", activateForScreenshot: false, info: {old: true}};
  const tabs = new Map<string, any>([[tab.name, tab]]);
  const dependencies = {performance: {now: () => now}, ToolError: Error, tabs, getPuppeteerDir: () => "/controlled", workerPageTargets: new WeakMap(), handleTabMessage() {},
    async initializeOwnedAttempt(selected: unknown, payload: unknown, budget: number, start: number) {
      assert.equal(selected, owner); calls.push("new-init"); payloads.push({payload, budget, start});
      if (holdAt === "new-init") await gate.promise; return {worker: next, info: {fresh: true}};
    },
  };
  const body = sources[2]!.slice(sources[2]!.indexOf("async function recycleTimedOutWorkerTab("), sources[2]!.indexOf("async function forceKillTab("));
  const cleanup = sources[2]!.slice(sources[2]!.indexOf("async function closeUnpublishedWorkerTargets("), sources[2]!.indexOf("/** Retain one authenticated cmux connection"));
  const recycle = new Function(...Object.keys(dependencies), `${transform(body + cleanup)};return recycleTimedOutWorkerTab;`)(...Object.values(dependencies));
  return {run: () => recycle(tab, 1000), calls, payloads, tab, original, next, tabs, release() {gate.resolve();}, lose() {valid = false;}, time(value: number) {now = value;}};
}
test("recycle retains original attach target and one original deadline", async () => {
  const h = recycleCase("old-drain"), result = outcome(h.run()); await ticks(); assert.deepEqual(h.calls, ["old-retire"]);
  h.time(400); h.release(); await ticks(); assert.equal(result()?.ok, true); assert.equal(h.tab.worker, h.next);
  assert.deepEqual(h.calls, ["old-retire", "new-init", "finish-startup", "new-listener"]);
  assert.deepEqual(h.payloads, [{payload: {mode: "attach", safeDir: "/controlled", targetId: "original-adopted", dialogs: "dismiss", recover: true, timeoutMs: 1000, activateForScreenshot: false}, budget: 1000, start: 10}]);
});
test("recycle owner loss during old drain prevents any new attempt", async () => {
  const h = recycleCase("old-drain"), result = outcome(h.run()); await ticks(); h.lose(); h.release(); await ticks();
  assert.equal(result()?.ok, false); assert.deepEqual(h.calls, ["old-retire"]); assert.equal(h.tab.worker, h.original);
});
test("recycle stale new attempt drains only new creation receipts and never adopts it", async () => {
  const h = recycleCase("new-init"), result = outcome(h.run()); await ticks(); h.tabs.set("original", {replacement: true}); h.release(); await ticks();
  assert.equal(result()?.ok, false); assert.equal(h.tab.worker, h.original); assert.equal(h.tabs.get("original").replacement, true);
  assert.deepEqual(h.calls, ["old-retire", "new-init", "new-retire", "close:new-owned-page"]);
});

let failed = 0;
for (const [name, body] of tests) { try { await body(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } }
console.log(JSON.stringify({ passed: tests.length - failed, failed, inputs: [hostPath, channelPath, supervisorPath].map((path, i) => ({ path, sha256: createHash("sha256").update(sources[i]!).digest("hex") })) }));
if (failed) process.exitCode = 1;
