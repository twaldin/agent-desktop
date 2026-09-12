import { afterEach, expect, test } from "bun:test";
import { parseBranchQueryMessage, parseBranchQueryRequest, type BranchQueryMessage, type BranchQueryRequest } from "@agent-desktop/shared";
import { BranchQueryPeer } from "./branch-query-peer";
import type { BranchQueryLease } from "./workspace-http";
import type { BranchQueryUpdate } from "./workspace/branch-live-queries";
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = () => new Promise<void>(done => setImmediate(done));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const query = { type: "git.recent-branches", limit: 10 } as const;
function request(action: BranchQueryRequest["action"] = "retain", subscriptionId = "one"): BranchQueryRequest {
  return { type: "branch-query", version: 1, hostId: "host", subscriptionId, target: { projectId: "project" }, query, action };
}
function update(generation = 1): BranchQueryUpdate {
  return { subscriptionId: "private-host-id", generation, requiresRecovery: false, phase: "complete", result: { type: query.type, branches: ["main"] } };
}
function fixture(options: { held?: boolean; failure?: boolean; early?: boolean } = {}) {
  let current = true, failSend = false, disposals = 0, recoveries = 0;
  const gate = deferred<BranchQueryLease>(), release = deferred<void>(), recovery = deferred<void>(), ended = deferred<void>(), hostAbort = new AbortController();
  let holdRelease = false, holdRecovery = false;
  const calls: { signal: AbortSignal; emit(update: BranchQueryUpdate): void }[] = [], messages: BranchQueryMessage[] = [], closes: string[] = [];
  const lease: BranchQueryLease = { subscriptionId: "private-host-id", signal: hostAbort.signal, closed: ended.promise,
    async recover() { recoveries++; if (holdRecovery) await recovery.promise; },
    async dispose() { disposals++; hostAbort.abort(); if (holdRelease) await release.promise; ended.resolve(); } };
  const peer = new BranchQueryPeer({ hostId: "host", isCurrent: () => current,
    async subscribe(_target, _query, signal, emit) {
      calls.push({ signal, emit });
      if (options.early) emit(update());
      if (options.failure) throw new Error("admission\nfailed");
      return options.held ? gate.promise : lease;
    },
    send(value) { if (failSend) throw new Error("delivery failed"); messages.push(parseBranchQueryMessage(value)); }, close: reason => closes.push(reason) });
  cleanups.push(async () => { gate.resolve(lease); release.resolve(); recovery.resolve(); await peer.dispose(); });
  return { peer, lease, gate, release, recovery, calls, messages, closes, send: (value = request()) => peer.receive(JSON.stringify(value)),
    end() { hostAbort.abort(); ended.resolve(); },
    set current(value: boolean) { current = value; }, set failSend(value: boolean) { failSend = value; },
    set holdRelease(value: boolean) { holdRelease = value; }, set holdRecovery(value: boolean) { holdRecovery = value; },
    get disposals() { return disposals; }, get recoveries() { return recoveries; } };
}

test("strict parser snapshots owner/query, rejects injected paths/fields and validates typed result bounds", () => {
  const value = { ...request(), target: { projectId: "project" }, query: { ...query, limit: 10 } }, parsed = parseBranchQueryRequest(value);
  value.target.projectId = "caller-edited"; value.query.limit = 4;
  expect(parsed.target).toEqual({ projectId: "project" }); expect(parsed.query).toEqual(query);
  if (!("projectId" in parsed.target) || parsed.query.type !== "git.recent-branches") throw new Error("Fixture parser changed method/owner.");
  parsed.target.projectId = "consumer-edited"; parsed.query.limit = 6;
  expect(value.target.projectId).toBe("caller-edited"); expect(value.query.limit).toBe(4);
  for (const bad of [null, [], { ...request(), hostId: "" }, { ...request(), version: 2 }, { ...request(), action: ["retain"] },
    { ...request(), query: { type: "git.status" } }, { ...request(), query: { ...query, limit: 101 } }, { ...request(), query: { ...query, path: "/foreign" } },
    { ...request(), target: { filePath: "/foreign" } }, { ...request(), target: { projectId: "p", sessionId: "s" } }, { ...request(), local: true }])
    expect(() => parseBranchQueryRequest(bad)).toThrow();
  const { action: _, ...identity } = request(), { subscriptionId: __, ...result } = update();
  const message = { ...identity, event: "result" as const, update: result };
  expect(parseBranchQueryMessage(message)).toEqual(message);
  for (const bad of [{ ...result, generation: 0 }, { ...result, requiresRecovery: 1 }, { ...result, result: { type: "git.base-branch", base: null } },
    { ...result, result: { type: query.type, branches: Array(11).fill("x") } }, { ...result, result: { type: query.type, branches: ["x\0y"] } }])
    expect(() => parseBranchQueryMessage({ ...message, update: bad })).toThrow();
  for (const [kind, result] of [["git.default-branch", { type: "git.default-branch", branch: null }], ["git.base-branch", { type: "git.base-branch", base: { local: "main", remote: "origin/team" } }]] as const)
    expect(parseBranchQueryMessage({ ...message, query: { type: kind }, update: { ...message.update, result } })).toMatchObject({ update: { result } });
});

test("duplicates share admission; early result waits for ready and maps private identity to wire identity", async () => {
  const f = fixture({ held: true, early: true }); f.send(); f.send(); f.send(request("inspect")); await flush();
  expect(f.calls).toHaveLength(1); expect(f.messages.map(m => m.event)).toEqual(["status", "status", "status"]);
  f.gate.resolve(f.lease); await flush();
  expect(f.messages.slice(-2)).toMatchObject([{ event: "status", phase: "ready" }, { event: "result", subscriptionId: "one", update: { generation: 1 } }]);
  f.calls[0]!.emit(update(3)); f.calls[0]!.emit(update(2)); f.calls[0]!.emit(update(3));
  expect(f.messages.filter(m => m.event === "result").map(m => m.event === "result" && m.update.generation)).toEqual([1, 3]);
  f.send(request("inspect")); expect(f.calls).toHaveLength(1); expect(f.messages.at(-1)).toMatchObject({ event: "result", update: { generation: 3 } });
  expect(JSON.stringify(f.messages)).not.toContain("private-host-id");
});

test("release before late acquisition suppresses buffered/late results and waits for cleanup", async () => {
  const f = fixture({ held: true, early: true }); f.send(); await flush(); f.send(request("release"));
  expect(f.calls[0]!.signal.aborted).toBe(true); let done = false;
  const disposal = f.peer.dispose().then(() => { done = true; }); await flush(); expect(done).toBe(false);
  f.gate.resolve(f.lease); await disposal; f.calls[0]!.emit(update(10));
  expect(f.disposals).toBe(1); expect(f.messages.some(m => m.event === "result" || m.event === "status" && m.phase === "ready")).toBe(false);
});

test("unknown inspect/recovery cannot acquire; release tombstone cannot revive and binding is immutable", async () => {
  const f = fixture(); f.send(request("inspect")); f.send(request("recover")); expect(f.calls).toEqual([]);
  f.send(request("release")); await flush(); f.send(); await flush(); expect(f.calls).toEqual([]);
  expect(f.messages.at(-1)).toMatchObject({ phase: "released" });
  f.send(request("retain", "fresh")); await flush(); expect(f.calls).toHaveLength(1);
  f.send({ ...request("inspect", "fresh"), query: { type: "git.default-branch" } }); await f.peer.dispose();
  expect(f.closes).toHaveLength(1); expect(f.disposals).toBe(1);
});

test("observed permission loss and failed delivery synchronously cancel without revival", async () => {
  for (const mode of ["permission", "delivery"] as const) {
    const f = fixture({ held: true }); f.send(); await flush();
    if (mode === "permission") f.current = false; else f.failSend = true;
    f.send(request("inspect")); expect(f.calls[0]!.signal.aborted).toBe(true);
    f.current = true; f.failSend = false; f.gate.resolve(f.lease); await f.peer.dispose();
    expect(f.closes).toHaveLength(1); expect(f.disposals).toBe(1);
    expect(f.messages.some(m => m.event === "status" && m.phase === "ready")).toBe(false);
  }
});

test("catalog retirement before or after readiness reports unavailable, never a stale result", async () => {
  for (const held of [false, true]) {
    const f = fixture({ held, early: true }); f.send(); await flush(); f.end();
    if (held) f.gate.resolve(f.lease);
    await flush(); f.calls[0]!.emit(update(5));
    expect(f.messages.at(-1)).toMatchObject({ event: "status", phase: "unavailable" });
    if (held) expect(f.messages.some(m => m.event === "result" || m.event === "status" && m.phase === "ready")).toBe(false);
    f.send(); await flush(); expect(f.calls).toHaveLength(1);
  }
});

test("recovery is exact and coalesced, release waits for in-flight recovery and resource disposal", async () => {
  const f = fixture(); f.holdRecovery = true; f.holdRelease = true; f.send(); await flush();
  f.send(request("recover")); f.send(request("recover")); await flush(); expect(f.recoveries).toBe(1);
  f.send(request("release")); let done = false; const disposal = f.peer.dispose().then(() => { done = true; }); await flush();
  expect(done).toBe(false); f.release.resolve(); await flush(); expect(done).toBe(false);
  f.recovery.resolve(); await disposal; expect(f.disposals).toBe(1);
});

test("query failure is a result, acquisition failure is terminal, fresh ID is deliberate retry", async () => {
  const f = fixture(); f.send(); await flush(); f.calls[0]!.emit({ subscriptionId: "private-host-id", generation: 1, requiresRecovery: true, phase: "failed", error: "Git\nfailed" });
  expect(f.messages.at(-1)).toMatchObject({ event: "result", update: { phase: "failed", error: "Git\nfailed", requiresRecovery: true } });
  f.calls[0]!.emit(update(2)); expect(f.messages.at(-1)).toMatchObject({ event: "result", update: { phase: "complete" } });
  const g = fixture({ failure: true }); g.send(); await flush(); g.send(); g.send(request("inspect")); g.send(request("recover"));
  expect(g.calls).toHaveLength(1); expect(g.messages.at(-1)).toMatchObject({ event: "status", phase: "failed", error: "admission\nfailed" });
  g.send(request("retain", "fresh")); await flush(); expect(g.calls).toHaveLength(2);
});

test("malformed binding/frame or owned result closes only its peer and cancels work", async () => {
  for (const bad of ["{", " ".repeat(1025), JSON.stringify({ ...request(), hostId: "foreign" }), JSON.stringify({ ...request(), target: { sessionId: "other" } })]) {
    const f = fixture(); f.send(); await flush(); f.peer.receive(bad); await f.peer.dispose();
    expect(f.closes).toHaveLength(1); expect(f.disposals).toBe(1);
  }
  const f = fixture(); f.send(); await flush(); f.calls[0]!.emit({ ...update(), result: { type: "git.default-branch", branch: "wrong" } } as BranchQueryUpdate);
  await f.peer.dispose(); expect(f.closes).toHaveLength(1); expect(f.disposals).toBe(1);
  const other = fixture(); other.send(); await flush(); other.calls[0]!.emit(update()); expect(other.messages.at(-1)).toMatchObject({ event: "result" });
});

test("connection admission and tombstone history are bounded and disposed before queued dispatch", async () => {
  const f = fixture(); for (let i = 0; i < 129; i++) f.send(request("retain", `id-${i}`)); await flush();
  expect(f.calls).toHaveLength(128); expect(f.messages.find(m => m.subscriptionId === "id-128")).toMatchObject({ phase: "failed" });
  for (let i = 129; i < 2048; i++) f.send(request("release", `id-${i}`));
  f.send(request("retain", "overflow")); await f.peer.dispose(); expect(f.closes).toHaveLength(1); expect(f.disposals).toBe(128);
  const g = fixture(); g.send(); const disposal = g.peer.dispose(); await Promise.all([disposal, g.peer.dispose()]); expect(g.calls).toEqual([]); expect(g.disposals).toBe(0);
});

test("failed acquired cleanup is reported and cannot claim a clean peer drain", async () => {
  const closed = deferred<void>(), abort = new AbortController(), messages: BranchQueryMessage[] = [];
  const peer = new BranchQueryPeer({ hostId: "host", isCurrent: () => true,
    subscribe: async () => ({ subscriptionId: "internal", signal: abort.signal, closed: closed.promise, recover: async () => {},
      async dispose() { abort.abort(); closed.resolve(); throw new Error("cleanup failed"); } }),
    send: message => messages.push(message), close: () => {} });
  peer.receive(JSON.stringify(request())); await flush(); peer.receive(JSON.stringify(request("release"))); await flush();
  expect(messages.at(-1)).toMatchObject({ phase: "released", error: "cleanup failed" });
  await expect(peer.dispose()).rejects.toThrow("peer cleanup failed");
});

for (const disposeRejects of [true, false]) test(`release drains rejected recovery independently of dispose rejection=${disposeRejects}`, async () => {
  const gate = deferred<void>(), closed = deferred<void>(), abort = new AbortController();
  let recoveries = 0, disposals = 0, completed = false;
  const messages: BranchQueryMessage[] = [];
  const peer = new BranchQueryPeer({ hostId: "host", isCurrent: () => true,
    subscribe: async () => ({ subscriptionId: "internal", signal: abort.signal, closed: closed.promise,
      async recover() { recoveries++; await gate.promise; },
      async dispose() { disposals++; abort.abort(); closed.resolve(); if (disposeRejects) throw new Error("dispose failed"); } }),
    send: value => messages.push(value), close: () => {} });
  peer.receive(JSON.stringify(request())); await flush(); peer.receive(JSON.stringify(request("recover"))); await flush();
  expect(recoveries).toBe(1);
  peer.receive(JSON.stringify(request("release")));
  const finished = peer.dispose().then(() => ({ errors: [] as unknown[] }), error => ({ errors: error.errors as unknown[] })).then(value => { completed = true; return value; });
  await flush(); const premature = completed;
  gate.reject(new Error("recovery failed after release"));
  const outcome = await finished;
  expect(premature).toBe(false);
  expect(disposals).toBe(1);
  expect(outcome.errors.map(String)).toContain("Error: recovery failed after release");
  if (disposeRejects) expect(outcome.errors.map(String)).toContain("Error: dispose failed");
  expect(messages.filter(value => value.event === "status" && value.phase === "released")).toEqual([]);
});
