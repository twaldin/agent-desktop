/** UNWIRED port prerequisite: whole selected module, controlled ports and owned upstream only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (args.length !== 1) throw new Error("Usage: browser-worker-cdp-channel.ts <worker-cdp-channel.ts>");
const selectedPath = args[0]!;
const source = await readFile(selectedPath, "utf8");
// Only type imports are removed. No source expressions, methods, or constants are replaced.
const selected = source.replace(/^import\s+type\b[\s\S]*?;\r?\n/gm, "");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(selected.replace(/^export /gm, ""));
type Frame = { type: "worker-cdp"; channel: string; kind: string; sequence?: number; data?: string; errors?: string[] };
type Transport = { onmessage?: (raw: string) => void; onclose?: () => void; send(raw: string): void; close(): void; dispose(): Promise<void> };
type Parent = { start(): void; receive(frame: unknown): boolean; dispose(): Promise<void> };
type Worker = Transport & { receive(frame: unknown): boolean; abort(error: unknown): void };
const { ParentWorkerCdpChannel, WorkerCdpChannel } = new Function(`${compiled}\nreturn { ParentWorkerCdpChannel, WorkerCdpChannel };`)() as {
  ParentWorkerCdpChannel: new (channel: string, transport: Transport, post: (frame: Frame) => void) => Parent;
  WorkerCdpChannel: new (channel: string, post: (frame: Frame) => void) => Worker;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ticks = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function errorMessages(error: unknown): string[] {
  return error instanceof AggregateError ? error.errors.flatMap(errorMessages) : [error instanceof Error ? error.message : String(error)];
}
type Outcome = { ok: true } | { ok: false; errors: string[] };
function track(promise: Promise<void>) {
  let outcome: Outcome | undefined;
  void promise.then(() => { outcome = { ok: true }; }, error => { outcome = { ok: false, errors: errorMessages(error) }; });
  return { pending: () => outcome === undefined, result: () => outcome };
}
function failed(outcome: Outcome, pattern: RegExp, label: string) {
  assert.equal(outcome.ok, false, `${label}: disposal must fail`);
  if (!outcome.ok) assert.match(outcome.errors.join("; "), pattern, `${label}: retained failure`);
}
type Side = "parent" | "worker";
function harness(sync = false) {
  const channel = "fixture-original-channel";
  const queues: Record<Side, Frame[]> = { parent: [], worker: [] };
  const posts: Array<{ from: Side; frame: Frame }> = [];
  const throws: Partial<Record<Side, Error>> = {};
  const drain = Promise.withResolvers<void>();
  void drain.promise.catch(() => {});
  let held = false, disposal: Promise<void> | undefined;
  const calls = { upstreamSend: [] as string[], upstreamClose: 0, upstreamDispose: 0 };
  let sendError: Error | undefined;
  let onmessage: ((raw: string) => void) | undefined, onclose: (() => void) | undefined;
  let setMessage: ((handler: ((raw: string) => void) | undefined) => void) | undefined;
  let setClose: ((handler: (() => void) | undefined) => void) | undefined;
  // The owned upstream has a separate, retained disposal/drain lifecycle. close is deliberately distinct.
  const upstream: Transport = {
    get onmessage() { return onmessage; },
    set onmessage(handler) { onmessage = handler; setMessage?.(handler); },
    get onclose() { return onclose; },
    set onclose(handler) { onclose = handler; setClose?.(handler); },
    send(raw) { calls.upstreamSend.push(raw); if (sendError) throw sendError; },
    close() { calls.upstreamClose++; },
    dispose() {
      if (!disposal) {
        calls.upstreamDispose++;
        disposal = (async () => { if (held) await drain.promise; })();
      }
      return disposal;
    },
  };
  let parent: Parent, worker: Worker;
  function post(from: Side, frame: Frame) {
    const injected = throws[from];
    if (injected) { delete throws[from]; throw injected; }
    const copy = structuredClone(frame);
    posts.push({ from, frame: copy });
    if (sync) (from === "parent" ? worker : parent).receive(copy);
    else queues[from].push(copy);
  }
  parent = new ParentWorkerCdpChannel(channel, upstream, frame => post("parent", frame));
  worker = new WorkerCdpChannel(channel, frame => post("worker", frame));
  function deliver(from: Side, count = Infinity) {
    let delivered = 0;
    while (queues[from].length && delivered < count) {
      const frame = queues[from].shift()!;
      (from === "parent" ? worker : parent).receive(frame);
      delivered++;
      assert(delivered <= 4096, "controlled port cannot pump indefinitely");
    }
  }
  function flush() {
    for (let index = 0; index < 50; index++) {
      if (!queues.parent.length && !queues.worker.length) return;
      deliver("parent"); deliver("worker");
    }
    assert.fail("controlled port did not quiesce");
  }
  async function done(value: ReturnType<typeof track>, label: string): Promise<Outcome> {
    for (let index = 0; index < 30 && value.pending(); index++) { flush(); await ticks(); }
    assert.equal(value.pending(), false, `${label}: explicit gates and port delivery must settle disposal`);
    return value.result()!;
  }
  return {
    channel, parent, worker, upstream, calls, queues, posts, deliver, flush, done,
    start() { parent.start(); },
    holdDrain() { held = true; return drain; },
    sendThrows(message: string) { sendError = new Error(message); },
    postThrows(side: Side, message: string) { throws[side] = new Error(message); },
    onMessageSet(effect: typeof setMessage) { setMessage = effect; },
    onCloseSet(effect: typeof setClose) { setClose = effect; },
    emit(raw: string) { upstream.onmessage?.(raw); },
    data(side: Side) { return posts.filter(posted => posted.from === side && posted.frame.kind === "data").map(posted => posted.frame); },
    frame(kind: string, rest: Partial<Frame> = {}): Frame { return { type: "worker-cdp", channel, kind, ...rest }; },
    async finish() {
      // Always release every held gate, including when an assertion failed before release.
      drain.resolve(); setMessage = undefined; setClose = undefined;
      const cleanup = track(parent.dispose());
      try { await done(cleanup, "fixture parent cleanup"); }
      finally { worker.abort(new Error("Fixture final cleanup of definitively detached controlled port")); await ticks(); }
      assert.equal(calls.upstreamClose, 0, "owned upstream disposal must never substitute close for drain");
    },
  };
}
type Harness = ReturnType<typeof harness>;
const passed: string[] = [], failures: Array<{ name: string; error: string }> = [];
async function scenario(name: string, run: (h: Harness) => Promise<void>, sync = false) {
  const h = harness(sync);
  let failure: unknown;
  try { await run(h); } catch (error) { failure = error; }
  finally {
    try { await h.finish(); } catch (error) { failure = failure ? new AggregateError([failure, error], "Case and cleanup failed") : error; }
  }
  if (failure) {
    const error = errorMessages(failure).join("; "); failures.push({ name, error });
    console.log(JSON.stringify({ case: name, outcome: "FAIL", error }));
  } else { passed.push(name); console.log(JSON.stringify({ case: name, outcome: "PASS" })); }
}
const request = (id: number) => JSON.stringify({ id, sessionId: "nested-child", method: "Runtime.evaluate", params: { expression: "({ nested: [1, '雪'] })", returnByValue: true } });

await scenario("raw nested CDP request reply and event roundtrip", async h => {
  h.start(); const received: string[] = []; h.worker.onmessage = raw => received.push(raw);
  const raw = request(1), reply = '{ "id":1,"sessionId":"nested-child","result":{"value":{"nested":[1,"雪"]}} }';
  const event = JSON.stringify({ sessionId: "nested-child", method: "Runtime.consoleAPICalled", params: { args: [{ value: "nested" }] } });
  h.worker.send(raw); h.flush(); h.emit(reply); h.emit(event); h.flush();
  assert.deepEqual(h.calls.upstreamSend, [raw], "CDP request stays byte-for-byte intact");
  assert.deepEqual(received, [reply, event], "nested replies and events stay byte-for-byte intact");
  assert.equal((await h.done(track(h.worker.dispose()), "roundtrip child disposal")).ok, true);
});
await scenario("original channel mismatch and non-channel traffic are ignored", async h => {
  h.start(); const received: string[] = []; h.worker.onmessage = raw => received.push(raw);
  for (const endpoint of [h.parent, h.worker]) {
    for (const frame of [null, "worker-cdp", { type: "other", channel: h.channel }, h.frame("data", { channel: "replacement-channel", sequence: -1, data: "bad" }), h.frame("close", { channel: "replacement-channel" })]) {
      assert.equal(endpoint.receive(frame), false, "foreign frame cannot own this attempt");
    }
  }
  h.worker.send(request(1)); h.emit("still-live"); h.flush();
  assert.deepEqual(h.calls.upstreamSend, [request(1)], "foreign frame did not retire parent");
  assert.deepEqual(received, ["still-live"], "foreign frame did not retire child");
});
await scenario("pre-connect buffering delivers in order", async h => {
  h.start(); h.emit("first"); h.emit("second"); h.flush();
  const received: string[] = []; h.worker.onmessage = raw => received.push(raw);
  assert.deepEqual(received, ["first", "second"], "late consumer receives buffered order");
});
await scenario("pre-connect buffer reentrant close suppresses remaining delivery", async h => {
  h.start(); h.emit("first"); h.emit("second"); h.flush();
  const received: string[] = []; let closes = 0;
  h.worker.onclose = () => { closes++; void h.worker.dispose().catch(() => {}); };
  h.worker.onmessage = raw => { received.push(raw); h.worker.close(); };
  assert.deepEqual(received, ["first"], "close during replay clears queued messages");
  assert.equal((await h.done(track(h.worker.dispose()), "reentrant close")).ok, true);
  assert.equal(closes, 1, "reentrant dispose emits one close notification");
});
await scenario("child dispose waits actual held upstream drain and explicit receipt", async h => {
  const drain = h.holdDrain(); h.start();
  const first = track(h.worker.dispose()), second = track(h.worker.dispose());
  h.flush(); await ticks();
  assert.equal(h.calls.upstreamDispose, 1, "child close starts upstream disposal once");
  assert(first.pending() && second.pending(), "all child callers wait held upstream work");
  assert.equal(h.posts.some(posted => posted.frame.kind === "drained"), false, "no early drain receipt");
  drain.resolve(); await ticks();
  assert(first.pending() && second.pending(), "resolved upstream still requires delivered drain receipt");
  for (const value of [first, second, track(h.worker.dispose())]) assert.equal((await h.done(value, "joined drain")).ok, true);
});
await scenario("upstream disposal failure retained for repeated parent and child disposal", async h => {
  const drain = h.holdDrain(); h.start(); const child = track(h.worker.dispose()); h.flush();
  const parent = track(h.parent.dispose()); drain.reject(new Error("Held owned upstream drain failed"));
  for (const [label, value] of [["parent", parent], ["child", child]] as const) failed(await h.done(value, label), /Held owned upstream drain failed/, label);
  failed(await h.done(track(h.parent.dispose()), "repeated parent"), /Held owned upstream drain failed/, "repeated parent");
  failed(await h.done(track(h.worker.dispose()), "repeated child"), /Held owned upstream drain failed/, "repeated child");
  assert.equal(h.calls.upstreamDispose, 1, "retained failures do not repeat upstream disposal");
});
await scenario("parent close racing queued data suppresses dispatch and late upstream callback", async h => {
  const drain = h.holdDrain(); h.start(); const late = h.upstream.onmessage!;
  h.worker.send(request(1)); const parent = track(h.parent.dispose());
  h.deliver("worker"); late("late parent event");
  assert.deepEqual(h.calls.upstreamSend, [], "queued child data cannot dispatch after parent retirement");
  assert.equal(h.data("parent").length, 0, "captured late callback cannot post after parent retirement");
  drain.resolve(); assert.equal((await h.done(parent, "parent close race")).ok, true);
});
await scenario("synchronous upstream message setter replay is delivered and acknowledged", async h => {
  const received: string[] = []; h.worker.onmessage = raw => received.push(raw);
  h.onMessageSet(handler => { handler?.("inline setter replay"); }); h.start();
  assert.deepEqual(received, ["inline setter replay"], "start safely handles synchronous setter replay");
  for (let index = 0; index < 300; index++) h.emit(`inline-${index}`);
  assert.equal(received.length, 301, "synchronous ACK releases each reserved credit");
  assert.equal((await h.done(track(h.worker.dispose()), "inline disposal")).ok, true);
}, true);
await scenario("synchronous upstream close setter retires before message setter", async h => {
  let messageInstalls = 0, closes = 0;
  h.worker.onclose = () => { closes++; };
  h.onMessageSet(handler => { if (handler) messageInstalls++; }); h.onCloseSet(handler => { handler?.(); }); h.start();
  assert.equal((await h.done(track(h.parent.dispose()), "setter close")).ok, true);
  assert.equal(messageInstalls, 0, "closed startup never installs live message listener");
  assert.equal(closes, 1, "inline close notifies child once");
  assert.equal(h.calls.upstreamDispose, 1, "inline close joins one upstream disposal");
}, true);
await scenario("synchronous nested receive acknowledges each original sequence", async h => {
  h.start(); const received: string[] = [];
  h.worker.onmessage = raw => {
    received.push(raw);
    if (raw === "outer") h.emit("nested");
  };
  h.emit("outer");
  assert.deepEqual(received, ["outer", "nested"], "consumer may synchronously reenter receive");
  const acknowledgements = h.posts.filter(posted => posted.from === "worker" && posted.frame.kind === "ack").map(posted => posted.frame.sequence);
  assert.deepEqual(acknowledgements, [2, 1], "nested and outer receives acknowledge their own reserved sequence");
  for (let index = 0; index < 300; index++) h.emit(`after-nested-${index}`);
  assert.equal(received.length, 302, "nested ACK handling preserves live credit recovery");
  assert.equal((await h.done(track(h.parent.dispose()), "nested ACK parent disposal")).ok, true, "nested ACK cannot cause false parent failure");
  assert.equal((await h.done(track(h.worker.dispose()), "nested ACK child disposal")).ok, true);
}, true);
await scenario("upstream send throws and failure reaches child retained disposal", async h => {
  h.sendThrows("Owned send exploded"); h.start(); h.worker.send(request(1)); h.flush();
  failed(await h.done(track(h.parent.dispose()), "send throw parent"), /Owned send exploded/, "parent send failure");
  failed(await h.done(track(h.worker.dispose()), "send throw child"), /Owned send exploded/, "child receives upstream failure");
  assert.equal(h.calls.upstreamSend.length, 1, "throwing send dispatches once");
});
await scenario("worker port send throws and local failure propagates to parent", async h => {
  h.start(); h.postThrows("worker", "Worker post exploded");
  assert.throws(() => h.worker.send(request(1)), /Worker post exploded/, "worker send exposes post failure");
  h.flush();
  failed(await h.done(track(h.worker.dispose()), "worker post failure"), /Worker post exploded/, "worker retains failure");
  failed(await h.done(track(h.parent.dispose()), "parent sees worker failure"), /Worker post exploded/, "parent retains remote worker failure");
  assert.deepEqual(h.calls.upstreamSend, [], "failed post cannot dispatch upstream");
});
await scenario("parent port send throws and failure reaches worker", async h => {
  h.start(); h.postThrows("parent", "Parent post exploded"); h.emit("undeliverable"); h.flush();
  failed(await h.done(track(h.parent.dispose()), "parent post failure"), /Parent post exploded/, "parent retains post failure");
  failed(await h.done(track(h.worker.dispose()), "child sees parent post failure"), /Parent post exploded/, "child sees post failure");
});
await scenario("actual 256 credits recover after actual ACK in both directions", async h => {
  h.start(); const received: string[] = []; h.worker.onmessage = raw => received.push(raw);
  for (let index = 0; index < 256; index++) { h.worker.send(request(index)); h.emit(`event-${index}`); }
  assert.equal(h.data("worker").length, 256, "all actual child credits usable");
  assert.equal(h.data("parent").length, 256, "all actual parent credits usable");
  h.flush(); h.worker.send(request(256)); h.emit("event-after-ack"); h.flush();
  assert.equal(h.calls.upstreamSend.length, 257, "actual child ACK restores send capacity");
  assert.equal(received.length, 257, "actual parent ACK restores send capacity");
  assert.equal((await h.done(track(h.worker.dispose()), "credit recovery")).ok, true);
});
await scenario("257th unacknowledged worker frame exhausts actual credit bound", async h => {
  h.start(); for (let index = 0; index < 256; index++) h.worker.send(request(index));
  assert.throws(() => h.worker.send(request(256)), /capacity/i, "257th unacknowledged child frame is refused");
  assert.equal(h.data("worker").length, 256, "overflow frame is never posted");
  failed(await h.done(track(h.worker.dispose()), "credit exhaustion"), /capacity/i, "credit error retained");
});
await scenario("257th unacknowledged parent frame retires actual credit bound", async h => {
  h.start(); h.worker.onmessage = () => {};
  for (let index = 0; index < 257; index++) h.emit(`event-${index}`);
  assert.equal(h.data("parent").length, 256, "parent overflow event is never posted");
  failed(await h.done(track(h.parent.dispose()), "parent credit exhaustion"), /capacity/i, "parent credit error retained");
});
await scenario("actual aggregate UTF8 byte bound refuses excess before post", async h => {
  h.start(); const half = "雪".repeat(Math.floor(8 * 1024 * 1024 / 3));
  h.worker.send(half); h.worker.send(half);
  assert.throws(() => h.worker.send("雪雪"), /capacity/i, "byte capacity counts UTF8 rather than JS characters");
  assert.equal(h.data("worker").length, 2, "byte overflow is refused before port post");
  failed(await h.done(track(h.worker.dispose()), "byte exhaustion"), /capacity/i, "byte error retained");
});
await scenario("startup buffer enforces actual 256 messages despite released wire credits", async h => {
  h.start(); for (let index = 0; index < 257; index++) { h.emit(`buffer-${index}`); h.flush(); }
  let received = 0; h.worker.onmessage = () => { received++; };
  assert.equal(received, 0, "overflow retirement clears startup buffer");
  failed(await h.done(track(h.worker.dispose()), "startup message bound"), /buffer/i, "startup message error retained");
});
await scenario("startup buffer enforces aggregate byte bound independently of wire credits", async h => {
  h.start(); const half = "x".repeat(8 * 1024 * 1024);
  h.emit(half); h.flush(); h.emit(half); h.flush(); h.emit("x"); h.flush();
  failed(await h.done(track(h.worker.dispose()), "startup byte bound"), /buffer/i, "startup bytes remain bounded after ACK");
});
for (const side of ["parent", "worker"] as const) {
  for (const [label, kind, fields, pattern] of [
    ["out-of-order sequence", "data", { sequence: 2, data: "bad" }, /message/i],
    ["fractional sequence", "data", { sequence: 1.5, data: "bad" }, /message/i],
    ["unknown ACK", "ack", { sequence: 1 }, /acknowledg/i],
    ["malformed ACK", "ack", { sequence: "1" }, /acknowledg/i],
  ] as const) {
    await scenario(`${side} rejects own-channel ${label}`, async h => {
      h.start(); const endpoint = side === "parent" ? h.parent : h.worker;
      assert.equal(endpoint.receive({ type: "worker-cdp", channel: h.channel, kind, ...fields }), true, "own-channel violation consumed");
      failed(await h.done(track(endpoint.dispose()), `${side} malformed frame`), pattern, "malformed frame failure retained");
      assert.deepEqual(h.calls.upstreamSend, [], "malformed frame cannot dispatch raw CDP");
    });
  }
}
await scenario("duplicate sequence cannot dispatch the same CDP request twice", async h => {
  h.start(); const frame = h.frame("data", { sequence: 1, data: request(1) });
  h.parent.receive(frame); h.parent.receive(frame);
  assert.deepEqual(h.calls.upstreamSend, [request(1)], "duplicate frame never dispatches twice");
  failed(await h.done(track(h.parent.dispose()), "duplicate sequence"), /message/i, "duplicate sequence retained");
});
await scenario("sparse malformed drain receipt fails without claiming successful drain", async h => {
  const drain = h.holdDrain(); h.start(); const disposal = track(h.worker.dispose());
  h.flush(); await ticks(); assert(disposal.pending(), "upstream drain is held before malformed receipt");
  h.worker.receive(h.frame("drained", { errors: new Array<string>(1) }));
  await ticks(); assert(disposal.pending(), "malformed control is not evidence of a lost port or completed native drain");
  drain.resolve(); await h.done(track(h.parent.dispose()), "sparse receipt parent cleanup");
  failed(await h.done(disposal, "sparse drain receipt"), /drain receipt/i, "sparse errors retained after actual drain");
  failed(await h.done(track(h.worker.dispose()), "repeated malformed receipt disposal"), /drain receipt/i, "malformed receipt failure retained");
});
await scenario("worker definitive port abort settles without inventing upstream drain", async h => {
  const drain = h.holdDrain(); h.start(); const disposal = track(h.worker.dispose());
  h.flush(); await ticks(); assert(disposal.pending(), "ordinary close waits upstream drain");
  h.worker.abort(new Error("Controlled worker port definitively lost"));
  failed(await h.done(disposal, "definitive abort"), /definitively lost/, "abort records actual port loss");
  failed(await h.done(track(h.worker.dispose()), "repeated abort disposal"), /definitively lost/, "abort retained for repeat callers");
  assert.equal(h.posts.some(posted => posted.frame.kind === "drained"), false, "abort does not manufacture drain receipt");
  drain.resolve(); await h.done(track(h.parent.dispose()), "aborted port parent cleanup");
});
await scenario("late worker callback delivery stays suppressed after close", async h => {
  h.start(); let received = 0, closes = 0;
  h.worker.onmessage = () => { received++; }; h.worker.onclose = () => { closes++; };
  h.worker.close(); h.worker.receive(h.frame("data", { sequence: 1, data: "late queued callback" }));
  await h.done(track(h.worker.dispose()), "late callback");
  h.worker.onclose = () => { closes++; }; h.worker.receive(h.frame("close"));
  assert.equal(received, 0, "retired child suppresses late queued data");
  assert.equal(closes, 1, "late close listener cannot replay completed notification");
});
await scenario("remote worker consumer failure propagates to parent cleanup", async h => {
  h.start(); h.worker.onmessage = () => { throw new Error("Worker CDP consumer exploded"); };
  h.emit("trigger consumer"); h.flush();
  failed(await h.done(track(h.worker.dispose()), "consumer failure child"), /Worker CDP consumer exploded/, "worker retains callback failure");
  failed(await h.done(track(h.parent.dispose()), "consumer failure parent"), /Worker CDP consumer exploded/, "parent retains remote callback failure");
});


await scenario("reentrant close callback failure survives explicit port abort", async h => {
  h.start(); h.worker.onclose = () => h.worker.abort(new Error("Reentrant close cleanup error"));
  h.worker.abort(new Error("Original port loss"));
  const outcome = await h.done(track(h.worker.dispose()), "reentrant abort");
  failed(outcome, /Original port loss/, "original abort retained");
  failed(outcome, /Reentrant close cleanup error/, "callback error also retained");
});
await scenario("drain notification cannot lose a reentrant malformed-control error", async h => {
  h.start(); h.worker.onclose = () => h.worker.receive({ type: "worker-cdp", channel: h.channel, kind: "drained", errors: null });
  // Defensive receive seam, not a claim that an ordered real parent omits its close notification.
  h.worker.receive(h.frame("drained", { errors: [] }));
  failed(await h.done(track(h.worker.dispose()), "reentrant drain notification"), /drain receipt/i, "retirement callback failure retained");
});

for (const trigger of ["local close", "incoming close"] as const) {
  for (const throwsAfterDrain of [false, true]) {
    await scenario(`${trigger}: reentrant valid drain ${throwsAfterDrain ? "retains callback failure" : "settles cleanly"}`, async h => {
      h.start(); let closes = 0;
      h.worker.onclose = () => {
        closes++;
        // The public reentrant receive seam, not an ordered-parent event schedule claim.
        h.worker.receive(h.frame("drained", { errors: [] }));
        if (throwsAfterDrain) throw new Error("Close callback failed after nested drain");
      };
      if (trigger === "local close") h.worker.close();
      else h.worker.receive(h.frame("close"));
      const outcome = await h.done(track(h.worker.dispose()), "close-first nested drain");
      if (throwsAfterDrain) failed(outcome, /Close callback failed after nested drain/, "close-first callback failure remains operational");
      else assert.equal(outcome.ok, true, "valid nested drain without callback failure stays successful");
      const repeated = await h.done(track(h.worker.dispose()), "repeated close-first nested drain");
      if (throwsAfterDrain) failed(repeated, /Close callback failed after nested drain/, "repeat caller retains callback failure");
      else assert.equal(repeated.ok, true);
      assert.equal(closes, 1, "callback invoked once");
    });
  }
}

console.log(JSON.stringify({ selectedPath, sourceSha256: hash(source), sourceBytes: Buffer.byteLength(source), completeModuleWithoutTypeImportsSha256: hash(selected), counts: { pass: passed.length, fail: failures.length }, passed, failures,
  scope: "UNWIRED port prerequisite only. Actual ParentWorkerCdpChannel and WorkerCdpChannel from the entire selected source, transpiled after stripping type imports; two-sided manual and synchronous fake port; fake owned ConnectionTransport with retained explicit disposal gate and injected errors. No source expressions or bounds changed. No SDK imports, real clocks, timers, worker, socket, browser, native process or consumer wiring. Does not prove actual worker/dispatcher integration or shared-browser ownership outside the selected channel. Every held upstream gate is settled in finally." }, null, 2));
if (failures.length) process.exitCode = 1;
