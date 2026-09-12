/** Selected native reader + pinned Connection + accepted RelayBridge, controlled transports only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";

const nativeRoot = process.argv[2];
if (!nativeRoot) throw new Error("Pass the selected native root");
const connectionPath = "node_modules/.bun/puppeteer-core@25.3.0/node_modules/puppeteer-core/src/cdp/Connection.ts";
const bridgePath = ".data/browser-relay-observation-2026-09-10/work/native/src/tools/browser/relay/bridge.ts";
const readerPath = `${nativeRoot}/src/tools/browser/target-observation.ts`;
const sources = await Promise.all([readerPath, connectionPath, bridgePath].map(path => readFile(path, "utf8")));
const transform = (source: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, ""));
type Observation = { inspect(targetId: string): Promise<"present" | "absent"> };
const capture = new Function(`${transform(sources[0]!)}\nreturn captureBrowserTargetObservation;`)() as (browser: unknown, kind: string, timeout: number) => Promise<Observation>;
const ticks = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const gate = <T>() => { const { promise, resolve, reject } = Promise.withResolvers<T>(); return { promise, resolve, reject }; };
const timeouts: number[] = [];
// Controlled callback bookkeeping: no real timers or protocol session allocation.
class Callbacks {
  pending = new Map<number, ReturnType<typeof gate<unknown>>>();
  constructor(readonly next: () => number) {}
  create(_method: string, timeout: number, send: (id: number) => void) {
    const id = this.next(), wait = gate<unknown>(); this.pending.set(id, wait); timeouts.push(timeout);
    try { send(id); } catch (error) { this.pending.delete(id); wait.reject(error); }
    return wait.promise;
  }
  has(id: number) { return this.pending.has(id); }
  resolve(id: number, value: unknown) { this.pending.get(id)?.resolve(value); this.pending.delete(id); }
  reject(id: number, message: string) { this.pending.get(id)?.reject(new Error(message)); this.pending.delete(id); }
  rejectRaw(id: number, error: unknown) { this.pending.get(id)?.reject(error); this.pending.delete(id); }
  clear() { for (const wait of this.pending.values()) wait.reject(new Error("Connection closed")); this.pending.clear(); }
  getPendingProtocolErrors() { return []; }
}
type Transport = { send(raw: string): void; close(): void; onmessage?: (raw: string) => void; onclose?: () => void };
type Connection = { send(method: string, params?: object): Promise<unknown>; _closed: boolean; dispose(): void };
const ConnectionClass = new Function("EventEmitter", "CallbackRegistry", "debug", "ConnectionClosedError", "TargetCloseError", "createIncrementalIdGenerator", "CDPSessionEvent", "createProtocolErrorMessage", "CdpCDPSession", `${transform(sources[1]!)}\nreturn Connection;`)(
  EventEmitter, Callbacks, () => () => {}, Error, Error, () => { let n = 0; return () => ++n; },
  { Disconnected: "disconnected" }, (response: { error: { message: string } }) => response.error.message,
  class { constructor() { throw new Error("Unexpected CDP session attachment"); } },
) as new (url: string, transport: Transport) => Connection;
type Bridge = { extConnected(s: { send(raw: string): void; close(): void }): void; extClosed(s: object): void; extMessage(s: object, raw: string): void; cdpConnected(s: { send(raw: string): void; close(): void }): number; cdpClosed(id: number): void; cdpMessage(id: number, raw: string): void };
const BridgeClass = new Function("setTimeout", "clearTimeout", `${transform(sources[2]!)}\nreturn RelayBridge;`) as (set: (fn: () => void) => number, clear: (id: number) => void) => new () => Bridge;
type Command = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
function cdp() {
  const calls: Command[] = [];
  let respond: (command: Command) => void = command => reply(command, { targetInfos: [] });
  const transport: Transport = { send(raw) { const command = JSON.parse(raw) as Command; calls.push(command); respond(command); }, close() {} };
  const connection = new ConnectionClass("controlled", transport);
  const browser = { _connection: connection, get connected() { return !this._connection._closed; }, target() { throw new Error("Unexpected target attachment"); }, targets() { throw new Error("Unexpected cached inventory"); } };
  function reply(command: Command, result: unknown) { transport.onmessage?.(JSON.stringify({ id: command.id, result })); }
  return { browser, connection, transport, calls, reply, setRespond(fn: typeof respond) { respond = fn; }, finish() { connection.dispose(); } };
}
function relay() {
  const timers = new Map<number, () => void>(); let timerId = 0;
  const bridge = new (BridgeClass(fn => { timers.set(++timerId, fn); return timerId; }, id => { timers.delete(id); }))();
  const h = cdp(), queries: unknown[] = [];
  const id = bridge.cdpConnected({ send: raw => h.transport.onmessage?.(raw), close() {} });
  h.setRespond(command => bridge.cdpMessage(id, JSON.stringify(command)));
  let query = async (tabId: number): Promise<unknown> => ({ tabId, present: true });
  let socket: { send(raw: string): void; close(): void };
  function hello(version: unknown = 1) {
    socket = { send(raw) {
      const rpc = JSON.parse(raw) as { t: string; id: number; op: string; tabId: number };
      assert.equal(rpc.t, "rpc"); assert.equal(rpc.op, "inspectTab"); queries.push(rpc);
      const original = socket;
      void query(rpc.tabId).then(result => bridge.extMessage(original, JSON.stringify({ t: "rpcResult", id: rpc.id, ok: true, result })), error => bridge.extMessage(original, JSON.stringify({ t: "rpcResult", id: rpc.id, ok: false, error: String(error) })));
    }, close() {} };
    bridge.extConnected(socket);
    bridge.extMessage(socket, JSON.stringify({ t: "hello", tabs: [], attachedTabIds: [], tabInspectionVersion: version, userAgent: "controlled", browserVersion: "controlled" }));
  }
  hello();
  return { ...h, bridge, queries, hello, setQuery(fn: typeof query) { query = fn; }, disconnectExtension() { bridge.extClosed(socket); }, finish() { bridge.extClosed(socket); bridge.cdpClosed(id); timers.clear(); h.finish(); } };
}
const passed: string[] = [], failed: Array<{ name: string; error: string }> = [];
async function scenario(name: string, run: () => Promise<void>) {
  try { await run(); passed.push(name); }
  catch (error) { failed.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
}
for (const backend of ["headless", "spawned", "connected"]) await scenario(`${backend} queries exact root with explicit all-target filter`, async () => {
  const h = cdp(); try {
    h.setRespond(command => h.reply(command, { targetInfos: [{ targetId: "worker", type: "worker" }, { targetId: "exact", type: "page", url: "about:blank" }] }));
    const reader = await capture(h.browser, backend, 731);
    assert.equal(h.calls.length, 0);
    assert.equal(await reader.inspect("exact"), "present");
    assert.equal(await reader.inspect("missing"), "absent");
    assert.deepEqual(h.calls.map(({ method, params, sessionId }) => ({ method, params, sessionId })), [1, 2].map(() => ({ method: "Target.getTargets", params: { filter: [{}] }, sessionId: undefined })));
    assert.deepEqual(timeouts.slice(-2), [731, 731]);
  } finally { h.finish(); }
});
await scenario("closed original connection cannot be recast as replacement availability", async () => {
  const h = cdp(), replacement = cdp(); try {
    const reader = await capture(h.browser, "connected", 1000); h.connection.dispose(); h.browser._connection = replacement.connection;
    await assert.rejects(reader.inspect("exact"), /Original browser/); assert.equal(h.calls.length, 0); assert.equal(replacement.calls.length, 0);
  } finally { h.finish(); replacement.finish(); }
});
await scenario("response followed by disconnect before continuation never yields absent", async () => {
  const h = cdp(); try {
    const reader = await capture(h.browser, "headless", 1000);
    h.setRespond(command => { h.reply(command, { targetInfos: [] }); h.connection.dispose(); });
    await assert.rejects(reader.inspect("exact"), /Original browser/); assert.equal(h.calls.length, 1);
  } finally { h.finish(); }
});
await scenario("in-flight original query drains rejection on disconnect", async () => {
  const h = cdp(); try {
    h.setRespond(() => {}); const reader = await capture(h.browser, "spawned", 1000);
    const pending = assert.rejects(reader.inspect("exact"), /Connection closed/); h.connection.dispose(); await pending;
    assert.equal(h.calls.length, 1);
  } finally { h.finish(); }
});
await scenario("malformed full inventories and wrong target kind never become absence", async () => {
  const h = cdp(); try {
    const reader = await capture(h.browser, "connected", 1000);
    for (const result of [null, {}, { targetInfos: null }, { targetInfos: [null] }, { targetInfos: [{}] }, { targetInfos: [{ targetId: "exact", type: "page" }, { targetId: "exact", type: "page" }] }, { targetInfos: [{ targetId: "exact", type: "worker" }] }]) {
      h.setRespond(command => h.reply(command, result)); await assert.rejects(reader.inspect("exact"), /inventory|not a page/);
    }
    h.setRespond(command => h.transport.onmessage?.(JSON.stringify({ id: command.id, error: { message: "query denied" } })));
    await assert.rejects(reader.inspect("exact"), /query denied/);
    h.setRespond(command => h.reply(command, { targetInfos: [] })); assert.equal(await reader.inspect("exact"), "absent");
  } finally { h.finish(); }
});
await scenario("invalid API input and missing internal connection dispatch nothing", async () => {
  const h = cdp(); try {
    for (const timeout of [0, -1, NaN, Infinity]) await assert.rejects(capture(h.browser, "relay", timeout), /timeout/);
    await assert.rejects(capture(h.browser, "cmux", 1000), /Unsupported/);
    await assert.rejects(capture({ connected: true }, "connected", 1000), /Original browser/);
    const reader = await capture(h.browser, "connected", 1000); await assert.rejects(reader.inspect(""), /target/);
    assert.equal(h.calls.length, 0);
  } finally { h.finish(); }
});
await scenario("actual relay root commands inspect uncached PAGE and TAB without attachment", async () => {
  const h = relay(); try {
    const reader = await capture(h.browser, "relay", 1000);
    assert.equal(await reader.inspect("PAGE7"), "present");
    h.setQuery(async tabId => ({ tabId, present: false })); assert.equal(await reader.inspect("TAB7"), "absent");
    assert.deepEqual(h.calls.map(c => c.method), ["OMP.getObservationContext", "OMP.inspectTab", "OMP.inspectTab"]);
    assert(h.calls.every(c => c.sessionId === undefined)); assert.equal(h.queries.length, 2);
  } finally { h.finish(); }
});
await scenario("relay loss-return rejects original handshake before query; fresh capture is separate", async () => {
  const h = relay(); try {
    const reader = await capture(h.browser, "relay", 1000); h.disconnectExtension(); h.hello();
    await assert.rejects(reader.inspect("PAGE7"), /connection/); assert.equal(h.queries.length, 0);
    const fresh = await capture(h.browser, "relay", 1000); assert.equal(await fresh.inspect("PAGE7"), "present"); assert.equal(h.queries.length, 1);
  } finally { h.finish(); }
});
await scenario("relay replacement during query cannot publish late absence", async () => {
  const h = relay(); try {
    const wait = gate<unknown>(); h.setQuery(() => wait.promise);
    const reader = await capture(h.browser, "relay", 1000), pending = assert.rejects(reader.inspect("PAGE7"), /replaced|connection|disconnected/);
    await ticks(); h.disconnectExtension(); h.hello(); wait.resolve({ tabId: 7, present: false }); await pending;
    assert.equal(h.queries.length, 1);
  } finally { h.finish(); }
});
await scenario("relay capability, canonical target and reply identity are enforced", async () => {
  const h = relay(); try {
    h.hello(2); await assert.rejects(capture(h.browser, "relay", 1000), /unavailable/); assert.equal(h.queries.length, 0);
    h.hello(); const reader = await capture(h.browser, "relay", 1000);
    for (const id of ["PAGE07", "PAGE-1", "PAGE9007199254740992", "native-id"]) await assert.rejects(reader.inspect(id), /target/);
    assert.equal(h.queries.length, 0);
    h.setQuery(async () => ({ tabId: 8, present: false })); await assert.rejects(reader.inspect("PAGE7"), /Invalid/);
  } finally { h.finish(); }
});
await scenario("malformed relay root context and echoed owner fields never authorize observation", async () => {
  const h = cdp(); try {
    for (const result of [null, {}, { version: 2, connectionId: "A" }, { version: 1, connectionId: "" }]) {
      h.setRespond(command => h.reply(command, result)); await assert.rejects(capture(h.browser, "relay", 1000), /context/);
    }
    h.setRespond(command => h.reply(command, { version: 1, connectionId: "A" })); const reader = await capture(h.browser, "relay", 1000);
    for (const result of [null, {}, { connectionId: "B", targetId: "PAGE7", present: false }, { connectionId: "A", targetId: "PAGE8", present: false }, { connectionId: "A", targetId: "PAGE7", present: "false" }]) {
      h.setRespond(command => h.reply(command, result)); await assert.rejects(reader.inspect("PAGE7"), /response/);
    }
  } finally { h.finish(); }
});
console.log(JSON.stringify({ selections: [readerPath, connectionPath, bridgePath].map((path, i) => ({ path, sha256: createHash("sha256").update(sources[i]!).digest("hex"), bytes: Buffer.byteLength(sources[i]!) })), passed, failed, counts: { passed: passed.length, failed: failed.length }, evidence: "Complete selected reader, pinned Connection and RelayBridge; controlled callback registry, transport, extension RPC, timers. No SDK import or native runtime." }, null, 2));
if (failed.length) process.exitCode = 1;
