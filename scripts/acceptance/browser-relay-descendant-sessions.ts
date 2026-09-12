/** Whole selected Bridge; public downstream commands and controlled extension descendant events. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2).filter(value => value !== "--pair");
if (args.length !== 1) throw new Error("Usage: browser-relay-descendant-sessions.ts <bridge.ts> [--pair]");
const selectedPath = args[0]!, source = await readFile(selectedPath, "utf8");
const selected = source.replace(/^import\b[\s\S]*?;\r?\n/gm, "");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(selected.replace(/^export /gm, ""));
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
type Message = Record<string, unknown> & { id?: number; t?: string; op?: string; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };
class Socket {
  readonly sent: Message[] = [];
  onSend: (message: Message) => void = () => {};
  onClose: () => void = () => {};
  constructor(readonly name: string) {}
  send(raw: string) { const message = JSON.parse(raw) as Message; this.sent.push(message); this.onSend(message); }
  close() { this.onClose(); }
}
type Bridge = { extConnected(socket: Socket): void; extClosed(socket: Socket): void; extMessage(socket: Socket, raw: string): void; cdpConnected(socket: Socket): number; cdpClosed(id: number): void; cdpMessage(id: number, raw: string): void };
type Client = { id: number; socket: Socket; page?: string };
type Rpc = { socket: Socket; message: Message; settled: boolean };
const ticks = async () => { for (let index = 0; index < 48; index++) await Promise.resolve(); };
function harness() {
  const timers = new Map<number, () => void>(); let timerId = 0, nextId = 0;
  const rpcs: Rpc[] = [], extensions: Socket[] = [], clients: Client[] = [];
  let policy: (rpc: Rpc) => boolean = () => false;
  const Bridge = new Function("setTimeout", "clearTimeout", "crypto", `${compiled}\nreturn RelayBridge;`)(
    (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, (id: number) => timers.delete(id), { randomUUID },
  ) as new (options: object) => Bridge;
  const bridge = new Bridge({ group: null });
  function reply(rpc: Rpc, result: unknown = {}) { if (rpc.settled) return; rpc.settled = true; bridge.extMessage(rpc.socket, JSON.stringify({ t: "rpcResult", id: rpc.message.id, ok: true, result })); }
  function extension(name: string) {
    const socket = new Socket(name); extensions.push(socket); socket.onClose = () => bridge.extClosed(socket);
    socket.onSend = message => { if (message.t !== "rpc") return; const rpc = { socket, message, settled: false }; rpcs.push(rpc); if (!policy(rpc)) queueMicrotask(() => reply(rpc, { value: "controlled" })); };
    return socket;
  }
  function hello(socket: Socket) { bridge.extMessage(socket, JSON.stringify({ t: "hello", userAgent: `Agent/${socket.name}`, browserVersion: `Chrome/${socket.name}`, tabInspectionVersion: 1, attachedTabIds: [7], tabs: [{ tabId: 7, url: "https://original.test/", title: "Original", active: false, windowId: 1, pinned: false, groupId: -1 }] })); }
  const a = extension("A"); bridge.extConnected(a); hello(a);
  function client(name: string): Client { const socket = new Socket(name), value = { id: bridge.cdpConnected(socket), socket }; clients.push(value); return value; }
  const first = client("first"), second = client("second"), outsider = client("unobserving");
  function command(client: Client, method: string, params: Record<string, unknown> = {}, sessionId?: string, id = ++nextId) {
    bridge.cdpMessage(client.id, JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); return id;
  }
  function response(client: Client, id: number) { const value = client.socket.sent.find(message => message.id === id); if (!value) throw new Error(`Missing controlled reply ${client.socket.name}:${id}`); return value; }
  function event(socket: Socket, method: string, params: Record<string, unknown>, nativeParent?: string) { bridge.extMessage(socket, JSON.stringify({ t: "cdpEvent", tabId: 7, method, params, ...(nativeParent ? { sessionId: nativeParent } : {}) })); }
  function attached(socket: Socket, nativeId: string, parent?: string) {
    event(socket, "Target.attachedToTarget", { sessionId: nativeId, targetInfo: { targetId: `target-${nativeId}`, type: "iframe", title: nativeId, url: "https://child.test/", browserContextId: "context-original" }, waitingForDebugger: true }, parent);
  }
  function attachment(client: Client, nativeId: string) {
    const value = client.socket.sent.filter(message => message.method === "Target.attachedToTarget" && (message.params?.targetInfo as Record<string, unknown> | undefined)?.targetId === `target-${nativeId}`).at(-1);
    if (!value || typeof value.params?.sessionId !== "string") throw new Error(`No child attachment ${client.socket.name}:${nativeId}`); return value;
  }
  function alias(client: Client, nativeId: string) { return attachment(client, nativeId).params!.sessionId as string; }
  return {
    bridge, a, first, second, outsider, clients, extensions, timers, rpcs, command, response, event, attached, attachment, alias, reply, extension, hello,
    setPolicy(next: typeof policy) { policy = next; },
    connect(socket: Socket) { bridge.extConnected(socket); hello(socket); },
    async ready() { for (const observer of [first, second]) { const id = command(observer, "Target.attachToTarget", { targetId: "PAGE7", flatten: true }); await ticks(); const value = response(observer, id); if (value.error || typeof value.result?.sessionId !== "string") throw new Error(`Page setup failed ${JSON.stringify(value)}`); observer.page = value.result.sessionId; } },
    async settleAll() { await ticks(); for (let round = 0; round < 12; round++) { for (const rpc of rpcs.filter(value => !value.settled)) reply(rpc); await ticks(); if (!rpcs.some(value => !value.settled)) return; } throw new Error("Controlled RPC gates did not quiesce"); },
    async finish() { policy = () => false; for (const rpc of rpcs.filter(value => !value.settled)) reply(rpc); await ticks(); for (const socket of extensions) { socket.onClose = () => {}; bridge.extClosed(socket); } for (const value of clients) bridge.cdpClosed(value.id); await ticks(); timers.clear(); },
  };
}
const passed: string[] = [], failures: Array<{ name: string; error: string }> = [], evidence: Array<{ name: string; rpcs: unknown; downstream: unknown; result?: unknown }> = [];
async function scenario(name: string, run: (h: ReturnType<typeof harness>, report: (value: unknown) => void) => Promise<void>) {
  const h = harness(); let result: unknown;
  try { await h.ready(); await run(h, value => { result = value; }); passed.push(name); }
  catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  finally { await h.finish(); evidence.push({ name, rpcs: h.rpcs.map(value => ({ socket: value.socket.name, message: value.message, settled: value.settled })), downstream: h.clients.map(value => ({ name: value.socket.name, messages: value.socket.sent })), result }); }
}
function sends(h: ReturnType<typeof harness>) { return h.rpcs.filter(value => value.message.op === "send"); }
function failed(message: Message) { assert(message.error, JSON.stringify(message)); }
function setupTree(h: ReturnType<typeof harness>) {
  h.attached(h.a, "native-child"); h.attached(h.a, "native-grandchild", "native-child");
  return { first: h.alias(h.first, "native-child"), second: h.alias(h.second, "native-child"), firstNested: h.alias(h.first, "native-grandchild"), secondNested: h.alias(h.second, "native-grandchild") };
}

await scenario("each observing page receives a private descendant tree with original event fields", async (h, report) => {
  const ids = setupTree(h); report(ids);
  assert.notEqual(ids.first, "native-child"); assert.notEqual(ids.second, "native-child"); assert.notEqual(ids.first, ids.second); assert.notEqual(ids.firstNested, ids.secondNested);
  const parent = h.attachment(h.first, "native-child"), nested = h.attachment(h.first, "native-grandchild");
  assert.equal(parent.sessionId, h.first.page); assert.equal(nested.sessionId, ids.first); assert.equal(parent.params!.waitingForDebugger, true);
  assert.equal((nested.params!.targetInfo as Record<string, unknown>).browserContextId, "context-original"); assert.equal(h.outsider.socket.sent.filter(message => message.method === "Target.attachedToTarget").length, 0);
});
await scenario("owned aliases forward exact native ids and equal downstream ids remain isolated", async (h, report) => {
  const ids = setupTree(h); const held: Rpc[] = []; h.setPolicy(rpc => { if (rpc.message.op === "send") { held.push(rpc); return true; } return false; });
  h.command(h.first, "Runtime.evaluate", { expression: "first" }, ids.first, 100); h.command(h.second, "Runtime.evaluate", { expression: "second" }, ids.secondNested, 100); await ticks();
  for (const rpc of held) h.reply(rpc, { owner: rpc.message.params?.expression }); await ticks();
  const replies = [h.response(h.first, 100), h.response(h.second, 100)]; report({ replies, nativeSessions: held.map(value => value.message.sessionId) });
  assert.deepEqual(held.map(value => value.message.sessionId), ["native-child", "native-grandchild"]); assert.equal(replies[0]!.result?.owner, "first"); assert.equal(replies[1]!.result?.owner, "second"); assert.equal(replies[0]!.sessionId, ids.first); assert.equal(replies[1]!.sessionId, ids.secondNested);
});
await scenario("raw native ids sibling aliases and unobserving caller cannot dispatch", async (h, report) => {
  const ids = setupTree(h), before = sends(h).length;
  const calls = [[h.first, "native-child"], [h.first, ids.second], [h.outsider, ids.first], [h.second, ids.firstNested]] as const;
  const requested = calls.map(([client, session]) => ({ client, id: h.command(client, "Runtime.evaluate", {}, session) })); await h.settleAll();
  const replies = requested.map(value => h.response(value.client, value.id)); report(replies); assert.equal(sends(h).length, before); for (const reply of replies) failed(reply);
});
await scenario("nested native events route by original local parent without exposing raw id", async (h, report) => {
  const ids = setupTree(h); const before = h.outsider.socket.sent.length;
  h.event(h.a, "Runtime.executionContextCreated", { context: { id: 51, name: "nested" } }, "native-grandchild");
  const eventFor = (client: Client) => client.socket.sent.filter(value => value.method === "Runtime.executionContextCreated").at(-1);
  report({ first: eventFor(h.first), second: eventFor(h.second) }); assert.equal(eventFor(h.first)?.sessionId, ids.firstNested); assert.equal(eventFor(h.second)?.sessionId, ids.secondNested); assert.equal(h.outsider.socket.sent.length, before);
  h.event(h.a, "Runtime.executionContextCreated", { context: { id: 52, name: "root" } }); assert.equal(eventFor(h.first)?.sessionId, h.first.page); assert.equal(eventFor(h.second)?.sessionId, h.second.page);
});
await scenario("local descendant detach retires only original client's subtree and sends no native detach", async (h, report) => {
  const ids = setupTree(h), before = h.rpcs.length;
  const detach = h.command(h.first, "Target.detachFromTarget", { sessionId: ids.first }, h.first.page); await ticks();
  const refused = h.command(h.first, "Runtime.evaluate", {}, ids.firstNested), allowed = h.command(h.second, "Runtime.evaluate", { marker: "survivor" }, ids.secondNested); await h.settleAll();
  const later = h.rpcs.slice(before); report({ detach: h.response(h.first, detach), refused: h.response(h.first, refused), allowed: h.response(h.second, allowed), later: later.map(value => value.message) });
  assert.equal(later.some(value => value.message.op === "detach" || value.message.method === "Target.detachFromTarget"), false); failed(h.response(h.first, refused)); assert.equal(h.response(h.second, allowed).error, undefined); assert.equal(sends(h).at(-1)?.message.sessionId, "native-grandchild");
});
await scenario("foreign detach parameter cannot remove a sibling connection's alias", async (h, report) => {
  const ids = setupTree(h), before = h.rpcs.length;
  h.command(h.first, "Target.detachFromTarget", { sessionId: ids.second }, h.first.page); await ticks(); const id = h.command(h.second, "Runtime.evaluate", {}, ids.second); await h.settleAll();
  report(h.response(h.second, id)); assert.equal(h.response(h.second, id).error, undefined); assert.equal(h.rpcs.slice(before).some(value => value.message.method === "Target.detachFromTarget" || value.message.op === "detach"), false);
});
await scenario("local page release retires its descendants while other observing page remains usable", async (h, report) => {
  const ids = setupTree(h), before = h.rpcs.length;
  h.command(h.first, "Target.detachFromTarget", { sessionId: h.first.page! }); await ticks();
  const refused = h.command(h.first, "Runtime.evaluate", {}, ids.first), allowed = h.command(h.second, "Runtime.evaluate", {}, ids.second); await h.settleAll();
  report({ refused: h.response(h.first, refused), allowed: h.response(h.second, allowed) }); failed(h.response(h.first, refused)); assert.equal(h.response(h.second, allowed).error, undefined); assert.equal(h.rpcs.slice(before).some(value => value.message.op === "detach"), false);
});
await scenario("held result after local alias removal cannot succeed or recreate a descendant", async (h, report) => {
  const ids = setupTree(h); let held: Rpc | undefined;
  h.setPolicy(rpc => { if (rpc.message.op === "send" && rpc.message.method === "Runtime.evaluate") { held = rpc; return true; } return false; });
  const id = h.command(h.first, "Runtime.evaluate", {}, ids.first); await ticks(); if (!held) throw new Error("Missing held descendant RPC");
  h.command(h.first, "Target.detachFromTarget", { sessionId: ids.first }, h.first.page); await ticks(); h.reply(held, { value: "stale" }); await ticks();
  h.setPolicy(() => false); const retry = h.command(h.first, "Runtime.evaluate", {}, ids.first); await h.settleAll();
  report({ original: h.response(h.first, id), retry: h.response(h.first, retry) }); failed(h.response(h.first, id)); failed(h.response(h.first, retry));
});
await scenario("native parent detach retires all corresponding aliases and nested descendants", async (h, report) => {
  const ids = setupTree(h); h.event(h.a, "Target.detachedFromTarget", { sessionId: "native-child", targetId: "target-native-child" });
  const first = h.command(h.first, "Runtime.evaluate", {}, ids.firstNested), second = h.command(h.second, "Runtime.evaluate", {}, ids.second); await h.settleAll();
  report({ first: h.response(h.first, first), second: h.response(h.second, second) }); failed(h.response(h.first, first)); failed(h.response(h.second, second)); assert.equal(sends(h).length, 0);
});
for (const mode of ["hello", "replacement", "tab removal"] as const) {
  await scenario(`${mode} retires old aliases and never revives them when native id returns`, async (h, report) => {
    const ids = setupTree(h); let socket = h.a;
    if (mode === "hello") h.hello(h.a);
    else if (mode === "replacement") { socket = h.extension("B"); h.connect(socket); }
    else { h.bridge.extMessage(h.a, JSON.stringify({ t: "tabRemoved", tabId: 7 })); h.hello(h.a); }
    const refused = h.command(h.first, "Runtime.evaluate", {}, ids.first); await h.settleAll();
    report({ reply: h.response(h.first, refused), nativeDispatches: sends(h).length }); failed(h.response(h.first, refused)); assert.equal(sends(h).length, 0);
    // Fresh explicit page admission is separate; its native-id reuse must mint a new local alias.
    const attach = h.command(h.first, "Target.attachToTarget", { targetId: "PAGE7", flatten: true }); await ticks(); const page = h.response(h.first, attach).result?.sessionId; if (typeof page !== "string") throw new Error("Fresh page admission failed");
    h.attached(socket, "native-child"); const fresh = h.alias(h.first, "native-child"); const allowed = h.command(h.first, "Runtime.evaluate", {}, fresh); await h.settleAll(); assert.notEqual(fresh, ids.first); assert.equal(h.response(h.first, allowed).error, undefined);
  });
}
for (const nested of [false, true]) {
  await scenario(`Target.attachToTarget ${nested ? "under owned child" : "under page"} returns the event's existing local alias`, async (h, report) => {
    const ids = setupTree(h), native = nested ? "native-result-nested" : "native-result-page", parent = nested ? ids.first : h.first.page!;
    h.setPolicy(rpc => {
      if (rpc.message.op === "send" && rpc.message.method === "Target.attachToTarget") {
        queueMicrotask(() => { h.attached(rpc.socket, native, nested ? "native-child" : undefined); h.reply(rpc, { sessionId: native }); }); return true;
      }
      return false;
    });
    const id = h.command(h.first, "Target.attachToTarget", { targetId: `target-${native}`, flatten: true }, parent); await h.settleAll();
    const reply = h.response(h.first, id), event = h.attachment(h.first, native), alias = h.alias(h.first, native);
    report({ reply, event }); assert.equal(reply.result?.sessionId, alias); assert.notEqual(alias, native); assert.equal(event.sessionId, parent);
    assert.equal(h.first.socket.sent.filter(value => value.method === "Target.attachedToTarget" && (value.params?.targetInfo as Record<string, unknown> | undefined)?.targetId === `target-${native}`).length, 1);
    assert.equal(h.response(h.first, id).error, undefined); assert.equal(h.timers.size, 0);
  });
}
await scenario("non-flat descendant tunnel and received-message envelope cannot bypass local ownership", async (h, report) => {
  const ids = setupTree(h), before = sends(h).length;
  const id = h.command(h.first, "Target.sendMessageToTarget", { sessionId: "native-grandchild", message: JSON.stringify({ id: 90, method: "Runtime.evaluate" }) }, ids.first);
  h.event(h.a, "Target.receivedMessageFromTarget", { sessionId: "native-grandchild", message: JSON.stringify({ id: 90, result: { foreign: true } }) }, "native-child");
  await h.settleAll(); report(h.response(h.first, id)); failed(h.response(h.first, id)); assert.equal(sends(h).length, before);
  for (const client of [h.first, h.second, h.outsider]) assert.equal(client.socket.sent.some(value => value.method === "Target.receivedMessageFromTarget"), false);
});

await scenario("two page sessions on one CDP client receive distinct aliases in parent-first order", async (h, report) => {
  const original = setupTree(h); const before = h.first.socket.sent.length;
  const id = h.command(h.first, "Target.attachToTarget", { targetId: "PAGE7", flatten: true }); await ticks();
  const newPage = h.response(h.first, id).result?.sessionId; if (typeof newPage !== "string") throw new Error("Second page admission failed");
  const child = h.alias(h.first, "native-child"), nested = h.alias(h.first, "native-grandchild");
  const emitted = h.first.socket.sent.slice(before).filter(value => value.method === "Target.attachedToTarget");
  report({ newPage, child, nested, emitted }); assert.notEqual(newPage, h.first.page); assert.notEqual(child, original.first); assert.notEqual(nested, original.firstNested);
  assert.equal(emitted[0]?.params?.sessionId, newPage); assert.equal(emitted[1]?.params?.sessionId, child); assert.equal(emitted[1]?.sessionId, newPage); assert.equal(emitted[2]?.params?.sessionId, nested); assert.equal(emitted[2]?.sessionId, child);
  const oldRequest = h.command(h.first, "Runtime.evaluate", {}, original.firstNested), newRequest = h.command(h.first, "Runtime.evaluate", {}, nested); await h.settleAll();
  assert.equal(h.response(h.first, oldRequest).error, undefined); assert.equal(h.response(h.first, newRequest).error, undefined); assert.deepEqual(sends(h).slice(-2).map(value => value.message.sessionId), ["native-grandchild", "native-grandchild"]);
});
await scenario("late observer receives cached native hierarchy after its page attachment", async (h, report) => {
  const original = setupTree(h); const before = h.outsider.socket.sent.length;
  const id = h.command(h.outsider, "Target.attachToTarget", { targetId: "PAGE7", flatten: true }); await ticks();
  const page = h.response(h.outsider, id).result?.sessionId; if (typeof page !== "string") throw new Error("Late observer admission failed");
  const child = h.alias(h.outsider, "native-child"), nested = h.alias(h.outsider, "native-grandchild");
  const emitted = h.outsider.socket.sent.slice(before).filter(value => value.method === "Target.attachedToTarget"); report({ page, child, nested, emitted });
  assert.equal(emitted[0]?.params?.sessionId, page); assert.equal(emitted[1]?.sessionId, page); assert.equal(emitted[1]?.params?.sessionId, child); assert.equal(emitted[2]?.sessionId, child); assert.equal(emitted[2]?.params?.sessionId, nested);
  assert.notEqual(child, original.first); assert.notEqual(child, original.second); const requestId = h.command(h.outsider, "Runtime.evaluate", {}, nested); await h.settleAll(); assert.equal(h.response(h.outsider, requestId).error, undefined); assert.equal(sends(h).at(-1)?.message.sessionId, "native-grandchild");
});

await scenario("root detach accepts its owned alias and leaves sibling native session usable", async (h, report) => {
  const ids = setupTree(h); const id = h.command(h.first, "Target.detachFromTarget", { sessionId: ids.first }); await ticks();
  const gone = h.command(h.first, "Runtime.evaluate", {}, ids.firstNested), live = h.command(h.second, "Runtime.evaluate", {}, ids.secondNested); await h.settleAll();
  report({ detach: h.response(h.first, id), gone: h.response(h.first, gone), live: h.response(h.second, live) });
  assert.equal(h.response(h.first, id).error, undefined); failed(h.response(h.first, gone)); assert.equal(h.response(h.second, live).error, undefined);
  assert.equal(h.rpcs.some(value => value.message.method === "Target.detachFromTarget" || value.message.op === "detach"), false);
});
await scenario("parent-scoped detach refuses its non-immediate descendant", async (h, report) => {
  const ids = setupTree(h); const id = h.command(h.first, "Target.detachFromTarget", { sessionId: ids.firstNested }, h.first.page); await ticks();
  const live = h.command(h.first, "Runtime.evaluate", {}, ids.firstNested); await h.settleAll(); report({ detach: h.response(h.first, id), live: h.response(h.first, live) });
  failed(h.response(h.first, id)); assert.equal(h.response(h.first, live).error, undefined);
});
await scenario("a mismatched announced target cannot satisfy an attachment result", async (h, report) => {
  h.setPolicy(rpc => { if (rpc.message.method === "Target.attachToTarget") { queueMicrotask(() => { h.attached(h.a, "wrong-target"); h.reply(rpc, { sessionId: "wrong-target" }); }); return true; } return false; });
  const id = h.command(h.first, "Target.attachToTarget", { targetId: "intended-target", flatten: true }, h.first.page); await h.settleAll(); report(h.response(h.first, id)); failed(h.response(h.first, id));
});
await scenario("native detach callback can reannounce without old cleanup erasing either new alias", async (h, report) => {
  const ids = setupTree(h); let announced = false;
  h.first.socket.onSend = message => { if (!announced && message.method === "Target.detachedFromTarget") { announced = true; h.attached(h.a, "native-child"); } };
  h.event(h.a, "Target.detachedFromTarget", { sessionId: "native-child" });
  const first = h.alias(h.first, "native-child"), second = h.alias(h.second, "native-child");
  const a = h.command(h.first, "Runtime.evaluate", {}, first), b = h.command(h.second, "Runtime.evaluate", {}, second); await h.settleAll();
  report({ first, second, firstReply: h.response(h.first, a), secondReply: h.response(h.second, b) });
  assert.notEqual(first, ids.first); assert.notEqual(second, ids.second); assert.equal(h.response(h.first, a).error, undefined); assert.equal(h.response(h.second, b).error, undefined);
});
await scenario("duplicate attachment preserves aliases and cyclic ancestry is ignored", async (h, report) => {
  const ids = setupTree(h); const before = h.first.socket.sent.filter(value => value.method === "Target.attachedToTarget").length;
  h.attached(h.a, "native-child"); h.attached(h.a, "native-child", "native-grandchild");
  const after = h.first.socket.sent.filter(value => value.method === "Target.attachedToTarget").length;
  const id = h.command(h.first, "Runtime.evaluate", {}, ids.firstNested); await h.settleAll(); report({ before, after, reply: h.response(h.first, id) });
  assert.equal(after, before); assert.equal(h.response(h.first, id).error, undefined); assert.equal(h.alias(h.first, "native-child"), ids.first);
});

for (const reentry of ["reannounce", "other original child"] as const) {
  await scenario(`page release ${reentry} callback cannot dispatch through the retiring parent`, async (h, report) => {
    const ids = setupTree(h); h.attached(h.a, "native-other");
    const other = h.alias(h.first, "native-other"), beforeSends = sends(h).length;
    const originalPage = h.first.page!;
    let fired = false, attempted: number | undefined, announcedAlias: string | undefined;
    const beforeMessages = h.first.socket.sent.length;
    h.first.socket.onSend = message => {
      if (fired || message.method !== "Target.detachedFromTarget") return;
      fired = true;
      if (reentry === "reannounce") {
        const before = h.first.socket.sent.length;
        h.attached(h.a, "native-child");
        const event = h.first.socket.sent.slice(before).find(value => value.method === "Target.attachedToTarget" && value.sessionId === originalPage && (value.params?.targetInfo as Record<string, unknown> | undefined)?.targetId === "target-native-child");
        if (typeof event?.params?.sessionId === "string") announcedAlias = event.params.sessionId;
        attempted = h.command(h.first, "Runtime.evaluate", { marker: "retiring-parent-reentry" }, announcedAlias ?? ids.first);
      } else attempted = h.command(h.first, "Runtime.evaluate", { marker: "retiring-parent-reentry" }, other);
    };
    const close = h.command(h.first, "Target.detachFromTarget", { sessionId: originalPage }); await h.settleAll();
    const reentrantDispatches = sends(h).slice(beforeSends).filter(value => value.message.params?.marker === "retiring-parent-reentry");
    report({ fired, announcedAlias, reentrantDispatches: reentrantDispatches.map(value => value.message), close: h.response(h.first, close), attempted: attempted === undefined ? undefined : h.response(h.first, attempted) });
    assert(fired); assert.equal(reentrantDispatches.length, 0, "retiring page callback dispatched a native command");
    assert.equal(announcedAlias, undefined); assert.notEqual(attempted, undefined); failed(h.response(h.first, attempted!));
    assert.equal(h.response(h.first, close).error, undefined);
    assert.equal(h.first.socket.sent.slice(beforeMessages).some(value => value.method === "Target.attachedToTarget" && value.sessionId === originalPage), false);
    const sibling = h.command(h.second, "Runtime.evaluate", { marker: "surviving-observer" }, ids.secondNested); await h.settleAll(); assert.equal(h.response(h.second, sibling).error, undefined);
  });
}
await scenario("a deliberate new page admitted from a detach callback retains its own aliases", async (h, report) => {
  const ids = setupTree(h); let requested: number | undefined;
  h.first.socket.onSend = message => {
    if (requested === undefined && message.method === "Target.detachedFromTarget") requested = h.command(h.first, "Target.attachToTarget", { targetId: "PAGE7", flatten: true });
  };
  const close = h.command(h.first, "Target.detachFromTarget", { sessionId: h.first.page! }); await h.settleAll();
  assert.notEqual(requested, undefined); const newPage = h.response(h.first, requested!).result?.sessionId; assert.equal(typeof newPage, "string");
  const child = h.attachment(h.first, "native-child"), alias = child.params!.sessionId as string;
  const live = h.command(h.first, "Runtime.evaluate", { marker: "deliberate-new-page" }, alias), old = h.command(h.first, "Runtime.evaluate", {}, ids.first); await h.settleAll();
  report({ newPage, child, close: h.response(h.first, close), live: h.response(h.first, live), old: h.response(h.first, old) });
  assert.notEqual(newPage, h.first.page); assert.equal(child.sessionId, newPage); assert.notEqual(alias, ids.first);
  assert.equal(h.response(h.first, live).error, undefined); failed(h.response(h.first, old)); assert.equal(h.response(h.first, close).error, undefined);
});

console.log(JSON.stringify({ selectedPath, sourceSha256: sha256(source), sourceBytes: Buffer.byteLength(source), completeModuleWithoutImportsSha256: sha256(selected), counts: { pass: passed.length, fail: failures.length }, passed, failures, evidence,
  limits: "Complete selected RelayBridge after type-import removal; public CDP/extension messages only, controlled sockets/UUID/timer callbacks and RPC replies. Two observing clients plus one unobserving client, native root and nested child events, no private reflection. No Chrome debugger/SDK/native/browser/network/IPC or real timer execution. Every held reply is explicitly settled before assertions; first original mismatch bounds later original controls. Native descendant detach and attachment are supplied extension events, not independently observed physical lifecycle. Fresh aliases are protocol ownership identifiers, not persisted server-incarnation claims." }, null, 2));
if (failures.length) process.exitCode = 1;
