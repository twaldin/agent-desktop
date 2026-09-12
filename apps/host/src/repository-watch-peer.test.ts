import { afterEach, expect, test } from "bun:test";
import { parseRepositoryWatchRequest, type RepositoryWatchRequest, type RepositoryWatchStatus } from "@agent-desktop/shared";
import { RepositoryWatchPeer } from "./repository-watch-peer";
import { RepositoryWatchSubscriptions, type RepositoryWatchLease } from "./workspace/repository-watch-subscriptions";
import type { MetadataWatchIO } from "./workspace/repository-metadata-watcher";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = () => new Promise<void>(done => setImmediate(done));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function request(action: RepositoryWatchRequest["action"] = "retain", subscriptionId = "one", target = { projectId: "project" }): RepositoryWatchRequest {
  return { type: "repository-watch", version: 1, hostId: "host", subscriptionId, action, target };
}
function fixture(retain?: (target: RepositoryWatchRequest["target"], signal: AbortSignal) => Promise<RepositoryWatchLease>) {
  let current = true, coverage: string | undefined, failSend = false, closes = 0;
  const calls: { target: RepositoryWatchRequest["target"]; signal: AbortSignal }[] = [], statuses: RepositoryWatchStatus[] = [], closed: string[] = [];
  const lease: RepositoryWatchLease = { get error() { return coverage; }, async dispose() { closes++; } };
  const peer = new RepositoryWatchPeer({ hostId: "host", isCurrent: () => current,
    retain: async (target, signal) => { calls.push({ target, signal }); return retain ? retain(target, signal) : lease; },
    send: status => { if (failSend) throw new Error("send failed"); statuses.push(status); }, close: reason => closed.push(reason) });
  cleanups.push(() => peer.dispose());
  return { peer, lease, calls, statuses, closed, send: (input = request()) => peer.receive(JSON.stringify(input)),
    get closes() { return closes; }, set current(value: boolean) { current = value; }, set coverage(value: string | undefined) { coverage = value; }, set failSend(value: boolean) { failSend = value; } };
}

test("strict owner protocol rejects standalone paths, mixed owners, wrong versions and malformed actions", () => {
  const input = request(), parsed = parseRepositoryWatchRequest(input);
  expect(parsed).toEqual(input);
  for (const invalid of [null, [], { ...input, version: 2 }, { ...input, action: ["retain"] }, { ...input, target: { filePath: "/repo" } },
    { ...input, target: { projectId: "p", sessionId: "s" } }, { ...input, hostId: "" }, { ...input, subscriptionId: "x\0y" }, { ...input, extra: true }]) {
    expect(() => parseRepositoryWatchRequest(invalid)).toThrow();
  }
});

test("pending duplicates share one acquisition; inspection reports settled coverage without reacquiring", async () => {
  const gate = deferred<RepositoryWatchLease>(), f = fixture(() => gate.promise);
  f.send(); f.send(); f.send(request("inspect")); await flush();
  expect(f.calls).toHaveLength(1); expect(f.statuses.map(value => value.phase)).toEqual(["pending", "pending", "pending"]);
  f.coverage = "one target unavailable"; gate.resolve(f.lease); await flush();
  expect(f.statuses.at(-1)).toMatchObject({ phase: "ready", error: "one target unavailable" });
  f.coverage = undefined; f.send(request("inspect")); expect(f.statuses.at(-1)?.error).toBeUndefined(); expect(f.calls).toHaveLength(1);
  f.send(request("release")); await flush(); f.send(); await flush();
  expect(f.statuses.at(-1)?.phase).toBe("released"); expect(f.calls).toHaveLength(1); expect(f.closes).toBe(1);
});

test("unknown inspection does not acquire; release before retain permanently retires this socket ID", async () => {
  const f = fixture(); f.send(request("inspect")); expect(f.statuses.at(-1)?.phase).toBe("unavailable");
  f.send(request("release")); await flush(); f.send(); await flush();
  expect(f.calls).toEqual([]); expect(f.statuses.at(-1)?.phase).toBe("released");
  f.send(request("retain", "fresh")); await flush(); expect(f.calls).toHaveLength(1);
});

test("release drains an uncancellable late acquisition and never publishes ready afterward", async () => {
  const gate = deferred<RepositoryWatchLease>(), f = fixture(() => gate.promise); f.send(); await flush();
  f.send(request("release")); expect(f.calls[0]!.signal.aborted).toBe(true);
  let disposed = false; const cleanup = f.peer.dispose().then(() => { disposed = true; }); await flush(); expect(disposed).toBe(false);
  gate.resolve(f.lease); await cleanup;
  expect(f.closes).toBe(1); expect(f.statuses.some(value => value.phase === "ready")).toBe(false);
});

test("socket disposal before dispatch performs no acquisition, and disposal is idempotent", async () => {
  const f = fixture(); f.send(); const first = f.peer.dispose(); expect(f.peer.dispose()).toBe(first); await first;
  f.send(request("retain", "fresh")); expect(f.calls).toEqual([]); expect(f.statuses.map(value => value.phase)).toEqual(["pending"]);
});

test("connection cleanup waits for the acquired resource's disposal, including release already underway", async () => {
  const gate = deferred<void>(); let closes = 0;
  const f = fixture(async () => ({ error: undefined, async dispose() { closes++; await gate.promise; } }));
  f.send(); await flush(); f.send(request("release")); await flush();
  let complete = false; const cleanup = f.peer.dispose().then(() => { complete = true; }); await flush();
  const held = !complete; gate.resolve(); await cleanup;
  expect(held).toBe(true); expect(closes).toBe(1);
  expect(f.statuses.at(-1)?.phase).toBe("releasing");
});

test("observed permission loss cannot revive after return while acquisition is held", async () => {
  const gate = deferred<RepositoryWatchLease>(), f = fixture(() => gate.promise); f.send(); await flush();
  f.current = false; f.send(request("inspect")); f.current = true; gate.resolve(f.lease); await f.peer.dispose();
  expect(f.closed).toHaveLength(1); expect(f.calls[0]!.signal.aborted).toBe(true); expect(f.closes).toBe(1);
  expect(f.statuses.map(value => value.phase)).toEqual(["pending"]);
});

test("permission is rechecked after acquisition without another request", async () => {
  const gate = deferred<RepositoryWatchLease>(), f = fixture(() => gate.promise); f.send(); await flush();
  f.current = false; gate.resolve(f.lease); await flush(); await f.peer.dispose();
  expect(f.closed).toHaveLength(1); expect(f.closes).toBe(1); expect(f.statuses.map(value => value.phase)).toEqual(["pending"]);
});

test("wrong host, wrong owner, malformed JSON and oversized frames close and drain only their peer", async () => {
  for (const invalid of [JSON.stringify({ ...request(), hostId: "other" }), JSON.stringify(request("release", "one", { projectId: "other" })), "{", " ".repeat(1025)]) {
    const f = fixture(); f.send(); await flush(); f.peer.receive(invalid); await f.peer.dispose();
    expect(f.closed).toHaveLength(1); expect(f.calls).toHaveLength(1); expect(f.closes).toBe(1);
  }
});

test("send failure retires acquisition and does not silently leave a live subscription", async () => {
  const f = fixture(); f.failSend = true; f.send(); await f.peer.dispose();
  expect(f.closed).toHaveLength(1); expect(f.calls).toEqual([]);
});

test("failed acquisition does not retry on duplicate or inspect; a fresh ID is deliberate retry", async () => {
  const f = fixture(async () => { throw new Error("catalog unavailable"); }); f.send(); await flush();
  expect(f.statuses.at(-1)).toMatchObject({ phase: "failed", error: "catalog unavailable" });
  f.send(); f.send(request("inspect")); await flush(); expect(f.calls).toHaveLength(1);
  f.send(request("retain", "fresh")); await flush(); expect(f.calls).toHaveLength(2);
  // This failure is already reported by acquisition; cleanup has no acquired resource.
  await f.peer.dispose();
});

test("failed release is visible and cleanup reports it instead of claiming a clean drain", async () => {
  const f = fixture(async () => ({ error: undefined, async dispose() { throw new Error("close failed"); } })); f.send(); await flush();
  f.send(request("release")); await flush(); expect(f.statuses.at(-1)).toMatchObject({ phase: "released", error: "close failed" });
  await expect(f.peer.dispose()).rejects.toThrow("cleanup failed"); cleanups.pop();
});

test("active subscriptions and retired history are bounded without recycling IDs", async () => {
  const f = fixture(); for (let i = 0; i < 129; i++) f.send(request("retain", `active-${i}`)); await flush();
  expect(f.calls).toHaveLength(128); expect(f.statuses.find(value => value.subscriptionId === "active-128")?.phase).toBe("failed");
  for (let i = 129; i < 2048; i++) f.send(request("release", `retired-${i}`));
  f.send(request("retain", "overflow")); await f.peer.dispose();
  expect(f.closed).toHaveLength(1); expect(f.closes).toBe(128); expect(f.calls).toHaveLength(128);
});

test("two actual registry subscribers share resources, one disconnected peer does not release the other", async () => {
  const opened: { changed(name: string | null, renamed: boolean): void; closes: number }[] = [], timers: (() => void)[] = [], events: string[] = [];
  const io: MetadataWatchIO = { now: () => 0, directoryIdentity: async path => path, directories: async () => [],
    async open(_path, _recursive, changed) { const done = deferred<Error | undefined>(), item = { changed, closes: 0 }; opened.push(item);
      return { closed: done.promise, async dispose() { item.closes++; done.resolve(undefined); } }; },
    schedule(callback) { timers.push(callback); return () => { const index = timers.indexOf(callback); if (index >= 0) timers.splice(index, 1); }; } };
  const registry = new RepositoryWatchSubscriptions({ resolve: () => ({ isCurrent: () => true, readContext: async () => ({ root: "/repo", commonDir: "/repo/.git", gitDir: "/repo/.git", headPath: "/repo/.git/HEAD", indexPath: "/repo/.git/index", headRef: "refs/heads/main" }) }),
    changed: target => { events.push(JSON.stringify(target)); }, recoveryChanged: () => {} }, io);
  cleanups.push(() => registry.dispose());
  const a = fixture((target, signal) => registry.retain(target, signal)), b = fixture((target, signal) => registry.retain(target, signal));
  a.send(); b.send(); await flush(); expect(a.statuses.at(-1)?.phase).toBe("ready"); expect(b.statuses.at(-1)?.phase).toBe("ready"); expect(opened).toHaveLength(6);
  await a.peer.dispose(); expect(opened.every(item => item.closes === 0)).toBe(true);
  opened[0]!.changed("HEAD", false); for (const timer of timers.splice(0)) timer(); await flush();
  expect(events).toEqual([JSON.stringify({ projectId: "project" })]);
  await b.peer.dispose(); expect(opened.every(item => item.closes === 1)).toBe(true);
  const c = fixture((target, signal) => registry.retain(target, signal)); c.send(); await flush();
  expect(c.statuses.at(-1)?.phase).toBe("ready"); expect(opened).toHaveLength(12);
});
