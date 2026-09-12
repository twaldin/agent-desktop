import { expect, test } from "bun:test";
import { RecentBranchCache } from "./recent-branch-cache";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("recent cache separates live/short modes and expires short results at 250ms", async () => {
  let now = 0, scans = 0;
  const cache = new RecentBranchCache(() => now), scan = async () => [`scan-${++scans}`];
  try {
    const first = await cache.read("/repo", "identity", false, scan); first.push("caller mutation");
    now = 249;
    expect(await cache.read("/repo", "identity", false, scan)).toEqual(["scan-1"]);
    now = 250;
    expect(await cache.read("/repo", "identity", false, scan)).toEqual(["scan-2"]);
    expect(await cache.read("/repo", "identity", true, scan)).toEqual(["scan-3"]);
    now = 10_000;
    expect(await cache.read("/repo", "identity", true, scan)).toEqual(["scan-3"]);
    expect(scans).toBe(3);
  } finally { await cache.dispose(); }
});

test("recent live generations follow relevant refs, watch health and final release", async () => {
  let scans = 0;
  const cache = new RecentBranchCache(), scan = async () => [`scan-${++scans}`];
  try {
    await cache.read("/repo", "identity", true, scan);
    for (const kind of ["index", "working-tree", "worktree-topology", "synced-branch"] as const) {
      cache.invalidate("/repo", kind);
      expect(await cache.read("/repo", "identity", true, scan)).toEqual(["scan-1"]);
    }
    for (const kind of ["config", "head", "local-refs", "remote-refs"] as const) {
      const before = scans; cache.invalidate("/repo", kind);
      await cache.read("/repo", "identity", true, scan); expect(scans).toBe(before + 1);
    }
    const before = scans;
    cache.watchHealthChanged("/repo"); await cache.read("/repo", "identity", true, scan);
    cache.invalidate("/repo"); await cache.read("/repo", "identity", true, scan);
    expect(scans).toBe(before + 2);
  } finally { await cache.dispose(); }
});

test("identity, root and host-owned caches never share completed reads", async () => {
  let scans = 0;
  const a = new RecentBranchCache(), b = new RecentBranchCache(), scan = async () => [`scan-${++scans}`];
  try {
    expect(await a.read("/repo", "old", true, scan)).toEqual(["scan-1"]);
    expect(await a.read("/repo", "replacement", true, scan)).toEqual(["scan-2"]);
    expect(await a.read("/linked", "replacement", true, scan)).toEqual(["scan-3"]);
    expect(await b.read("/repo", "replacement", true, scan)).toEqual(["scan-4"]);
  } finally { await Promise.all([a.dispose(), b.dispose()]); }
});

test("a retired pending scan cannot fill or delete its successor", async () => {
  const cache = new RecentBranchCache(), old = deferred<string[]>();
  let scans = 0;
  try {
    const first = cache.read("/repo", "identity", true, async () => { scans++; return old.promise; });
    await Promise.resolve(); cache.invalidate("/repo", "head");
    expect(await cache.read("/repo", "identity", true, async () => { scans++; return ["new"]; })).toEqual(["new"]);
    old.resolve(["old"]); expect(await first).toEqual(["old"]);
    expect(await cache.read("/repo", "identity", true, async () => { scans++; return ["unexpected"]; })).toEqual(["new"]);
    expect(scans).toBe(2);
  } finally { old.resolve([]); await cache.dispose(); }
});

test("one consumer cancellation preserves another; final cancellation retires sent work", async () => {
  const last = deferred<string[]>();
  const cache = new RecentBranchCache(), gate = deferred<string[]>(), one = new AbortController(), two = new AbortController();
  let sent: AbortSignal | undefined, scans = 0;
  const scan = async (signal: AbortSignal) => { sent = signal; scans++; return gate.promise; };
  try {
    const a = cache.read("/repo", "identity", true, scan, one.signal).then(() => "fulfilled", () => "aborted");
    const b = cache.read("/repo", "identity", true, scan, two.signal);
    await Promise.resolve(); one.abort(); expect(sent?.aborted).toBe(false);
    gate.resolve(["main"]); expect(await a).toBe("aborted"); expect(await b).toEqual(["main"]); expect(scans).toBe(1);
    cache.invalidate("/repo");
    const abort = new AbortController(); let lastSignal: AbortSignal | undefined;
    const retired = cache.read("/repo", "identity", true, async signal => { lastSignal = signal; return last.promise; }, abort.signal).catch(() => "aborted");
    await Promise.resolve(); abort.abort(); expect(lastSignal?.aborted).toBe(true);
    expect(await cache.read("/repo", "identity", true, async () => ["replacement"])).toEqual(["replacement"]);
    last.resolve(["stale"]); expect(await retired).toBe("aborted");
    expect(await cache.read("/repo", "identity", true, async () => ["unexpected"])).toEqual(["replacement"]);
  } finally { gate.resolve([]); last.resolve([]); await cache.dispose(); }
});

test("failed scans remain errors and disposal waits for uncooperative sent work", async () => {
  const cache = new RecentBranchCache(), failure = new Error("Git failed"), gate = deferred<string[]>();
  await expect(cache.read("/repo", "identity", true, async () => { throw failure; })).rejects.toThrow("Git failed");
  expect(await cache.read("/repo", "identity", true, async () => ["recovered"])).toEqual(["recovered"]);
  cache.invalidate("/repo");
  const read = cache.read("/repo", "identity", true, async () => gate.promise);
  await Promise.resolve(); let closed = false;
  const disposal = cache.dispose().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  await expect(cache.read("/repo", "identity", true, async () => [])).rejects.toThrow("stopped");
  gate.resolve(["late"]); await read; await disposal; expect(closed).toBe(true);
});
