/** Complete selected owned-CDP module; controlled sessions/connections/events, never an SDK or network import. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2).filter(arg => arg !== "--pair");
if (args.length !== 1) throw new Error("Usage: browser-owned-cdp-transport.ts <owned-cdp-transport.ts> [--pair]");
const selectedPath = args[0]!;
const source = await readFile(selectedPath, "utf8");
const selected = source.replace(/^import\b[\s\S]*?;\r?\n/gm, "");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(selected.replace(/^export /gm, ""));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const events = { SessionAttached: "sessionattached", Disconnected: Symbol("Disconnected") };
type Callback = (...args: unknown[]) => void;
class Emitter {
  readonly listeners = new Map<string | symbol, Set<Callback>>();
  on(event: string | symbol, callback: Callback) { let selected = this.listeners.get(event); if (!selected) { selected = new Set(); this.listeners.set(event, selected); } selected.add(callback); return this; }
  off(event: string | symbol, callback: Callback) { this.listeners.get(event)?.delete(callback); return this; }
  emit(event: string | symbol, ...args: unknown[]) {
    for (const listener of [...this.listeners.get(event) ?? []]) listener(...args);
    if (event !== "*") for (const listener of [...this.listeners.get("*") ?? []]) listener(event, ...args);
  }
  count() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}
type Call = { connection: string; sessionId?: string; method: string; params: unknown; options: unknown };
type StartupCreation = Readonly<{ requestId: number } & (
  { status: "pending" } | { status: "created"; targetId: string } | { status: "unknown"; error: string }
)>;
type Transport = { readonly startupCreations: readonly StartupCreation[]; finishStartup(): void; send(message: string): void; close(): void; dispose(): Promise<void>; onmessage?: (message: string) => void; onclose?: () => void };
type Outcome = { ok: true; value?: unknown } | { ok: false; error: string; failures: string[] };
const ticks = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
function messages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(messages);
  return [error instanceof Error ? error.message : String(error)];
}
function tracked(promise: Promise<unknown>) {
  let result: Outcome | undefined;
  const settled = promise.then(value => { result = { ok: true, value }; }, error => { result = { ok: false, error: error instanceof Error ? error.message : String(error), failures: messages(error) }; });
  return { pending: () => !result, async done() { await settled; return result!; } };
}
function harness() {
  const calls: Call[] = [], fallbackReleases: Array<() => void> = [];
  const sessions: Session[] = [];
  let allocationId = "owned-root";
  let closedEffect: (session: Session) => void = () => {};
  let attachGate: Promise<unknown> | undefined, detachGate: Promise<unknown> | undefined;
  let read: (session: Session, method: string, params: unknown) => Promise<unknown> = async (_session, method, params) => ({ method, params });
  class Connection {
    _closed = false;
    readonly _sessions = new Map<string, Session>();
    constructor(readonly name: string) {}
    _session(id: string) { return this._sessions.get(id); }
    async send(method: string, params: unknown, options: unknown) {
      calls.push({ connection: this.name, method, params, options });
      if (method === "Target.attachToBrowserTarget") return attachGate ? await attachGate : { sessionId: allocationId };
      if (method === "Target.detachFromTarget") return detachGate ? await detachGate : {};
      throw new Error(`Unexpected connection command ${method}`);
    }
  }
  class Session extends Emitter {
    detached = false;
    closedCount = 0;
    constructor(readonly origin: Connection, readonly targetType: string, readonly sessionId: string, readonly parent?: Session, readonly emulated?: boolean) { super(); sessions.push(this); }
    id() { return this.sessionId; }
    connection() { return this.origin; }
    parentSession() { return this.parent; }
    async send(method: string, params: unknown, options: unknown) { calls.push({ connection: this.origin.name, sessionId: this.id(), method, params, options }); return await read(this, method, params); }
    onClosed() { this.closedCount++; this.detached = true; this.emit(events.Disconnected); closedEffect(this); }
  }
  const capture = new Function("CdpCDPSession", "CDPSessionEvent", `${compiled}\nreturn captureOwnedCdpTransport;`)(Session, events) as (browser: unknown, timeout: number) => Promise<Transport>;
  const original = new Connection("original"), replacement = new Connection("replacement");
  const browser = { _connection: original, connected: true };
  const transports: Transport[] = [];
  function gate<T>(fallback: T) { const deferred = Promise.withResolvers<T>(); fallbackReleases.push(() => deferred.resolve(fallback)); return deferred; }
  function session(id: string, parent?: Session, connection = original) { const value = new Session(connection, "page", id, parent); connection._sessions.set(id, value); return value; }
  return {
    browser, original, replacement, sessions, calls, gate, session,
    async capture(timeout = 1000) { const value = await capture(browser, timeout); transports.push(value); return value; },
    root() { const value = original._session(allocationId); if (!value) throw new Error("No captured original session"); return value; },
    setAllocation(id: string) { allocationId = id; },
    holdAllocation(promise: Promise<unknown>) { attachGate = promise; },
    holdDetach(promise: Promise<unknown>) { detachGate = promise; },
    setRead(callback: typeof read) { read = callback; },
    setClosedEffect(callback: typeof closedEffect) { closedEffect = callback; },
    child(id: string, parent: Session) { const value = session(id, parent); parent.emit(events.SessionAttached, value); return value; },
    async finish() { for (const release of fallbackReleases) release(); await ticks(); await Promise.all(transports.map(transport => transport.dispose().catch(() => undefined))); },
  };
}
function request(id: number, method = "Runtime.evaluate", sessionId?: string) { return JSON.stringify({ id, method, params: { expression: "1 + 1" }, ...(sessionId ? { sessionId } : {}) }); }
const passed: string[] = [], failures: Array<{ name: string; error: string }> = [], evidence: Array<{ name: string; calls: Call[]; result?: unknown }> = [];
async function scenario(name: string, run: (h: ReturnType<typeof harness>, report: (value: unknown) => void) => Promise<void>) {
  const h = harness(); let result: unknown;
  try { await run(h, value => { result = value; }); passed.push(name); }
  catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  finally { await h.finish(); evidence.push({ name, calls: h.calls, result }); }
}
function assertFailure(result: Outcome, pattern: RegExp) { assert.equal(result.ok, false, JSON.stringify(result)); if (!result.ok) assert.match(result.failures.join("; "), pattern); }
function dispatched(h: ReturnType<typeof harness>) { return h.calls.filter(call => call.sessionId !== undefined); }

await scenario("normal root and flattened child requests replies and events stay on owned sessions", async (h, report) => {
  const unrelated = h.session("unrelated"); const foreignChild = h.session("unrelated-child", unrelated);
  const transport = await h.capture(); const root = h.root(); const child = h.child("owned-child", root);
  const delivered: Record<string, unknown>[] = []; transport.onmessage = raw => delivered.push(JSON.parse(raw));
  transport.send(request(1)); transport.send(request(2, "Page.getFrameTree", child.id())); await ticks();
  root.emit("Target.targetInfoChanged", { targetInfo: { targetId: "page-original" } }); child.emit("Page.loadEventFired", { timestamp: 1 });
  const result = await tracked(transport.dispose()).done(); report({ delivered, result });
  assert.deepEqual(dispatched(h).map(call => [call.sessionId, call.method]), [["owned-root", "Runtime.evaluate"], ["owned-child", "Page.getFrameTree"]]);
  assert.equal(delivered.length, 4); assert.equal(delivered[0]!.id, 1); assert.equal(delivered[1]!.sessionId, "owned-child");
  assert.equal(delivered[2]!.method, "Target.targetInfoChanged"); assert.equal("sessionId" in delivered[2]!, false); assert.equal(delivered[3]!.sessionId, "owned-child");
  assert.equal(unrelated.detached, false); assert.equal(foreignChild.detached, false); assert.equal(h.original._session("unrelated")?.id(), "unrelated"); assert.equal(h.original._closed, false); assert.equal(result.ok, true);
});
await scenario("malformed requests do not dispatch and duplicate pending id is refused", async (h, report) => {
  const transport = await h.capture(); h.session("foreign"); const gate = h.gate({ result: "held" }); h.setRead(async () => await gate.promise);
  const invalid = ["not JSON", "null", "[]", JSON.stringify({ id: 0, method: "A.b" }), JSON.stringify({ id: 1.5, method: "A.b" }), JSON.stringify({ id: 1, method: "" }), JSON.stringify({ id: 1, method: "A.b", params: [] }), JSON.stringify({ id: 1, method: "A.b", sessionId: "" })];
  const refusals: string[] = [];
  for (const raw of invalid) { try { transport.send(raw); } catch (error) { refusals.push((error as Error).message); } }
  const before = dispatched(h).length; transport.send(request(10)); let duplicate: string | undefined;
  try { transport.send(request(10)); } catch (error) { duplicate = (error as Error).message; }
  gate.resolve({ result: "held" }); await ticks(); report({ refusals, duplicate, before });
  assert.equal(refusals.length, invalid.length); assert.equal(before, 0); assert.match(duplicate ?? "", /Duplicate/); assert.equal(dispatched(h).length, 1); await transport.dispose();
});
for (const state of ["detached", "foreign", "replaced"] as const) {
  await scenario(`${state} child gets a correlated refusal while the original root remains usable`, async (h, report) => {
    const transport = await h.capture();
    const root = h.root();
    const child = state === "foreign" ? h.session("child") : h.child("child", root);
    if (state === "detached") child.onClosed();
    if (state === "replaced") h.session(child.id(), root);
    const delivered: Record<string, unknown>[] = [];
    let closeCount = 0;
    transport.onmessage = raw => delivered.push(JSON.parse(raw));
    transport.onclose = () => { closeCount++; };
    // Puppeteer can queue this command before a child-detached event is delivered.
    transport.send(request(41, "Runtime.runIfWaitingForDebugger", child.id()));
    await ticks();
    assert.deepEqual(delivered, [{ id: 41, sessionId: child.id(), error: {
      code: -32000, message: "Session closed or not owned by this browser transport",
    } }]);
    assert.equal(dispatched(h).length, 0);
    assert.equal(closeCount, 0);
    transport.send(request(42));
    await ticks();
    assert.deepEqual(dispatched(h).map(call => [call.sessionId, call.method]), [[root.id(), "Runtime.evaluate"]]);
    assert.equal(delivered[1]?.id, 42);
    assert.equal("error" in delivered[1]!, false);
    assert.equal(closeCount, 0);
    const result = await tracked(transport.dispose()).done();
    assert.equal(result.ok, true);
    assert.equal(closeCount, 1);
    report({ delivered, result, closeCount });
  });
}
await scenario("original connection replacement during allocation cleans only original allocated session", async (h, report) => {
  const allocation = h.gate({ sessionId: "owned-root" }); h.holdAllocation(allocation.promise);
  const opening = tracked(h.capture()); await ticks(); h.browser._connection = h.replacement;
  allocation.resolve({ sessionId: "owned-root" }); const result = await opening.done(); report(result);
  assertFailure(result, /Original browser transport connection/); assert.deepEqual(h.calls.map(call => [call.connection, call.method]), [["original", "Target.attachToBrowserTarget"], ["original", "Target.detachFromTarget"]]); assert.equal(h.replacement._closed, false);
});
await scenario("allocation cannot adopt or detach a preexisting session id", async (h, report) => {
  const existing = h.session("already-owned"); h.setAllocation(existing.id()); const result = await tracked(h.capture()).done(); report(result);
  assertFailure(result, /Invalid owned browser session allocation/); assert.equal(h.calls.filter(call => call.method === "Target.detachFromTarget").length, 0); assert.equal(existing.detached, false); assert.equal(h.original._session(existing.id())?.id(), existing.id());
});
await scenario("original connection replacement during held response suppresses reply and retires original session", async (h, report) => {
  const transport = await h.capture(); const reply = h.gate({ result: "stale" }); h.setRead(async () => await reply.promise);
  const delivered: string[] = []; transport.onmessage = value => delivered.push(value); transport.send(request(1)); await ticks();
  h.browser._connection = h.replacement; reply.resolve({ result: "stale" }); await ticks(); const result = await tracked(transport.dispose()).done(); report({ delivered, result });
  assert.deepEqual(delivered, []); assertFailure(result, /Original browser transport connection/); assert.equal(h.calls.filter(call => call.connection === "replacement").length, 0); assert.equal(h.original._session("owned-root"), undefined);
});
await scenario("dispose awaits independently held detach and pending failure and retains both errors", async (h, report) => {
  const transport = await h.capture(); const root = h.root(); const read = h.gate({}), detach = h.gate({}); h.setRead(async () => await read.promise); h.holdDetach(detach.promise);
  transport.send(request(1)); const first = tracked(transport.dispose()); const second = tracked(transport.dispose()); await ticks();
  const bothHeld = first.pending() && second.pending(); detach.reject(new Error("Detach failed")); await ticks(); const waitsRead = first.pending() && second.pending();
  read.reject(new Error("Held protocol read failed")); const results = await Promise.all([first.done(), second.done()]); const repeated = await tracked(transport.dispose()).done(); report({ bothHeld, waitsRead, results, repeated });
  assert.equal(bothHeld, true); assert.equal(waitsRead, true); assert.equal(h.calls.filter(call => call.method === "Target.detachFromTarget").length, 1);
  for (const result of [...results, repeated]) { assertFailure(result, /Detach failed/); assertFailure(result, /Held protocol read failed/); } assert.equal(root.detached, true);
});
await scenario("pending read can settle while detach is held and valid late reply is suppressed", async (h, report) => {
  const transport = await h.capture(); const root = h.root(); const read = h.gate({}), detach = h.gate({}); h.setRead(async () => await read.promise); h.holdDetach(detach.promise);
  const delivered: string[] = []; transport.onmessage = value => delivered.push(value); transport.send(request(1)); const disposal = tracked(transport.dispose());
  read.resolve({ ok: "late" }); await ticks(); const held = disposal.pending(); detach.resolve({}); const result = await disposal.done(); report({ held, result, delivered });
  assert.equal(held, true); assert.equal(result.ok, true); assert.deepEqual(delivered, []); assert.equal(root.detached, true);
});
await scenario("pending capacity refuses the 257th request without dispatch and reopens after settlement", async (h, report) => {
  const transport = await h.capture(); transport.onmessage = () => {}; const gate = h.gate({}); h.setRead(async () => await gate.promise);
  for (let id = 1; id <= 256; id++) transport.send(request(id)); let refusal: string | undefined;
  try { transport.send(request(257)); } catch (error) { refusal = (error as Error).message; }
  const atLimit = dispatched(h).length; gate.resolve({}); await ticks(); transport.send(request(257)); await ticks(); report({ refusal, atLimit, after: dispatched(h).length });
  assert.match(refusal ?? "", /capacity/); assert.equal(atLimit, 256); assert.equal(dispatched(h).length, 257); await transport.dispose();
});
await scenario("buffered events flush in order when listener is supplied", async (h, report) => {
  const transport = await h.capture(); const root = h.root(); root.emit("Page.first", { order: 1 }); root.emit("Page.second", { order: 2 });
  const delivered: Record<string, unknown>[] = []; transport.onmessage = raw => delivered.push(JSON.parse(raw)); report(delivered);
  assert.deepEqual(delivered.map(value => value.method), ["Page.first", "Page.second"]); await transport.dispose(); assert.equal(root.count(), 0);
});
await scenario("257th buffered event retires and retains buffer capacity error", async (h, report) => {
  const transport = await h.capture(); const root = h.root(); let closes = 0; transport.onclose = () => closes++;
  for (let index = 0; index < 257; index++) root.emit("Page.buffered", { index }); const result = await tracked(transport.dispose()).done(); report({ closes, result });
  assertFailure(result, /buffer exceeded/); assert.equal(closes, 1); assert.equal(root.count(), 0); assert.equal(h.calls.filter(call => call.method === "Target.detachFromTarget").length, 1);
});
await scenario("oversized buffered event retires without delivering the oversized payload", async (h, report) => {
  const transport = await h.capture(); h.root().emit("Page.large", { value: "x".repeat(16 * 1024 * 1024 + 1) });
  let delivered = 0; transport.onmessage = () => delivered++; const result = await tracked(transport.dispose()).done(); report({ delivered, result }); assertFailure(result, /buffer exceeded/); assert.equal(delivered, 0);
});
await scenario("onmessage can reentrantly close without queued extra dispatch or duplicate close notification", async (h, report) => {
  const transport = await h.capture(); const root = h.root(); let delivered = 0, closes = 0, refusal: string | undefined;
  transport.onclose = () => closes++; transport.onmessage = () => { delivered++; transport.close(); try { transport.send(request(99)); } catch (error) { refusal = (error as Error).message; } };
  root.emit("Page.live", {}); const result = await tracked(transport.dispose()).done(); report({ delivered, closes, refusal, result });
  assert.equal(delivered, 1); assert.equal(closes, 1); assert.match(refusal ?? "", /closed/); assert.equal(dispatched(h).length, 0); assert.equal(result.ok, true); assert.equal(root.count(), 0);
});
await scenario("throwing live onmessage listener retires and retains callback error", async (h, report) => {
  const transport = await h.capture(); transport.onmessage = () => { throw new Error("Consumer delivery failed"); }; h.root().emit("Page.live", {});
  const result = await tracked(transport.dispose()).done(); report(result); assertFailure(result, /Consumer delivery failed/); assert.equal(h.calls.filter(call => call.method === "Target.detachFromTarget").length, 1);
});
await scenario("onclose can reenter disposal and throw while all callers observe retained failure", async (h, report) => {
  const transport = await h.capture(); let nested: ReturnType<typeof tracked> | undefined, closes = 0;
  transport.onclose = () => { closes++; nested = tracked(transport.dispose()); throw new Error("Consumer close failed"); };
  const result = await tracked(transport.dispose()).done(); const nestedResult = nested ? await nested.done() : undefined; const repeated = await tracked(transport.dispose()).done(); report({ result, nestedResult, repeated, closes });
  assert(nestedResult); for (const value of [result, nestedResult, repeated]) assertFailure(value, /Consumer close failed/); assert.equal(closes, 1); assert.equal(h.calls.filter(call => call.method === "Target.detachFromTarget").length, 1);
});
await scenario("child disconnect stops child events without disposing root or unrelated child", async (h, report) => {
  const transport = await h.capture(); const root = h.root(), first = h.child("first", root), second = h.child("second", root); const delivered: Record<string, unknown>[] = [];
  transport.onmessage = raw => delivered.push(JSON.parse(raw)); first.onClosed(); first.emit("Page.stale", {}); second.emit("Page.current", {}); transport.send(request(1)); await ticks(); report(delivered);
  assert.equal(delivered.some(value => value.method === "Page.stale"), false); assert.equal(delivered.some(value => value.method === "Page.current" && value.sessionId === "second"), true); assert.equal(root.detached, false); assert.equal(second.detached, false); await transport.dispose();
});
await scenario("foreign child-parent event retires without adopting foreign session", async (h, report) => {
  const transport = await h.capture(); const foreignParent = h.session("foreign-parent"), foreign = h.session("foreign-child", foreignParent);
  h.root().emit(events.SessionAttached, foreign); const result = await tracked(transport.dispose()).done(); report(result); assertFailure(result, /Foreign browser child parent/); assert.equal(foreign.detached, false); assert.equal(dispatched(h).length, 0);
});
await scenario("unchanged connected owner accepts repeated requests and protocol errors remain shaped replies", async (h, report) => {
  const transport = await h.capture(); const delivered: Record<string, unknown>[] = []; transport.onmessage = raw => delivered.push(JSON.parse(raw));
  h.setRead(async (_session, method) => { if (method === "Runtime.fail") throw Object.assign(new Error("Protocol denied"), { code: -123, data: { reason: "controlled" } }); return { value: 2 }; });
  transport.send(request(1, "Runtime.fail")); await ticks(); transport.send(request(1)); await ticks(); const result = await tracked(transport.dispose()).done(); report({ delivered, result });
  assert.deepEqual(delivered[0]!.error, { message: "Protocol denied", code: -123, data: { reason: "controlled" } }); assert.deepEqual(delivered[1]!.result, { value: 2 }); assert.equal(result.ok, true); assert.equal(h.calls.filter(call => call.method === "Target.attachToBrowserTarget").length, 1);
});
await scenario("throwing buffered onmessage consumer is retained in disposal accounting", async (h, report) => {
  const transport = await h.capture(); const root = h.root(); root.emit("Page.buffered", {}); let escaped: string | undefined;
  try { transport.onmessage = () => { throw new Error("Buffered consumer failed"); }; } catch (error) { escaped = (error as Error).message; }
  const result = await tracked(transport.dispose()).done(); report({ escaped, result }); assertFailure(result, /Buffered consumer failed/); assert.equal(root.count(), 0);
});
await scenario("session cleanup failure cannot bypass still-pending request drain", async (h, report) => {
  const transport = await h.capture(); const root = h.root(); const read = h.gate({}); h.setRead(async () => await read.promise);
  h.setClosedEffect(session => { if (session.id() === root.id()) throw new Error("Session cleanup failed"); });
  transport.send(request(1)); const disposal = tracked(transport.dispose()); await ticks(); const held = disposal.pending();
  read.reject(new Error("Later request failed")); const result = await disposal.done(); report({ held, result });
  assert.equal(held, true); assertFailure(result, /Session cleanup failed/); assertFailure(result, /Later request failed/); assert.equal(h.original._session(root.id()), undefined);
});
await scenario("late close listener receives one completed notification without replaying cleanup", async (h, report) => {
  const transport = await h.capture(); await transport.dispose(); let closes = 0; transport.onclose = () => closes++; transport.close(); transport.onclose = () => closes++;
  const result = await tracked(transport.dispose()).done(); report({ closes, result }); assert.equal(closes, 1); assert.equal(result.ok, true); assert.equal(h.calls.filter(call => call.method === "Target.detachFromTarget").length, 1);
});

await scenario("cleanup closes captured children while preserving a same-id replacement map entry", async (h, report) => {
  const transport = await h.capture(); const root = h.root(), originalChild = h.child("child-id", root); const detach = h.gate({}); h.holdDetach(detach.promise);
  const disposal = tracked(transport.dispose()); await ticks(); const replacementChild = h.session("child-id", h.session("replacement-parent"));
  detach.resolve({}); const result = await disposal.done(); report({ result, originalClosed: originalChild.closedCount, replacementClosed: replacementChild.closedCount });
  assert.equal(originalChild.detached, true); assert.equal(replacementChild.detached, false); assert.equal(replacementChild.closedCount, 0); assert.equal(h.original._session("child-id")?.parentSession()?.id(), "replacement-parent"); assert.equal(result.ok, true);
});

await scenario("observed connection loss at send remains retired after original connection returns", async (h, report) => {
  const transport = await h.capture(); const detach = h.gate({}); h.holdDetach(detach.promise);
  h.browser._connection = h.replacement;
  assert.throws(() => transport.send(request(1)), /Original browser transport connection/);
  h.browser._connection = h.original;
  let refused = false;
  try { transport.send(request(2)); } catch { refused = true; }
  detach.resolve({}); const result = await tracked(transport.dispose()).done(); report({ refused, result });
  assert.equal(refused, true); assert.equal(dispatched(h).length, 0);
  assertFailure(result, /Original browser transport connection/);
  assert.equal(h.calls.filter(call => call.connection === "replacement").length, 0);
});


await scenario("retired startup create retains native target before detach without child reply", async (h, report) => {
  const transport = await h.capture(); const read = h.gate({ targetId: "created-original" }), detach = h.gate({});
  h.setRead(async () => await read.promise); h.holdDetach(detach.promise);
  const delivered: string[] = []; transport.onmessage = value => delivered.push(value);
  transport.send(request(1, "Target.createTarget")); await ticks();
  const pendingReceipt = transport.startupCreations;
  const disposal = tracked(transport.dispose()); await ticks();
  const beforeReply = { pending: disposal.pending(), detachCalls: h.calls.filter(call => call.method === "Target.detachFromTarget").length, rootDetached: h.root().detached };
  read.resolve({ targetId: "created-original" }); await ticks();
  const afterReply = { pending: disposal.pending(), receipts: transport.startupCreations, detachCalls: h.calls.filter(call => call.method === "Target.detachFromTarget").length };
  detach.resolve({}); const result = await disposal.done(); report({ pendingReceipt, beforeReply, afterReply, delivered, result });
  assert.deepEqual(pendingReceipt, [{ requestId: 1, status: "pending" }]);
  assert.deepEqual(beforeReply, { pending: true, detachCalls: 0, rootDetached: false });
  assert.deepEqual(afterReply, { pending: true, receipts: [{ requestId: 1, status: "created", targetId: "created-original" }], detachCalls: 1 });
  assert.deepEqual(delivered, []); assert.equal(result.ok, true);
  assert.deepEqual(transport.startupCreations, afterReply.receipts);
  assert.throws(() => transport.send(request(2, "Target.createTarget")), /closed/);
});
await scenario("startup create rejection remains unknown through disposal and refuses startup completion", async (h, report) => {
  const transport = await h.capture(); const read = h.gate({}); h.setRead(async () => await read.promise);
  const delivered: Record<string, unknown>[] = []; transport.onmessage = value => delivered.push(JSON.parse(value));
  transport.send(request(1, "Target.createTarget")); read.reject(new Error("Original create reply lost")); await ticks();
  let completionError: string | undefined;
  try { transport.finishStartup(); } catch (error) { completionError = (error as Error).message; }
  const receipts = transport.startupCreations; const result = await tracked(transport.dispose()).done(); report({ receipts, completionError, delivered, result });
  assert.deepEqual(receipts, [{ requestId: 1, status: "unknown", error: "Original create reply lost" }]);
  assert.match(completionError ?? "", /pending or unknown/); assertFailure(result, /Original create reply lost/);
  assert.equal(dispatched(h).length, 1); assert.equal(delivered.length, 1); assert.equal(delivered[0]!.id, 1);
  assert.deepEqual(transport.startupCreations, receipts);
});
for (const invalid of [undefined, {}, { targetId: "" }, { targetId: "   " }, { targetId: 17 }, []]) {
  await scenario(`malformed startup creation response is unknown: ${JSON.stringify(invalid) ?? "undefined"}`, async (h, report) => {
    const transport = await h.capture(); h.setRead(async () => invalid); transport.onmessage = () => {};
    transport.send(request(1, "Target.createTarget")); await ticks();
    const receipts = transport.startupCreations; let completionError: string | undefined;
    try { transport.finishStartup(); } catch (error) { completionError = (error as Error).message; }
    const result = await tracked(transport.dispose()).done(); report({ receipts, completionError, result });
    assert.equal(receipts.length, 1); assert.equal(receipts[0]!.status, "unknown");
    if (receipts[0]!.status === "unknown") assert.match(receipts[0]!.error, /no valid target id/);
    assert.match(completionError ?? "", /pending or unknown/); assertFailure(result, /no valid target id/);
    assert.equal(dispatched(h).length, 1);
  });
}
await scenario("startup completion requires settled receipt then stops tracking later user creations", async (h, report) => {
  const transport = await h.capture(); const read = h.gate({ targetId: "startup" }); h.setRead(async () => await read.promise); transport.onmessage = () => {};
  transport.send(request(1, "Target.createTarget"));
  let pendingError: string | undefined; try { transport.finishStartup(); } catch (error) { pendingError = (error as Error).message; }
  read.resolve({ targetId: "startup" }); await ticks(); transport.finishStartup();
  h.setRead(async () => ({ targetId: "later-user-page" })); transport.send(request(2, "Target.createTarget")); await ticks();
  transport.finishStartup(); const receipts = transport.startupCreations; const result = await tracked(transport.dispose()).done(); report({ pendingError, receipts, result });
  assert.match(pendingError ?? "", /pending or unknown/);
  assert.deepEqual(receipts, [{ requestId: 1, status: "created", targetId: "startup" }]);
  assert.equal(dispatched(h).length, 2); assert.equal(result.ok, true);
});
await scenario("startup receipt snapshots resist consumer mutation and preserve reused request ids", async (h, report) => {
  const transport = await h.capture(); let count = 0; const nativeResults: Array<{ targetId: string }> = [];
  h.setRead(async () => { const value = { targetId: `target-${++count}` }; nativeResults.push(value); return value; }); transport.onmessage = () => {};
  transport.send(request(1, "Target.createTarget")); await ticks();
  const snapshot = transport.startupCreations;
  try { (snapshot as unknown as Array<unknown>).push({ requestId: 99, status: "created", targetId: "foreign" }); } catch {}
  try { (snapshot[0] as unknown as { targetId: string }).targetId = "consumer-replacement"; } catch {}
  nativeResults[0]!.targetId = "native-result-mutated";
  transport.send(request(1, "Target.createTarget")); await ticks();
  const receipts = transport.startupCreations; transport.finishStartup(); await transport.dispose(); report({ snapshot, receipts });
  assert.deepEqual(receipts, [{ requestId: 1, status: "created", targetId: "target-1" }, { requestId: 1, status: "created", targetId: "target-2" }]);
  assert.deepEqual(snapshot, [{ requestId: 1, status: "created", targetId: "target-1" }]);
  assert.equal(dispatched(h).length, 2);
});
await scenario("completed startup creation receipts retain bounded admission until startup finishes", async (h, report) => {
  const transport = await h.capture(); let count = 0; h.setRead(async () => ({ targetId: `target-${++count}` })); transport.onmessage = () => {};
  for (let id = 1; id <= 256; id++) { transport.send(request(id, "Target.createTarget")); await ticks(); }
  let refusal: string | undefined; try { transport.send(request(257, "Target.createTarget")); } catch (error) { refusal = (error as Error).message; }
  const beforeCompletion = { dispatched: dispatched(h).length, receipts: transport.startupCreations.length };
  transport.finishStartup(); transport.send(request(257, "Target.createTarget")); await ticks();
  const receipts = transport.startupCreations; await transport.dispose(); report({ refusal, beforeCompletion, finalCalls: dispatched(h).length, receipts: receipts.length });
  assert.match(refusal ?? "", /startup creation capacity/); assert.deepEqual(beforeCompletion, { dispatched: 256, receipts: 256 });
  assert.equal(dispatched(h).length, 257); assert.equal(receipts.length, 256);
  assert.deepEqual(receipts[255], { requestId: 256, status: "created", targetId: "target-256" });
});
await scenario("creation receipt survives throwing worker delivery without losing its target", async (h, report) => {
  const transport = await h.capture(); const read = h.gate({ targetId: "original-target" }); h.setRead(async () => await read.promise);
  transport.onmessage = () => { throw new Error("Worker delivery failed"); };
  transport.send(request(1, "Target.createTarget")); read.resolve({ targetId: "original-target" }); await ticks();
  const result = await tracked(transport.dispose()).done(); report({ receipts: transport.startupCreations, result });
  assert.deepEqual(transport.startupCreations, [{ requestId: 1, status: "created", targetId: "original-target" }]);
  assertFailure(result, /Worker delivery failed/); assert.equal(h.calls.filter(call => call.connection === "replacement").length, 0);
});
await scenario("lost original connection after create keeps original receipt and refuses publication", async (h, report) => {
  const transport = await h.capture(); const read = h.gate({ targetId: "original-target" }); h.setRead(async () => await read.promise);
  const delivered: string[] = []; transport.onmessage = value => delivered.push(value);
  transport.send(request(1, "Target.createTarget")); h.browser._connection = h.replacement;
  read.resolve({ targetId: "original-target" }); await ticks(); const result = await tracked(transport.dispose()).done(); report({ receipts: transport.startupCreations, delivered, result });
  assert.deepEqual(transport.startupCreations, [{ requestId: 1, status: "created", targetId: "original-target" }]);
  assert.deepEqual(delivered, []); assertFailure(result, /Original browser transport connection/);
  assert.equal(h.calls.filter(call => call.connection === "replacement").length, 0);
});

console.log(JSON.stringify({ selectedPath, sourceSha256: hash(source), sourceBytes: Buffer.byteLength(source), completeModuleWithoutImportsSha256: hash(selected), counts: { pass: passed.length, fail: failures.length }, passed, failures, evidence,
  limits: "Exact complete selected production module transpiled with imports stripped; controlled original Connection, fake CdpCDPSession/EventEmitter with wildcard and attached/disconnected events. Allocation/detach and request gates settled explicitly, no real clocks/timeouts/SDK/CDP/browser/network/IPC/native process. Session onClosed marks only that controlled session; no claim about actual Puppeteer cascade behavior. Other sessions are deliberately retained and inspected. No evaluation of installed SDK or full native type graph. Startup creation cases retain controlled native replies before wire delivery and session detach, preserve unknown outcomes and bounded copied receipts; they do not prove parent orphan closure, actual worker termination, server incarnation or native creation behavior. Cases exercise source adapter behavior, not physical server identity or backend closure." }, null, 2));
if (failures.length) process.exitCode = 1;
