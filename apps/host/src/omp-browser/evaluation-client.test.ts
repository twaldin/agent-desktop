/** Actual parent channel module and whole WorkerClient class, controlled native/IPC
 * dependencies only. These fixtures never launch a worker, SDK, or browser. */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openWorkerBrowserEvaluation, type BrowserEvaluationClient, type WorkerBrowserEvaluation } from "./evaluation-client";
import { copyEvaluationBinding, copyEvaluationFrame, copyEvaluationValue, evaluationKey,
  type BrowserEvaluationBinding, type BrowserEvaluationDescriptor, type BrowserEvaluationFrame, type BrowserEvaluationOperation } from "./evaluation-wire";
import { WORKER_PROTOCOL_VERSION, type ChildMessage, type ParentMessage, type WorkerOperation } from "../omp-workers/protocol";

const target = { workerPid: 717, name: "original", targetId: "target-717" };
const binding = (backend: "cdp" | "cmux", operationId = "operation"): BrowserEvaluationBinding => ({ ...target, ownerId: "owner-717", operationId, backend });
const ticks = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
const observe = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined as unknown }), error => ({ value: undefined as T | undefined, error }));
const errors = (value: unknown): string[] => value instanceof AggregateError ? value.errors.flatMap(errors) : [value instanceof Error ? value.message : String(value)];
const control = (kind: "close" | "drained", messages: string[] = []): BrowserEvaluationFrame => ({ type: "worker-cdp", channel: "channel-717", kind, errors: messages });

function model(backend: "cdp" | "cmux") {
  let post: ((frame: BrowserEvaluationFrame) => void) | undefined;
  let lost: ((error: unknown) => void) | undefined;
  let started = false;
  const requests: BrowserEvaluationOperation[] = [], sent: BrowserEvaluationFrame[] = [], order: string[] = [];
  const actual: Array<{ args: Extract<BrowserEvaluationOperation, { operation: "requestBrowserEvaluation" }>["args"]; gate: ReturnType<typeof Promise.withResolvers<Record<string, unknown>>> }> = [];
  const entered64 = Promise.withResolvers<void>();
  const descriptor: BrowserEvaluationDescriptor = backend === "cdp"
    ? { binding: binding(backend), backend, descriptor: { version: 1, channel: "channel-717", targetId: target.targetId, activateForScreenshot: true, dialogs: "dismiss" } }
    : { binding: binding(backend), backend, state: { version: 1, surfaceId: target.targetId, url: "https://original.invalid/", title: "Original", viewport: { width: 800, height: 600, deviceScaleFactor: 2 }, elementRefs: [{ id: 7, ref: "@e7", name: "Original" }] } };
  const hooks: { start?: () => void; dispose?: () => Promise<void> } = {};
  let unsubscribed = false, ownerDestructions = 0;
  const client: BrowserEvaluationClient & { destroyOwner(): void } = {
    pid: target.workerPid,
    subscribeBrowserEvaluation(value, receiver, onLost) {
      assert.deepEqual(value, binding(backend)); assert.equal(post, undefined);
      order.push("subscribe"); post = receiver; lost = onLost;
      return () => { unsubscribed = true; order.push("unsubscribe"); };
    },
    postBrowserEvaluationFrame(value, frame) { assert.deepEqual(value, binding(backend)); sent.push(frame); },
    request<T>(operation: BrowserEvaluationOperation): Promise<T> {
      requests.push(operation); order.push(operation.operation);
      assert(post, "route must precede open and start");
      switch (operation.operation) {
        case "openBrowserEvaluation": return Promise.resolve(descriptor as unknown as T);
        case "startBrowserEvaluation": started = true; hooks.start?.(); return Promise.resolve(undefined as T);
        case "requestBrowserEvaluation": {
          const gate = Promise.withResolvers<Record<string, unknown>>();
          actual.push({ args: operation.args, gate }); if (actual.length === 64) entered64.resolve();
          return gate.promise as Promise<T>;
        }
        case "disposeBrowserEvaluation": {
          if (hooks.dispose) return hooks.dispose() as Promise<T>;
          if (started) { post(control("close")); post(control("drained")); }
          return Promise.resolve(undefined as T);
        }
      }
    },
    destroyOwner() { ownerDestructions++; },
  };
  return { client, descriptor, requests, sent, order, actual, entered64, hooks,
    emit(frame: BrowserEvaluationFrame) { assert(post); post(frame); },
    lose(error: unknown) { assert(lost); lost(error); for (const request of actual) request.gate.reject(error); },
    unsubscribed: () => unsubscribed, ownerDestructions: () => ownerDestructions };
}
async function open(h: ReturnType<typeof model>, backend: "cdp" | "cmux") {
  return openWorkerBrowserEvaluation(h.client, "owner-717", target, "operation", backend, 500);
}
function cdp(handle: WorkerBrowserEvaluation) { assert.equal(handle.backend, "cdp"); if (handle.backend !== "cdp") throw new Error("CDP fixture expected"); return handle; }
function cmux(handle: WorkerBrowserEvaluation) { assert.equal(handle.backend, "cmux"); if (handle.backend !== "cmux") throw new Error("CMUX fixture expected"); return handle; }

test("parent registers before open/start, receives synchronous replay, keeps one receiver and forwards only real ACKs", async () => {
  const h = model("cdp"), handle = cdp(await open(h, "cdp")), frames: BrowserEvaluationFrame[] = [];
  h.hooks.start = () => h.emit({ type: "worker-cdp", channel: "channel-717", kind: "data", sequence: 1, data: "replay" });
  const sink = (frame: BrowserEvaluationFrame) => { frames.push(frame); };
  await handle.start(sink); await handle.start(sink);
  assert.deepEqual(h.order.slice(0, 3), ["subscribe", "openBrowserEvaluation", "startBrowserEvaluation"]);
  assert.equal(h.requests.filter(row => row.operation === "startBrowserEvaluation").length, 1);
  assert.equal(frames.length, 1); assert.deepEqual(h.sent, []);
  await assert.rejects(handle.start(() => {}), /receiver/);
  const ack: BrowserEvaluationFrame = { type: "worker-cdp", channel: "channel-717", kind: "ack", sequence: 1 };
  handle.receive(ack); assert.deepEqual(h.sent, [ack]);
  await handle.dispose(); assert(h.unsubscribed()); assert.equal(h.ownerDestructions(), 0);
});

test("close-first nested drained callback then throw retains the callback and native errors through repeated disposal", async () => {
  const h = model("cdp"), handle = cdp(await open(h, "cdp"));
  let closing: Promise<void> | undefined;
  await handle.start(frame => {
    if (frame.kind === "close") {
      closing = handle.dispose();
      h.emit(control("drained", ["native terminal failure"]));
      throw new Error("outer close callback failure");
    }
  });
  h.emit(control("close", ["native close failure"]));
  assert(closing);
  const result = await observe(closing);
  assert(errors(result.error).includes("outer close callback failure"));
  assert(errors(result.error).includes("native close failure"));
  assert(errors(result.error).includes("native terminal failure"));
  assert.equal(handle.dispose(), closing);
  assert.equal(h.requests.filter(row => row.operation === "disposeBrowserEvaluation").length, 1);
  assert.equal(h.ownerDestructions(), 0);
});

test("source process loss rejects disposal instead of fabricating successful drain", async () => {
  const h = model("cdp"), handle = cdp(await open(h, "cdp")), frames: BrowserEvaluationFrame[] = [];
  await handle.start(frame => { frames.push(frame); });
  h.lose(new Error("source process lost"));
  const result = await observe(handle.dispose());
  assert(errors(result.error).includes("source process lost"));
  assert.deepEqual(frames, []); assert(h.unsubscribed());
  assert.equal(h.requests.filter(row => row.operation === "disposeBrowserEvaluation").length, 0);
});

test("close and completed disposal RPC alone do not substitute for CDP drained", async () => {
  const h = model("cdp"), handle = cdp(await open(h, "cdp"));
  await handle.start(() => {});
  h.hooks.dispose = async () => { h.emit(control("close")); };
  let settled = false; const closing = handle.dispose().then(() => { settled = true; });
  await ticks(); assert.equal(settled, false); assert.equal(h.unsubscribed(), false);
  h.emit(control("drained")); await closing; assert(h.unsubscribed());
});

test("CMUX keeps 64 actual requests, increasing sequences, caller and response copies, and never retries a failure", async () => {
  const h = model("cmux"), handle = cmux(await open(h, "cmux"));
  const state = handle.state; state.elementRefs[0]!.name = "changed"; state.viewport.width = 1;
  assert.equal(handle.state.elementRefs[0]!.name, "Original"); assert.equal(handle.state.viewport.width, 800);
  const params = { surface_id: target.targetId, nested: { content: "before" } }, options = { timeoutMs: 500 };
  const calls = [observe(handle.request("browser.eval", params, options)), ...Array.from({ length: 63 }, () => observe(handle.request("browser.url.get", { surface_id: target.targetId })))];
  params.nested.content = "after"; options.timeoutMs = 1;
  await h.entered64.promise;
  await assert.rejects(handle.request("browser.eval", {}), /capacity/);
  assert.equal(h.actual.length, 64); assert.deepEqual(h.actual.map(row => row.args.sequence), Array.from({ length: 64 }, (_, i) => i + 1));
  assert.deepEqual(h.actual[0]!.args.params, { surface_id: target.targetId, nested: { content: "before" } });
  assert.equal(h.actual[0]!.args.options?.timeoutMs, 500);
  const native = { surface_id: target.targetId, nested: { response: "native" } };
  h.actual[0]!.gate.resolve(native);
  for (let i = 1; i < 64; i++) h.actual[i]!.gate.resolve({ surface_id: target.targetId });
  const results = await Promise.all(calls); await ticks();
  const returned = results[0]!.value as typeof native; returned.nested.response = "caller";
  assert.equal(native.nested.response, "native");
  native.nested.response = "source-later"; assert.equal(returned.nested.response, "caller");
  const failed = observe(handle.request("browser.eval", { surface_id: target.targetId }));
  await ticks(); assert.equal(h.actual.length, 65); assert.equal(h.actual[64]!.args.sequence, 65);
  h.actual[64]!.gate.reject(new Error("ordinary native failure"));
  assert(errors((await failed).error).includes("ordinary native failure")); await ticks();
  assert.equal(h.actual.length, 65); await handle.dispose(); assert.equal(h.ownerDestructions(), 0);
});

test("CMUX source loss makes dispatched request unknown and retains its failure in cleanup", async () => {
  const h = model("cmux"), handle = cmux(await open(h, "cmux"));
  const pending = observe(handle.request("browser.eval", { surface_id: target.targetId })); await ticks();
  assert.equal(h.actual.length, 1); h.lose(new Error("lost dispatched request"));
  const result = await pending;
  assert.equal((result.error as { code?: string }).code, "OUTCOME_UNKNOWN");
  assert(errors((await observe(handle.dispose())).error).includes("lost dispatched request"));
  assert.equal(h.actual.length, 1);
});

test("CMUX disposal joins held actual work and retains independent late operational failure", async () => {
  const h = model("cmux"), handle = cmux(await open(h, "cmux"));
  const pending = observe(handle.request("browser.eval", {})); await ticks();
  let settled = false; const closing = observe(handle.dispose()).then(value => { settled = true; return value; });
  await ticks(); assert.equal(settled, false); assert.equal(h.unsubscribed(), false);
  h.actual[0]!.gate.reject(new Error("late native failure"));
  await pending; const result = await closing;
  assert(errors(result.error).includes("late native failure")); assert.equal(h.ownerDestructions(), 0);
});

test("receiver throw drains only evaluation access and changed owner bindings never reopen original channels", async () => {
  const h = model("cdp"), handle = cdp(await open(h, "cdp"));
  await handle.start(frame => { if (frame.kind === "data") throw new Error("receiver failed"); });
  h.emit({ type: "worker-cdp", channel: "channel-717", kind: "data", sequence: 1, data: "event" });
  assert(errors((await observe(handle.dispose())).error).includes("receiver failed"));
  await assert.rejects(openWorkerBrowserEvaluation(h.client, "new-owner", target, "operation", "cdp", 500), /binding changed/);
  assert.equal(h.requests.filter(row => row.operation === "openBrowserEvaluation").length, 1);
  assert.equal(h.ownerDestructions(), 0);
});

test("source channel-control failure remains on disposal without destroying the original owner", async () => {
  const h = model("cdp"), handle = cdp(await open(h, "cdp"));
  await handle.start(() => {});
  h.hooks.dispose = async () => { h.emit(control("close")); h.emit(control("drained", ["native drain failure"])); throw new Error("control reply failure"); };
  const closing = handle.dispose(), result = await observe(closing);
  assert(errors(result.error).includes("native drain failure"));
  assert(errors(result.error).includes("control reply failure"));
  assert.equal(handle.dispose(), closing); assert.equal(h.ownerDestructions(), 0);
});

interface ExtractedClient {
  readonly pid: number;
  request<T = unknown>(operation: WorkerOperation): Promise<T>;
  close(options?: { requireAcknowledgement?: boolean }): Promise<void>;
  subscribeBrowserEvaluation(binding: BrowserEvaluationBinding, post: (frame: BrowserEvaluationFrame) => void, lost: (error: unknown) => void): () => void;
}
async function workerClientFixture() {
  // Select the WHOLE maintained class, never a rewritten receive/request excerpt.
  const source = await readFile(new URL("../omp-workers/runtime.ts", import.meta.url), "utf8");
  const start = source.indexOf("export class WorkerClient {"), end = source.indexOf("/** One native OMP process", start);
  assert(start >= 0 && end > start);
  const selected = source.slice(start, end);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(selected.replace("export class", "class")
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(path.resolve("apps/host/src/omp-workers/runtime.ts")).href)));
  const sent: ParentMessage[] = [], exited = Promise.withResolvers<number>();
  let receive!: (message: ChildMessage) => void, exit!: (child: { pid: number }, code: number, signal: null) => void, kills = 0;
  const processDouble = { pid: target.workerPid, exitCode: null as number | null, signalCode: null, exited: exited.promise,
    send(message: ParentMessage) {
      sent.push(copyEvaluationValue(message));
      if (message.type === "disposeAck") { processDouble.exitCode = 0; exit(processDouble, 0, null); exited.resolve(0); }
    },
    kill() { kills++; processDouble.exitCode = 1; exit(processDouble, 1, null); exited.resolve(1); },
  };
  const fakeBun = { spawn(options: { ipc: typeof receive; onExit: typeof exit }) { receive = options.ipc; exit = options.onExit; return processDouble; } };
  class Failure extends Error { constructor(value: { message: string }) { super(value.message); } }
  const factory = new Function("Bun", "path", "fileURLToPath", "getBundledRuntimeRoot", "assertBundledRuntime", "setTimeout", "clearTimeout", "WORKER_PROTOCOL_VERSION",
    "WorkerFailureError", "copyEvaluationBinding", "copyEvaluationFrame", "copyEvaluationValue", "evaluationKey", `${code}\nreturn WorkerClient;`);
  const Client = factory(fakeBun, path, fileURLToPath, () => undefined, () => { throw new Error("Unexpected bundled runtime"); },
    () => ({ unref() {} }), () => {}, WORKER_PROTOCOL_VERSION, Failure, copyEvaluationBinding, copyEvaluationFrame, copyEvaluationValue, evaluationKey) as new(options: { executablePath: string; environment: Record<string, string> }) => ExtractedClient;
  const client = new Client({ executablePath: "/controlled/bun", environment: {} });
  receive({ type: "ready", version: WORKER_PROTOCOL_VERSION });
  return { client, sent, receive, kills: () => kills,
    selected: { sha256: new Bun.CryptoHasher("sha256").update(selected).digest("hex"), bytes: Buffer.byteLength(selected) },
    async finish() {
      const closing = client.close({ requireAcknowledgement: true }); await ticks();
      const message = sent.find(row => row.type === "request" && row.operation === "dispose"); assert(message?.type === "request");
      receive({ type: "response", id: message.id, ok: true }); await closing;
    } };
}
const requests = (messages: ParentMessage[]) => messages.filter((message): message is Extract<ParentMessage, { type: "request" }> => message.type === "request");

test("whole actual WorkerClient validates CMUX receipt before ACK and gives orphan/mismatched replies no ACK", async () => {
  const h = await workerClientFixture(), value = binding("cmux");
  const invoke = (sequence: number) => observe(h.client.request({ operation: "requestBrowserEvaluation", args: { binding: value, sequence, method: "browser.eval", params: {} } }));
  const valid = invoke(1); await ticks(); const first = requests(h.sent).at(-1)!;
  h.receive({ type: "response", id: first.id, ok: true, value: { nested: { value: "received" } }, evaluation: { binding: value, sequence: 1 } });
  assert.equal((await valid).error, undefined);
  assert.deepEqual(h.sent.filter(row => row.type === "browserEvaluationAck"), [{ type: "browserEvaluationAck", binding: value, sequence: 1 }]);
  h.receive({ type: "response", id: first.id, ok: false, error: { name: "Error", message: "orphan" }, evaluation: { binding: value, sequence: 1 } });
  const invalid = invoke(2); await ticks(); const second = requests(h.sent).at(-1)!;
  h.receive({ type: "response", id: second.id, ok: true, value: {}, evaluation: { binding: { ...value, ownerId: "other-owner" }, sequence: 2 } });
  assert.equal(((await invalid).error as { code: string }).code, "OUTCOME_UNKNOWN");
  assert.equal(h.sent.filter(row => row.type === "browserEvaluationAck").length, 1);
  const rejected = invoke(3); await ticks(); const third = requests(h.sent).at(-1)!;
  h.receive({ type: "response", id: third.id, ok: false, error: { name: "Error", message: "native failure" }, evaluation: { binding: value, sequence: 3 } });
  assert(errors((await rejected).error).includes("native failure"));
  assert.equal(h.sent.filter(row => row.type === "browserEvaluationAck").length, 2);
  const wrongSequence = invoke(4); await ticks(); const fourth = requests(h.sent).at(-1)!;
  h.receive({ type: "response", id: fourth.id, ok: true, value: {}, evaluation: { binding: value, sequence: 99 } });
  assert.equal(((await wrongSequence).error as { code: string }).code, "OUTCOME_UNKNOWN");
  assert.equal(h.sent.filter(row => row.type === "browserEvaluationAck").length, 2);
  await h.finish(); assert.equal(h.kills(), 0); assert(h.selected.bytes > 1000);
});

test("whole actual WorkerClient keeps64 channel controls beyond128 ordinary requests, deduplicates disposal, and admits controls while closing", async () => {
  const h = await workerClientFixture();
  const ordinary = Array.from({ length: 128 }, () => observe(h.client.request({ operation: "getBrowserMetadata" })));
  await ticks(); assert.equal(requests(h.sent).length, 128);
  await assert.rejects(h.client.request({ operation: "getBrowserMetadata" }), /limit/);
  const controls = Array.from({ length: 63 }, (_, index) => observe(h.client.request({ operation: "disposeBrowserEvaluation", args: { binding: binding("cmux", `close-${index}`) } })));
  await ticks(); assert.equal(requests(h.sent).filter(row => row.operation === "disposeBrowserEvaluation").length, 63);
  const duplicate = observe(h.client.request({ operation: "disposeBrowserEvaluation", args: { binding: binding("cmux", "close-0") } }));
  const closing = h.client.close({ requireAcknowledgement: true }); await ticks();
  const last = observe(h.client.request({ operation: "disposeBrowserEvaluation", args: { binding: binding("cmux", "close-63") } }));
  await ticks();
  await assert.rejects(h.client.request({ operation: "disposeBrowserEvaluation", args: { binding: binding("cmux", "close-64") } }), /limit/);
  const disposalRequests = requests(h.sent).filter(row => row.operation === "disposeBrowserEvaluation"); assert.equal(disposalRequests.length, 64);
  for (const message of disposalRequests) h.receive({ type: "response", id: message.id, ok: true });
  assert((await Promise.all([...controls, duplicate, last])).every(row => row.error === undefined));
  const whole = requests(h.sent).find(row => row.operation === "dispose"); assert(whole);
  h.receive({ type: "response", id: whole.id, ok: true }); await closing;
  assert((await Promise.all(ordinary)).every(row => row.error instanceof Error));
  assert.equal(h.kills(), 0); assert.equal(h.sent.filter(row => row.type === "disposeAck").length, 1);
});

test("whole actual WorkerClient frame route bypasses generic events, fabricates no CDP ACK and reports definitive close loss", async () => {
  const h = await workerClientFixture(), value = binding("cdp"), frames: BrowserEvaluationFrame[] = [], failures: unknown[] = [];
  h.client.subscribeBrowserEvaluation(value, frame => frames.push(frame), error => failures.push(error));
  const frame: BrowserEvaluationFrame = { type: "worker-cdp", channel: "channel-717", kind: "data", sequence: 1, data: "opaque-native-frame" };
  h.receive({ type: "browserEvaluationFrame", binding: value, frame });
  assert.deepEqual(frames, [frame]); assert.equal(h.sent.length, 0);
  await h.finish(); assert.equal(failures.length, 1); assert.equal(h.kills(), 0);
});
