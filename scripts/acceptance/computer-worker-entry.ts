/** Whole selected entry with controlled Core, inbox and port. No SDK or Worker execution. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const [sourcePath] = process.argv.slice(2);
if (!sourcePath) throw new Error("Expected a complete computer worker entry source");
const source = await readFile(sourcePath, "utf8");
const executable = new Bun.Transpiler({ loader: "ts" }).transformSync(
  source.replace(/^import\b[\s\S]*?;\r?\n/gm, "").replace(/^export (?=function )/gm, ""),
);
type Transport = {
  send(message: unknown, transfers?: unknown[]): void;
  onMessage(handler: (message: unknown) => void): () => void;
  close(): void;
};
function harness(options: { missingPort?: boolean; selector?: boolean; buffered?: boolean } = {}) {
  const handlers = new Set<(message: unknown) => void>();
  const posts: Array<{ message: unknown; transfers: unknown[] }> = [];
  const received: unknown[] = [];
  let constructed = 0, consumed = 0, bound = 0, unbound = 0, closed = 0;
  let transport: Transport | undefined, unsubscribe: (() => void) | undefined;
  let inboxHandler: ((message: unknown) => void) | undefined;
  const record = (message: unknown, transfers: unknown[]) => posts.push({ message, transfers });
  const port = {
    postMessage: record,
    on(event: string, handler: (message: unknown) => void) {
      assert.equal(event, "message"); handlers.add(handler);
    },
    off(event: string, handler: (message: unknown) => void) {
      assert.equal(event, "message"); handlers.delete(handler);
    },
    close() { closed++; },
  };
  const workerGlobal = {
    postMessage(message: unknown, transfers: unknown[]) {
      assert.equal(this, workerGlobal); record(message, transfers);
    },
  };
  const bufferedFirst = { type: "ping", id: "buffered" };
  const inbox = options.buffered ? {
    bind(handler: (message: unknown) => void) {
      bound++; inboxHandler = handler; handler(bufferedFirst);
      return () => { unbound++; inboxHandler = undefined; };
    },
  } : undefined;
  class ControlledCore {
    constructor(value: Transport) {
      constructed++; transport = value; unsubscribe = value.onMessage(message => received.push(message));
    }
  }
  const start = new Function("parentPort", "consumeWorkerInbox", "isWorkerHostSelector", "ComputerWorkerCore", "Bun", "globalThis",
    executable + "\nreturn startComputerWorker;")(
      options.missingPort ? undefined : port,
      () => { consumed++; return inbox; },
      (argument: string) => argument === "controlled-worker-selector",
      ControlledCore,
      { argv: options.selector ? ["controlled-worker-selector"] : [] },
      workerGlobal,
    ) as () => void;
  return {
    start, posts, received, bufferedFirst,
    send(message: unknown, transfers?: unknown[]) { transport!.send(message, transfers); },
    receive(message: unknown) { for (const handler of [...handlers]) handler(message); },
    buffered(message: unknown) { inboxHandler?.(message); },
    unsubscribe() { unsubscribe!(); },
    close() { transport!.close(); },
    replaceGlobalSend() { workerGlobal.postMessage = () => { throw new Error("replacement global send"); }; },
    state: () => ({ constructed, consumed, bound, unbound, closed, listeners: handlers.size }),
  };
}

const tests: Array<[string, () => void]> = [
  ["missing parent remains inert on direct and explicit startup", () => {
    const h = harness({ missingPort: true }); h.start(); h.start();
    assert.equal(h.state().constructed, 0); assert.equal(h.state().consumed, 0);
  }],
  ["host selector defers startup; explicit startup happens once", () => {
    const h = harness({ selector: true }); assert.equal(h.state().constructed, 0);
    h.start(); h.start(); assert.equal(h.state().constructed, 1); assert.equal(h.state().consumed, 1);
  }],
  ["direct startup and captured send retain payload and transfers", () => {
    const h = harness(); h.start(); assert.equal(h.state().constructed, 1);
    h.replaceGlobalSend();
    const buffer = new ArrayBuffer(8), controlledPort = { marker: "port" };
    const message = { type: "result", buffer, port: controlledPort };
    const transfers = [buffer, controlledPort]; h.send(message, transfers); h.send({ type: "ready" });
    assert.equal(h.posts.length, 2); assert.equal(h.posts[0]!.message, message);
    assert.equal(h.posts[0]!.transfers[0], buffer); assert.equal(h.posts[0]!.transfers[1], controlledPort);
    assert.deepEqual(h.posts[1]!.transfers, []);
  }],
  ["buffered inbox retains exclusive delivery and unsubscribe", () => {
    const h = harness({ buffered: true }); const next = { type: "ping", id: "next" };
    h.receive({ type: "foreign" }); h.buffered(next);
    assert.deepEqual(h.received, [h.bufferedFirst, next]); assert.equal(h.state().listeners, 0);
    h.unsubscribe(); h.buffered({ type: "late" });
    assert.equal(h.received.length, 2); assert.equal(h.state().bound, 1); assert.equal(h.state().unbound, 1);
  }],
  ["direct listener removal and close retain the original parent port", () => {
    const h = harness(); const message = { type: "ping", id: "direct" };
    h.receive(message); assert.deepEqual(h.received, [message]); assert.equal(h.state().listeners, 1);
    h.unsubscribe(); h.receive({ type: "late" }); h.close();
    assert.equal(h.received.length, 1); assert.equal(h.state().listeners, 0); assert.equal(h.state().closed, 1);
  }],
];
let failed = 0;
for (const [name, run] of tests) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
console.log(JSON.stringify({ selectedSource: sourcePath, sha256: createHash("sha256").update(source).digest("hex"), passed: tests.length - failed, failed,
  scope: "Whole actual entry with injected boundaries; controlled port identity, no native MessagePort transfer/Worker/IPC proof" }));
if (failed) process.exitCode = 1;
