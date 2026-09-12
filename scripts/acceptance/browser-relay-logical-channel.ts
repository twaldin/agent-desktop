/** Whole selected Bridge with controlled physical clients and flattened logical browser roots. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2).filter(value => value !== "--pair");
if (args.length !== 1) throw new Error("Usage: browser-relay-logical-channel.ts <bridge.ts> [--pair]");
const selectedPath = args[0]!, source = await readFile(selectedPath, "utf8");
const selected = source.replace(/^import\b[\s\S]*?;\r?\n/gm, "");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(selected.replace(/^export /gm, ""));
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
type Message = Record<string, unknown> & { id?: number; t?: string; op?: string; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };
class Socket {
  readonly sent: Message[] = []; closed = 0;
  onSend: (message: Message) => void = () => {};
  onClose: () => void = () => {};
  constructor(readonly name: string) {}
  send(raw: string) { const message = JSON.parse(raw) as Message; this.sent.push(message); this.onSend(message); }
  close() { this.closed++; this.onClose(); }
}
type Bridge = { extConnected(socket: Socket): void; extClosed(socket: Socket): void; extMessage(socket: Socket, raw: string): void; cdpConnected(socket: Socket): number; cdpClosed(id: number): void; cdpMessage(id: number, raw: string): void };
type Client = { id: number; socket: Socket };
type Root = { client: Client; session: string; page?: string };
type Rpc = { socket: Socket; message: Message; settled: boolean };
const ticks = async () => { for (let index = 0; index < 64; index++) await Promise.resolve(); };
function harness(group = false) {
  const timers = new Map<number, () => void>(); let timerId = 0, nextId = 0;
  const rpcs: Rpc[] = [], extensions: Socket[] = [], clients: Client[] = [];
  let policy: (rpc: Rpc) => boolean = () => false;
  const Bridge = new Function("setTimeout", "clearTimeout", "crypto", `${compiled}\nreturn RelayBridge;`)(
    (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, (id: number) => timers.delete(id), { randomUUID },
  ) as new (options: object) => Bridge;
  const bridge = new Bridge({ group: group ? { title: "Controlled", color: "blue" } : null });
  function reply(rpc: Rpc, result: unknown = {}) { if (rpc.settled) return; rpc.settled = true; bridge.extMessage(rpc.socket, JSON.stringify({ t: "rpcResult", id: rpc.message.id, ok: true, result })); }
  function reject(rpc: Rpc, error: string) { if (rpc.settled) return; rpc.settled = true; bridge.extMessage(rpc.socket, JSON.stringify({ t: "rpcResult", id: rpc.message.id, ok: false, error })); }
  function extension(name: string) {
    const socket = new Socket(name); extensions.push(socket); socket.onClose = () => bridge.extClosed(socket);
    socket.onSend = message => { if (message.t !== "rpc") return; const rpc = { socket, message, settled: false }; rpcs.push(rpc); if (!policy(rpc)) queueMicrotask(() => reply(rpc, { value: "controlled" })); };
    return socket;
  }
  function hello(socket: Socket) { bridge.extMessage(socket, JSON.stringify({ t: "hello", userAgent: `Agent/${socket.name}`, browserVersion: `Chrome/${socket.name}`, tabInspectionVersion: 1, attachedTabIds: [7], tabs: [{ tabId: 7, url: "https://original.test/", title: "Original", active: false, windowId: 1, pinned: false, groupId: -1 }] })); }
  const a = extension("A"); bridge.extConnected(a); hello(a);
  function client(name: string): Client { const socket = new Socket(name), value = { id: bridge.cdpConnected(socket), socket }; clients.push(value); return value; }
  const physical = client("physical"), foreign = client("foreign");
  function command(client: Client, method: string, params: Record<string, unknown> = {}, sessionId?: string, id = ++nextId) {
    bridge.cdpMessage(client.id, JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); return id;
  }
  function peek(client: Client, id: number, sessionId?: string) { return client.socket.sent.find(message => message.id === id && message.sessionId === sessionId); }
  function response(client: Client, id: number, sessionId?: string) { const value = peek(client, id, sessionId); if (!value) throw new Error(`Missing controlled reply ${client.socket.name}:${sessionId ?? "physical"}:${id}`); return value; }
  async function root(client = physical): Promise<Root> {
    const id = command(client, "Target.attachToBrowserTarget"); await ticks(); const value = response(client, id);
    if (value.error || typeof value.result?.sessionId !== "string") throw new Error(`Logical browser admission failed: ${JSON.stringify(value)}`);
    return { client, session: value.result.sessionId };
  }
  function send(root: Root, method: string, params: Record<string, unknown> = {}, id?: number) { return command(root.client, method, params, root.session, id); }
  async function page(root: Root) { const id = send(root, "Target.attachToTarget", { targetId: "PAGE7", flatten: true }); await ticks(); const value = response(root.client, id, root.session); if (value.error || typeof value.result?.sessionId !== "string") throw new Error(`Logical page admission failed: ${JSON.stringify(value)}`); root.page = value.result.sessionId; return root.page; }
  function event(socket: Socket, method: string, params: Record<string, unknown>, nativeParent?: string) { bridge.extMessage(socket, JSON.stringify({ t: "cdpEvent", tabId: 7, method, params, ...(nativeParent ? { sessionId: nativeParent } : {}) })); }
  function attached(nativeId: string, nativeParent?: string) { event(a, "Target.attachedToTarget", { sessionId: nativeId, targetInfo: { targetId: `target-${nativeId}`, type: "iframe", title: nativeId, url: "https://child.test/" }, waitingForDebugger: true }, nativeParent); }
  function child(root: Root, nativeId: string, parent = root.page) { const value = root.client.socket.sent.filter(message => message.method === "Target.attachedToTarget" && message.sessionId === parent && (message.params?.targetInfo as Record<string, unknown> | undefined)?.targetId === `target-${nativeId}`).at(-1); if (typeof value?.params?.sessionId !== "string") throw new Error(`Missing child ${root.session}:${nativeId}`); return value.params.sessionId; }
  function detach(root: Root) { return command(root.client, "Target.detachFromTarget", { sessionId: root.session }); }
  return { bridge, a, physical, foreign, clients, extensions, timers, rpcs, command, send, response, peek, root, page, event, attached, child, detach, reply, reject, extension, hello,
    setPolicy(next: typeof policy) { policy = next; },
    connect(socket: Socket) { bridge.extConnected(socket); hello(socket); },
    async settleAll() { await ticks(); for (let round = 0; round < 16; round++) { for (const rpc of rpcs.filter(value => !value.settled)) reply(rpc); await ticks(); if (!rpcs.some(value => !value.settled)) return; } throw new Error("Controlled RPC gates did not quiesce"); },
    async finish() { policy = () => false; for (const rpc of rpcs.filter(value => !value.settled)) reply(rpc); await ticks(); for (const value of clients) bridge.cdpClosed(value.id); await ticks(); for (const rpc of rpcs.filter(value => !value.settled)) reply(rpc); await ticks(); for (const socket of extensions) { socket.onClose = () => {}; bridge.extClosed(socket); } await ticks(); timers.clear(); },
  };
}
const passed: string[] = [], failures: Array<{ name: string; error: string }> = [], evidence: Array<{ name: string; rpcs: unknown; downstream: unknown; result?: unknown }> = [];
async function scenario(name: string, run: (h: ReturnType<typeof harness>, report: (value: unknown) => void) => Promise<void>, group = false) {
  const h = harness(group); let result: unknown;
  try { await run(h, value => { result = value; }); passed.push(name); }
  catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  finally { await h.finish(); evidence.push({ name, rpcs: h.rpcs.map(value => ({ socket: value.socket.name, message: value.message, settled: value.settled })), downstream: h.clients.map(value => ({ name: value.socket.name, closed: value.socket.closed, messages: value.socket.sent })), result }); }
}
function failed(message: Message) { assert(message.error, JSON.stringify(message)); }
function sends(h: ReturnType<typeof harness>) { return h.rpcs.filter(value => value.message.op === "send"); }

await scenario("two browser roots allocate independent sessions without fabricated root attachment events", async (h, report) => {
  const a = await h.root(), b = await h.root(); const x = h.send(a, "Browser.getVersion"), y = h.send(b, "Browser.getVersion"); await h.settleAll();
  report({ a: a.session, b: b.session, replies: [h.response(a.client, x, a.session), h.response(b.client, y, b.session)] });
  assert.notEqual(a.session, b.session); assert.equal(h.physical.socket.sent.some(value => value.method === "Target.attachedToTarget" && [a.session, b.session].includes(String(value.params?.sessionId))), false);
  assert.equal(h.response(a.client, x, a.session).result?.product, "Chrome/A"); assert.equal(h.response(b.client, y, b.session).result?.product, "Chrome/A"); assert.equal(h.rpcs.length, 0);
});
await scenario("discovery events belong only to the root that enabled discovery", async (h, report) => {
  const a = await h.root(), b = await h.root(); const id = h.send(a, "Target.setDiscoverTargets", { discover: true }); await h.settleAll();
  const events = h.physical.socket.sent.filter(value => value.method === "Target.targetCreated"); report(events);
  assert.equal(h.response(a.client, id, a.session).error, undefined); assert(events.length >= 2); assert(events.every(value => value.sessionId === a.session));
  const later = h.send(b, "Target.getTargetInfo", { targetId: "PAGE7" }); await h.settleAll(); assert.equal((h.response(b.client, later, b.session).result?.targetInfo as Record<string, unknown>)?.targetId, "PAGE7");
});
await scenario("equal browser command ids remain isolated across logical roots", async (h, report) => {
  const a = await h.root(), b = await h.root(); const held: Rpc[] = []; h.setPolicy(rpc => { if (rpc.message.op === "activateTab") { held.push(rpc); return true; } return false; });
  h.send(a, "Target.activateTarget", { targetId: "PAGE7" }, 300); h.send(b, "Target.activateTarget", { targetId: "PAGE7" }, 300); await ticks();
  for (const rpc of [...held].reverse()) h.reply(rpc); await h.settleAll(); report({ held: held.length, replies: h.physical.socket.sent.filter(value => value.id === 300) });
  assert.equal(held.length, 2); assert.equal(h.response(a.client, 300, a.session).error, undefined); assert.equal(h.response(b.client, 300, b.session).error, undefined); assert.equal(h.physical.socket.sent.filter(value => value.id === 300).length, 2);
});
await scenario("page attachments retain logical root envelope and private page identifiers", async (h, report) => {
  const a = await h.root(), b = await h.root(); await h.page(a); await h.page(b);
  const events = h.physical.socket.sent.filter(value => value.method === "Target.attachedToTarget"); report(events); assert.notEqual(a.page, b.page);
  assert.equal(events.find(value => value.params?.sessionId === a.page)?.sessionId, a.session); assert.equal(events.find(value => value.params?.sessionId === b.page)?.sessionId, b.session);
  const aEvent = h.physical.socket.sent.findIndex(value => value.method === "Target.attachedToTarget" && value.params?.sessionId === a.page);
  const aReply = h.physical.socket.sent.findIndex(value => value.result?.sessionId === a.page); assert(aEvent >= 0 && aEvent < aReply);
});
await scenario("flattened page and descendant replies and events route to their original logical connection", async (h, report) => {
  const a = await h.root(), b = await h.root(); await h.page(a); await h.page(b); h.attached("native-child"); h.attached("native-nested", "native-child");
  const ac = h.child(a, "native-child"), bc = h.child(b, "native-child"), an = h.child(a, "native-nested", ac), bn = h.child(b, "native-nested", bc);
  const x = h.command(a.client, "Runtime.evaluate", { expression: "a" }, an), y = h.command(b.client, "Runtime.evaluate", { expression: "b" }, b.page); await h.settleAll();
  h.event(h.a, "Runtime.executionContextCreated", { context: { id: 81 } }, "native-nested"); const events = h.physical.socket.sent.filter(value => value.method === "Runtime.executionContextCreated"); report({ ac, bc, an, bn, events });
  assert.notEqual(ac, bc); assert.notEqual(an, bn); assert.equal(h.response(a.client, x, an).error, undefined); assert.equal(h.response(b.client, y, b.page).error, undefined);
  assert.deepEqual(sends(h).slice(-2).map(value => value.message.sessionId), ["native-nested", undefined]); assert.deepEqual(events.map(value => value.sessionId).sort(), [an, bn].sort());
});
await scenario("another physical client cannot route through or detach a foreign logical root", async (h, report) => {
  const a = await h.root(); await h.page(a); const before = h.rpcs.length;
  const x = h.command(h.foreign, "Target.activateTarget", { targetId: "PAGE7" }, a.session), y = h.command(h.foreign, "Target.detachFromTarget", { sessionId: a.session }); await h.settleAll();
  const live = h.send(a, "Browser.getVersion"); await h.settleAll(); report({ dispatch: h.response(h.foreign, x, a.session), detach: h.response(h.foreign, y), live: h.response(a.client, live, a.session) });
  failed(h.response(h.foreign, x, a.session)); assert.equal(h.rpcs.length, before); assert.equal(h.response(a.client, live, a.session).error, undefined);
});
await scenario("retiring one claimed root preserves a sibling holder and physical registry", async (h, report) => {
  const a = await h.root(), b = await h.root(); await h.page(a); await h.page(b);
  h.command(a.client, "OMP.claimTarget", {}, a.page); h.command(b.client, "OMP.claimTarget", {}, b.page); await h.settleAll(); const before = h.rpcs.length;
  const detach = h.detach(a); await h.settleAll(); const alive = h.command(b.client, "Runtime.evaluate", {}, b.page), info = h.command(h.physical, "Target.getTargetInfo", { targetId: "PAGE7" }); await h.settleAll();
  report({ detach: h.response(a.client, detach), alive: h.response(b.client, alive, b.page), later: h.rpcs.slice(before).map(value => value.message) });
  assert.equal(h.response(a.client, detach).error, undefined); assert.equal(h.rpcs.slice(before).some(value => value.message.op === "detach"), false); assert.equal(h.response(b.client, alive, b.page).error, undefined); assert.equal((h.response(h.physical, info).result?.targetInfo as Record<string, unknown>)?.targetId, "PAGE7"); assert.equal(h.physical.socket.closed, 0); assert.equal(h.a.closed, 0);
});
await scenario("last root holder releases the original debugger once and emits root detached event", async (h, report) => {
  const a = await h.root(); await h.page(a); const before = h.rpcs.length, id = h.detach(a); await h.settleAll();
  const later = h.rpcs.slice(before); report({ reply: h.response(a.client, id), later: later.map(value => value.message) });
  assert.equal(h.response(a.client, id).error, undefined); assert.equal(later.filter(value => value.message.op === "detach" && value.socket === h.a && value.message.tabId === 7).length, 1);
  assert.equal(h.physical.socket.sent.filter(value => value.method === "Target.detachedFromTarget" && value.params?.sessionId === a.session && value.sessionId === undefined).length, 1); assert.equal(h.a.closed, 0); assert.equal(h.physical.socket.closed, 0);
});
await scenario("root detach waits for held mutation and forbids its late success", async (h, report) => {
  const a = await h.root(); await h.page(a); let held: Rpc | undefined; h.setPolicy(rpc => { if (rpc.message.method === "Runtime.evaluate") { held = rpc; return true; } return false; });
  const request = h.command(a.client, "Runtime.evaluate", {}, a.page); await ticks(); if (!held) throw new Error("Missing held page mutation");
  const detach = h.detach(a); await ticks(); const early = h.peek(a.client, detach); h.reply(held, { value: "late-success" }); await h.settleAll();
  report({ early, operation: h.response(a.client, request, a.page), detach: h.response(a.client, detach) }); assert.equal(early, undefined); failed(h.response(a.client, request, a.page)); assert.equal(h.response(a.client, detach).error, undefined);
});
await scenario("root detach acknowledgement waits for original debugger detach gate", async (h, report) => {
  const a = await h.root(); await h.page(a); let held: Rpc | undefined; h.setPolicy(rpc => { if (rpc.message.op === "detach") { held = rpc; return true; } return false; });
  const id = h.detach(a); await ticks(); const early = h.peek(a.client, id); const observed = !!held; if (held) h.reply(held); await h.settleAll(); report({ early, observed, reply: h.response(a.client, id) });
  assert(observed, "Original debugger detach was not dispatched"); assert.equal(early, undefined); assert.equal(h.response(a.client, id).error, undefined); assert.equal(h.rpcs.filter(value => value.message.op === "detach").length, 1);
});
await scenario("original debugger detach failure is returned while sibling root stays usable", async (h, report) => {
  const a = await h.root(), b = await h.root(); await h.page(a); let held: Rpc | undefined; h.setPolicy(rpc => { if (rpc.message.op === "detach") { held = rpc; return true; } return false; });
  const id = h.detach(a); await ticks(); const early = h.peek(a.client, id); if (held) h.reject(held, "controlled debugger detach failure"); await h.settleAll(); const alive = h.send(b, "Browser.getVersion"); await h.settleAll();
  report({ early, observed: !!held, reply: h.response(a.client, id), alive: h.response(b.client, alive, b.session) }); assert(held, "No controlled original detach gate"); assert.equal(early, undefined); failed(h.response(a.client, id)); assert.equal(h.response(b.client, alive, b.session).error, undefined); assert.equal(h.physical.socket.closed, 0);
});
for (const change of ["hello", "replacement", "disconnect-return"] as const) {
  await scenario(`${change} permanently retires roots and permits a deliberate fresh root only`, async (h, report) => {
    const a = await h.root(); await h.page(a); let owner = h.a;
    if (change === "hello") h.hello(h.a);
    else { if (change === "disconnect-return") h.bridge.extClosed(h.a); owner = h.extension("B"); h.connect(owner); }
    await ticks(); const before = h.rpcs.length, old = h.send(a, "Target.activateTarget", { targetId: "PAGE7" }); await h.settleAll(); const fresh = await h.root(); await h.page(fresh); const current = h.send(fresh, "Target.activateTarget", { targetId: "PAGE7" }); await h.settleAll();
    report({ old: h.response(a.client, old, a.session), fresh: fresh.session, current: h.response(fresh.client, current, fresh.session), later: h.rpcs.slice(before).map(value => ({ socket: value.socket.name, message: value.message })) });
    failed(h.response(a.client, old, a.session)); assert.notEqual(fresh.session, a.session); assert.equal(h.response(fresh.client, current, fresh.session).error, undefined); assert.equal(h.rpcs.slice(before).filter(value => value.message.op === "activateTab").length, 1); assert.equal(h.rpcs.slice(before).at(-1)?.socket, owner);
  });
}
await scenario("held browser mutation cannot publish into an invalidated logical root", async (h, report) => {
  const a = await h.root(); let held: Rpc | undefined; h.setPolicy(rpc => { if (rpc.message.op === "activateTab") { held = rpc; return true; } return false; });
  const id = h.send(a, "Target.activateTarget", { targetId: "PAGE7" }); await ticks(); if (!held) throw new Error("Missing held browser mutation"); h.hello(h.a); h.reply(held); await h.settleAll();
  report(h.response(a.client, id, a.session)); failed(h.response(a.client, id, a.session)); assert.equal(h.rpcs.filter(value => value.message.op === "activateTab").length, 1);
});
await scenario("physical parent close retires its roots but preserves a different physical holder", async (h, report) => {
  const a = await h.root(), b = await h.root(h.foreign); await h.page(a); await h.page(b); let held: Rpc | undefined; h.setPolicy(rpc => { if (rpc.message.method === "Runtime.evaluate" && rpc.message.params?.marker === "held") { held = rpc; return true; } return false; });
  const id = h.command(a.client, "Runtime.evaluate", { marker: "held" }, a.page); await ticks(); if (!held) throw new Error("Missing parent-close held mutation"); h.bridge.cdpClosed(a.client.id); h.reply(held, { value: "late" }); await h.settleAll();
  const live = h.command(b.client, "Runtime.evaluate", { marker: "live" }, b.page); await h.settleAll(); const old = h.peek(a.client, id, a.page); report({ old, live: h.response(b.client, live, b.page) });
  assert.equal(old?.result?.value, undefined); assert.equal(h.response(b.client, live, b.page).error, undefined); assert.equal(h.rpcs.some(value => value.message.op === "detach"), false); assert.equal(h.a.closed, 0);
});
await scenario("Browser.close on logical root or page never reaches the extension", async (h, report) => {
  const a = await h.root(); await h.page(a); const before = h.rpcs.length, root = h.send(a, "Browser.close"), page = h.command(a.client, "Browser.close", {}, a.page); await h.settleAll(); const live = h.send(a, "Browser.getVersion"); await h.settleAll();
  report({ root: h.response(a.client, root, a.session), page: h.response(a.client, page, a.page), live: h.response(a.client, live, a.session) }); assert.equal(h.rpcs.length, before); assert.equal(h.a.closed, 0); assert.equal(h.physical.socket.closed, 0); assert.equal(h.response(a.client, live, a.session).error, undefined);
});
await scenario("retired root cannot release a newly admitted root using reused target identity", async (h, report) => {
  const a = await h.root(); await h.page(a); const first = h.detach(a); await h.settleAll(); const fresh = await h.root(); await h.page(fresh); const before = h.rpcs.length;
  const stale = h.send(a, "Target.detachFromTarget", { sessionId: fresh.page! }); await h.settleAll(); const live = h.command(fresh.client, "Runtime.evaluate", {}, fresh.page); await h.settleAll();
  report({ first: h.response(a.client, first), stale: h.response(a.client, stale, a.session), live: h.response(fresh.client, live, fresh.page) }); failed(h.response(a.client, stale, a.session)); assert.equal(h.response(fresh.client, live, fresh.page).error, undefined); assert.equal(h.rpcs.slice(before).some(value => value.message.op === "detach"), false);
});
await scenario("logical detach does not disable sibling discovery on the same physical socket", async (h, report) => {
  const a = await h.root(), b = await h.root(); h.send(a, "Target.setDiscoverTargets", { discover: true }); h.send(b, "Target.setDiscoverTargets", { discover: true }); await h.settleAll();
  h.detach(a); await h.settleAll(); const before = h.physical.socket.sent.length;
  h.bridge.extMessage(h.a, JSON.stringify({ t: "tabCreated", tab: { tabId: 8, url: "https://new.test/", title: "New", active: false, windowId: 1, pinned: false, groupId: -1 } })); await h.settleAll();
  const events = h.physical.socket.sent.slice(before).filter(value => value.method === "Target.targetCreated"); report(events); assert(events.length >= 2); assert(events.every(value => value.sessionId === b.session)); assert.equal(h.physical.socket.closed, 0);
});
await scenario("new-tab automatic attach and resulting detach both drain before root acknowledgement", async (h, report) => {
  const a = await h.root(); h.send(a, "Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }); await h.settleAll();
  let attachGate: Rpc | undefined, detachGate: Rpc | undefined;
  h.setPolicy(rpc => {
    if (rpc.message.tabId === 8 && rpc.message.op === "attach") { attachGate = rpc; return true; }
    if (rpc.message.tabId === 8 && rpc.message.op === "detach") { detachGate = rpc; return true; }
    return false;
  });
  h.bridge.extMessage(h.a, JSON.stringify({ t: "tabCreated", tab: { tabId: 8, url: "https://automatic.test/", title: "Automatic", active: false, windowId: 1, pinned: false, groupId: -1 } })); await ticks();
  const id = h.detach(a); await ticks(); const beforeAttach = h.peek(a.client, id); if (attachGate) h.reply(attachGate); await ticks();
  const beforeDetach = h.peek(a.client, id); if (detachGate) h.reply(detachGate); await h.settleAll();
  report({ attached: !!attachGate, detached: !!detachGate, beforeAttach, beforeDetach, reply: h.response(a.client, id) });
  assert(attachGate, "No held automatic attachment"); assert(detachGate, "No original debugger detach after automatic attachment"); assert.equal(beforeAttach, undefined); assert.equal(beforeDetach, undefined); assert.equal(h.response(a.client, id).error, undefined);
  assert.equal(h.physical.socket.sent.some(value => value.method === "Target.attachedToTarget" && value.sessionId === a.session && (value.params?.targetInfo as Record<string, unknown> | undefined)?.targetId === "TAB8"), false);
});
await scenario("cached runtime replay stops when its first outward callback disposes the root", async (h, report) => {
  const a = await h.root(); await h.page(a);
  h.command(a.client, "Runtime.disable", {}, a.page); await h.settleAll();
  h.event(h.a, "Runtime.executionContextCreated", { context: { id: 901, name: "first cached" } });
  h.event(h.a, "Runtime.executionContextCreated", { context: { id: 902, name: "second cached" } });
  let detachId: number | undefined;
  h.physical.socket.onSend = message => {
    if (detachId === undefined && message.sessionId === a.page && message.method === "Runtime.executionContextCreated") detachId = h.detach(a);
  };
  const before = h.physical.socket.sent.length, id = h.command(a.client, "Runtime.enable", {}, a.page); await h.settleAll();
  const replay = h.physical.socket.sent.slice(before).filter(value => value.sessionId === a.page && value.method === "Runtime.executionContextCreated");
  report({ replay, enable: h.peek(a.client, id, a.page), detach: detachId === undefined ? undefined : h.peek(a.client, detachId) });
  assert.notEqual(detachId, undefined, "First cached context was not replayed"); assert.deepEqual(replay.map(value => (value.params?.context as Record<string, unknown> | undefined)?.id), [901]);
  assert.equal(h.response(a.client, detachId!).error, undefined); assert.equal(h.physical.socket.closed, 0);
});

await scenario("a retiring shared-attach joiner retains the original operational failure", async (h, report) => {
  const a = await h.root(), b = await h.root();
  h.bridge.extMessage(h.a, JSON.stringify({ t: "tabCreated", tab: { tabId: 8, url: "https://new.test/", title: "New", active: false, windowId: 1, pinned: false, groupId: -1 } }));
  let gate: Rpc | undefined;
  h.setPolicy(rpc => { if (rpc.message.op === "attach" && rpc.message.tabId === 8) { gate = rpc; return true; } return false; });
  const first = h.send(a, "Target.attachToTarget", { targetId: "PAGE8", flatten: true });
  const joined = h.send(b, "Target.attachToTarget", { targetId: "PAGE8", flatten: true }); await ticks();
  const close = h.detach(b); await ticks(); const before = h.peek(b.client, close);
  if (gate) h.reject(gate, "shared original attach failed"); await h.settleAll();
  report({ gate: !!gate, before, first: h.response(a.client, first, a.session), joined: h.response(b.client, joined, b.session), close: h.response(b.client, close) });
  assert(gate); assert.equal(before, undefined); failed(h.response(b.client, close));
  assert.equal(h.rpcs.filter(value => value.message.op === "attach" && value.message.tabId === 8).length, 1);
});
await scenario("fresh grouping waits behind the exact original ungroup cleanup", async (h, report) => {
  const a = await h.root(), b = await h.root(); await h.page(a); await h.page(b);
  let ungroup: Rpc | undefined;
  h.setPolicy(rpc => {
    if (rpc.message.op === "group") { queueMicrotask(() => h.reply(rpc, { grouped: { "7": 100 } })); return true; }
    if (rpc.message.op === "ungroup") { ungroup = rpc; return true; }
    return false;
  });
  h.command(a.client, "OMP.claimTarget", {}, a.page); await h.settleAll();
  const close = h.detach(a); await ticks(); const groupsBefore = h.rpcs.filter(value => value.message.op === "group").length;
  h.command(b.client, "OMP.claimTarget", {}, b.page); await ticks(); const during = h.rpcs.filter(value => value.message.op === "group").length;
  if (ungroup) h.reply(ungroup); await h.settleAll();
  report({ groupsBefore, during, after: h.rpcs.filter(value => value.message.op === "group").length, close: h.response(a.client, close) });
  assert(ungroup); assert.equal(during, groupsBefore); assert.equal(h.rpcs.filter(value => value.message.op === "group").length, groupsBefore + 1); assert.equal(h.response(a.client, close).error, undefined);
}, true);
await scenario("nested roots route through the physical parent and expire close receipts globally", async (h, report) => {
  let firstParent: Root | undefined, firstChild: Root | undefined, latest: Root | undefined;
  for (let index = 0; index < 70; index++) {
    const parent = await h.root(); const id = h.send(parent, "Target.attachToBrowserTarget"); await ticks();
    const childId = h.response(parent.client, id, parent.session).result?.sessionId; assert.equal(typeof childId, "string");
    const child: Root = { client: parent.client, session: childId as string }; const version = h.send(child, "Browser.getVersion"); await ticks(); assert.equal(h.response(child.client, version, child.session).result?.product, "Chrome/A");
    if (!firstParent) { firstParent = parent; firstChild = child; } latest = child;
    const close = h.detach(parent); await h.settleAll(); assert.equal(h.response(parent.client, close).error, undefined);
  }
  const expired = h.detach(firstChild!), retained = h.detach(latest!); await h.settleAll();
  report({ expired: h.response(h.physical, expired), retained: h.response(h.physical, retained), roots: 140 });
  failed(h.response(h.physical, expired)); assert.equal(h.response(h.physical, retained).error, undefined);
});
await scenario("repeated disposal joins retained failure without another native mutation", async (h, report) => {
  const a = await h.root(); await h.page(a); let gate: Rpc | undefined;
  h.setPolicy(rpc => { if (rpc.message.op === "detach") { gate = rpc; return true; } return false; });
  const first = h.detach(a), second = h.detach(a); await ticks(); const before = [h.peek(a.client, first), h.peek(a.client, second)];
  if (gate) h.reject(gate, "original cleanup refused"); await h.settleAll(); const third = h.detach(a); await h.settleAll();
  report({ before, replies: [first, second, third].map(id => h.response(a.client, id)) }); assert(gate); assert.deepEqual(before, [undefined, undefined]);
  for (const id of [first, second, third]) failed(h.response(a.client, id)); assert.equal(h.rpcs.filter(value => value.message.op === "detach").length, 1);
});
await scenario("detach failure does not skip still-held independent ungroup cleanup", async (h, report) => {
  const a = await h.root(); await h.page(a); let detach: Rpc | undefined, ungroup: Rpc | undefined;
  h.setPolicy(rpc => {
    if (rpc.message.op === "group") { queueMicrotask(() => h.reply(rpc, { grouped: { "7": 100 } })); return true; }
    if (rpc.message.op === "detach") { detach = rpc; return true; }
    if (rpc.message.op === "ungroup") { ungroup = rpc; return true; }
    return false;
  });
  h.command(a.client, "OMP.claimTarget", {}, a.page); await h.settleAll();
  const close = h.detach(a); await ticks(); if (detach) h.reject(detach, "detach failed"); await ticks(); const beforeUngroup = h.peek(a.client, close);
  if (ungroup) h.reply(ungroup); await h.settleAll();
  report({ detach: !!detach, ungroup: !!ungroup, beforeUngroup, close: h.response(a.client, close) });
  assert(detach); assert(ungroup); assert.equal(beforeUngroup, undefined); failed(h.response(a.client, close));
}, true);
await scenario("detach reservation precedes reentrant fresh-root attachment", async (h, report) => {
  const a = await h.root(), b = await h.root(); await h.page(a); let gate: Rpc | undefined, attachId: number | undefined;
  h.setPolicy(rpc => { if (rpc.message.op === "detach") { gate = rpc; attachId = h.send(b, "Target.attachToTarget", { targetId: "PAGE7", flatten: true }); return true; } return false; });
  const close = h.detach(a); await ticks(); const before = h.rpcs.filter(value => value.message.op === "attach").length;
  if (gate) h.reply(gate); await h.settleAll();
  report({ before, after: h.rpcs.filter(value => value.message.op === "attach").length, close: h.response(a.client, close), attach: attachId === undefined ? undefined : h.response(b.client, attachId, b.session) });
  assert(gate); assert.notEqual(attachId, undefined); assert.equal(before, 0); assert.equal(h.rpcs.filter(value => value.message.op === "attach").length, 1); assert.equal(h.response(b.client, attachId!, b.session).error, undefined);
});


await scenario("live root capacity recovers after explicit disposal without allocating the rejected root", async (h, report) => {
  const roots: Root[] = [];
  for (let index = 0; index < 256; index++) roots.push(await h.root());
  const rejected = h.command(h.physical, "Target.attachToBrowserTarget"); await ticks();
  const close = h.detach(roots[0]!); await h.settleAll(); const fresh = await h.root();
  report({ roots: roots.length, rejected: h.response(h.physical, rejected), close: h.response(h.physical, close), fresh: fresh.session });
  failed(h.response(h.physical, rejected)); assert.equal(h.response(h.physical, close).error, undefined); assert(!roots.some(root => root.session === fresh.session)); assert.equal(h.rpcs.length, 0);
});
await scenario("pending request capacity refuses before dispatch and recovers after original results", async (h, report) => {
  const root = await h.root(), held: Rpc[] = [];
  h.setPolicy(rpc => { if (rpc.message.op === "activateTab") { held.push(rpc); return true; } return false; });
  const ids = Array.from({ length: 256 }, () => h.send(root, "Target.activateTarget", { targetId: "PAGE7" }));
  const overflow = h.send(root, "Target.activateTarget", { targetId: "PAGE7" }); await ticks(); const admitted = held.length;
  for (const rpc of held) h.reply(rpc); await h.settleAll(); h.setPolicy(() => false);
  const fresh = h.send(root, "Target.activateTarget", { targetId: "PAGE7" }); await h.settleAll();
  report({ admitted, overflow: h.response(root.client, overflow, root.session), fresh: h.response(root.client, fresh, root.session) });
  assert.equal(admitted, 256); failed(h.response(root.client, overflow, root.session)); for (const id of ids) assert.equal(h.response(root.client, id, root.session).error, undefined);
  assert.equal(h.response(root.client, fresh, root.session).error, undefined); assert.equal(h.rpcs.filter(value => value.message.op === "activateTab").length, 257);
});

await scenario("retiring roots keep admission capacity while original activation is pending", async (h, report) => {
  const held: Rpc[] = [], closes: number[] = [];
  h.setPolicy(rpc => { if (rpc.message.op === "activateTab") { held.push(rpc); return true; } return false; });
  for (let index = 0; index < 256; index++) {
    const root = await h.root(); h.send(root, "Target.activateTarget", { targetId: "PAGE7" }); await ticks();
    closes.push(h.detach(root)); await ticks();
  }
  const overflow = h.command(h.physical, "Target.attachToBrowserTarget"); await ticks();
  const before = closes.filter(id => h.peek(h.physical, id) !== undefined).length;
  const overflowReply = h.response(h.physical, overflow);
  for (const rpc of held) h.reply(rpc); await h.settleAll();
  const fresh = await h.root();
  report({ held: held.length, before, overflowReply, fresh: fresh.session });
  assert.equal(held.length, 256); assert.equal(before, 0); failed(overflowReply);
  for (const id of closes) assert.equal(h.response(h.physical, id).error, undefined);
  assert.equal(h.rpcs.filter(rpc => rpc.message.op === "activateTab").length, 256);
});
for (const rejectCleanup of [false, true]) {
  await scenario(`retiring native cleanup retains capacity until ${rejectCleanup ? "failure" : "success"} settlement`, async (h, report) => {
    const root = await h.root(); await h.page(root);
    for (let index = 1; index < 256; index++) await h.root();
    let held: Rpc | undefined;
    h.setPolicy(rpc => { if (rpc.message.op === "detach") { held = rpc; return true; } return false; });
    const close = h.detach(root); await ticks();
    const overflow = h.command(h.physical, "Target.attachToBrowserTarget"); await ticks();
    const overflowReply = h.response(h.physical, overflow), before = h.peek(h.physical, close);
    if (held) { if (rejectCleanup) h.reject(held, "Original cleanup refused"); else h.reply(held); }
    await h.settleAll(); const fresh = h.command(h.physical, "Target.attachToBrowserTarget"); await ticks();
    const freshReply = h.response(h.physical, fresh);
    report({ held: !!held, before, overflowReply, close: h.response(h.physical, close), freshReply });
    assert(held); assert.equal(before, undefined); failed(overflowReply);
    assert.equal(freshReply.error, undefined); assert.equal(typeof freshReply.result?.sessionId, "string");
    if (rejectCleanup) failed(h.response(h.physical, close)); else assert.equal(h.response(h.physical, close).error, undefined);
    assert.equal(h.rpcs.filter(rpc => rpc.message.op === "detach").length, 1);
  });
}
await scenario("nested retiring roots count at the physical owner while another physical client remains independent", async (h, report) => {
  const parent = await h.root(), held: Rpc[] = [];
  h.setPolicy(rpc => { if (rpc.message.op === "activateTab") { held.push(rpc); return true; } return false; });
  for (let index = 1; index < 256; index++) {
    const id = h.send(parent, "Target.attachToBrowserTarget"); await ticks();
    const session = h.response(parent.client, id, parent.session).result?.sessionId; assert.equal(typeof session, "string");
    h.send({ client: parent.client, session: session as string }, "Target.activateTarget", { targetId: "PAGE7" });
  }
  await ticks(); const close = h.detach(parent); await ticks();
  const overflow = h.command(h.physical, "Target.attachToBrowserTarget"); await ticks();
  const overflowReply = h.response(h.physical, overflow), before = h.peek(h.physical, close);
  const foreign = await h.root(h.foreign);
  for (const rpc of held) h.reply(rpc); await h.settleAll(); const fresh = await h.root();
  report({ held: held.length, before, overflowReply, foreign: foreign.session, fresh: fresh.session });
  assert.equal(held.length, 255); assert.equal(before, undefined); failed(overflowReply);
  assert.equal(h.response(h.physical, close).error, undefined); assert.notEqual(foreign.session, fresh.session);
});

console.log(JSON.stringify({ selectedPath, sourceSha256: sha256(source), sourceBytes: Buffer.byteLength(source), completeModuleWithoutImportsSha256: sha256(selected), counts: { pass: passed.length, fail: failures.length }, passed, failures, evidence,
  limits: "Complete selected RelayBridge after type-import removal; controlled physical sockets, flattened logical-root commands, supplied extension events/RPC replies and timer callbacks. No private reflection or Chrome/SDK/worker/native/network/IPC execution. Every held gate is settled before behavioral assertions; each old first mismatch bounds later old controls. Awaiting controlled detach is not physical debugger closure proof. Alias/claim isolation is local protocol ownership, not authorization or persisted backend incarnation." }, null, 2));
if (failures.length) process.exitCode = 1;
