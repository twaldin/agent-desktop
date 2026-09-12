/** Complete selected RelayBridge; public grouping commands with controlled extension replies and epochs. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2).filter(value => value !== "--pair");
if (args.length !== 1) throw new Error("Usage: browser-relay-group-ownership.ts <bridge.ts> [--pair]");
const selectedPath = args[0]!;
const source = await readFile(selectedPath, "utf8"), selected = source.replace(/^import\b[\s\S]*?;\r?\n/gm, "");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(selected.replace(/^export /gm, ""));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Message = Record<string, unknown> & { id?: number; t?: string; op?: string; method?: string; tabIds?: number[]; result?: Record<string, unknown>; error?: unknown };
type Snapshot = { tabId: number; url: string; title: string; active: boolean; windowId: number; pinned: boolean; groupId: number };
const tab = (tabId: number, changes: Partial<Snapshot> = {}): Snapshot => ({ tabId, url: `https://tab${tabId}.test/`, title: `Tab ${tabId}`, active: false, windowId: 1, pinned: false, groupId: -1, ...changes });
class Socket {
  readonly sent: Message[] = [];
  closeCount = 0;
  onSend: (message: Message) => void = () => {};
  onClose: () => void = () => {};
  constructor(readonly name: string) {}
  send(raw: string) { const message = JSON.parse(raw) as Message; this.sent.push(message); this.onSend(message); }
  close() { this.closeCount++; this.onClose(); }
}
type Bridge = { extConnected(socket: Socket): void; extClosed(socket: Socket): void; extMessage(socket: Socket, raw: string): void; cdpConnected(socket: Socket): number; cdpClosed(id: number): void; cdpMessage(id: number, raw: string): void; listTargets(): Array<Record<string, string>> };
type GroupRequest = { socket: Socket; message: Message; settled: boolean };
const ticks = async () => { for (let index = 0; index < 48; index++) await Promise.resolve(); };
function harness(enabled = true) {
  const timers = new Map<number, () => void>(); let timerId = 0, commandId = 0;
  const log: Array<{ message: string; data: unknown }> = [], groups: GroupRequest[] = [], extensions: Socket[] = [], clients: Array<{ id: number; socket: Socket }> = [];
  const Bridge = new Function("setTimeout", "clearTimeout", "crypto", `${compiled}\nreturn RelayBridge;`)(
    (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, (id: number) => timers.delete(id), { randomUUID },
  ) as new (options: object) => Bridge;
  const bridge = new Bridge({ group: enabled ? { title: "omp", color: "blue" } : null, log: (message: string, data: unknown) => log.push({ message, data }) });
  function extension(name: string) {
    const socket = new Socket(name); extensions.push(socket);
    socket.onSend = message => {
      if (message.t !== "rpc") return;
      if (message.op === "group") { groups.push({ socket, message, settled: false }); return; }
      queueMicrotask(() => bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: message.id, ok: true, result: {} })));
    };
    socket.onClose = () => bridge.extClosed(socket); return socket;
  }
  function hello(socket: Socket, tabs = [tab(7), tab(8), tab(9)]) {
    bridge.extMessage(socket, JSON.stringify({ t: "hello", userAgent: `Agent/${socket.name}`, browserVersion: `Chrome/${socket.name}`, tabInspectionVersion: 1, tabs, attachedTabIds: tabs.map(value => value.tabId) }));
  }
  const a = extension("A"); bridge.extConnected(a); hello(a);
  function command(client: { id: number; socket: Socket }, method: string, params: Record<string, unknown>, sessionId?: string) {
    const id = ++commandId; bridge.cdpMessage(client.id, JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); return id;
  }
  function complete(request: GroupRequest, failure?: string, groupId = 41) {
    if (request.settled) return; request.settled = true;
    bridge.extMessage(request.socket, JSON.stringify({ t: "rpcResult", id: request.message.id, ok: !failure, ...(failure ? { error: failure } : { result: { grouped: Object.fromEntries((request.message.tabIds ?? []).map(id => [String(id), groupId])) } }) }));
  }
  async function settleAll() {
    for (let round = 0; round < 12; round++) { for (const request of groups.filter(value => !value.settled)) complete(request); await ticks(); if (!groups.some(value => !value.settled)) return; }
    throw new Error("Controlled grouping did not quiesce after supplied replies");
  }
  return {
    bridge, a, extensions, groups, clients, timers, log, extension, hello, complete, settleAll,
    connect(socket: Socket, tabs?: Snapshot[]) { bridge.extConnected(socket); hello(socket, tabs); },
    update(socket: Socket, snapshot: Snapshot) { bridge.extMessage(socket, JSON.stringify({ t: "tabUpdated", tab: snapshot })); },
    remove(socket: Socket, tabId: number) { bridge.extMessage(socket, JSON.stringify({ t: "tabRemoved", tabId })); },
    create(socket: Socket, snapshot: Snapshot) { bridge.extMessage(socket, JSON.stringify({ t: "tabCreated", tab: snapshot })); },
    async claim(tabId: number) {
      const socket = new Socket(`CDP-${tabId}-${clients.length}`), client = { id: bridge.cdpConnected(socket), socket }; clients.push(client);
      const attachId = command(client, "Target.attachToTarget", { targetId: `PAGE${tabId}`, flatten: true }); await ticks();
      const attach = socket.sent.find(value => value.id === attachId), sessionId = attach?.result?.sessionId;
      if (attach?.error || typeof sessionId !== "string") throw new Error(`Controlled page-session setup failed ${JSON.stringify(attach)}`);
      const claimId = command(client, "OMP.claimTarget", {}, sessionId); await ticks();
      const claim = socket.sent.find(value => value.id === claimId); if (!claim || claim.error) throw new Error(`Controlled claim failed ${JSON.stringify(claim)}`);
      return client;
    },
    release(client: { id: number }) { bridge.cdpClosed(client.id); },
    async finish() { await settleAll(); for (const socket of extensions) { socket.onClose = () => {}; bridge.extClosed(socket); } for (const client of clients) bridge.cdpClosed(client.id); await ticks(); timers.clear(); },
  };
}
const passed: string[] = [], failures: Array<{ name: string; error: string }> = [], evidence: Array<{ name: string; groups: unknown; sockets: unknown; logs: unknown; result?: unknown }> = [];
async function scenario(name: string, run: (h: ReturnType<typeof harness>, report: (value: unknown) => void) => Promise<void>, enabled = true) {
  const h = harness(enabled); let result: unknown;
  try { await run(h, value => { result = value; }); passed.push(name); }
  catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  finally { await h.finish(); evidence.push({ name, groups: h.groups.map(value => ({ socket: value.socket.name, message: value.message, settled: value.settled })), sockets: h.extensions.map(socket => ({ name: socket.name, sent: socket.sent })), logs: h.log, result }); }
}
function groupIds(h: ReturnType<typeof harness>, socket?: Socket) { return h.groups.filter(value => !socket || value.socket === socket).map(value => value.message.tabIds); }
function requireGroup(h: ReturnType<typeof harness>, index = 0) { const value = h.groups[index]; if (!value) throw new Error(`Missing controlled group request ${index}`); return value; }

for (const sameSocket of [false, true]) {
  await scenario(`${sameSocket ? "same-socket hello" : "replacement extension"} retires queued work before new-owner dispatch`, async (h, report) => {
    await h.claim(7); await h.claim(8); const old = requireGroup(h); const replacement = sameSocket ? h.a : h.extension("B");
    const pinned = [tab(7, { pinned: true }), tab(8, { pinned: true }), tab(9, { pinned: true })];
    if (sameSocket) h.hello(replacement, pinned); else h.connect(replacement, pinned);
    h.complete(old); await h.settleAll(); report({ groups: groupIds(h), replacement: groupIds(h, replacement) });
    assert.deepEqual(groupIds(h), [[7]], "Retired queued tab must never reach any later group RPC"); assert.equal(h.timers.size, 0);
  });
}
await scenario("settled original result cannot mark the current pinned tab grouped after hello", async (h, report) => {
  await h.claim(7); h.complete(requireGroup(h), undefined, 41);
  // First turn runs the accepted RPC's settlement owner check; grouping consumes it on a later turn.
  await Promise.resolve(); h.hello(h.a, [tab(7, { pinned: true }), tab(8), tab(9)]); await ticks();
  h.update(h.a, tab(7, { pinned: true, groupId: 41 })); await h.settleAll();
  const ungroup = h.a.sent.filter(value => value.op === "ungroup"); report({ groups: groupIds(h), ungroup });
  assert.deepEqual(ungroup, [], "Old grouping success must not give current epoch ungroup authority"); assert.deepEqual(groupIds(h), [[7]]);
});
await scenario("old completion cannot clear a newer in-flight grouping token and queue duplicate work", async (h, report) => {
  await h.claim(7); const old = requireGroup(h); h.complete(old, undefined, 41); await Promise.resolve();
  const b = h.extension("B"); h.connect(b, [tab(7), tab(8), tab(9)]); await ticks();
  const newRequests = h.groups.filter(value => value.socket === b); const before = newRequests.length;
  h.update(b, tab(7)); await ticks(); const whileHeld = h.groups.filter(value => value.socket === b).length;
  await h.settleAll(); const after = h.groups.filter(value => value.socket === b).length; report({ before, whileHeld, after, groups: groupIds(h, b) });
  assert.equal(before, 1, "New epoch must independently reconcile the still-claimed ungrouped tab"); assert.equal(whileHeld, 1); assert.equal(after, 1, "Old finally must not admit duplicate queued work"); assert.deepEqual(groupIds(h, b), [[7]]);
});
await scenario("removed and recreated same numeric tab never inherits a queued group", async (h, report) => {
  await h.claim(7); await h.claim(8); h.remove(h.a, 8); h.create(h.a, tab(8, { title: "Fresh unclaimed replacement" }));
  h.complete(requireGroup(h)); await h.settleAll(); report({ groups: groupIds(h), targets: h.bridge.listTargets() });
  assert.deepEqual(groupIds(h), [[7]]); assert.equal(h.bridge.listTargets().find(value => value.id === "PAGE8")?.title, "Fresh unclaimed replacement");
});
await scenario("queued tab pinned before dispatch is omitted", async (h, report) => {
  await h.claim(7); await h.claim(8); h.update(h.a, tab(8, { pinned: true })); h.complete(requireGroup(h)); await h.settleAll(); report(groupIds(h)); assert.deepEqual(groupIds(h), [[7]]);
});
await scenario("queued tab whose last claim was released is omitted", async (h, report) => {
  await h.claim(7); const second = await h.claim(8); h.release(second); await ticks(); h.complete(requireGroup(h)); await h.settleAll(); report(groupIds(h)); assert.deepEqual(groupIds(h), [[7]]);
});
await scenario("same owner serializes one held group then batches later claimed tabs", async (h, report) => {
  await h.claim(7); await h.claim(8); await h.claim(9); const before = h.groups.length;
  h.complete(requireGroup(h)); await ticks(); const second = requireGroup(h, 1); const whileSecondHeld = h.groups.length;
  h.complete(second); await h.settleAll(); report({ before, whileSecondHeld, groups: groupIds(h) });
  assert.equal(before, 1); assert.equal(whileSecondHeld, 2); assert.deepEqual(groupIds(h), [[7], [8, 9]]); assert.equal(h.timers.size, 0);
});
await scenario("group rejection leaves later deliberate lifecycle retry available", async (h, report) => {
  await h.claim(7); h.complete(requireGroup(h), "Controlled group failed"); await ticks(); const afterFailure = h.groups.length;
  h.update(h.a, tab(7)); await ticks(); const retry = requireGroup(h, 1); h.complete(retry, undefined, 52); await h.settleAll();
  h.update(h.a, tab(7, { groupId: 52 })); await h.settleAll(); report({ afterFailure, groups: groupIds(h), logs: h.log });
  assert.equal(afterFailure, 1); assert.deepEqual(groupIds(h), [[7], [7]]); assert.equal(h.timers.size, 0);
});
await scenario("pinned and unclaimed tabs do not group until explicit eligible claim", async (h, report) => {
  h.update(h.a, tab(7, { pinned: true })); await h.claim(7); h.update(h.a, tab(8)); await ticks(); const before = h.groups.length;
  h.update(h.a, tab(7)); await h.settleAll(); report({ before, groups: groupIds(h) }); assert.equal(before, 0); assert.deepEqual(groupIds(h), [[7]]);
});
await scenario("grouping disabled never dispatches group or ungroup across claims and hello", async (h, report) => {
  await h.claim(7); await h.claim(8); h.hello(h.a, [tab(7), tab(8), tab(9)]); h.update(h.a, tab(7, { pinned: true })); await h.settleAll();
  report(h.a.sent); assert.deepEqual(h.a.sent.filter(value => value.op === "group" || value.op === "ungroup"), []); assert.equal(h.timers.size, 0);
}, false);
await scenario("eligibility loss and return retires dispatched group before fresh retry", async (h, report) => {
  await h.claim(7); const old = requireGroup(h);
  h.update(h.a, tab(7, { pinned: true })); h.update(h.a, tab(7)); await ticks();
  const beforeOldSettlement = h.groups.length;
  h.complete(old, undefined, 41); await ticks(); const afterOldSettlement = h.groups.length;
  await h.settleAll(); report({ beforeOldSettlement, afterOldSettlement, groups: groupIds(h) });
  assert.equal(beforeOldSettlement, 1, "The fresh attempt still waits for the dispatched old request");
  assert.equal(afterOldSettlement, 2, "Old success cannot confirm a retired eligibility attempt");
  assert.deepEqual(groupIds(h), [[7], [7]]); assert.equal(h.timers.size, 0);
});
await scenario("existing user group and explicit opt-out remain excluded", async (h, report) => {
  h.update(h.a, tab(8, { groupId: 99 })); await h.claim(8);
  await h.claim(7); h.complete(requireGroup(h), undefined, 41); await ticks();
  h.update(h.a, tab(7, { groupId: 41 })); h.update(h.a, tab(7, { groupId: -1 }));
  h.update(h.a, tab(7)); await h.settleAll(); report(groupIds(h));
  assert.deepEqual(groupIds(h), [[7]]); assert.equal(h.timers.size, 0);
});
console.log(JSON.stringify({ selectedPath, sourceSha256: hash(source), sourceBytes: Buffer.byteLength(source), completeModuleWithoutImportsSha256: hash(selected), counts: { pass: passed.length, fail: failures.length }, passed, failures, evidence,
  limits: "Complete selected RelayBridge transpiled after type-import removal. Public CDP attach/OMP.claimTarget and extension hello/tab/rpcResult messages; controlled sockets/UUID/timers only. Group replies use actual grouped per-tab map, every held RPC receives a reply or epoch rejection before assertions. One explicit promise turn models post-RPC/pre-group-consumer settlement, not a Chrome scheduler or native reproduction. No private reflection, SDK/browser/Chrome/network/IPC/native execution, real elapsed-time or physical group rollback proof. Same fixture for original and final selected bridge; first old mismatch bounds later old assertions." }, null, 2));
if (failures.length) process.exitCode = 1;
