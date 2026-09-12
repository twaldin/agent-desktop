import { afterEach, expect, test } from "bun:test";
import type { BranchQueryMessage, BranchQueryRequest, BranchQueryResultUpdate, BranchQueryView } from "@agent-desktop/shared";
import { BranchQueryConnection } from "./branch-query-connection";
import { BranchQueryPeer } from "../../../host/src/branch-query-peer";
import type { BranchQueryUpdate } from "../../../host/src/workspace/branch-live-queries";

const target = { projectId: "project" }, query = { type: "git.recent-branches", limit: 10 } as const;
const flush = () => new Promise<void>(done => setImmediate(done));
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function snapshot(version: number | undefined = 1, replayComplete: boolean | undefined = true, hostId = "host") {
  return { type: "state", ...(replayComplete === undefined ? {} : { replayComplete }),
    state: { host: { id: hostId }, ...(version === undefined ? {} : { branchQueries: { version } }) } };
}
function status(request: BranchQueryRequest, phase: Extract<BranchQueryMessage, { event: "status" }>["phase"] = "ready", error?: string): BranchQueryMessage {
  const { action: _, ...identity } = request;
  return { ...identity, event: "status", phase, ...(error ? { error } : {}) };
}
function result(request: BranchQueryRequest, generation = 1, update?: BranchQueryResultUpdate): BranchQueryMessage {
  const { action: _, ...identity } = request;
  return { ...identity, event: "result", update: update ?? { generation, requiresRecovery: false,
    phase: "complete", result: { type: query.type, branches: ["main"] } } };
}
function fixture() {
  let id = 0;
  const client = new BranchQueryConnection("host", () => `wire-${++id}`), views: BranchQueryView[] = [];
  cleanups.push(() => client.dispose());
  const observer = client.retain(target, query, view => views.push(view));
  const connect = (failSend = false) => {
    const sent: BranchQueryRequest[] = [], closed: string[] = [];
    const handle = client.attach({ send(request) { if (failSend) throw new Error("send failed"); sent.push(request); }, close: reason => closed.push(reason) });
    return { ...handle, sent, closed };
  };
  return { client, observer, views, connect };
}

test("first admission waits for replay completion and the independent branch capability", () => {
  const f = fixture(), socket = f.connect();
  socket.receive(snapshot(1, false)); f.observer.inspect(); f.observer.recover();
  expect(socket.sent).toEqual([]); expect(f.views.at(-1)).toEqual({ phase: "connecting" });
  // This host need not expose the separate public repository-watch observer API.
  socket.receive(snapshot()); expect(socket.sent).toHaveLength(1); expect(f.views.at(-1)?.phase).toBe("pending");
  f.observer.recover(); expect(socket.sent).toHaveLength(1);
  socket.receive(status(socket.sent[0]!, "ready", "partial coverage"));
  expect(f.views.at(-1)).toEqual({ phase: "ready", error: "partial coverage" });
  f.observer.inspect(); f.observer.recover(); socket.receive(snapshot()); socket.receive(snapshot(1, false));
  expect(socket.sent.map(value => value.action)).toEqual(["retain", "inspect", "recover"]);
});

for (const replayComplete of [false, undefined]) for (const version of [2, undefined]) {
  test(`ordinary state capability contradiction retires admission (${version}, ${replayComplete})`, () => {
    const f = fixture(), old = f.connect(); old.receive(snapshot()); const request = old.sent[0]!;
    old.receive(status(request)); old.receive(result(request));
    // Construct absent fields directly: snapshot's optional arguments have defaults.
    old.receive({ type: "state", ...(replayComplete === undefined ? {} : { replayComplete }),
      state: { host: { id: "host" }, ...(version === undefined ? {} : { branchQueries: { version } }) } });
    expect(old.closed).toHaveLength(1); expect(f.views.at(-1)?.phase).toBe("disconnected");
    f.observer.inspect(); f.observer.recover(); old.receive(status(request)); expect(old.sent).toHaveLength(1);
    const next = f.connect(); next.receive(snapshot(1, false)); expect(next.sent).toEqual([]);
    next.receive(snapshot()); expect(next.sent[0]!.subscriptionId).not.toBe(request.subscriptionId);
    next.receive(status(next.sent[0]!)); next.receive(result(next.sent[0]!));
    expect(f.views.at(-1)).toMatchObject({ phase: "ready", update: { generation: 1 } });
  });
}

test("unsupported hosts remain request-free until a fresh supported connection", () => {
  const f = fixture(), old = f.connect(); old.receive(snapshot(2));
  expect(f.views.at(-1)?.phase).toBe("unsupported"); f.observer.inspect(); f.observer.recover(); expect(old.sent).toEqual([]);
  old.receive(snapshot(2, false)); expect(old.closed).toEqual([]);
  old.receive(snapshot(1, false)); expect(old.closed).toHaveLength(1);
  const next = f.connect(); next.receive(snapshot()); expect(next.sent).toHaveLength(1);
});

test("query generations are monotonic within readiness and reset after reconnect", () => {
  const f = fixture(), old = f.connect(); old.receive(snapshot()); const request = old.sent[0]!;
  old.receive(status(request)); old.receive(result(request, 3)); const count = f.views.length;
  old.receive(result(request, 2)); old.receive(result(request, 3)); expect(f.views).toHaveLength(count);
  old.receive(status(request, "pending")); expect(f.views).toHaveLength(count);
  old.receive(status(request, "ready", "watch error")); expect(f.views.at(-1)).toMatchObject({ phase: "ready", error: "watch error", update: { generation: 3 } });
  old.disconnected(); expect(f.views.at(-1)?.phase).toBe("disconnected");
  const next = f.connect(); next.receive(snapshot()); const nextCount = f.views.length;
  old.receive(result(request, 100)); old.disconnected(); expect(f.views).toHaveLength(nextCount);
  next.receive(status(next.sent[0]!)); next.receive(result(next.sent[0]!, 1));
  expect(f.views.at(-1)).toMatchObject({ phase: "ready", update: { generation: 1 } });
});

test("query failure remains recoverable; lifetime failure cannot revive", () => {
  const f = fixture(), socket = f.connect(); socket.receive(snapshot()); const request = socket.sent[0]!;
  socket.receive(status(request)); socket.receive(result(request, 1, { generation: 1, requiresRecovery: true, phase: "failed", error: "Git unavailable" }));
  expect(f.views.at(-1)).toMatchObject({ phase: "ready", update: { phase: "failed", requiresRecovery: true } });
  f.observer.recover(); expect(socket.sent.at(-1)?.action).toBe("recover");
  socket.receive(result(request, 2)); expect(f.views.at(-1)).toMatchObject({ phase: "ready", update: { phase: "complete" } });
  socket.receive(status(request, "unavailable")); const count = f.views.length;
  socket.receive(status(request)); socket.receive(result(request, 3)); f.observer.recover();
  expect(f.views).toHaveLength(count); expect(f.views.at(-1)?.phase).toBe("failed");
  expect(socket.sent.map(value => value.action)).toEqual(["retain", "recover"]);
});

test("wrong identity, query, malformed payload and result before ready close the connection", () => {
  const invalid: ((request: BranchQueryRequest) => unknown)[] = [
    r => ({ ...status(r), hostId: "other" }), r => ({ ...status(r), target: { sessionId: "other" } }),
    r => ({ ...status(r), query: { ...query, limit: 9 } }), r => ({ ...status(r), phase: "invented" }),
    r => result(r), () => snapshot(1, true, "other"),
  ];
  for (const create of invalid) {
    const f = fixture(), socket = f.connect(); socket.receive(snapshot()); socket.receive(create(socket.sent[0]!));
    expect(socket.closed).toHaveLength(1); expect(f.views.at(-1)?.phase).toBe("disconnected");
  }
});

test("caller and delivered nested values cannot change the retained request or saved update", () => {
  const f = fixture(), owner = { sessionId: "session" }, selected = { ...query, limit: 4 };
  const delivered: BranchQueryView[] = [];
  const observer = f.client.retain(owner, selected, view => {
    delivered.push(structuredClone(view));
    if (view.phase === "ready" && view.update?.phase === "complete" && view.update.result.type === query.type) view.update.result.branches.push("listener edit");
  });
  owner.sessionId = "caller edit"; selected.limit = 1;
  const socket = f.connect(); socket.receive(snapshot()); const request = socket.sent[1]!;
  expect(request.target).toEqual({ sessionId: "session" }); expect(request.query).toEqual({ ...query, limit: 4 });
  socket.receive(status(request)); const message = result(request); socket.receive(message);
  if (message.event !== "result" || message.update.phase !== "complete" || message.update.result.type !== query.type) throw new Error("Unexpected fixture result.");
  message.update.result.branches.push("transport edit");
  socket.receive(status(request)); expect(delivered.at(-1)).toMatchObject({ update: { result: { branches: ["main"] } } });
  Object.assign(request.target, { sessionId: "sent edit" }); Object.assign(request.query, { limit: 2 });
  observer.inspect(); expect(socket.sent.at(-1)).toMatchObject({ target: { sessionId: "session" }, query: { ...query, limit: 4 } });
});

test("release and controller disposal are idempotent and do not close the shared socket", () => {
  const f = fixture(), socket = f.connect();
  const early = f.client.retain({ sessionId: "early" }, query, () => {}); early.dispose();
  socket.receive(snapshot()); expect(socket.sent).toHaveLength(1);
  f.observer.dispose(); f.observer.dispose(); const count = f.views.length;
  socket.receive(status(socket.sent[0]!)); socket.receive(result(socket.sent[0]!)); f.observer.inspect();
  expect(f.views).toHaveLength(count); expect(socket.sent.map(r => r.action)).toEqual(["retain", "release"]);
  const other = f.client.retain({ sessionId: "other" }, query, () => {}); other.inspect();
  f.client.dispose(); f.client.dispose();
  expect(socket.sent.map(r => r.action)).toEqual(["retain", "release", "retain", "inspect", "release"]);
  expect(socket.closed).toEqual([]); expect(() => f.client.retain(target, query, () => {})).toThrow("disposed");
});

test("pending listener release prevents acquisition and leaves a tombstone only", () => {
  const f = fixture(); let release = () => {};
  const observer = f.client.retain({ sessionId: "early" }, query, view => { if (view.phase === "pending") release(); });
  release = observer.dispose;
  const socket = f.connect(); socket.receive(snapshot());
  expect(socket.sent.map(r => [r.target, r.action])).toEqual([[target, "retain"], [{ sessionId: "early" }, "release"]]);
});

test("reentrant reconnect during disconnect delivery cannot erase replacement observers", () => {
  const client = new BranchQueryConnection("host"); cleanups.push(() => client.dispose());
  let reconnect = false; const sent: BranchQueryRequest[] = [], views: BranchQueryView[] = [];
  client.retain(target, query, view => { if (view.phase === "disconnected" && !reconnect) {
    reconnect = true; client.attach({ send: r => sent.push(r), close() {} }).receive(snapshot());
  } });
  const second = client.retain({ sessionId: "second" }, query, view => views.push(view));
  const old = client.attach({ send() {}, close() {} }); old.receive(snapshot()); old.disconnected();
  expect(views.at(-1)?.phase).toBe("pending"); second.inspect();
  expect(sent.map(r => r.action)).toEqual(["retain", "retain", "inspect"]);
});

test("send failure and reused wire ID fail closed without extra acquisition", () => {
  const f = fixture(), socket = f.connect(true); socket.receive(snapshot());
  expect(socket.closed).toHaveLength(1); expect(f.views.at(-1)?.phase).toBe("disconnected");
  const client = new BranchQueryConnection("host", () => "same"); cleanups.push(() => client.dispose());
  client.retain(target, query, () => {}); client.retain({ sessionId: "second" }, query, () => {});
  const sent: BranchQueryRequest[] = [], closed: string[] = [];
  client.attach({ send: r => sent.push(r), close: reason => closed.push(reason) }).receive(snapshot());
  expect(sent).toHaveLength(1); expect(closed).toHaveLength(1);
});

test("pending listener connection replacement cannot send retain on the retired attachment", () => {
  const client = new BranchQueryConnection("host"); cleanups.push(() => client.dispose());
  const oldSent: BranchQueryRequest[] = [], nextSent: BranchQueryRequest[] = [], closed: string[] = [];
  let replaced = false;
  client.retain(target, query, view => { if (view.phase === "pending" && !replaced) {
    replaced = true; client.attach({ send: r => nextSent.push(r), close() {} }).receive(snapshot());
  } });
  const old = client.attach({ send: r => oldSent.push(r), close: reason => closed.push(reason) }); old.receive(snapshot());
  expect(oldSent).toEqual([]); expect(nextSent.map(r => r.action)).toEqual(["retain"]); expect(closed).toHaveLength(1);
});

test("unknown valid result identity does not allocate or perturb an admitted observer", () => {
  const f = fixture(), socket = f.connect(); socket.receive(snapshot()); socket.receive(status(socket.sent[0]!));
  const count = f.views.length;
  socket.receive(result({ ...socket.sent[0]!, subscriptionId: "unknown" }));
  expect(f.views).toHaveLength(count); expect(socket.sent).toHaveLength(1); expect(socket.closed).toEqual([]);
});

test("logical observer and wire-history bounds survive repeated retain/release", () => {
  let id = 0; const client = new BranchQueryConnection("host", () => `id-${++id}`); cleanups.push(() => client.dispose());
  const observers = Array.from({ length: 128 }, () => client.retain(target, query, () => {}));
  expect(() => client.retain(target, query, () => {})).toThrow("Too many"); observers.forEach(observer => observer.dispose());
  const sent: BranchQueryRequest[] = [], closed: string[] = [];
  client.attach({ send: r => sent.push(r), close: reason => closed.push(reason) }).receive(snapshot());
  for (let i = 0; i < 2048; i++) client.retain(target, query, () => {}).dispose();
  client.retain(target, query, () => {});
  expect(sent.filter(r => r.action === "retain")).toHaveLength(2048);
  expect(sent.filter(r => r.action === "release")).toHaveLength(2048);
  expect(closed).toHaveLength(1);
});

test("actual peer/client exchange readiness, early result, recovery and independent release", async () => {
  const client = new BranchQueryConnection("host"); const views: BranchQueryView[] = [];
  let receive!: (value: unknown) => void, acquired = 0, disposed = 0, recovered = 0;
  const emitters: ((update: BranchQueryUpdate) => void)[] = [];
  const peer = new BranchQueryPeer({ hostId: "host", isCurrent: () => true,
    async subscribe(_target, _query, _signal, emit) {
      const privateId = `private-${++acquired}`, abort = new AbortController(); let end!: () => void;
      const closed = new Promise<void>(done => { end = done; }); emitters.push(emit);
      emit({ subscriptionId: privateId, generation: 1, requiresRecovery: true, phase: "complete", result: { type: query.type, branches: ["main"] } });
      return { subscriptionId: privateId, signal: abort.signal, closed, async recover() { recovered++; }, async dispose() { disposed++; abort.abort(); end(); } };
    }, send: value => receive(value), close() {} });
  const connection = client.attach({ send: request => peer.receive(JSON.stringify(request)), close() { void peer.dispose(); } }); receive = connection.receive;
  try {
    const first = client.retain(target, query, value => views.push(value));
    const second = client.retain({ sessionId: "second" }, query, () => {});
    receive(snapshot()); await flush();
    expect(acquired).toBe(2); expect(views.at(-1)).toMatchObject({ phase: "ready", update: { generation: 1, requiresRecovery: true } });
    first.recover(); await flush(); expect(recovered).toBe(1);
    first.dispose(); await flush(); const count = views.length;
    emitters[0]!({ subscriptionId: "private-1", generation: 2, requiresRecovery: false, phase: "complete", result: { type: query.type, branches: ["late"] } });
    expect(views).toHaveLength(count); expect(disposed).toBe(1); second.inspect(); expect(acquired).toBe(2);
    second.dispose(); await flush(); expect(disposed).toBe(2);
  } finally { client.dispose(); await peer.dispose(); }
});
