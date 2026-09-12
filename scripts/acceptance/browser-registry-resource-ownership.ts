/** Complete selected registry module with controlled browser, loader, process and filesystem boundaries. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
const args = process.argv.slice(2).filter(arg => arg !== "--pair");
if (args.length !== 2) throw new Error("Usage: browser-registry-resource-ownership.ts <registry.ts> <tab-supervisor.ts> [--pair]");
const selectedPath = args[0]!;
const source = await readFile(selectedPath, "utf8");
const supervisorPath = args[1]!;
const supervisorSource = await readFile(supervisorPath, "utf8");
function selectFunction(name: string) {
  const start = supervisorSource.indexOf(`function ${name}(`);
  const end = supervisorSource.indexOf("\n}\n", start);
  if (start < 0 || end < start) throw new Error(`Missing complete ${name}`);
  return supervisorSource.slice(start, end + 2);
}
const supervisorSelections = [selectFunction("acquireTab"), selectFunction("closeAbandonedWorkerPage")];
const selected = source.replace(/^import\b[\s\S]*?;\r?\n/gm, "");
const body = new Bun.Transpiler({ loader: "ts" }).transformSync(selected.replace(/^export /gm, ""));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Kind = { kind: string; headless?: boolean; path?: string; cdpUrl?: string; socketPath?: string; surface?: string };
type ResourceBrowser = { id: number; connected: boolean; close(): Promise<void>; disconnect(): void; process(): { pid: number } };
type Client = { id: number; connect(): Promise<void>; close(): void };
type Handle = { key: string; kind: Kind; refCount: number; client?: Client; browser?: ResourceBrowser; pid?: number; userDataDir?: string; sharedDaemon?: { name: string; projectDir: string }; stealth?: object };
type Options = { kill: boolean; timeoutMs?: number; resource?: string };
type Outcome = { ok: true } | { ok: false; error: string };
const ticks = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function tracked(promise: Promise<unknown>) {
  let result: Outcome | undefined;
  const settled = promise.then(() => { result = { ok: true }; }, error => { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; });
  return { pending: () => result === undefined, async done() { await settled; return result!; } };
}
function harness() {
  const calls: Array<{ op: string; id?: number; value?: unknown }> = [];
  const browsers: ResourceBrowser[] = [], clients: Client[] = [];
  let browserId = 0, clientId = 0;
  let shared = false;
  let openGate: Promise<void> | undefined, closeGate: Promise<void> | undefined;
  let connectGate: Promise<void> | undefined;
  let onClose: (browser: ResourceBrowser) => void = () => {};
  let onDisconnect: (browser: ResourceBrowser) => void = () => {};
  let onClientClose: (client: Client) => void = () => {};
  let removeFailure: string | undefined, killFailure: string | undefined;
  function makeBrowser(): ResourceBrowser {
    const browser: ResourceBrowser = {
      id: ++browserId, connected: true,
      async close() { calls.push({ op: "close", id: browser.id }); onClose(browser); if (closeGate) await closeGate; browser.connected = false; },
      disconnect() { calls.push({ op: "disconnect", id: browser.id }); onDisconnect(browser); browser.connected = false; },
      process() { return { pid: 5000 + browser.id }; },
    };
    browsers.push(browser); return browser;
  }
  class FakeClient implements Client {
    readonly id = ++clientId;
    constructor(options: unknown) { clients.push(this); calls.push({ op: "client.new", id: this.id, value: options }); }
    async connect() { calls.push({ op: "client.connect", id: this.id }); if (openGate) await openGate; }
    close() { calls.push({ op: "client.close", id: this.id }); onClientClose(this); }
  }
  const bindings: Record<string, unknown> = {
    path, isCompiledBinary: () => shared, workerHostEntry: () => null,
    logger: { debug(message: string, details: unknown) { calls.push({ op: "log", value: { message, details } }); } },
    withTimeout: async (promise: Promise<unknown>, timeout: number, message: string) => { calls.push({ op: "timeout.bound", value: { timeout, message } }); return await promise; },
    ToolError: Error, ToolAbortError: class extends Error {},
    findFreeCdpPort: async () => 9222,
    findReusableCdp: async () => undefined,
    gracefulKillTreeOnce: async (pid: number) => { calls.push({ op: "kill", value: pid }); if (killFailure) throw new Error(killFailure); },
    waitForCdp: async (url: string) => { calls.push({ op: "wait.cdp", value: url }); if (openGate) await openGate; },
    CmuxSocketClient: FakeClient,
    BROWSER_PROTOCOL_TIMEOUT_MS: 1000, DEFAULT_VIEWPORT: { width: 800, height: 600, deviceScaleFactor: 1 },
    launchHeadlessBrowser: async (options: unknown) => { calls.push({ op: "launch", value: options }); const browser = makeBrowser(); if (openGate) await openGate; return { browser, userDataDir: `/original/profile-${browser.id}` }; },
    loadPuppeteer: async () => ({ connect: async (options: unknown) => { calls.push({ op: "puppeteer.connect", value: options }); const browser = makeBrowser(); if (connectGate) await connectGate; return browser; } }),
    removeUserDataDir: async (directory: string) => { calls.push({ op: "remove", value: directory }); if (removeFailure) throw new Error(removeFailure); },
    reapOrphanSharedTargets: async (_browser: unknown, options: unknown) => { calls.push({ op: "reap", value: options }); },
    ensureRelayDaemon: async () => false, isLoopbackRelayUrl: () => false,
    ensureSharedBrowser: async (options: unknown) => { calls.push({ op: "shared.ensure", value: options }); if (openGate) await openGate; return { wsEndpoint: "ws://controlled/shared", projectDir: "/original/project", daemonName: "original-daemon" }; },
    Bun: { spawn(argv: string[]) { calls.push({ op: "spawn", value: argv }); return { pid: 7001, unref() {} }; } },
  };
  const api = new Function(...Object.keys(bindings), `${body}\nreturn { acquireBrowser, holdBrowser, releaseBrowser, getBrowsersMapForTest };`)(...Object.values(bindings)) as {
    acquireBrowser(kind: Kind, options: { cwd: string; signal?: AbortSignal }): Promise<Handle>;
    holdBrowser(handle: Handle): void;
    releaseBrowser(handle: Handle, options: Options): Promise<void>;
    getBrowsersMapForTest(): ReadonlyMap<string, Handle>;
  };
  return {
    calls, browsers, clients, api, makeBrowser,
    acquire(kind: Kind, signal?: AbortSignal) { return api.acquireBrowser(kind, { cwd: "/original/project", signal }); },
    setConnectGate(gate: Promise<void>) { connectGate = gate; },
    hold(handle: Handle) { api.holdBrowser(handle); },
    release(handle: Handle, options: Options = { kill: false }) { return api.releaseBrowser(handle, options); },
    useShared() { shared = true; },
    setOpenGate(gate: Promise<void>) { openGate = gate; },
    setCloseGate(gate: Promise<void>) { closeGate = gate; },
    setOnClose(callback: typeof onClose) { onClose = callback; },
    setOnDisconnect(callback: typeof onDisconnect) { onDisconnect = callback; },
    setOnClientClose(callback: typeof onClientClose) { onClientClose = callback; },
    failRemove(message: string) { removeFailure = message; },
    failKill(message: string) { killFailure = message; },
  };
}
const passed: string[] = [], failures: Array<{ name: string; error: string }> = [], evidence: Array<{ name: string; calls: unknown; result?: unknown }> = [];
async function scenario(name: string, run: (h: ReturnType<typeof harness>, report: (value: unknown) => void) => Promise<void>) {
  const h = harness(); let result: unknown;
  try { await run(h, value => { result = value; }); passed.push(name); }
  catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  finally { evidence.push({ name, calls: h.calls, result }); }
}
const cmux = (): Kind => ({ kind: "cmux", socketPath: "/original/cmux.sock" });
const headless = (): Kind => ({ kind: "headless", headless: true });
const spawned = (): Kind => ({ kind: "spawned", path: "/controlled/App" });
function resourceOps(h: ReturnType<typeof harness>, op: string) { return h.calls.filter(call => call.op === op); }

await scenario("acquired cmux owns original client and original registry key despite public edits", async (h, report) => {
  const handle = await h.acquire(cmux()); const originalKey = handle.key; const originalClient = handle.client!;
  handle.key = "foreign-key"; handle.client = { id: 999, async connect() {}, close() { h.calls.push({ op: "client.close", id: 999 }); } }; h.hold(handle);
  const result = await tracked(h.release(handle)).done(); report(result);
  assert.deepEqual(resourceOps(h, "client.close").map(call => call.id), [originalClient.id]);
  assert.equal(h.api.getBrowsersMapForTest().has(originalKey), false); assert.equal(result.ok, true);
});
for (const kind of ["connected", "relay"]) {
  await scenario(`${kind} disposal disconnects only captured browser regardless of changed kind`, async (h, report) => {
    const handle = await h.acquire({ kind, cdpUrl: `http://controlled/${kind}` }); const original = handle.browser!;
    h.hold(handle); const replacement = h.makeBrowser(); handle.browser = replacement; handle.kind.kind = "spawned"; handle.pid = 9901;
    const result = await tracked(h.release(handle, { kill: true })).done(); report(result);
    assert.deepEqual(resourceOps(h, "disconnect").map(call => call.id), [original.id]); assert.equal(replacement.connected, true);
    assert.deepEqual(resourceOps(h, "kill"), []); assert.deepEqual(resourceOps(h, "close"), []); assert.equal(result.ok, true);
  });
}
await scenario("headless awaited cleanup retains captured profile and browser", async (h, report) => {
  const handle = await h.acquire(headless()); const original = handle.browser!; const profile = handle.userDataDir;
  h.hold(handle); const gate = Promise.withResolvers<void>(); h.setCloseGate(gate.promise);
  const release = tracked(h.release(handle)); await ticks(); const held = release.pending();
  handle.browser = h.makeBrowser(); handle.userDataDir = "/foreign/profile"; handle.kind.kind = "connected";
  gate.resolve(); const result = await release.done(); report({ held, result });
  assert.equal(held, true); assert.deepEqual(resourceOps(h, "close").map(call => call.id), [original.id]);
  assert.deepEqual(resourceOps(h, "remove").map(call => call.value), [profile]); assert.equal(handle.browser.connected, true); assert.equal(result.ok, true);
});
await scenario("shared headless retains broker ownership instead of closing after public marker deletion", async (h, report) => {
  h.useShared(); const handle = await h.acquire(headless()); const original = handle.browser!;
  h.hold(handle); delete handle.sharedDaemon; handle.userDataDir = "/foreign/profile";
  const result = await tracked(h.release(handle, { kill: true })).done(); report(result);
  assert.deepEqual(resourceOps(h, "disconnect").map(call => call.id), [original.id]); assert.deepEqual(resourceOps(h, "close"), []);
  assert.deepEqual(resourceOps(h, "kill"), []); assert.deepEqual(resourceOps(h, "remove"), []); assert.equal(result.ok, true);
});
await scenario("spawned cleanup retains original pid and copies kill option before disconnect callback", async (h, report) => {
  const handle = await h.acquire(spawned()); const original = handle.browser!; h.hold(handle);
  const options = { kill: true }; h.setOnDisconnect(() => { handle.pid = 9999; options.kill = false; });
  const result = await tracked(h.release(handle, options)).done(); report(result);
  assert.deepEqual(resourceOps(h, "disconnect").map(call => call.id), [original.id]); assert.deepEqual(resourceOps(h, "kill").map(call => call.value), [7001]); assert.equal(result.ok, true);
});
await scenario("kind mutation during launch does not change acquired key or disposal policy", async (h, report) => {
  const kind = headless(); const gate = Promise.withResolvers<void>(); h.setOpenGate(gate.promise);
  const opening = h.acquire(kind); await ticks(); kind.kind = "connected"; kind.cdpUrl = "http://replacement"; kind.headless = false;
  gate.resolve(); const handle = await opening; h.hold(handle); const result = await tracked(h.release(handle)).done(); report({ key: handle.key, kind: handle.kind, result });
  assert.equal(handle.key, "headless:1"); assert.equal(handle.kind.kind, "headless"); assert.equal(handle.kind.headless, true);
  assert.equal(h.api.getBrowsersMapForTest().size, 0); assert.equal(resourceOps(h, "close").length, 1); assert.equal(resourceOps(h, "remove").length, 1);
});
await scenario("overlapping releases retain full profile-removal failure and cannot revive hold", async (h, report) => {
  const handle = await h.acquire(headless()); h.hold(handle); const gate = Promise.withResolvers<void>(); h.setCloseGate(gate.promise); h.failRemove("Profile removal failed");
  const first = tracked(h.release(handle)); const second = tracked(h.release(handle)); await ticks();
  const bothHeld = first.pending() && second.pending(); let holdError: string | undefined;
  try { h.hold(handle); } catch (error) { holdError = (error as Error).message; }
  gate.resolve(); const results = await Promise.all([first.done(), second.done()]); const repeated = await tracked(h.release(handle)).done(); report({ bothHeld, holdError, results, repeated });
  assert.equal(bothHeld, true); assert.match(holdError ?? "", /retiring/); assert.equal(resourceOps(h, "close").length, 1); assert.equal(resourceOps(h, "remove").length, 1);
  for (const result of [...results, repeated]) { assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error, "Profile removal failed"); }
});
await scenario("reentrant cmux release joins retained close error without repeating native callback", async (h, report) => {
  const handle = await h.acquire(cmux()); h.hold(handle); let nested: ReturnType<typeof tracked> | undefined; let entered = false;
  h.setOnClientClose(() => { if (!entered) { entered = true; nested = tracked(h.release(handle)); } throw new Error("Client close failed"); });
  const first = tracked(h.release(handle)); await ticks(); const firstResult = await first.done(); const nestedResult = nested ? await nested.done() : undefined;
  const repeated = await tracked(h.release(handle)).done(); report({ firstResult, nestedResult, repeated });
  assert.equal(resourceOps(h, "client.close").length, 1); assert(nestedResult);
  for (const result of [firstResult, nestedResult, repeated]) { assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error, "Client close failed"); }
});
await scenario("spawned kill failure remains visible to later release callers", async (h, report) => {
  const handle = await h.acquire(spawned()); h.hold(handle); h.failKill("Process cleanup failed");
  const first = await tracked(h.release(handle, { kill: true })).done(); const repeated = await tracked(h.release(handle, { kill: false })).done(); report({ first, repeated });
  assert.equal(resourceOps(h, "kill").length, 1); for (const result of [first, repeated]) { assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error, "Process cleanup failed"); }
});
await scenario("fresh same-key handle survives held old cleanup and remains reusable", async (h, report) => {
  const old = await h.acquire(headless()); h.hold(old); const gate = Promise.withResolvers<void>(); h.setCloseGate(gate.promise);
  const retiring = tracked(h.release(old)); await ticks(); const fresh = await h.acquire(headless()); h.hold(fresh);
  gate.resolve(); const result = await retiring.done(); const selected = await h.acquire(headless()); report({ result, oldBrowser: old.browser!.id, freshBrowser: fresh.browser!.id, selectedBrowser: selected.browser!.id });
  assert.equal(selected.browser!.id, fresh.browser!.id); assert.notEqual(selected.browser!.id, old.browser!.id);
  assert.equal(fresh.browser!.connected, true); assert.equal(resourceOps(h, "close").length, 1); await h.release(fresh);
});
await scenario("external structural handle captures resources at first hold", async (h, report) => {
  const original = h.makeBrowser(); const handle: Handle = { key: "external", kind: { kind: "connected", cdpUrl: "http://external" }, refCount: 0, browser: original };
  h.hold(handle); const replacement = h.makeBrowser(); handle.browser = replacement;
  const result = await tracked(h.release(handle)).done(); report(result); assert.deepEqual(resourceOps(h, "disconnect").map(call => call.id), [original.id]); assert.equal(replacement.connected, true);
});
await scenario("configured spawned non-kill release disconnects without process destruction", async (h, report) => {
  const handle = await h.acquire(spawned()); h.hold(handle); const result = await tracked(h.release(handle, { kill: false })).done(); report(result);
  assert.equal(resourceOps(h, "disconnect").length, 1); assert.equal(resourceOps(h, "kill").length, 0); assert.equal(result.ok, true);
});
await scenario("headless close rejection retains existing fallback and profile removal behavior", async (h, report) => {
  const handle = await h.acquire(headless()); h.hold(handle); h.setOnClose(() => { throw new Error("Controlled browser close failure"); });
  const result = await tracked(h.release(handle)).done(); report(result);
  assert.equal(result.ok, true); assert.deepEqual(resourceOps(h, "kill").map(call => call.value), [5000 + handle.browser!.id]); assert.equal(resourceOps(h, "remove").length, 1); assert.equal(resourceOps(h, "log").length, 1);
});

function supervisor(h: ReturnType<typeof harness>) {
  const targets = new Map<object, string>();
  const calls: string[] = [];
  const bindings = {
    holdBrowser: h.api.holdBrowser, releaseBrowser: h.api.releaseBrowser,
    captureCmuxTabClient: () => { throw new Error("Unexpected cmux caller"); },
    acquireChains: new Map<string, Promise<void>>(), workerPageTargets: targets,
    acquireTabImpl: async (name: string) => { calls.push(`acquire:${name}`); return { name }; },
    closeTargetById: async (_handle: Handle, id: string) => { calls.push(`close:${id}`); },
  };
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(supervisorSelections.join("\n"));
  const api = new Function(...Object.keys(bindings), `${code}\nreturn { acquireTab, closeAbandonedWorkerPage };`)(...Object.values(bindings)) as {
    acquireTab(name: string, handle: Handle, options: object): Promise<{ name: string }>;
    closeAbandonedWorkerPage(handle: Handle, worker: object): void;
  };
  return { api, targets, calls };
}
await scenario("retired hold rejects public acquisition asynchronously without worker dispatch", async (h, report) => {
  const handle = await h.acquire(headless()); h.hold(handle); await h.release(handle);
  const s = supervisor(h); let syncError: string | undefined; let pending: Promise<{ name: string }> | undefined;
  try { pending = s.api.acquireTab("new-page", handle, {}); } catch (error) { syncError = (error as Error).message; }
  const result = pending ? await tracked(pending).done() : undefined; report({ syncError, result, calls: s.calls });
  assert.equal(syncError, undefined); assert(result && !result.ok); assert.match(result.error, /retiring/); assert.deepEqual(s.calls, []);
});
await scenario("retired best-effort abandoned cleanup preserves initialization error and performs no close", async (h, report) => {
  const handle = await h.acquire(headless()); h.hold(handle); await h.release(handle);
  const s = supervisor(h), worker = {}; s.targets.set(worker, "original-target");
  let error: string | undefined;
  try { s.api.closeAbandonedWorkerPage(handle, worker); throw new Error("Worker initialization failed"); } catch (failure) { error = (failure as Error).message; }
  await ticks(); report({ error, calls: s.calls });
  assert.equal(error, "Worker initialization failed"); assert.deepEqual(s.calls, []); assert.equal(s.targets.has(worker), false); assert.equal(handle.refCount, 0);
});
await scenario("live callers preserve acquisition and best-effort target close", async (h, report) => {
  const handle = await h.acquire(headless()); h.hold(handle); const s = supervisor(h), worker = {};
  const created = await s.api.acquireTab("new-page", handle, {});
  s.targets.set(worker, "original-target"); s.api.closeAbandonedWorkerPage(handle, worker); await ticks();
  report({ created, calls: s.calls, refs: handle.refCount });
  assert.equal(created.name, "new-page"); assert.deepEqual(s.calls, ["acquire:new-page", "close:original-target"]);
  assert.equal(handle.refCount, 1); assert.equal(handle.browser!.connected, true); await h.release(handle);
});

for (const mutate of [false, true]) {
  await scenario(`aborted spawned open retains original kill policy with caller mutation=${mutate}`, async (h, report) => {
    const kind = spawned(); const gate = Promise.withResolvers<void>(); const abort = new AbortController(); h.setConnectGate(gate.promise);
    const opening = tracked(h.acquire(kind, abort.signal)); await ticks();
    const reachedConnect = resourceOps(h, "puppeteer.connect").length;
    if (mutate) { kind.kind = "connected"; kind.cdpUrl = "http://replacement"; }
    abort.abort(); gate.resolve(); const result = await opening.done(); report({ reachedConnect, result });
    assert.equal(reachedConnect, 1); assert.equal(result.ok, false);
    assert.deepEqual(resourceOps(h, "kill").map(call => call.value), [7001]);
    assert.equal(resourceOps(h, "disconnect").length, 1); assert.equal(h.api.getBrowsersMapForTest().size, 0);
    assert.equal(resourceOps(h, "spawn").length, 1);
  });
}
await scenario("aborted connected open cannot escalate to spawned cleanup by caller mutation", async (h, report) => {
  const kind: Kind = { kind: "connected", cdpUrl: "http://original" }; const gate = Promise.withResolvers<void>(); const abort = new AbortController(); h.setConnectGate(gate.promise);
  const opening = tracked(h.acquire(kind, abort.signal)); await ticks(); kind.kind = "spawned"; kind.path = "/replacement/App";
  abort.abort(); gate.resolve(); const result = await opening.done(); report(result);
  assert.equal(result.ok, false); assert.equal(resourceOps(h, "disconnect").length, 1); assert.deepEqual(resourceOps(h, "kill"), []);
  assert.equal(resourceOps(h, "spawn").length, 0); assert.equal(h.api.getBrowsersMapForTest().size, 0);
});

console.log(JSON.stringify({ supervisorPath, supervisorSha256: hash(supervisorSource), supervisorSelections: supervisorSelections.map(value => ({ bytes: Buffer.byteLength(value), sha256: hash(value) })), selectedPath, sourceSha256: hash(source), sourceBytes: Buffer.byteLength(source), completeModuleWithoutImportsSha256: hash(selected), passed, failures, counts: { pass: passed.length, fail: failures.length }, evidence,
  limits: "Whole selected registry module with imports removed and exact source body transpiled. Browser/client/loader/launch/process/profile/broker dependencies are controlled; no SDK, native, network, child process, filesystem cleanup or real timer execution. withTimeout awaits the supplied controlled promise and records its bound; no wallclock timeout proof. Existing swallowed browser disconnect/close errors remain existing behavior; retained failures tested on client close, profile removal and spawned kill. Structural external handle protection begins at first hold only. No server incarnation/native target lifetime or full registry concurrency proof. Same fixture and injected boundaries for either selected registry. Two complete selected supervisor functions use the actual selected registry hold/release with controlled worker dispatch/target cleanup; the initialization error control is a caller model, not full worker initialization." }, null, 2));
if (failures.length) process.exitCode = 1;
