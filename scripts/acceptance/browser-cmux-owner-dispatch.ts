/** Actual supervisor sections, complete CmuxTab class and accepted socket client; controlled transport only. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";

const positional = process.argv.slice(2).filter(value => value !== "--pair");
const nativeRoot = positional[0];
if (!nativeRoot || positional.length > 2) throw new Error("Usage: browser-cmux-owner-dispatch.ts <nativeRoot> [beforeSupervisorPath] [--pair]");
const supervisorPath = positional[1] ?? `${nativeRoot}/src/tools/browser/tab-supervisor.ts`;
const paths = [supervisorPath, `${nativeRoot}/src/tools/browser/cmux/cmux-tab.ts`, `${nativeRoot}/../dependencies/src/tools/browser/cmux/socket-client.ts`, `${nativeRoot}/../dependencies/src/tools/browser/cmux/surface-observation.ts`];
const [supervisor, tabSource, clientSource, observationSource] = await Promise.all(paths.map(path => readFile(path, "utf8"))) as [string, string, string, string];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const transpiler = new Bun.Transpiler({ loader: "ts" });
function section(source: string, start: string, end: string): string {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`Missing selected source section ${start}`);
  return source.slice(a, b);
}
const helper = supervisor.includes("function captureCmuxTabClient(")
  ? section(supervisor, "function captureCmuxTabClient(", "async function acquireCmuxTab(") : "";
const acquire = section(supervisor, "async function acquireCmuxTab(", "export async function runInTab(");
const acquisition = section(supervisor, "export function getTab(", "export async function runInTab(");
const release = section(supervisor, "async function releaseTabSession(", "async function releaseMatchingTabs(");
const classSource = section(tabSource, "export class CmuxTab {", "class CmuxResponse {");
const numberFrom = tabSource.slice(tabSource.indexOf("function numberFrom("));
const clientSuffix = clientSource.slice(clientSource.indexOf("const DEFAULT_CONNECT_TIMEOUT_MS"));
const compile = (value: string) => transpiler.transformSync(value.replace(/^export /gm, ""));
const observationFunctions = section(supervisor, "function rememberTabObservation(", "const viewportCaptures =");
const captureCmuxObservation = new Function(`${compile(observationSource.replace(/^import type[^;]+;\n/gm, ""))}\nreturn captureCmuxSurfaceObservation;`)() as (client: unknown, timeout: number) => unknown;
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
const CmuxTab = new Function("ToolError", "throwIfAborted", "untilAborted", "DEFAULT_VIEWPORT", "GEOMETRY_SCRIPT", "mapWaitUntil",
  `${compile(classSource + "\n" + numberFrom)}\nreturn CmuxTab;`)(Error,
  (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("Controlled run aborted"); },
  (_signal: AbortSignal | undefined, run: () => Promise<unknown>) => run(), viewport, "controlled geometry", (value: string) => value,
) as new (options: object) => Tab;

type RequestOptions = { timeoutMs?: number; connectionGeneration?: number; checkedReply?: boolean };
type Client = { connect(): Promise<void>; close(): void; readonly connectionGeneration?: number; request(method: string, params: Record<string, unknown>, options?: RequestOptions): Promise<Record<string, unknown>> };
type Tab = { goto(url: string, options?: object): Promise<void>; setRunContext(context: object): void; closeSurface(timeout?: number): Promise<void> };
type Session = { name: string; targetId: string; cmuxTab: Tab; state: string; pending: Map<string, unknown>; cmuxOwnsSurface: boolean };
type Wire = { id: string; method: string; params: Record<string, unknown> };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };
const ticks = async () => { for (let index = 0; index < 48; index++) await Promise.resolve(); };
function track<T>(promise: Promise<T>) {
  let result: Outcome<T> | undefined;
  const settled = promise.then(value => { result = { ok: true, value }; }, error => { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; });
  return { async done() { for (let index = 0; index < 12 && !result; index++) await ticks(); if (!result) throw new Error("Controlled operation did not settle after all supplied replies"); await settled; return result; } };
}
class Socket extends EventEmitter {
  destroyed = false;
  writes: Wire[] = [];
  constructor(readonly onWrite: (socket: Socket, wire: Wire) => void) { super(); }
  setEncoding(_encoding: string) { return this; }
  write(raw: string, _callback: (error?: Error) => void) { const wire = JSON.parse(raw) as Wire; this.writes.push(wire); this.onWrite(this, wire); return true; }
  end() { return this; }
  destroy() { this.destroyed = true; return this; }
  reply(wire: Wire, result: Record<string, unknown>) { this.emit("data", JSON.stringify({ id: wire.id, ok: true, result }) + "\n"); }
  fail(wire: Wire, message: string) { this.emit("data", JSON.stringify({ id: wire.id, ok: false, error: { code: "controlled_failure", message } }) + "\n"); }
}
function harness() {
  const events: Array<{ client: string; socket: number; method: string; params: Record<string, unknown> }> = [];
  const clients: Array<{ client: Client; sockets: Socket[] }> = [];
  const timers = new Map<number, () => void>(); let timerId = 0;
  let policy: (name: string, socket: Socket, wire: Wire) => boolean = () => false;
  function backend(name: string) {
    const sockets: Socket[] = [];
    const Class = new Function("randomUUID", "net", "os", "path", "ToolError", "setTimeout", "clearTimeout", `${compile(clientSuffix)}\nreturn CmuxSocketClient;`)(
      randomUUID, { createConnection() {
        const socket = new Socket((selected, wire) => {
          events.push({ client: name, socket: sockets.indexOf(selected), method: wire.method, params: wire.params });
          if (policy(name, selected, wire)) return;
          queueMicrotask(() => selected.reply(wire, wire.method === "browser.open_split" ? { surface_id: "original-surface", url: "about:blank" }
            : wire.method === "browser.url.get" ? { url: "https://original.test/" }
            : wire.method === "browser.navigate" ? { url: wire.params.url }
            : wire.method === "browser.eval" ? { value: wire.params.script === "document.title" ? "Original title" : viewport } : {}));
        });
        sockets.push(socket); queueMicrotask(() => socket.emit("connect")); return socket;
      } }, { homedir() { throw new Error("Unexpected credentials lookup"); } }, {}, Error,
      (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, (id: number) => timers.delete(id),
    ) as new (options: object) => Client;
    const client = new Class({ socketPath: "/controlled/cmux.sock", relayId: "", relayToken: "" });
    const value = { client, sockets }; clients.push(value); return value;
  }
  const a = backend("A");
  const browser = { client: a.client, kind: { kind: "cmux" }, surface: undefined as string | undefined };
  const tabs = new Map<string, Session>(); const acquireChains = new Map<string, Promise<void>>(); const tabObservations = new WeakMap<object, unknown>();
  let releaseEffect = () => {};
  const counters = { holds: 0, releases: 0, captures: 0 };
  const api = new Function("ToolError", "ToolAbortError", "CmuxTab", "captureBrowserTargetObservation", "captureCmuxSurfaceObservation", "holdBrowser", "tabs", "DEFAULT_VIEWPORT", "mapWaitUntil", "process", "postmortem", "DEFAULT_TAB_CLOSE_TIMEOUT_MS", "waitForTabCleanup", "isLastSurfaceCloseError", "logger", "releaseBrowser", "acquireChains", "killedTabs", "performance", "BrowserTabCreateRejected", "tabObservations",
    `${compile(observationFunctions + "\n" + acquisition + "\n" + release)}\nreturn { acquireTab, releaseTabSession };`)(
      Error, Error, CmuxTab, async () => { throw new Error("Unexpected Puppeteer capture"); },
      (client: unknown, timeout: number) => { counters.captures++; return captureCmuxObservation(client, timeout); },
      () => counters.holds++, tabs, viewport, (value: string) => value, { env: {} }, { markExpectedCleanupError: (error: Error) => error }, 1000,
      (_tab: unknown, _timeout: number, _resource: string, promise: Promise<unknown>) => promise, () => false, { debug() {} }, async () => { counters.releases++; releaseEffect(); }, acquireChains, new Map(), { now: () => 0 }, Error, tabObservations,
    ) as { acquireTab(name: string, browser: unknown, options: object): Promise<{ tab: Session; created: boolean }>; releaseTabSession(tab: Session, options: object): Promise<void> };
  return {
    a, browser, tabs, counters, events, backend,
    setPolicy(value: typeof policy) { policy = value; },
    setReleaseEffect(value: () => void) { releaseEffect = value; },
    holdName() { const gate = Promise.withResolvers<void>(); acquireChains.set("selected", gate.promise); return () => gate.resolve(); },
    async open(attached = false) { return api.acquireTab("selected", browser, { ownerSessionId: "owner", timeoutMs: 1000, dialogs: "dismiss", ...(attached ? { cmuxSurface: "attached-surface", url: "https://selected.test/" } : {}) }); },
    release(tab: Session) { return api.releaseTabSession(tab, { timeoutMs: 1000 }); },
    async replaceConnection() { a.sockets.at(-1)!.emit("close"); await a.client.connect(); await ticks(); },
    async finish() { policy = () => false; for (const item of clients) item.client.close(); timers.clear(); await ticks(); },
  };
}
const passed: string[] = [], failures: Array<{ name: string; error: string }> = [], evidence: Array<{ name: string; events: unknown; counters: unknown; result?: unknown }> = [];
async function scenario(name: string, run: (h: ReturnType<typeof harness>, report: (value: unknown) => void) => Promise<void>) {
  const h = harness(); let result: unknown;
  try { await h.a.client.connect(); await run(h, value => { result = value; }); passed.push(name); }
  catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  finally { await h.finish(); evidence.push({ name, events: h.events, counters: h.counters, result }); }
}
function rejected(result: Outcome<unknown>) { assert.equal(result.ok, false, JSON.stringify(result)); if (!result.ok) assert.match(result.error, /original|connection|closed/i); }

await scenario("name-queue wait preserves admission connection before any creation", async (h, report) => {
  const releaseName = h.holdName(); const opening = track(h.open()); await ticks();
  await h.replaceConnection(); releaseName(); const result = await opening.done(); report(result);
  assert.deepEqual(h.events, [], JSON.stringify(h.events)); rejected(result); assert.equal(h.tabs.size, 0);
});
await scenario("disconnected acquisition does not implicitly connect or allocate a hold", async (h, report) => {
  h.a.sockets[0]!.emit("close"); const result = await track(h.open()).done(); report(result);
  assert.deepEqual(h.events, []); rejected(result); assert.equal(h.a.sockets.length, 1); assert.equal(h.counters.holds, 0);
});
await scenario("reuse cannot treat cached metadata as a new connection's tab", async (h, report) => {
  await h.open(); await h.replaceConnection(); const events = h.events.length;
  const result = await track(h.open()).done(); report(result); rejected(result); assert.equal(h.events.length, events);
});
await scenario("same original connection reuses the current tab without another create", async (h, report) => {
  await h.open(); const events = h.events.length; const result = await track(h.open()).done(); report(result);
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.created, false);
  assert.equal(h.events.length, events); assert.equal(h.counters.captures, 1);
});
await scenario("outer release settlement cannot return success after original connection loss", async (h, report) => {
  h.setReleaseEffect(() => { if (h.counters.releases === 1) h.a.sockets.at(-1)!.emit("close"); });
  const result = await track(h.open()).done(); report(result); rejected(result);
  assert.equal(h.a.sockets.length, 1); assert.equal(h.counters.holds, 2); assert.equal(h.counters.releases, 1);
});

for (const attached of [false, true]) {
  await scenario(`queued ${attached ? "attached navigate" : "open split"} cannot dispatch on reconnected socket`, async (h, report) => {
    h.setPolicy((_name, _socket, wire) => wire.method === "controlled.blocker");
    const blocker = track(h.a.client.request("controlled.blocker", {})); await ticks();
    const opening = track(h.open(attached)); await ticks();
    await h.replaceConnection(); const [blocked, result] = await Promise.all([blocker.done(), opening.done()]); report({ blocked, result });
    const foreign = h.events.filter(event => event.socket > 0); assert.deepEqual(foreign, [], JSON.stringify(foreign)); rejected(result); assert.equal(h.tabs.size, 0);
  });
}
// The legacy pump awaits connect even when already connected. Hold that actual
// public continuation (not the pump body), replace its socket, then release it.
for (const operation of ["create", "adopt", "action"] as const) {
  await scenario(`post-connect queue continuation cannot dispatch ${operation} on replacement`, async (h, report) => {
    const tab = operation === "action" ? (await h.open()).tab : undefined;
    const originalConnect = h.a.client.connect.bind(h.a.client);
    const gate = Promise.withResolvers<void>(); let entered = false;
    h.a.client.connect = async () => {
      await originalConnect();
      if (!entered) { entered = true; await gate.promise; }
    };
    const pending = track<void | { tab: Session; created: boolean }>(tab ? tab.cmuxTab.goto("https://later.test/") : h.open(operation === "adopt"));
    let beforeReplacement: unknown;
    try {
      await ticks();
      beforeReplacement = { entered, events: h.events.map(event => ({ ...event })) };
      h.a.sockets.at(-1)!.emit("close");
      await originalConnect();
    } finally { gate.resolve(); }
    const result = await pending.done(); report({ beforeReplacement, result });
    assert.deepEqual(h.events.filter(event => event.socket > 0), [], JSON.stringify(h.events));
    assert.equal(result.ok, true, JSON.stringify(result));
  });
}
await scenario("readyInfo caught geometry failure cannot publish after original connection loss", async (h, report) => {
  let lost = false;
  h.setPolicy((_name, socket, wire) => {
    if (!lost && wire.method === "browser.eval" && wire.params.script !== "document.title") { lost = true; queueMicrotask(() => { socket.reply(wire, { value: viewport }); socket.emit("close"); }); return true; }
    return false;
  });
  const result = await track(h.open()).done(); report(result); rejected(result); assert.equal(h.tabs.size, 0); assert.equal(h.counters.holds, 1);
  assert.equal(h.a.sockets.length, 1, "failed preparation must not implicitly reconnect for title or close");
});
await scenario("replacement browser client cannot receive failed acquisition cleanup", async (h, report) => {
  const b = h.backend("B"); await b.client.connect();
  h.setPolicy((name, socket, wire) => {
    if (name === "A" && wire.method === "browser.url.get") { h.browser.client = b.client; queueMicrotask(() => socket.fail(wire, "Readiness unavailable")); return true; }
    return false;
  });
  const result = await track(h.open()).done(); report(result); assert.equal(result.ok, false); assert.deepEqual(h.events.filter(event => event.client === "B"), []); assert.equal(h.tabs.size, 0);
});
await scenario("same-wrapper kind replacement during readiness cannot publish captured surface", async (h, report) => {
  h.setPolicy((_name, socket, wire) => {
    if (wire.method === "browser.eval" && wire.params.script === "document.title") { h.browser.kind.kind = "relay"; queueMicrotask(() => socket.reply(wire, { value: "Late title" })); return true; }
    return false;
  });
  const result = await track(h.open()).done(); report(result); rejected(result); assert.equal(h.tabs.size, 0); assert.equal(h.counters.holds, 1);
});
await scenario("existing tab queued navigation cannot move onto reconnected socket", async (h, report) => {
  const { tab } = await h.open();
  h.setPolicy((_name, _socket, wire) => wire.method === "controlled.blocker");
  const blocker = track(h.a.client.request("controlled.blocker", {})); await ticks();
  const navigating = track(tab.cmuxTab.goto("https://later.test/")); await ticks();
  await h.replaceConnection(); const [blocked, result] = await Promise.all([blocker.done(), navigating.done()]); report({ blocked, result });
  assert.deepEqual(h.events.filter(event => event.socket > 0), []); rejected(result);
});
await scenario("existing tab action rejects a replaced wrapper client before requests", async (h, report) => {
  const { tab } = await h.open(); const count = h.events.length;
  const b = h.backend("B"); await b.client.connect(); h.browser.client = b.client;
  const result = await track(tab.cmuxTab.goto("https://later.test/")).done(); report(result); rejected(result); assert.equal(h.events.length, count);
});
await scenario("owned surface release never sends close to replacement wrapper client", async (h, report) => {
  const { tab } = await h.open(); const b = h.backend("B"); await b.client.connect(); h.browser.client = b.client;
  const result = await track(h.release(tab)).done(); report(result); assert.deepEqual(h.events.filter(event => event.client === "B"), []); rejected(result);
  assert.equal(h.counters.releases, 2); assert.equal(h.tabs.size, 0);
});
await scenario("same original connection creates navigates and closes despite aborted tool context", async (h, report) => {
  const { tab } = await h.open(); await tab.cmuxTab.goto("https://later.test/", { waitUntil: "load" });
  const abort = new AbortController(); abort.abort(); tab.cmuxTab.setRunContext({ signal: abort.signal, timeoutMs: 1000 });
  const result = await track(h.release(tab)).done(); report(result); assert.equal(result.ok, true); assert.equal(h.a.sockets.length, 1);
  assert.equal(h.events.filter(event => event.method === "browser.open_split").length, 1); assert.equal(h.events.filter(event => event.method === "surface.close").length, 1);
  assert.equal(h.counters.holds, 2); assert.equal(h.counters.releases, 2); assert.equal(h.tabs.size, 0);
});
await scenario("same original attached surface navigates and releases without physical close", async (h, report) => {
  const { tab } = await h.open(true); const result = await track(h.release(tab)).done(); report(result); assert.equal(result.ok, true);
  assert.equal(h.events.filter(event => event.method === "browser.navigate").length, 1); assert.equal(h.events.filter(event => event.method === "surface.close").length, 0);
  assert.equal(h.a.sockets.length, 1); assert.equal(h.counters.releases, 2); assert.equal(h.tabs.size, 0);
});
console.log(JSON.stringify({ paths, sources: [supervisor, tabSource, clientSource, observationSource].map((source, index) => ({ path: paths[index], sha256: sha256(source), bytes: Buffer.byteLength(source) })), selections: { helper: sha256(helper), acquire: sha256(acquire), completeAcquisition: sha256(acquisition), observationFunctions: sha256(observationFunctions), release: sha256(release), completeTabClass: sha256(classSource), completeSocketSuffix: sha256(clientSuffix) }, counts: { pass: passed.length, fail: failures.length }, passed, failures, evidence,
  limits: "Complete actual CmuxTab class and socket-client suffix; exact complete supervisor public acquire/implementation/helper and full release functions. Controlled EventEmitter sockets/replies/microtask delivery/timers, no SDK/import/network/native/browser execution. Actual cmux observation reader and selected capture/remember functions are exercised; registry resource release is controlled; no physical cleanup/refcount/server-incarnation proof. Pair changes only selected supervisor, keeps current actual CmuxTab/client and fixture; no old full graph. No relay crypto/authentication or wallclock timing exercised. The post-connect overlap holds the public connect continuation while preserving the actual pump body. Geometry-script input and untilAborted are controlled; close-after-aborted-context tests actual closeSurface bypass, not real abort IPC." }, null, 2));
if (failures.length) process.exitCode = 1;
