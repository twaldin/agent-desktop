/** Actual selected Core, host, both channels, native transport and initialization function. All external operations injected; no SDK/Worker/IPC/native process. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const paths = process.argv.slice(2);
if (paths.length !== 5) throw new Error("Expected Core, channel, host, owned transport and supervisor source paths");
const sources = await Promise.all(paths.map(path => readFile(path, "utf8")));
const transform = (source: string) => new Bun.Transpiler({loader: "ts"}).transformSync(source.replace(/^import\b[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""));
const {ParentWorkerCdpChannel, WorkerCdpChannel} = new Function(`${transform(sources[1]!)};return {ParentWorkerCdpChannel, WorkerCdpChannel};`)();
type Frame = {type: string; [key: string]: any};
type Wire = {send(raw: string): void; onmessage?: (raw: string) => void; onclose?: () => void; close(): void; dispose(): Promise<void>; startupCreations?: readonly any[]};
type Handle = {send(frame: Frame): void; terminate(): Promise<void>; abort(error: Error): Promise<void>; assertActive(): void; finishStartup(): void; startupCreations: readonly any[]; createdTargetId?: string; onMessage(fn: (frame: Frame) => void): () => void; onError(fn: (error: Error) => void): () => void};
const ticks = async () => {for (let i = 0; i < 300; i++) await Promise.resolve();};
const flatten = (error: unknown): string[] => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error instanceof Error ? error.message : String(error)];
function tracked(promise: Promise<unknown>) {
  let result: {ok: boolean; value?: unknown; errors: string[]} | undefined;
  const done = promise.then(value => {result = {ok: true, value, errors: []};}, error => {result = {ok: false, errors: flatten(error)};});
  return {result: () => result, pending: () => !result, done: async () => {await done; return result!;}};
}
type Callback = (...args: any[]) => void;
class Emitter {
  readonly listeners = new Map<string | symbol, Set<Callback>>();
  on(name: string | symbol, callback: Callback) {if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(callback); return this;}
  off(name: string | symbol, callback: Callback) {this.listeners.get(name)?.delete(callback); return this;}
  emit(name: string | symbol, ...args: unknown[]) {for (const callback of [...this.listeners.get(name) ?? []]) callback(...args); for (const callback of [...this.listeners.get("*") ?? []]) callback(name, ...args);}
}
function harness(hold?: "loader" | "create" | "navigate" | "detach") {
  const gate = Promise.withResolvers<void>(), nativeReply = Promise.withResolvers<unknown>();
  const calls: string[] = [], messages: Frame[] = [], connects: Record<string, unknown>[] = [], budgets: number[] = [];
  const eventNames = {SessionAttached: "attached", Disconnected: Symbol("disconnected")};
  let now = 0, next = 0, pageCloses = 0, nativeCreated = false, constructorFails = false, navigateFails = false;
  let onMessage: ((frame: Frame) => void) | undefined, facade: Wire | undefined;
  const rpcPending = new Map<number, ReturnType<typeof Promise.withResolvers<any>>>();
  const cores: any[] = [], ports: ControlledWorker[] = [], handles: Handle[] = [];
  class NativeConnection {
    _closed = false; readonly _sessions = new Map<string, NativeSession>();
    _session(id: string) {return this._sessions.get(id);}
    async send(method: string) {calls.push(`native:${method}`); if (method === "Target.attachToBrowserTarget") return {sessionId: "owned-root"}; if (method === "Target.detachFromTarget") {if (hold === "detach") await gate.promise; return {}; } throw new Error(`Unexpected native root command ${method}`);}
  }
  class NativeSession extends Emitter {
    detached = false;
    constructor(readonly origin: NativeConnection, _kind: string, readonly selectedId: string, readonly parent?: NativeSession) {super();}
    id() {return this.selectedId;} connection() {return this.origin;} parentSession() {return this.parent;}
    onClosed() {this.detached = true; this.emit(eventNames.Disconnected);}
    async send(method: string) {
      calls.push(`native-session:${method}`);
      if (method === "Target.createTarget") {if (hold === "create") {const result = await nativeReply.promise; nativeCreated = true; return result;} nativeCreated = true; return {targetId: "original-created"};}
      if (method === "Page.navigate") {if (hold === "navigate") await gate.promise; if (navigateFails) throw new Error("Original navigation failed");}
      if (method === "Target.closeTarget") nativeCreated = false;
      return {};
    }
  }
  const native = new NativeConnection(), browserOwner = {connected: true, _connection: native};
  const capture = new Function("CdpCDPSession", "CDPSessionEvent", `${transform(sources[3]!)};return captureOwnedCdpTransport;`)(NativeSession, eventNames);
  const rpc = (method: string, params: unknown = {}) => {
    if (!facade) throw new Error("Missing original facade");
    const id = ++next, done = Promise.withResolvers<any>(); rpcPending.set(id, done);
    try {facade.send(JSON.stringify({id, method, params}));} catch (error) {rpcPending.delete(id); done.reject(error);}
    return done.promise;
  };
  const session = {send: rpc, async detach() {}};
  const page = {
    target: () => target, isClosed: () => false, on() {return page;}, off() {return page;}, once() {return page;}, removeAllListeners() {return page;},
    mainFrame: () => ({}), viewport: () => ({width: 800, height: 600}), url: () => "https://original.test/", title: async () => "Original",
    goto: async (url: string) => rpc("Page.navigate", {url}), createCDPSession: async () => session,
    async close() {pageCloses++; await rpc("Target.closeTarget", {targetId: "original-created"});}, async setRequestInterception() {},
  };
  const target = {_targetId: "original-created", page: async () => page, createCDPSession: async () => session};
  const browser = {connected: true, target: () => target, targets: () => [target], waitForTarget: async () => target,
    disconnect() {calls.push("facade.disconnect"); browser.connected = false; facade?.close();},
  };
  const dependencies = {
    Bun: {sleep: async () => {}}, AbortSignal: {timeout: () => new AbortController().signal, any: AbortSignal.any.bind(AbortSignal)},
    JsRuntime: class {setCwd() {} setRunScope() {}}, RunOutput: class {finish() {return []; }},
    withTimeout: (promise: Promise<unknown>) => promise, cloneSafe: structuredClone,
    WorkerCdpChannel, CELL_BUDGET_SLACK_MS: 100, BROWSER_PROTOCOL_TIMEOUT_MS: 1000, DEFAULT_VIEWPORT: {width: 800, height: 600},
    postmortem: {interceptUnhandledRejections: () => () => {}, markExpectedCleanupError: (error: unknown) => error, isExpectedCleanupError: () => false},
    installBrowserWorkerRejectionGuard: () => () => {}, ToolError: class ToolError extends Error {}, ToolAbortError: class ToolAbortError extends Error {},
    async loadPuppeteerInWorker() {
      if (hold === "loader") await gate.promise;
      return {async connect(options: Record<string, unknown>) {
        connects.push(options); assert.equal(options.browserWSEndpoint, undefined); facade = options.transport as Wire;
        facade.onmessage = raw => {const frame = JSON.parse(raw); const done = rpcPending.get(frame.id); if (!done) return; rpcPending.delete(frame.id); frame.error ? done.reject(new Error(frame.error.message)) : done.resolve(frame.result);};
        facade.onclose = () => {browser.connected = false; for (const done of rpcPending.values()) done.reject(new Error("Original channel closed")); rpcPending.clear();};
        await rpc("Browser.getVersion"); return browser;
      }};
    },
    applyStealthPatches: async () => {}, applyViewport: async () => {},
  };
  const ActualCore = new Function(...Object.keys(dependencies), `${transform(sources[0]!)};return WorkerCore;`)(...Object.values(dependencies));
  class RecordedCore extends ActualCore {constructor(port: unknown, isolated: boolean) {super(port, isolated); cores.push(this);}}
  class ControlledWorker extends Emitter {
    alive = true; inbox?: (frame: Frame) => void;
    constructor() {
      super(); if (constructorFails) throw new Error("Controlled Worker constructor unavailable"); ports.push(this);
      const port = {send: (frame: Frame) => {messages.push(structuredClone(frame)); queueMicrotask(() => {if (this.alive) this.emit("message", {data: frame});});},
        onMessage: (callback: (frame: Frame) => void) => {this.inbox = callback; return () => {this.inbox = undefined;};},
        close: () => {calls.push("child-port.close");},
      };
      new RecordedCore(port, true);
    }
    addEventListener(name: string, callback: Callback) {this.on(name, callback);} removeEventListener(name: string, callback: Callback) {this.off(name, callback);}
    postMessage(frame: Frame) {queueMicrotask(() => {if (this.alive) this.inbox?.(frame);});}
    terminate() {calls.push("controlled-force"); this.alive = false; return undefined;}
  }
  const hostDeps = {ParentWorkerCdpChannel, Worker: ControlledWorker, workerHostEntry: () => undefined, logger: {warn() {}}, loadWorker: async () => ({WorkerCore: RecordedCore})};
  const hostSource = sources[2]!.replace('import.meta.url', JSON.stringify(`file://${paths[2]}`)).replace('import("./tab-worker")', 'loadWorker()');
  const host = new Function(...Object.keys(hostDeps), `${transform(hostSource)};return {spawnInlineWorker, spawnTabWorker};`)(...Object.values(hostDeps));
  const selectedInit = sources[4]!.slice(sources[4]!.indexOf("async function initializeTabWorker("), sources[4]!.indexOf("/**\n * True once the caller's init budget"));
  const initDeps = {performance: {now: () => now}, ToolError: Error, ToolAbortError: Error, workerPageTargets: new WeakMap(), SETUP_BUDGET_FLOOR_MS: 2000, SETUP_BUDGET_CAP_MS: 5000,
    async raceWithTimeout(promise: Promise<unknown>, budget: number) {budgets.push(budget); return await promise;},
    markReportedInitFailure: (error: unknown) => error, errorFromPayload: (payload: {message: string}) => new Error(payload.message), logWorkerMessage() {},
  };
  const initialize = new Function(...Object.keys(initDeps), `${transform(selectedInit)};return initializeTabWorker;`)(...Object.values(initDeps));
  return {
    calls, messages, connects, budgets, cores, ports,
    async spawn(mode: "inline" | "worker" = "inline") {
      const owned = await capture(browserOwner, 1000); const handle: Handle = await (mode === "inline" ? host.spawnInlineWorker(owned, "original-attempt") : host.spawnTabWorker(owned, "original-attempt")); handles.push(handle);
      handle.onMessage(frame => {if (!ports.length) messages.push(structuredClone(frame)); onMessage?.(frame);}); return handle;
    },
    init(handle: Handle, mode: "headless" | "attach" = "headless") {return initialize(handle, {mode, cdpChannel: "original-attempt", safeDir: "/controlled", targetId: "original-created", timeoutMs: 1000, url: "https://destination.test/"}, 1000, 0);},
    releaseCreate(value: unknown = {targetId: "original-created"}) {nativeReply.resolve(value);}, rejectCreate() {nativeReply.reject(new Error("Original creation reply lost"));},
    release() {gate.resolve();}, time(value: number) {now = value;}, failNavigation() {navigateFails = true;}, failConstruction() {constructorFails = true;},
    effect(callback: (frame: Frame) => void) {onMessage = callback;}, stats: () => ({nativeCreated, pageCloses, nativeSessions: native._sessions.size, pendingRpc: rpcPending.size}),
    async finish() {
      gate.resolve(); nativeReply.resolve({targetId: "original-created"}); await ticks();
      // Explicitly settle controlled, retained Core promises even when the fake physical port drops delivery.
      await Promise.allSettled(cores.map(core => core.abort(new Error("Controlled fixture finished")))); await ticks();
      await Promise.allSettled(handles.map(handle => handle.abort(new Error("Controlled fixture finished"))));
    },
  };
}
const passed: string[] = [], failures: Array<{name: string; errors: string[]}> = [];
async function scenario(name: string, hold: Parameters<typeof harness>[0], run: (h: ReturnType<typeof harness>) => Promise<void>) {
  const h = harness(hold); try {await run(h); passed.push(name);} catch (error) {failures.push({name, errors: flatten(error)});} finally {await h.finish();}
}
for (const adapter of ["inline", "worker"] as const) for (const mode of ["headless", "attach"] as const) {
  await scenario(`${adapter} actual host/Core startup and explicit ${mode} close`, undefined, async h => {
    const handle = await h.spawn(adapter), initialized = tracked(h.init(handle, mode)); await ticks();
    assert.equal(initialized.result()?.ok, true, JSON.stringify(initialized.result())); handle.finishStartup();
    assert.equal(h.connects.length, 1); assert.equal(h.connects[0]!.browserWSEndpoint, undefined);
    assert.equal(handle.startupCreations.length, mode === "headless" ? 1 : 0);
    handle.send({type: "close"}); const done = tracked(handle.terminate()); await ticks();
    assert.equal(done.result()?.ok, true, JSON.stringify(done.result())); assert.equal(h.stats().pageCloses, mode === "headless" ? 1 : 0);
    assert.equal(h.stats().nativeSessions, 0); assert.equal(h.stats().pendingRpc, 0);
  });
}
await scenario("construction-only fallback installs the actual inline Core once", undefined, async h => {
  h.failConstruction(); const handle = await h.spawn("worker"), initialized = tracked(h.init(handle)); await ticks();
  assert.equal(initialized.result()?.ok, true); assert.equal(h.cores.length, 1); assert.equal(h.ports.length, 0); handle.finishStartup();
  const done = tracked(handle.terminate()); await ticks(); assert.equal(done.result()?.ok, true); assert.equal(h.stats().pageCloses, 0);
});
await scenario("retirement during actual inline loader joins it without later connect", "loader", async h => {
  const handle = await h.spawn(), initialized = tracked(h.init(handle)); await ticks(); const done = tracked(handle.terminate()); await ticks();
  assert(done.pending()); h.release(); await ticks(); assert.equal(done.result()?.ok, true); assert.equal(h.connects.length, 0);
  assert.equal(initialized.result()?.ok, false); assert.equal(h.stats().nativeSessions, 0);
});
for (const adapter of ["inline", "worker"] as const) {
  await scenario(`${adapter} graceful retirement joins sent creation and settles startup`, "create", async h => {
    const handle = await h.spawn(adapter), initialized = tracked(h.init(handle)); await ticks();
    const done = tracked(handle.terminate()); await ticks(); assert(done.pending()); assert(initialized.pending());
    h.releaseCreate(); await ticks(); assert.equal(done.result()?.ok, true, JSON.stringify(done.result()));
    assert.equal(initialized.result()?.ok, false); assert.equal(h.messages.some(frame => frame.type === "ready"), false);
    assert.equal(handle.startupCreations[0]?.targetId, "original-created"); assert.equal(h.stats().nativeSessions, 0);
  });
}
await scenario("physical loss while create is held keeps the parent receipt until the native reply", "create", async h => {
  const handle = await h.spawn("worker"), initialized = tracked(h.init(handle)); await ticks();
  const done = tracked(handle.abort(new Error("Original worker lost"))); await ticks();
  assert(done.pending()); assert.equal(h.calls.includes("native:Target.detachFromTarget"), false);
  h.releaseCreate(); await ticks(); assert.equal(done.pending(), false); assert.equal(initialized.result()?.ok, false);
  assert.deepEqual(handle.startupCreations, [{requestId: 2, status: "created", targetId: "original-created"}]);
  assert.equal(handle.createdTargetId, undefined); assert.equal(h.messages.some(frame => frame.type === "ready"), false);
  assert.equal(h.stats().nativeSessions, 0); assert.equal(h.stats().nativeCreated, true);
});
await scenario("lost native create reply remains unknown through actual host drain", "create", async h => {
  const handle = await h.spawn("worker"); tracked(h.init(handle)); await ticks(); const done = tracked(handle.abort(new Error("Original worker lost")));
  h.rejectCreate(); await ticks(); assert.equal(done.result()?.ok, false); assert.ok(done.result()?.errors.some(error => error.includes("creation reply lost")));
  assert.equal(handle.startupCreations[0]?.status, "unknown"); assert.equal(h.calls.filter(call => call === "native-session:Target.createTarget").length, 1);
});
await scenario("normal operation failure reports once and graceful retirement preserves cleanup", undefined, async h => {
  h.failNavigation(); const handle = await h.spawn(), initialized = tracked(h.init(handle)); await ticks();
  assert.equal(initialized.result()?.ok, false); assert.equal(h.messages.filter(frame => frame.type === "init-failed").length, 1);
  const done = tracked(handle.terminate()); await ticks(); assert.equal(done.result()?.ok, true); assert.equal(h.stats().pageCloses, 1); assert.equal(h.stats().nativeCreated, false);
});
console.log(JSON.stringify({passed, failures, inputs: paths.map((path, i) => ({path, sha256: createHash("sha256").update(sources[i]!).digest("hex")})), limits: "Complete selected Core, host, both channels, owned transport and actual supervisor initialization function. Puppeteer loader/facade, native Connection/CDPSession, Worker port/process behavior and clocks are controlled substitutes. No real Worker/SDK/network/IPC/native execution, physical exit or backend compatibility proof. Force drops controlled port delivery; fixture teardown explicitly settles remaining simulated Core promises. Orphan closure is not performed by this fixture; parent known/unknown receipts are inspected."}, null, 2));
if (failures.length) process.exitCode = 1;
