import { expect, test } from "bun:test";
import { parseRepositoryWatchStatus, type RepositoryWatchRequest, type RepositoryWatchStatus } from "@agent-desktop/shared";
import { RepositoryWatchConnection, type RepositoryWatchView } from "./repository-watch-connection";
import { RepositoryWatchPeer } from "../../../host/src/repository-watch-peer";

const target = { projectId: "project" };
const flush = () => new Promise<void>(done => setImmediate(done));
const snapshot = (supported = true, replayComplete = true, hostId = "host") => ({ type: "state", replayComplete, state: { host: { id: hostId }, ...(supported ? { repositoryWatches: { version: 1 } } : {}) } });
function status(request: RepositoryWatchRequest, phase: RepositoryWatchStatus["phase"] = "ready", error?: string): RepositoryWatchStatus {
  return { type: "repository-watch", version: 1, hostId: request.hostId, subscriptionId: request.subscriptionId, target: { ...request.target }, phase, ...(error ? { error } : {}) };
}
function fixture() {
  let id = 0;
  const client = new RepositoryWatchConnection("host", () => `wire-${++id}`), views: RepositoryWatchView[] = [];
  const observer = client.retain(target, view => views.push(view));
  const connect = (failSend = false) => {
    const sent: RepositoryWatchRequest[] = [], closed: string[] = [];
    const handle = client.attach({ send: request => { if (failSend) throw new Error("send failed"); sent.push(request); }, close: error => closed.push(error) });
    return { sent, closed, ...handle };
  };
  return { client, views, observer, connect };
}

test("status parser validates identity, phase and errors and clones the target", () => {
  const input = status({ type: "repository-watch", version: 1, hostId: "host", subscriptionId: "one", target, action: "retain" });
  const parsed = parseRepositoryWatchStatus(input);
  expect(parsed).toEqual(input);
  Object.assign(input.target, { projectId: "caller-edited" });
  expect(parsed.target).toEqual({ projectId: "project" });
  Object.assign(parsed.target, { projectId: "consumer-edited" });
  expect(input.target).toEqual({ projectId: "caller-edited" });
  for (const invalid of [null, [], { ...input, phase: ["ready"] }, { ...input, phase: "connected" }, { ...input, version: 2 },
    { ...input, error: null }, { ...input, error: "x".repeat(1001) }, { ...input, target: { filePath: "/repo" } }, { ...input, sequence: 1 }]) {
    expect(() => parseRepositoryWatchStatus(invalid)).toThrow();
  }
});

test("retention waits for the fresh replay-complete capability snapshot, then for matching readiness", () => {
  const f = fixture(), socket = f.connect();
  socket.receive(snapshot(true, false)); f.observer.inspect(); expect(socket.sent).toEqual([]); expect(f.views.at(-1)?.phase).toBe("connecting");
  socket.receive(snapshot()); expect(socket.sent).toHaveLength(1); expect(f.views.at(-1)?.phase).toBe("pending");
  socket.receive(status(socket.sent[0]!, "ready", "partial coverage")); expect(f.views.at(-1)).toEqual({ phase: "ready", error: "partial coverage" });
  f.observer.inspect(); expect(socket.sent.at(-1)?.action).toBe("inspect"); socket.receive(status(socket.sent[0]!)); expect(f.views.at(-1)).toEqual({ phase: "ready" });
  socket.receive(snapshot()); expect(socket.sent.filter(value => value.action === "retain")).toHaveLength(1);
  f.client.dispose();
});

test("unsupported hosts never receive watch requests; a supported reconnect uses a new lifetime", () => {
  const f = fixture(), old = f.connect(); old.receive(snapshot(false));
  f.observer.inspect(); expect(old.sent).toEqual([]); expect(f.views.at(-1)?.phase).toBe("unsupported");
  const next = f.connect(); next.receive(snapshot()); expect(old.closed).toHaveLength(1); expect(next.sent).toHaveLength(1);
  old.receive(snapshot()); old.disconnected(); expect(f.views.at(-1)?.phase).toBe("pending");
  f.client.dispose();
});

test("disconnect retires old readiness; late status and close callbacks cannot affect a replacement socket", () => {
  const f = fixture(), old = f.connect(); old.receive(snapshot()); old.receive(status(old.sent[0]!));
  old.disconnected(); expect(f.views.at(-1)?.phase).toBe("disconnected"); f.observer.inspect(); expect(old.sent).toHaveLength(1);
  const next = f.connect(); next.receive(snapshot()); expect(next.sent[0]!.subscriptionId).not.toBe(old.sent[0]!.subscriptionId);
  const count = f.views.length; old.receive(status(old.sent[0]!, "failed", "old")); old.disconnected("old");
  expect(f.views).toHaveLength(count); next.receive(status(next.sent[0]!)); expect(f.views.at(-1)).toEqual({ phase: "ready" });
  f.client.dispose();
});

test("released observers cannot be revived by late replies or reconnect, and release is sent exactly once", () => {
  const f = fixture(), socket = f.connect(); socket.receive(snapshot()); f.observer.dispose(); f.observer.dispose();
  expect(socket.sent.map(value => value.action)).toEqual(["retain", "release"]);
  const count = f.views.length; socket.receive(status(socket.sent[0]!)); f.observer.inspect();
  const next = f.connect(); next.receive(snapshot()); expect(next.sent).toEqual([]); expect(f.views).toHaveLength(count); f.client.dispose();
});

test("release before capability sends nothing and leaves other observers retained", () => {
  const f = fixture(), otherViews: RepositoryWatchView[] = [], other = f.client.retain({ sessionId: "session" }, view => otherViews.push(view)), socket = f.connect();
  f.observer.dispose(); socket.receive(snapshot()); expect(socket.sent).toHaveLength(1); expect(socket.sent[0]!.target).toEqual({ sessionId: "session" });
  other.dispose(); expect(socket.sent.at(-1)?.action).toBe("release"); expect(socket.closed).toEqual([]); f.client.dispose();
});

test("failed and unavailable wire states never silently reacquire or accept late ready", () => {
  for (const phase of ["failed", "unavailable", "released", "releasing"] as const) {
    const f = fixture(), socket = f.connect(); socket.receive(snapshot()); socket.receive(status(socket.sent[0]!, phase));
    expect(f.views.at(-1)?.phase).toBe("failed"); socket.receive(status(socket.sent[0]!)); socket.receive(snapshot());
    expect(f.views.at(-1)?.phase).toBe("failed"); expect(socket.sent).toHaveLength(1); f.client.dispose();
  }
});

test("late pending cannot regress ready, and unknown valid IDs never allocate observers", () => {
  const f = fixture(), socket = f.connect(); socket.receive(snapshot()); socket.receive(status(socket.sent[0]!));
  socket.receive(status(socket.sent[0]!, "pending")); const count = f.views.length;
  socket.receive({ ...status(socket.sent[0]!), subscriptionId: "other" });
  expect(f.views.at(-1)?.phase).toBe("ready"); expect(f.views).toHaveLength(count); expect(socket.sent).toHaveLength(1); f.client.dispose();
});

test("wrong host, target or malformed status closes this connection and drops readiness", () => {
  for (const invalid of [(r: RepositoryWatchRequest) => ({ ...status(r), hostId: "other" }), (r: RepositoryWatchRequest) => ({ ...status(r), target: { sessionId: "other" } }),
    (r: RepositoryWatchRequest) => ({ ...status(r), phase: "invented" }), () => snapshot(true, true, "other")]) {
    const f = fixture(), socket = f.connect(); socket.receive(snapshot()); socket.receive(invalid(socket.sent[0]!));
    expect(socket.closed).toHaveLength(1); expect(f.views.at(-1)?.phase).toBe("disconnected"); f.client.dispose();
  }
});

test("send failure clears every observer without pretending readiness", () => {
  const f = fixture(), other: RepositoryWatchView[] = []; f.client.retain({ projectId: "other" }, value => other.push(value));
  const socket = f.connect(true); socket.receive(snapshot());
  expect(f.views.at(-1)?.phase).toBe("disconnected"); expect(other.at(-1)?.phase).toBe("disconnected"); expect(socket.closed).toHaveLength(1); f.client.dispose();
});

test("capability changes require reconnect and duplicate wire IDs fail closed", () => {
  const f = fixture(), socket = f.connect(); socket.receive(snapshot()); socket.receive(snapshot(false)); expect(socket.closed).toHaveLength(1); f.client.dispose();
  const client = new RepositoryWatchConnection("host", () => "same"), sent: RepositoryWatchRequest[] = [], closed: string[] = [];
  client.retain(target, () => {}); client.retain({ projectId: "other" }, () => {});
  const connection = client.attach({ send: r => sent.push(r), close: r => closed.push(r) }); connection.receive(snapshot());
  expect(sent).toHaveLength(1); expect(closed).toHaveLength(1); client.dispose();
});

test("controller disposal releases all wires without closing the shared event socket", () => {
  const f = fixture(), socket = f.connect(); f.client.retain({ projectId: "other" }, () => {}); socket.receive(snapshot());
  f.client.dispose(); f.client.dispose(); expect(socket.sent.map(value => value.action)).toEqual(["retain", "retain", "release", "release"]);
  expect(socket.closed).toEqual([]); expect(() => f.client.retain(target, () => {})).toThrow("disposed"); expect(() => f.connect()).toThrow("disposed");
});

test("observer delivery can reconnect without old disconnect delivery erasing replacement wires", () => {
  const client = new RepositoryWatchConnection("host"); let reconnected = false;
  const sent: RepositoryWatchRequest[] = [], secondViews: RepositoryWatchView[] = [];
  client.retain(target, view => {
    if (view.phase === "disconnected" && !reconnected) {
      reconnected = true;
      client.attach({ send: request => sent.push(request), close: () => {} }).receive(snapshot());
    }
  });
  const second = client.retain({ projectId: "other" }, view => secondViews.push(view));
  const old = client.attach({ send: () => {}, close: () => {} }); old.receive(snapshot()); old.disconnected();
  expect(reconnected).toBe(true); expect(secondViews.at(-1)?.phase).toBe("pending");
  second.inspect(); expect(sent.map(value => value.action)).toEqual(["retain", "retain", "inspect"]); client.dispose();
});

test("logical observer and wire history limits cannot be bypassed by repeated release", () => {
  let id = 0; const client = new RepositoryWatchConnection("host", () => `id-${++id}`);
  const observers = Array.from({ length: 128 }, () => client.retain(target, () => {}));
  expect(() => client.retain(target, () => {})).toThrow("Too many"); observers.forEach(observer => observer.dispose());
  const sent: RepositoryWatchRequest[] = [], closed: string[] = [];
  const connection = client.attach({ send: value => sent.push(value), close: value => closed.push(value) }); connection.receive(snapshot());
  for (let i = 0; i < 2048; i++) client.retain(target, () => {}).dispose();
  client.retain(target, () => {});
  expect(sent.filter(value => value.action === "retain")).toHaveLength(2048); expect(closed).toHaveLength(1); client.dispose();
});

test("actual peer and client exchange pending/ready/release while preserving an independent observer", async () => {
  let acquired = 0, disposed = 0; const client = new RepositoryWatchConnection("host"), views: RepositoryWatchView[] = [];
  let receive!: (value: unknown) => void;
  const peer = new RepositoryWatchPeer({ hostId: "host", isCurrent: () => true, retain: async () => { acquired++; return { error: undefined, async dispose() { disposed++; } }; },
    send: value => receive(value), close: () => {} });
  const connection = client.attach({ send: request => peer.receive(JSON.stringify(request)), close: () => { void peer.dispose(); } }); receive = connection.receive;
  try {
    const first = client.retain(target, value => views.push(value)), second = client.retain(target, () => {});
    receive(snapshot()); await flush(); expect(acquired).toBe(2); expect(views.at(-1)?.phase).toBe("ready");
    first.dispose(); await flush(); expect(disposed).toBe(1); second.inspect(); expect(acquired).toBe(2);
    second.dispose(); await flush(); expect(disposed).toBe(2);
  } finally { client.dispose(); await peer.dispose(); }
});


for (const replayComplete of [undefined, false]) {
  for (const version of [undefined, 2]) {
    test(`live capability loss version=${version} replayComplete=${replayComplete} retires readiness until fresh admission`, () => {
      const f = fixture(), old = f.connect();
      try {
        old.receive(snapshot()); const original = old.sent[0]!; old.receive(status(original));
        old.receive({ type: "state", ...(replayComplete === undefined ? {} : { replayComplete }),
          state: { host: { id: "host" }, ...(version === undefined ? {} : { repositoryWatches: { version } }) } });
        expect(old.closed).toHaveLength(1); expect(f.views.at(-1)?.phase).toBe("disconnected");
        f.observer.inspect(); old.receive(snapshot()); old.receive(status(original));
        expect(old.sent).toHaveLength(1); expect(f.views.at(-1)?.phase).toBe("disconnected");
        const next = f.connect(); next.receive(snapshot(true, false));
        expect(next.sent).toEqual([]); expect(f.views.at(-1)?.phase).toBe("connecting");
        next.receive(snapshot()); expect(next.sent).toHaveLength(1);
        expect(next.sent[0]!.subscriptionId).not.toBe(original.subscriptionId);
        next.receive(status(next.sent[0]!)); expect(f.views.at(-1)?.phase).toBe("ready");
      } finally { f.client.dispose(); }
    });
  }
}

test("live capability stability is harmless after first admission and unsupported-to-supported requires reconnect", () => {
  const f = fixture(), socket = f.connect();
  try {
    socket.receive(snapshot(false, false)); socket.receive(snapshot(true, false));
    expect(socket.closed).toEqual([]); expect(socket.sent).toEqual([]); expect(f.views.at(-1)?.phase).toBe("connecting");
    socket.receive(snapshot(false)); socket.receive(snapshot(false, false));
    expect(socket.closed).toEqual([]); expect(f.views.at(-1)?.phase).toBe("unsupported");
    socket.receive(snapshot(true, false)); expect(socket.closed).toHaveLength(1); expect(socket.sent).toEqual([]);
    const next = f.connect(); next.receive(snapshot()); next.receive(snapshot(true, false));
    expect(next.closed).toEqual([]); expect(next.sent).toHaveLength(1);
    expect(f.views.at(-1)?.phase).toBe("pending");
  } finally { f.client.dispose(); }
});
