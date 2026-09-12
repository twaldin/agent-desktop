/** Complete selected entry, controlled inbox/Core/port only. No Worker or SDK import/evaluation. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const [entryPath] = process.argv.slice(2);
if (!entryPath) throw new Error("Expected complete worker entry source path");
const entrySource = await readFile(entryPath, "utf8");
const executable = new Bun.Transpiler({ loader: "ts" }).transformSync(
  entrySource.replace(/^import\b[\s\S]*?;\r?\n/gm, ""),
);
type Message = { type: string; [key: string]: unknown };
type Handler = (...args: any[]) => void;
type Transport = {
  send(message: Message, transfer?: unknown[]): void;
  onMessage(handler: (message: Message) => void): () => void;
  close(): void;
};
const ticks = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function harness(options: { inbox?: Message[]; closeOnReplay?: boolean; missingPort?: boolean } = {}) {
  const callbacks = new Map<string, Set<Handler>>();
  const received: Message[] = [], posts: Array<{ message: Message; transfer: unknown[] }> = [];
  const errors: unknown[][] = [], abortReasons: Error[] = [];
  const drain = Promise.withResolvers<void>();
  let transport: Transport | undefined, unbind: (() => void) | undefined;
  let inboxHandler: ((message: Message) => void) | undefined;
  let inboxBinds = 0, inboxUnbinds = 0, closeCalls = 0, consumeCalls = 0;
  let cleanupStarts = 0, cleanupFinished = false, physical = false;
  const emit = (kind: string, ...args: any[]) => {
    for (const callback of [...callbacks.get(kind) ?? []]) callback(...args);
  };
  const port = {
    on(kind: string, callback: Handler) {
      if (!callbacks.has(kind)) callbacks.set(kind, new Set());
      callbacks.get(kind)!.add(callback);
      return port;
    },
    off(kind: string, callback: Handler) { callbacks.get(kind)?.delete(callback); return port; },
    postMessage(message: Message, transfer: unknown[]) { posts.push({ message, transfer }); },
    close() { closeCalls++; emit("close"); },
  };
  const originalGlobal = {
    postMessage(message: Message, transfer: unknown[]) { posts.push({ message, transfer }); },
  };
  const inbox = options.inbox === undefined ? undefined : {
    bind(handler: (message: Message) => void) {
      inboxBinds++; inboxHandler = handler;
      for (const message of options.inbox!) handler(message);
      return () => { inboxUnbinds++; inboxHandler = undefined; };
    },
  };
  class ControlledCore {
    private cleanup: Promise<void> | undefined;
    constructor(value: Transport, isPhysical: boolean) {
      transport = value; physical = isPhysical;
      unbind = value.onMessage(message => {
        received.push(message);
        if (options.closeOnReplay && message.type === "close") value.close();
      });
    }
    abort(reason: Error): Promise<void> {
      abortReasons.push(reason);
      if (!this.cleanup) {
        cleanupStarts++;
        this.cleanup = drain.promise.then(() => { cleanupFinished = true; });
      }
      return this.cleanup;
    }
  }
  const load = () => new Function("parentPort", "consumeWorkerInbox", "WorkerCore", "console", "globalThis", executable)(
    options.missingPort ? undefined : port,
    () => { consumeCalls++; return inbox; },
    ControlledCore,
    { error: (...args: unknown[]) => errors.push(args) },
    originalGlobal,
  );
  return {
    load, emit, received, posts, errors, abortReasons,
    queued: (kind: string) => [...callbacks.get(kind) ?? []],
    direct: (message: Message) => emit("message", message),
    buffered: (message: Message) => inboxHandler?.(message),
    send: (message: Message, transfer?: unknown[]) => transport!.send(message, transfer),
    close: () => transport!.close(),
    unbind: () => unbind!(),
    settle: (error?: Error) => error ? drain.reject(error) : drain.resolve(),
    replaceGlobalSend: (replacement: typeof originalGlobal.postMessage) => { originalGlobal.postMessage = replacement; },
    state: () => ({ inboxBinds, inboxUnbinds, closeCalls, consumeCalls, cleanupStarts, cleanupFinished, physical,
      messages: callbacks.get("message")?.size ?? 0,
      closes: callbacks.get("close")?.size ?? 0,
      messageErrors: callbacks.get("messageerror")?.size ?? 0 }),
  };
}

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, run: () => void | Promise<void>) => tests.push([name, run]);
test("missing parent fails before consuming inbox or constructing Core", () => {
  const h = harness({ missingPort: true });
  assert.throws(h.load, /missing parentPort/);
  assert.equal(h.state().consumeCalls, 0); assert.equal(h.state().physical, false);
});
test("original buffered inbox replays once and exclusively owns subsequent delivery", () => {
  const init = { type: "init", channel: "original" }, later = { type: "run" };
  const h = harness({ inbox: [init] }); h.load();
  h.direct({ type: "foreign-direct" }); h.buffered(later);
  assert.deepEqual(h.received, [init, later]); assert.equal(h.state().inboxBinds, 1);
  assert.equal(h.state().messages, 0); assert.equal(h.state().physical, true);
  h.unbind(); h.buffered({ type: "after-unbind" });
  assert.equal(h.state().inboxUnbinds, 1); assert.equal(h.received.length, 2);
});
test("direct entry has one removable listener and forwards transfer list", () => {
  const h = harness(); h.load(); const init = { type: "init" }, sent = { type: "reply" };
  h.direct(init); const transfer = [new ArrayBuffer(1)]; h.send(sent, transfer); h.send({ type: "plain" });
  assert.deepEqual(h.received, [init]); assert.equal(h.state().messages, 1);
  assert.deepEqual(h.posts, [{ message: sent, transfer }, { message: { type: "plain" }, transfer: [] }]);
  h.unbind(); h.direct({ type: "ignored" }); assert.equal(h.received.length, 1); assert.equal(h.state().messages, 0);
});
test("captured send preserves transferred port and buffer ownership after a global replacement", () => {
  const h = harness(); h.load();
  let replacementCalls = 0;
  h.replaceGlobalSend(() => { replacementCalls++; });
  const port = { originalPort: true }, buffer = new ArrayBuffer(3);
  const message = { type: "tool-call", port, buffer };
  h.send(message, [port, buffer]);
  assert.equal(replacementCalls, 0); assert.equal(h.posts.length, 1);
  // Transfer objects are the exact ports/buffers referenced by the payload;
  // substituting a clone would change which resources are transferred.
  assert.equal(h.posts[0]!.transfer[0], message.port);
  assert.equal(h.posts[0]!.transfer[1], message.buffer);
  assert.equal(h.posts[0]!.message, message);
});
test("lost original parent starts held abort and reports eventual cleanup failure", async () => {
  const h = harness(); h.load(); h.emit("close"); await ticks();
  const before = h.state(); h.settle(new Error("Original detach failed")); await ticks();
  assert.equal(before.cleanupStarts, 1); assert.equal(before.cleanupFinished, false);
  assert.match(h.abortReasons[0]!.message, /Original tab worker parent port closed/);
  assert.equal(h.errors.length, 1); assert.equal(h.errors[0]![0], "Tab worker lost-port cleanup failed");
  assert.match(String(h.errors[0]![1]), /Original detach failed/);
});
test("messageerror forwards original error into the same retained abort cleanup", async () => {
  const h = harness(); h.load(); const error = new Error("Original port decode failed");
  h.emit("messageerror", error); h.emit("close"); await ticks(); const before = h.state();
  h.settle(); await ticks();
  assert.equal(h.abortReasons[0]!.message, "Original port decode failed"); assert.equal(before.cleanupStarts, 1);
  assert.equal(before.cleanupFinished, false); assert.equal(h.state().cleanupFinished, true); assert.deepEqual(h.errors, []);
});
test("local transport close removes lifecycle listeners before synchronous port close", () => {
  const h = harness(); h.load(); h.close(); h.emit("messageerror", new Error("After local close"));
  assert.equal(h.state().closeCalls, 1); assert.equal(h.state().closes, 0); assert.equal(h.state().messageErrors, 0);
  assert.deepEqual(h.abortReasons, []);
});
test("synchronous constructor inbox close does not install listeners on the closed port", () => {
  const h = harness({ inbox: [{ type: "close" }], closeOnReplay: true }); h.load();
  const afterConstruction = h.state(); h.emit("messageerror", new Error("After replay close"));
  assert.equal(afterConstruction.closeCalls, 1); assert.equal(afterConstruction.closes, 0);
  assert.equal(afterConstruction.messageErrors, 0); assert.deepEqual(h.abortReasons, []);
});
test("queued original messageerror callback cannot start abort after local close", () => {
  const h = harness(); h.load(); const queued = h.queued("messageerror"); h.close();
  for (const callback of queued) callback(new Error("Queued before local close"));
  assert.equal(queued.length, 1); assert.equal(h.state().cleanupStarts, 0); assert.deepEqual(h.abortReasons, []);
});

let passed = 0;
const failures: Array<{ name: string; error: string }> = [];
for (const [name, run] of tests) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); console.error(`FAIL ${name}`, error); }
}
console.log(JSON.stringify({ source: entryPath, sha256: createHash("sha256").update(entrySource).digest("hex"), passed, failed: failures.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
