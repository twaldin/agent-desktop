/** Complete selected relay + shipped extension with controlled transports/Chrome callbacks only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = process.argv[2];
if (!root) throw new Error("Pass the selected native package root");
const bridgeSource = await readFile(`${root}/src/tools/browser/relay/bridge.ts`, "utf8");
const extensionSource = await readFile(`${root}/src/tools/browser/relay/extension-assets/background.js.txt`, "utf8");
const body = new Bun.Transpiler({ loader: "ts" }).transformSync(bridgeSource.replace(/^import type .*;\n/m, "").replace("export class RelayBridge", "class RelayBridge")).trim();
type Message = { id: number; result?: Record<string, unknown>; error?: { message: string } };
type Transport = { send(raw: string): void; close(): void };
type Bridge = { extConnected(socket: Transport): void; extClosed(socket: Transport): void; extMessage(socket: Transport, raw: string): void; cdpConnected(socket: Transport): number; cdpClosed(id: number): void; cdpMessage(id: number, raw: string): void };
const makeBridge = new Function("setTimeout", "clearTimeout", `${body}\nreturn RelayBridge;`) as (set: (fn: () => void) => number, clear: (id: number) => void) => new () => Bridge;
const ticks = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const gate = <T>() => { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tab = (id: number, url = "https://example.test") => ({ id, url, title: "Live tab", active: false, windowId: 1, pinned: false, groupId: -1 });
function harness() {
  const timers = new Map<number, () => void>(); let timerId = 0;
  const bridge = new (makeBridge(fn => { timers.set(++timerId, fn); return timerId; }, id => { timers.delete(id); }))();
  const replies: Message[] = [], calls: string[] = [], sockets: Socket[] = [];
  let live: unknown = [tab(7)], query = async (): Promise<unknown> => live;
  let send = async (): Promise<unknown> => { throw new Error("Unexpected debugger send"); };
  const events: Record<string, (...args: any[]) => void> = {};
  const event = (name: string) => ({ addListener(fn: (...args: any[]) => void) { events[name] = fn; } });
  const unexpected = (name: string) => (..._args: unknown[]) => { calls.push(name); throw new Error(`Unexpected Chrome mutation: ${name}`); };
  const chrome = {
    tabs: { query(filter: unknown) { calls.push("query"); assert.deepEqual(filter, {}); return query(); }, get: unexpected("get"), create: unexpected("create"), remove: unexpected("remove"), update: unexpected("update"), group: unexpected("group"), ungroup: unexpected("ungroup"), onCreated: event("created"), onUpdated: event("updated"), onRemoved: event("removed") },
    debugger: { getTargets: async () => [], attach: unexpected("attach"), detach: unexpected("detach"), sendCommand: () => { calls.push("send"); return send(); }, onEvent: event("debuggerEvent"), onDetach: event("debuggerDetach") },
    windows: { update: unexpected("windowUpdate") }, tabGroups: { query: unexpected("groupQuery") },
    storage: { local: { get: async (defaults: unknown) => defaults }, session: { get: async () => ({ ompGroupTitle: "" }) }, onChanged: event("storage") },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: event("click") },
    alarms: { create() {}, onAlarm: event("alarm") }, runtime: { onInstalled: event("installed"), onStartup: event("startup") },
  };
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; sent: unknown[] = [];
    onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
    readonly transport: Transport = { send: raw => this.onmessage?.({ data: raw }), close: () => this.close() };
    constructor(_url: string) { sockets.push(this); bridge.extConnected(this.transport); }
    send(raw: string) { this.sent.push(JSON.parse(raw)); bridge.extMessage(this.transport, raw); }
    close() { this.readyState = 3; bridge.extClosed(this.transport); this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
  }
  const ext = new Function("chrome", "WebSocket", "navigator", "setTimeout", "clearTimeout", "setInterval", "clearInterval", `${extensionSource}\nreturn { connect, runRpc };`)(
    chrome, Socket, { userAgent: "Chrome/controlled" }, () => 1, () => {}, () => 1, () => {},
  ) as { connect(): Promise<void>; runRpc(msg: unknown): Promise<unknown> };
  const conn = bridge.cdpConnected({ send(raw) { replies.push(JSON.parse(raw)); }, close() {} });
  let sequence = 0;
  return {
    bridge, ext, calls, sockets, replies, events, conn, timers,
    expireRpcTimers() { const current = [...timers.values()]; timers.clear(); for (const fn of current) fn(); },
    setSend(fn: () => Promise<unknown>) { send = fn; },
    setLive(value: unknown) { live = value; }, setQuery(fn: () => Promise<unknown>) { query = fn; },
    async ready() { await ticks(); sockets.at(-1)!.open(); await ticks(); calls.length = 0; },
    async reconnect() { sockets.at(-1)!.close(); await ext.connect(); sockets.at(-1)!.open(); await ticks(); },
    send(method: string, params?: object) { const id = ++sequence; bridge.cdpMessage(conn, JSON.stringify({ id, method, params })); return id; },
    reply(id: number) { const reply = replies.find(item => item.id === id); assert(reply, `Missing reply ${id}`); return reply; },
    async context() { const id = this.send("OMP.getObservationContext"); await ticks(); const result = this.reply(id); assert(!result.error, result.error?.message); assert.equal(result.result?.version, 1); assert.equal(typeof result.result?.connectionId, "string"); return result.result!.connectionId as string; },
    finish() { for (const socket of sockets) socket.close(); bridge.cdpClosed(conn); },
  };
}
const passed: string[] = [], failed: Array<{ name: string; message: string }> = [];
async function scenario(name: string, run: (h: ReturnType<typeof harness>) => Promise<void>) {
  const h = harness();
  try { await h.ready(); await run(h); passed.push(name); }
  catch (e) { failed.push({ name, message: e instanceof Error ? e.stack ?? e.message : String(e) }); }
  finally { h.finish(); await ticks(); }
}
const pair = process.argv.includes("--pair");
await scenario("fresh query sees ineligible and detached tabs without acquisition or cached absence", async h => {
  const connectionId = await h.context();
  h.setLive([tab(7, "chrome://settings"), tab(8, "about:blank")]);
  h.events.debuggerDetach!({ tabId: 7 }, "canceled_by_user");
  const id = h.send("OMP.inspectTab", { connectionId, targetId: "PAGE7" }); await ticks();
  assert.deepEqual(h.reply(id).result, { connectionId, targetId: "PAGE7", present: true });
  assert.deepEqual(h.calls, ["query"]);
  h.setLive([tab(8)]);
  const absent = h.send("OMP.inspectTab", { connectionId, targetId: "PAGE7" }); await ticks();
  assert.deepEqual(h.reply(absent).result, { connectionId, targetId: "PAGE7", present: false });
  assert.deepEqual(h.calls, ["query", "query"]);
});
await scenario("extension old async result never travels over replacement socket", async h => {
  const pending = gate<unknown>(); h.setSend(() => pending.promise);
  const old = h.sockets[0]!;
  old.onmessage!({ data: JSON.stringify({ t: "rpc", id: 701, op: "send", tabId: 7, method: "Runtime.evaluate", params: { expression: "1" } }) });
  await ticks(); old.close(); h.setQuery(async () => [tab(7)]); await h.ext.connect(); h.sockets[1]!.open(); await ticks();
  pending.resolve({ result: { type: "number", value: 1 } }); await ticks();
  assert.equal(h.sockets[1]!.sent.filter((x: any) => x.t === "rpcResult" && x.id === 701).length, 0);
  assert.equal(old.sent.filter((x: any) => x.t === "rpcResult" && x.id === 701).length, 0);
});
if (!pair) {
  await scenario("old extension capability and unknown handshakes cannot authorize inspection", async h => {
    const socket = h.sockets[0]!;
    for (const version of [undefined, 2, "1", null]) {
      h.bridge.extMessage(socket.transport, JSON.stringify({ t: "hello", tabs: [], attachedTabIds: [], userAgent: "", browserVersion: "", tabInspectionVersion: version }));
      const id = h.send("OMP.getObservationContext"); await ticks(); assert.match(h.reply(id).error!.message, /unavailable/);
    }
    assert.deepEqual(h.calls, []);
  });
  await scenario("connection loss and same-ID reconnect reject original token before query", async h => {
    const original = await h.context(); h.sockets[0]!.close();
    const down = h.send("OMP.inspectTab", { connectionId: original, targetId: "PAGE7" }); await ticks(); assert.match(h.reply(down).error!.message, /connection/);
    await h.ext.connect(); h.sockets[1]!.open(); await ticks(); const fresh = await h.context(); assert.notEqual(original, fresh); h.calls.length = 0;
    const id = h.send("OMP.inspectTab", { connectionId: original, targetId: "PAGE7" }); await ticks(); assert.match(h.reply(id).error!.message, /connection/); assert.deepEqual(h.calls, []);
    const yes = h.send("OMP.inspectTab", { connectionId: fresh, targetId: "TAB7" }); await ticks(); assert.equal(h.reply(yes).result?.present, true);
  });
  await scenario("reply delivered then connection replaced before continuation cannot publish", async h => {
    const original = await h.context(); const socket = h.sockets[0]!;
    const pending = gate<unknown>(); h.setQuery(() => pending.promise);
    const id = h.send("OMP.inspectTab", { connectionId: original, targetId: "PAGE7" }); await ticks();
    // Deliver a valid response directly, then retire its connection before the await continuation.
    const rpc = 1; h.bridge.extMessage(socket.transport, JSON.stringify({ t: "rpcResult", id: rpc, ok: true, result: { tabId: 7, present: false } }));
    socket.close(); pending.resolve([]); await ticks(); assert.match(h.reply(id).error!.message, /connection/); assert.equal(h.reply(id).result, undefined);
  });
  await scenario("query rejection and malformed snapshots remain errors, never absence", async h => {
    const connectionId = await h.context();
    for (const value of [null, {}, new Array(1), [{ id: -1 }], [{ id: 7 }, { id: 7 }], [{}]]) {
      h.setLive(value); const id = h.send("OMP.inspectTab", { connectionId, targetId: "PAGE7" }); await ticks(); assert(h.reply(id).error); assert.equal(h.reply(id).result, undefined);
    }
    h.setQuery(async () => { throw new Error("query denied"); }); const id = h.send("OMP.inspectTab", { connectionId, targetId: "PAGE7" }); await ticks(); assert.match(h.reply(id).error!.message, /query denied/);
  });
  await scenario("strict target and response identity reject without side effects", async h => {
    const connectionId = await h.context();
    for (const targetId of ["PAGE07", "PAGE-1", "PAGE9007199254740992", "other", "PAGE", 7]) {
      const id = h.send("OMP.inspectTab", { connectionId, targetId }); await ticks(); assert(h.reply(id).error);
    }
    assert.deepEqual(h.calls, []);
    for (const result of [null, [], {}, { tabId: 8, present: true }, { tabId: 7, present: 0 }]) {
      const pending = gate<unknown>(); h.setQuery(() => pending.promise);
      const id = h.send("OMP.inspectTab", { connectionId, targetId: "PAGE7" }); await ticks();
      const rpcId = h.calls.length;
      h.bridge.extMessage(h.sockets[0]!.transport, JSON.stringify({ t: "rpcResult", id: rpcId, ok: true, result }));
      pending.resolve([]); await ticks(); assert.match(h.reply(id).error!.message, /Invalid relay tab inspection response/);
    }
  });
  await scenario("bridge bound rejects ninth read and capacity returns after settled query", async h => {
    const connectionId = await h.context(), pending = gate<unknown>(); h.setQuery(() => pending.promise);
    const ids = Array.from({ length: 9 }, () => h.send("OMP.inspectTab", { connectionId, targetId: "PAGE7" })); await ticks();
    assert.equal(h.calls.length, 8); assert.match(h.reply(ids[8]!).error!.message, /capacity/);
    pending.resolve([tab(7)]); await ticks(); for (const id of ids.slice(0, 8)) assert.equal(h.reply(id).result?.present, true);
    h.setQuery(async () => []); const next = h.send("OMP.inspectTab", { connectionId, targetId: "PAGE7" }); await ticks(); assert.equal(h.reply(next).result?.present, false);
  });
  await scenario("extension bound retains held reads through socket loss", async h => {
    const pending = gate<unknown>(); h.setQuery(() => pending.promise);
    const reads = Array.from({ length: 8 }, () => h.ext.runRpc({ op: "inspectTab", tabId: 7 }));
    h.sockets[0]!.close(); await assert.rejects(h.ext.runRpc({ op: "inspectTab", tabId: 7 }), /capacity/);
    assert.equal(h.calls.length, 8); pending.resolve([]); await Promise.all(reads);
    assert.deepEqual(await h.ext.runRpc({ op: "inspectTab", tabId: 7 }), { tabId: 7, present: false });
  });
  await scenario("old hello and old message callbacks cannot cross replacement connection", async h => {
    const held = gate<unknown>(); h.sockets[0]!.close(); h.setQuery(() => held.promise); await h.ext.connect(); const old = h.sockets[1]!; old.open(); await ticks();
    old.close(); h.setQuery(async () => [tab(9)]); await h.ext.connect(); const replacement = h.sockets[2]!; replacement.open(); await ticks();
    const token = await h.context(), before = replacement.sent.length, calls = h.calls.length;
    held.resolve([tab(7)]); old.onmessage!({ data: JSON.stringify({ t: "rpc", id: 999, op: "inspectTab", tabId: 7 }) }); await ticks();
    assert.equal(replacement.sent.length, before); assert.equal(h.calls.length, calls); assert.equal(await h.context(), token);
  });
  await scenario("same-socket new hello invalidates an awaiting inspection", async h => {
    const original = await h.context(), pending = gate<unknown>(); h.setQuery(() => pending.promise);
    const id = h.send("OMP.inspectTab", { connectionId: original, targetId: "PAGE7" }); await ticks();
    h.bridge.extMessage(h.sockets[0]!.transport, JSON.stringify({ t: "hello", tabInspectionVersion: 1, tabs: [], attachedTabIds: [], userAgent: "", browserVersion: "" }));
    pending.resolve([]); await ticks(); assert.match(h.reply(id).error!.message, /connection/);
    assert.notEqual(await h.context(), original);
  });
  await scenario("timed-out relay reads cannot bypass extension outstanding-read bound", async h => {
    const connectionId = await h.context(), pending = gate<unknown>(); h.setQuery(() => pending.promise);
    const ids = Array.from({ length: 8 }, () => h.send("OMP.inspectTab", { connectionId, targetId: "PAGE7" })); await ticks();
    h.expireRpcTimers(); await ticks(); for (const id of ids) assert.match(h.reply(id).error!.message, /timed out/);
    const retry = h.send("OMP.inspectTab", { connectionId, targetId: "PAGE7" }); await ticks();
    assert.match(h.reply(retry).error!.message, /capacity/); assert.equal(h.calls.length, 8);
    pending.resolve([]); await ticks(); h.setQuery(async () => [tab(7)]);
    const fresh = h.send("OMP.inspectTab", { connectionId, targetId: "PAGE7" }); await ticks(); assert.equal(h.reply(fresh).result?.present, true);
  });
  await scenario("synchronous transport rejection releases pending timer and capacity", async h => {
    const connectionId = await h.context(), transport = h.sockets[0]!.transport, send = transport.send;
    transport.send = () => { throw new Error("write failed"); };
    for (let i = 0; i < 9; i++) {
      const id = h.send("OMP.inspectTab", { connectionId, targetId: "PAGE7" }); await ticks(); assert.match(h.reply(id).error!.message, /write failed/); assert.equal(h.timers.size, 0);
    }
    transport.send = send;
    const id = h.send("OMP.inspectTab", { connectionId, targetId: "PAGE7" }); await ticks(); assert.equal(h.reply(id).result?.present, true);
  });
  await scenario("ordinary extension reply is delivered once to its requesting socket", async h => {
    const old = h.sockets[0]!; h.setSend(async () => ({ result: { type: "number", value: 1 } }));
    old.onmessage!({ data: JSON.stringify({ t: "rpc", id: 702, op: "send", tabId: 7, method: "Runtime.evaluate" }) }); await ticks();
    assert.deepEqual(old.sent.filter((x: any) => x.t === "rpcResult" && x.id === 702), [{ t: "rpcResult", id: 702, ok: true, result: { result: { type: "number", value: 1 } } }]);
    assert.deepEqual(h.calls, ["send"]);
  });
  await scenario("closed downstream receives no successful late observation", async h => {
    const connectionId = await h.context(), pending = gate<unknown>(); h.setQuery(() => pending.promise);
    const id = h.send("OMP.inspectTab", { connectionId, targetId: "PAGE7" }); await ticks(); h.bridge.cdpClosed(h.conn);
    pending.resolve([]); await ticks(); assert.equal(h.replies.some(reply => reply.id === id), false);
  });
}
console.log(JSON.stringify({ selectedRoot: root, bridgeSha256: createHash("sha256").update(bridgeSource).digest("hex"), extensionSha256: createHash("sha256").update(extensionSource).digest("hex"), passed, failed, scope: "Complete selected class/extension with controlled callbacks, not Chrome/WS/IPC/native execution" }, null, 2));
if (failed.length) process.exitCode = 1;
