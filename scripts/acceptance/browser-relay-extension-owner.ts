/** Complete selected RelayBridge with controlled socket, hello, RPC and timer delivery only. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2).filter(value => value !== "--pair");
if (args.length !== 1) throw new Error("Usage: browser-relay-extension-owner.ts <bridge.ts> [--pair]");
const selectedPath = args[0]!;
const source = await readFile(selectedPath, "utf8");
const selected = source.replace(/^import\b[\s\S]*?;\r?\n/gm, "");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(selected.replace(/^export /gm, ""));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Message = Record<string, unknown> & { id?: number; t?: string; op?: string; method?: string; result?: Record<string, unknown>; error?: { message?: string } };
type Snapshot = { tabId: number; url: string; title: string; active: boolean; windowId: number; pinned: boolean; groupId: number };
const tab = (tabId = 7): Snapshot => ({ tabId, url: `https://tab${tabId}.test/`, title: `Tab ${tabId}`, active: false, windowId: 1, pinned: false, groupId: -1 });
class Socket {
  readonly sent: Message[] = [];
  closeCount = 0;
  onSend: (message: Message) => void = () => {};
  onClose: () => void = () => {};
  constructor(readonly name: string) {}
  send(raw: string) { const message = JSON.parse(raw) as Message; this.sent.push(message); this.onSend(message); }
  close() { this.closeCount++; this.onClose(); }
}
type Bridge = {
  readonly ready: boolean;
  extConnected(socket: Socket): void;
  extClosed(socket: Socket): void;
  extMessage(socket: Socket, message: string): void;
  cdpConnected(socket: Socket): number;
  cdpClosed(id: number): void;
  cdpMessage(id: number, message: string): void;
  listTargets(): Array<Record<string, string>>;
  versionInfo(url: string): Record<string, string>;
};
const ticks = async () => { for (let index = 0; index < 48; index++) await Promise.resolve(); };
function harness() {
  const timers = new Map<number, { callback: () => void; timeout: number }>(); let timerId = 0, commandId = 0;
  const log: Array<{ message: string; data: unknown }> = [];
  const Bridge = new Function("setTimeout", "clearTimeout", "crypto", `${compiled}\nreturn RelayBridge;`)(
    (callback: () => void, timeout: number) => { timers.set(++timerId, { callback, timeout }); return timerId; },
    (id: number) => timers.delete(id), { randomUUID },
  ) as new (options: object) => Bridge;
  const bridge = new Bridge({ group: null, log: (message: string, data: unknown) => log.push({ message, data }) });
  const extensions: Socket[] = [];
  const client = new Socket("CDP"), connectionId = bridge.cdpConnected(client);
  let policy: (socket: Socket, message: Message) => boolean = () => false;
  function rpcReply(socket: Socket, message: Message, result: unknown = {}) { bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: message.id, ok: true, result })); }
  function extension(name: string) {
    const socket = new Socket(name); extensions.push(socket);
    socket.onSend = message => {
      if (message.t !== "rpc" || policy(socket, message)) return;
      queueMicrotask(() => rpcReply(socket, message, message.op === "createTab" ? { tab: tab(9) } : {}));
    };
    socket.onClose = () => bridge.extClosed(socket);
    return socket;
  }
  function hello(socket: Socket, tabs = [tab()], attachedTabIds: number[] = [7]) {
    bridge.extMessage(socket, JSON.stringify({ t: "hello", userAgent: `Agent/${socket.name}`, browserVersion: `Chrome/${socket.name}`, tabInspectionVersion: 1, tabs, attachedTabIds }));
  }
  const a = extension("A"); bridge.extConnected(a); hello(a);
  function command(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = ++commandId; bridge.cdpMessage(connectionId, JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); return id;
  }
  function reply(id: number) { const value = client.sent.find(message => message.id === id); if (!value) throw new Error(`No controlled CDP reply for ${id}`); return value; }
  return {
    bridge, client, a, extensions, timers, log, extension, hello, command, reply, rpcReply,
    setPolicy(next: typeof policy) { policy = next; },
    connect(socket: Socket, tabs = [tab()], attached = [7]) { bridge.extConnected(socket); hello(socket, tabs, attached); },
    async attach() { const id = command("Target.attachToTarget", { targetId: "PAGE7", flatten: true }); await ticks(); const result = reply(id); if (result.error || typeof result.result?.sessionId !== "string") throw new Error(`Controlled attachment setup failed: ${JSON.stringify(result)}`); return result.result.sessionId; },
    fireTimer() { const first = timers.entries().next().value as [number, { callback: () => void; timeout: number }] | undefined; if (!first) throw new Error("No pending controlled timer"); timers.delete(first[0]); first[1].callback(); return first[1].timeout; },
    async finish() { policy = () => false; for (const socket of extensions) { socket.onClose = () => {}; bridge.extClosed(socket); } await ticks(); bridge.cdpClosed(connectionId); await ticks(); timers.clear(); },
  };
}
const passed: string[] = [], failures: Array<{ name: string; error: string }> = [], evidence: Array<{ name: string; extensions: unknown; downstream: Message[]; remainingTimers: number; result?: unknown }> = [];
async function scenario(name: string, run: (h: ReturnType<typeof harness>, report: (value: unknown) => void) => Promise<void>) {
  const h = harness(); let result: unknown;
  try { await run(h, value => { result = value; }); passed.push(name); }
  catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  finally { await h.finish(); evidence.push({ name, extensions: h.extensions.map(socket => ({ name: socket.name, sent: socket.sent, closeCount: socket.closeCount })), downstream: h.client.sent, remainingTimers: h.timers.size, result }); }
}
function rejectReply(message: Message) { assert(message.error && typeof message.error.message === "string", JSON.stringify(message)); }
function rpcs(socket: Socket, op?: string) { return socket.sent.filter(message => message.t === "rpc" && (op === undefined || message.op === op)); }

await scenario("create result followed by same-socket hello cannot publish old target into new epoch", async (h, report) => {
  let held: Message | undefined; h.setPolicy((_socket, message) => { if (message.op === "createTab") { held = message; return true; } return false; });
  const id = h.command("Target.createTarget", { url: "https://requested.test/" }); await ticks(); if (!held) throw new Error("Missing held create RPC");
  h.rpcReply(h.a, held, { tab: tab(9) }); h.hello(h.a, [tab()], [7]); await ticks();
  const reply = h.reply(id); report({ reply, targets: h.bridge.listTargets(), timers: h.timers.size }); rejectReply(reply); assert.equal(h.bridge.listTargets().some(target => target.id === "PAGE9"), false); assert.equal(h.timers.size, 0);
});
await scenario("same-socket hello rejects held request and clears its old timer", async (h, report) => {
  let held: Message | undefined; h.setPolicy((_socket, message) => { if (message.op === "createTab") { held = message; return true; } return false; });
  const id = h.command("Target.createTarget"); await ticks(); if (!held) throw new Error("Missing held create RPC");
  const before = h.timers.size; h.hello(h.a, [tab()], [7]); await ticks(); const afterHello = h.timers.size;
  h.rpcReply(h.a, held, { tab: tab(9) }); await ticks(); const reply = h.reply(id); report({ before, afterHello, reply });
  assert.equal(before, 1); assert.equal(afterHello, 0); rejectReply(reply); assert.equal(h.bridge.listTargets().some(target => target.id === "PAGE9"), false);
});
await scenario("Runtime.enable cannot send enable on replacement after disable settles", async (h, report) => {
  const session = await h.attach(); let disable: Message | undefined;
  h.setPolicy((_socket, message) => { if (message.op === "send" && message.method === "Runtime.disable") { disable = message; return true; } return false; });
  const id = h.command("Runtime.enable", {}, session); await ticks(); if (!disable) throw new Error("Missing held Runtime.disable RPC");
  h.rpcReply(h.a, disable); const b = h.extension("B"); h.connect(b, [tab()], [7]); await ticks();
  const reply = h.reply(id); report({ reply, replacement: rpcs(b) }); assert.equal(rpcs(b).some(message => message.method === "Runtime.enable"), false); rejectReply(reply); assert.equal(h.timers.size, 0);
});
await scenario("attach queued behind old detach cannot attach on replacement extension", async (h, report) => {
  const session = await h.attach(); let detach: Message | undefined;
  h.setPolicy((_socket, message) => { if (message.op === "detach") { detach = message; return true; } return false; });
  const detachId = h.command("Target.detachFromTarget", { sessionId: session }); await ticks(); if (!detach) throw new Error("Missing held detach RPC");
  const attachId = h.command("Target.attachToTarget", { targetId: "PAGE7", flatten: true }); await ticks();
  const b = h.extension("B"); h.connect(b, [tab()], []); h.rpcReply(h.a, detach); await ticks();
  const reply = h.reply(attachId); report({ detachReply: h.reply(detachId), reply, replacement: rpcs(b) }); assert.equal(rpcs(b, "attach").length, 0); rejectReply(reply); assert.equal(h.timers.size, 0);
});
await scenario("same-owner create publishes intended target and fresh post-hello create works", async (h, report) => {
  const first = h.command("Target.createTarget", { url: "https://first.test/" }); await ticks(); const firstReply = h.reply(first);
  h.hello(h.a, [tab()], [7]); h.setPolicy((socket, message) => { if (message.op === "createTab") { queueMicrotask(() => h.rpcReply(socket, message, { tab: tab(10) })); return true; } return false; });
  const second = h.command("Target.createTarget", { url: "https://fresh.test/" }); await ticks(); const secondReply = h.reply(second); report({ firstReply, secondReply });
  assert.equal(firstReply.result?.targetId, "PAGE9"); assert.equal(secondReply.result?.targetId, "PAGE10"); assert.equal(h.bridge.listTargets().some(target => target.id === "PAGE10"), true); assert.equal(h.timers.size, 0);
});
await scenario("same-owner Runtime cycle preserves disable then enable and duplicate join", async (h, report) => {
  const session = await h.attach(); let disable: Message | undefined;
  h.setPolicy((_socket, message) => { if (message.op === "send" && message.method === "Runtime.disable") { disable = message; return true; } return false; });
  const first = h.command("Runtime.enable", {}, session), second = h.command("Runtime.enable", {}, session); await ticks(); if (!disable) throw new Error("Missing runtime gate");
  h.rpcReply(h.a, disable); await ticks(); report({ replies: [h.reply(first), h.reply(second)], methods: rpcs(h.a, "send").map(message => message.method) });
  assert.equal(h.reply(first).error, undefined); assert.equal(h.reply(second).error, undefined); assert.deepEqual(rpcs(h.a, "send").map(message => message.method), ["Runtime.disable", "Runtime.enable"]); assert.equal(h.timers.size, 0);
});
await scenario("same-owner attach waits for detach before fresh attach and then succeeds", async (h, report) => {
  const session = await h.attach(); let detach: Message | undefined;
  h.setPolicy((_socket, message) => { if (message.op === "detach") { detach = message; return true; } return false; });
  h.command("Target.detachFromTarget", { sessionId: session }); await ticks(); if (!detach) throw new Error("Missing detach gate");
  const id = h.command("Target.attachToTarget", { targetId: "PAGE7", flatten: true }); await ticks(); const before = rpcs(h.a, "attach").length;
  h.rpcReply(h.a, detach); await ticks(); const reply = h.reply(id); report({ before, reply });
  assert.equal(before, 0); assert.equal(rpcs(h.a, "attach").length, 1); assert.equal(typeof reply.result?.sessionId, "string"); assert.equal(reply.error, undefined); assert.equal(h.timers.size, 0);
});
await scenario("fresh deliberate command after replacement uses only the new extension", async (h, report) => {
  const b = h.extension("B"); h.connect(b, [tab()], []); const id = h.command("Target.createTarget", { url: "https://new.test/" }); await ticks();
  const reply = h.reply(id); report(reply); assert.equal(reply.result?.targetId, "PAGE9"); assert.equal(rpcs(h.a).length, 0); assert.equal(rpcs(b, "createTab").length, 1); assert.equal(h.timers.size, 0);
});
await scenario("old socket hello and rpc result cannot settle replacement request", async (h, report) => {
  const b = h.extension("B"); h.connect(b); let held: Message | undefined;
  h.setPolicy((_socket, message) => { if (message.op === "createTab") { held = message; return true; } return false; });
  const id = h.command("Target.createTarget"); await ticks(); if (!held) throw new Error("Missing replacement request");
  h.hello(h.a, [tab(99)], []); h.rpcReply(h.a, held, { tab: tab(99) }); await ticks(); const premature = h.client.sent.filter(message => message.id === id).length;
  h.rpcReply(b, held, { tab: tab(10) }); await ticks(); const reply = h.reply(id); report({ premature, reply, version: h.bridge.versionInfo("ws://controlled") });
  assert.equal(premature, 0); assert.equal(reply.result?.targetId, "PAGE10"); assert.equal(h.bridge.listTargets().some(target => target.id === "PAGE99"), false); assert.equal(h.bridge.versionInfo("ws://controlled").Browser, "Chrome/B"); assert.equal(h.timers.size, 0);
});
await scenario("send failure clears pending timer and permits a later deliberate command", async (h, report) => {
  let fail = true; h.setPolicy((_socket, message) => { if (message.op === "createTab" && fail) { fail = false; throw new Error("Controlled extension send failed"); } return false; });
  const first = h.command("Target.createTarget"); await ticks(); const firstReply = h.reply(first), afterFailure = h.timers.size;
  const second = h.command("Target.createTarget"); await ticks(); report({ firstReply, afterFailure, secondReply: h.reply(second) });
  rejectReply(firstReply); assert.match(firstReply.error!.message!, /Controlled extension send failed/); assert.equal(afterFailure, 0); assert.equal(h.reply(second).result?.targetId, "PAGE9"); assert.equal(h.timers.size, 0);
});
await scenario("controlled RPC timeout cannot produce late success or automatic retry", async (h, report) => {
  let held: Message | undefined; h.setPolicy((_socket, message) => { if (message.op === "createTab") { held = message; return true; } return false; });
  const id = h.command("Target.createTarget"); await ticks(); if (!held) throw new Error("Missing timeout gate"); const timeout = h.fireTimer(); await ticks();
  h.rpcReply(h.a, held, { tab: tab(99) }); await ticks(); const reply = h.reply(id); report({ timeout, reply }); rejectReply(reply); assert.match(reply.error!.message!, /timed out/); assert.equal(h.client.sent.filter(message => message.id === id).length, 1); assert.equal(rpcs(h.a, "createTab").length, 1); assert.equal(h.bridge.listTargets().some(target => target.id === "PAGE99"), false); assert.equal(h.timers.size, 0);
});
await scenario("reentrant old-socket close cannot overwrite a newer extension owner", async (h, report) => {
  const b = h.extension("B"), c = h.extension("C"); let reentered = false;
  h.a.onClose = () => { h.bridge.extClosed(h.a); if (!reentered) { reentered = true; h.connect(c); } };
  h.bridge.extConnected(b); // No B hello: a callback installed and handshook C before this outer call returned.
  const id = h.command("Target.createTarget"); await ticks(); const reply = h.reply(id); report({ reply, version: h.bridge.versionInfo("ws://controlled"), b: rpcs(b), c: rpcs(c) });
  assert.equal(rpcs(b, "createTab").length, 0); assert.equal(rpcs(c, "createTab").length, 1); assert.equal(reply.result?.targetId, "PAGE9"); assert.equal(h.bridge.versionInfo("ws://controlled").Browser, "Chrome/C"); assert.equal(h.timers.size, 0);
});
await scenario("old attach settlement cannot erase or ban a newer held replacement attach", async (h, report) => {
  h.hello(h.a, [tab()], []);
  const held: Array<{ socket: Socket; message: Message }> = [];
  h.setPolicy((socket, message) => { if (message.op === "attach") { held.push({ socket, message }); return true; } return false; });
  const old = h.command("Target.attachToTarget", { targetId: "PAGE7" }); await ticks();
  const b = h.extension("B"); h.connect(b, [tab()], []);
  const first = h.command("Target.attachToTarget", { targetId: "PAGE7" }); await ticks();
  const second = h.command("Target.attachToTarget", { targetId: "PAGE7" }); await ticks();
  const pendingB = rpcs(b, "attach").length;
  for (const item of held) h.rpcReply(item.socket, item.message);
  await ticks(); const oldReply = h.reply(old), firstReply = h.reply(first), secondReply = h.reply(second);
  report({ pendingB, oldReply, firstReply, secondReply });
  assert.equal(pendingB, 1); rejectReply(oldReply);
  assert.equal(typeof firstReply.result?.sessionId, "string"); assert.equal(typeof secondReply.result?.sessionId, "string");
  assert.equal(firstReply.error, undefined); assert.equal(secondReply.error, undefined); assert.equal(h.timers.size, 0);
});

await scenario("replacement without hello cannot admit an RPC and becomes usable after its handshake", async (h, report) => {
  const b = h.extension("B"); h.bridge.extConnected(b);
  const denied = h.command("Target.createTarget"); await ticks(); const deniedReply = h.reply(denied), beforeHello = rpcs(b).length;
  h.hello(b); const fresh = h.command("Target.createTarget"); await ticks(); const freshReply = h.reply(fresh);
  report({ beforeHello, deniedReply, freshReply }); assert.equal(beforeHello, 0); rejectReply(deniedReply);
  assert.equal(freshReply.result?.targetId, "PAGE9"); assert.equal(h.timers.size, 0);
});

for (const immediate of [false, true]) {
  await scenario(`disconnect-invalidated attach cannot ban ${immediate ? "already reconnected" : "later reconnected"} same-URL tab`, async (h, report) => {
    h.hello(h.a, [tab()], []); let held: Message | undefined;
    h.setPolicy((socket, message) => { if (socket === h.a && message.op === "attach") { held = message; return true; } return false; });
    const old = h.command("Target.attachToTarget", { targetId: "PAGE7", flatten: true }); await ticks(); if (!held) throw new Error("Missing original attach gate");
    h.bridge.extClosed(h.a); const b = h.extension("B");
    if (immediate) h.connect(b, [tab()], []);
    await ticks();
    if (!immediate) h.connect(b, [tab()], []);
    h.rpcReply(h.a, held); const fresh = h.command("Target.attachToTarget", { targetId: "PAGE7", flatten: true }); await ticks();
    const oldReply = h.reply(old), freshReply = h.reply(fresh), replacementCalls = rpcs(b, "attach").length;
    report({ oldReply, freshReply, replacementCalls, targets: h.bridge.listTargets() });
    assert.equal(replacementCalls, 1, "Fresh original-owner admission must not inherit an old disconnect ban");
    rejectReply(oldReply); assert.equal(freshReply.error, undefined); assert.equal(typeof freshReply.result?.sessionId, "string");
    assert.equal(h.bridge.listTargets().some(target => target.id === "PAGE7"), true); assert.equal(h.timers.size, 0);
  });
}
await scenario("unchanged-owner operational attach rejection still bans repeated same-URL admission", async (h, report) => {
  h.hello(h.a, [tab()], []);
  h.setPolicy((socket, message) => { if (message.op === "attach") { queueMicrotask(() => h.bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: message.id, ok: false, error: "Controlled debugger denied" }))); return true; } return false; });
  const first = h.command("Target.attachToTarget", { targetId: "PAGE7" }); await ticks();
  const retry = h.command("Target.attachToTarget", { targetId: "PAGE7" }); await ticks(); report({ first: h.reply(first), retry: h.reply(retry), calls: rpcs(h.a, "attach").length });
  rejectReply(h.reply(first)); rejectReply(h.reply(retry)); assert.equal(rpcs(h.a, "attach").length, 1);
  assert.equal(h.bridge.listTargets().some(target => target.id === "PAGE7"), false); assert.equal(h.timers.size, 0);
});
console.log(JSON.stringify({ selectedPath, sourceSha256: hash(source), sourceBytes: Buffer.byteLength(source), completeModuleWithoutImportsSha256: hash(selected), counts: { pass: passed.length, fail: failures.length }, passed, failures, evidence,
  limits: "Complete selected RelayBridge source transpiled with its type imports removed. Public downstream CDP commands and extension messages only; injected sockets, timer callbacks and UUID generation. No Chrome/debugger/SDK/network/IPC/native/browser/runtime execution or real timer elapsed-time proof. Snapshot fixtures use actual tabId fields; extension replies and epochs are controlled. Runtime/attach gates are actual pending Bridge RPCs settled or rejected before assertions; stale old replies delivered explicitly. No physical server incarnation or completed backend action rollback claim. Same fixture for selected original/final module." }, null, 2));
if (failures.length) process.exitCode = 1;
