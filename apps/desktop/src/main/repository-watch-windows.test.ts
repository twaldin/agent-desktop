import { expect, test } from "bun:test";
import type { RepositoryWatchObserverStatus, RepositoryWatchRequest } from "@agent-desktop/shared";
import { RepositoryWatchConnection } from "./repository-watch-connection";
import { RepositoryWatchWindows } from "./repository-watch-windows";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const flush = () => new Promise<void>(done => setImmediate(done));
const request = (action: RepositoryWatchRequest["action"] = "retain", subscriptionId = "one", hostId = "host", projectId = "project"): RepositoryWatchRequest => ({ type: "repository-watch", version: 1, action, subscriptionId, hostId, target: { projectId } });
function fixture() {
  const sent: RepositoryWatchRequest[] = [], statuses: { senderId: number; status: RepositoryWatchObserverStatus }[] = [], calls: string[] = [];
  let connect: (hostId: string, isCurrent: () => boolean) => Promise<RepositoryWatchConnection>;
  let notify: ((senderId: number, status: RepositoryWatchObserverStatus) => void) | undefined;
  const client = new RepositoryWatchConnection("host");
  const channel = client.attach({ send: value => sent.push(value), close: () => {} });
  channel.receive({ type: "state", replayComplete: true, state: { host: { id: "host" }, repositoryWatches: { version: 1 } } });
  connect = async () => client;
  const windows = new RepositoryWatchWindows({ connect: (hostId, current) => { calls.push(hostId); return connect(hostId, current); },
    notify: (senderId, status) => { statuses.push({ senderId, status }); notify?.(senderId, status); } });
  windows.reset(1); windows.reset(2);
  return { client, windows, sent, statuses, calls, channel,
    set connect(value: typeof connect) { connect = value; }, set notify(value: typeof notify) { notify = value; },
    dispose() { windows.dispose(); client.dispose(); } };
}

test("same observer duplicates share admission, while inspection only uses an existing lease", async () => {
  const f = fixture(), gate = deferred<RepositoryWatchConnection>(); f.connect = () => gate.promise;
  const first = f.windows.dispatch(1, request(), () => true, f.windows.token(1)), duplicate = f.windows.dispatch(1, request(), () => true, f.windows.token(1));
  await f.windows.dispatch(1, request("inspect"), () => true, f.windows.token(1)); await flush(); expect(f.calls).toEqual(["host"]); expect(f.sent).toEqual([]);
  gate.resolve(f.client); await Promise.all([first, duplicate]); expect(f.sent.map(value => value.action)).toEqual(["retain"]);
  await f.windows.dispatch(1, request("inspect"), () => true, f.windows.token(1)); expect(f.sent.at(-1)?.action).toBe("inspect");
  f.dispose();
});

test("release during host lookup prevents late admission, including release then repeated retain", async () => {
  const f = fixture(), gate = deferred<RepositoryWatchConnection>(); f.connect = () => gate.promise;
  const pending = f.windows.dispatch(1, request(), () => true, f.windows.token(1)); await flush();
  await f.windows.dispatch(1, request("release"), () => true, f.windows.token(1)); const duplicate = f.windows.dispatch(1, request(), () => true, f.windows.token(1));
  gate.resolve(f.client); await Promise.all([pending, duplicate]);
  expect(f.calls).toHaveLength(1); expect(f.sent).toEqual([]); expect(f.statuses.at(-1)?.status.view.phase).toBe("released"); f.dispose();
});

test("closing a window during lookup cancels admission and cannot attach to a reused sender ID", async () => {
  const f = fixture(), gate = deferred<RepositoryWatchConnection>(); f.connect = () => gate.promise;
  const pending = f.windows.dispatch(1, request(), () => true, f.windows.token(1)); await flush(); f.windows.releaseWindow(1); f.windows.reset(1);
  const count = f.statuses.length; gate.resolve(f.client); await pending;
  expect(f.sent).toEqual([]); expect(f.statuses).toHaveLength(count);
  await f.windows.dispatch(1, request(), () => true, f.windows.token(1)); expect(f.sent).toHaveLength(1); f.dispose();
});

test("navigation reset releases current wires and old replies do not reach the new renderer lifetime", async () => {
  const f = fixture(); await f.windows.dispatch(1, request(), () => true, f.windows.token(1)); const old = f.sent[0]!;
  f.windows.reset(1); expect(f.sent.map(value => value.action)).toEqual(["retain", "release"]);
  await f.windows.dispatch(1, request(), () => true, f.windows.token(1)); const next = f.sent.at(-1)!; expect(next.subscriptionId).not.toBe(old.subscriptionId);
  const count = f.statuses.length;
  f.channel.receive({ type: "repository-watch", version: 1, hostId: "host", subscriptionId: old.subscriptionId, target: old.target, phase: "ready" });
  expect(f.statuses).toHaveLength(count);
  f.channel.receive({ type: "repository-watch", version: 1, hostId: "host", subscriptionId: next.subscriptionId, target: next.target, phase: "ready" });
  expect(f.statuses.at(-1)?.status).toMatchObject({ subscriptionId: "one", view: { phase: "ready" } }); f.dispose();
});

test("the same logical ID in another window owns an independent lease and delivery destination", async () => {
  const f = fixture(); await f.windows.dispatch(1, request(), () => true, f.windows.token(1)); await f.windows.dispatch(2, request(), () => true, f.windows.token(2));
  const second = f.sent[1]!; expect(f.sent[0]!.subscriptionId).not.toBe(second.subscriptionId);
  f.windows.releaseWindow(1); expect(f.sent.filter(value => value.action === "release")).toHaveLength(1);
  f.channel.receive({ type: "repository-watch", version: 1, hostId: "host", subscriptionId: second.subscriptionId, target: second.target, phase: "ready", error: "partial" });
  expect(f.statuses.at(-1)).toMatchObject({ senderId: 2, status: { subscriptionId: "one", view: { phase: "ready", error: "partial" } } }); f.dispose();
});

test("unknown inspection and release do not look up a host; release records a nonrevivable ID", async () => {
  const f = fixture(); await f.windows.dispatch(1, request("inspect"), () => true, f.windows.token(1)); expect(f.statuses.at(-1)?.status.view.phase).toBe("unavailable");
  await f.windows.dispatch(1, request("release"), () => true, f.windows.token(1)); await f.windows.dispatch(1, request(), () => true, f.windows.token(1));
  expect(f.calls).toEqual([]); expect(f.sent).toEqual([]); expect(f.statuses.at(-1)?.status.view.phase).toBe("released"); f.dispose();
});

test("host/target mismatch and malformed inputs cannot redirect an existing observer", async () => {
  const f = fixture(); await f.windows.dispatch(1, request(), () => true, f.windows.token(1));
  for (const invalid of [request("release", "one", "other"), request("retain", "one", "host", "other"), { ...request(), target: { filePath: "/repo" } }, { ...request(), version: 2 }]) {
    expect(() => f.windows.dispatch(1, invalid, () => true, f.windows.token(1))).toThrow();
  }
  expect(f.calls).toEqual(["host"]); expect(f.sent).toHaveLength(1); f.dispose();
});

test("observed frame loss latches across return, and post-lookup frame loss suppresses admission", async () => {
  for (const restore of [false, true]) {
    const f = fixture(), gate = deferred<RepositoryWatchConnection>(); let current = true, admitted: (() => boolean) | undefined;
    f.connect = (_hostId, guard) => { admitted = guard; return gate.promise; };
    const pending = f.windows.dispatch(1, request(), () => current, f.windows.token(1)); await flush(); current = false;
    if (restore) { expect(admitted!()).toBe(false); current = true; }
    gate.resolve(f.client); await pending; expect(f.sent).toEqual([]); f.dispose();
  }
});

test("host lookup failure is visible, duplicates do not retry, and a fresh observer can retry", async () => {
  const f = fixture(); f.connect = async () => { throw new Error("host unavailable"); };
  await f.windows.dispatch(1, request(), () => true, f.windows.token(1)); expect(f.statuses.at(-1)?.status.view).toEqual({ phase: "failed", error: "host unavailable" });
  await f.windows.dispatch(1, request(), () => true, f.windows.token(1)); await f.windows.dispatch(1, request("inspect"), () => true, f.windows.token(1)); expect(f.calls).toHaveLength(1);
  f.connect = async () => f.client; await f.windows.dispatch(1, request("retain", "fresh"), () => true, f.windows.token(1)); expect(f.sent).toHaveLength(1); f.dispose();
});

test("renderer loss during synchronous observer notification disposes the newly returned lease", async () => {
  const f = fixture(); f.notify = (id, status) => { if (status.view.phase === "pending") f.windows.releaseWindow(id); };
  await f.windows.dispatch(1, request(), () => true, f.windows.token(1));
  expect(f.sent.map(value => value.action)).toEqual(["retain", "release"]);
  const count = f.statuses.length; f.channel.disconnected(); expect(f.statuses).toHaveLength(count); f.dispose();
});

test("an expired frame observed on a duplicate retain releases its old active lease", async () => {
  const f = fixture(); let original = true; await f.windows.dispatch(1, request(), () => original, f.windows.token(1)); original = false;
  await f.windows.dispatch(1, request(), () => true, f.windows.token(1)); original = true;
  await f.windows.dispatch(1, request(), () => true, f.windows.token(1)); expect(f.calls).toHaveLength(1); expect(f.sent.map(value => value.action)).toEqual(["retain", "release"]); f.dispose();
});

test("window bounds include pending lookups and released history without implicit reset", async () => {
  const f = fixture(), gate = deferred<RepositoryWatchConnection>(); f.connect = () => gate.promise;
  const pending = Array.from({ length: 129 }, (_, index) => f.windows.dispatch(1, request("retain", `id-${index}`), () => true, f.windows.token(1)));
  await flush(); expect(f.calls).toHaveLength(128); expect(f.statuses.at(-1)?.status.view.phase).toBe("failed");
  f.windows.releaseWindow(1); gate.resolve(f.client); await Promise.all(pending); expect(f.sent).toEqual([]);
  f.windows.reset(1); for (let i = 0; i < 2048; i++) await f.windows.dispatch(1, request("release", `id-${i}`), () => true, f.windows.token(1));
  expect(() => f.windows.dispatch(1, request("retain", "overflow"), () => true, f.windows.token(1))).toThrow("history"); f.dispose();
});

test("application disposal invalidates all pending windows and never reopens on reset", async () => {
  const f = fixture(), gate = deferred<RepositoryWatchConnection>(); f.connect = () => gate.promise;
  const pending = f.windows.dispatch(1, request(), () => true, f.windows.token(1)); await flush(); f.windows.dispose(); f.windows.reset(1); gate.resolve(f.client); await pending;
  expect(f.sent).toEqual([]); expect(() => f.windows.dispatch(1, request(), () => true, f.windows.token(1))).toThrow("unavailable"); f.dispose();
});


test("navigation denies outgoing document requests before and after the new document loads", async () => {
  const f = fixture(), oldToken = f.windows.token(1);
  try {
    f.windows.releaseWindow(1); // Main-frame navigation starts; the old frame may still be alive.
    expect(f.windows.token(1)).toBeUndefined();
    expect(() => f.windows.dispatch(1, request(), () => true, oldToken)).toThrow("unavailable");
    expect(f.calls).toEqual([]);
    f.windows.reset(1); // Only the replacement document's did-finish-load grants a new token.
    expect(f.windows.token(1)).not.toBe(oldToken);
    for (const action of ["retain", "inspect", "release"] as const) {
      expect(() => f.windows.dispatch(1, request(action), () => true, oldToken)).toThrow("unavailable");
    }
    expect(f.calls).toEqual([]); expect(f.statuses).toEqual([]);
    await f.windows.dispatch(1, request(), () => true, f.windows.token(1));
    expect(f.calls).toEqual(["host"]); expect(f.sent.map(value => value.action)).toEqual(["retain"]);
  } finally { f.dispose(); }
});

test("a document token from another window or an absent token cannot authorize admission", async () => {
  const f = fixture();
  try {
    for (const token of [undefined, null, "", f.windows.token(2)]) {
      expect(() => f.windows.dispatch(1, request(), () => true, token)).toThrow("unavailable");
    }
    expect(f.calls).toEqual([]); expect(f.statuses).toEqual([]);
    await f.windows.dispatch(2, request(), () => true, f.windows.token(2));
    expect(f.calls).toEqual(["host"]);
  } finally { f.dispose(); }
});
