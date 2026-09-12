import { afterEach, expect, test } from "bun:test";
import { BranchLiveQueries, type BranchLiveQuery, type BranchLiveResult, type BranchQueryLocation, type BranchQueryUpdate } from "./branch-live-queries";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const location: BranchQueryLocation = { hostId: "host", root: "/repo", commonDir: "/repo/.git", local: true };
const recent: BranchLiveQuery = { type: "git.recent-branches", limit: 10 };
function result(query: BranchLiveQuery, name = "main"): BranchLiveResult {
  if (query.type === "git.recent-branches") return { type: query.type, branches: [name] };
  if (query.type === "git.default-branch") return { type: query.type, branch: name };
  return { type: query.type, base: { local: name, remote: "origin" } };
}
function fixture() {
  let now = 0, timerId = 0;
  const timers = new Map<number, { at: number; run(): void }>(), set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  globalThis.setTimeout = ((run: () => void, ms = 0) => { const id = ++timerId; timers.set(id, { at: now + ms, run }); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  const runs: { query: BranchLiveQuery; location: BranchQueryLocation; signal: AbortSignal; gate: ReturnType<typeof deferred<BranchLiveResult>> }[] = [];
  const updates: BranchQueryUpdate[] = [], prepared: BranchQueryLocation[] = [];
  const owner = new BranchLiveQueries({ run(query, location, signal) { const gate = deferred<BranchLiveResult>(); runs.push({ query, location, signal, gate }); return gate.promise; }, prepareRecovery: l => { prepared.push(l); } });
  cleanups.push(async () => {
    const disposal = owner.dispose(); for (const run of runs) run.gate.resolve(result(run.query));
    await flush(); await disposal; globalThis.setTimeout = set; globalThis.clearTimeout = clear;
  });
  return { owner, runs, updates, prepared,
    add(id: string, query = recent, at = location, current = () => true, recovery = false, emit = (update: BranchQueryUpdate) => { updates.push(update); }) {
      return owner.subscribe({ subscriptionId: id, location: at, query, isCurrent: current, requiresRecovery: recovery, emit });
    },
    async tick(ms: number) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.run(); await flush(); },
    get timerCount() { return timers.size; },
  };
}

test("initial reads are immediate; equivalent subscriptions share one result with independent observer ownership", async () => {
  const f = fixture(); const one = f.add("one"), two = f.add("two"); await flush();
  expect(f.runs).toHaveLength(1); expect(f.timerCount).toBe(0);
  one.dispose(); expect(f.runs[0]!.signal.aborted).toBe(false);
  f.runs[0]!.gate.resolve(result(recent)); await flush();
  expect(f.updates.map(u => u.subscriptionId)).toEqual(["two"]);
  two.dispose(); await f.owner.dispose(); expect(() => f.add("after")).toThrow("ended");
});

test("run identity snapshots params/root/host and repository queue serializes different queries including linked roots", async () => {
  const f = fixture(), mutable = { ...recent }, at = { ...location };
  f.add("one", mutable, at); mutable.limit = 99; at.root = "/changed";
  f.add("same", { limit: 10, type: "git.recent-branches" });
  f.add("other-limit", { ...recent, limit: 11 });
  f.add("linked", recent, { ...location, root: "/linked" });
  f.add("other-host", recent, { ...location, hostId: "elsewhere" });
  f.add("other-common", recent, { ...location, commonDir: "/other/.git" }); await flush();
  expect(f.runs.map(r => [r.location.hostId, r.location.commonDir, r.query])).toEqual([
    ["host", "/repo/.git", recent], ["elsewhere", "/repo/.git", recent], ["host", "/other/.git", recent],
  ]);
  f.runs[0]!.gate.resolve(result(recent)); await flush();
  expect(f.runs[3]!.query).toEqual({ ...recent, limit: 11 });
  f.runs[3]!.gate.resolve(result(f.runs[3]!.query)); await flush();
  expect(f.runs[4]!.location.root).toBe("/linked");
});

test("local invalidations coalesce100ms after the current read, suppress old generation and complete refresh waiters on new result", async () => {
  const f = fixture(); f.add("one"); await flush();
  let complete = false;
  const first = f.owner.changed(location, "head"), second = f.owner.changed(location, "local-refs").then(() => { complete = true; });
  await f.tick(100); expect(f.runs).toHaveLength(1); expect(complete).toBe(false);
  f.runs[0]!.gate.resolve(result(recent, "stale")); await flush(); expect(f.updates).toEqual([]);
  await f.tick(99); expect(f.runs).toHaveLength(1);
  await f.tick(1); expect(f.runs).toHaveLength(2);
  f.runs[1]!.gate.resolve(result(recent, "fresh")); await flush(); await first; await second;
  expect(complete).toBe(true); expect(f.updates).toHaveLength(1);
  expect(f.updates[0]).toMatchObject({ phase: "complete", result: { branches: ["fresh"] } });
});

test("only exact host/common/root and method dependencies refresh; remote refresh is immediate", async () => {
  const f = fixture(), remote = { ...location, local: false };
  f.add("base", { type: "git.base-branch" }, remote); await flush();
  f.runs[0]!.gate.resolve(result({ type: "git.base-branch" })); await flush();
  for (const at of [{ ...remote, hostId: "wrong" }, { ...remote, commonDir: "/wrong" }, { ...remote, root: "/wrong" }]) await f.owner.changed(at, "head");
  await f.owner.changed(remote, "local-refs"); expect(f.runs).toHaveLength(1);
  const change = f.owner.changed(remote, "config"); await flush(); expect(f.runs).toHaveLength(2); expect(f.timerCount).toBe(0);
  f.runs[1]!.gate.resolve(result({ type: "git.base-branch" }, "updated")); await change;
});

test("final consumer cancellation aborts shared run, queued cancelled work never starts, queue survives rejected predecessor", async () => {
  const f = fixture(); const a = f.add("a"), b = f.add("b"), queued = f.add("queued", { type: "git.base-branch" }); await flush();
  a.dispose(); expect(f.runs[0]!.signal.aborted).toBe(false);
  b.dispose(); queued.dispose(); expect(f.runs[0]!.signal.aborted).toBe(true);
  f.add("next", { type: "git.default-branch" }); await flush(); expect(f.runs).toHaveLength(1);
  f.runs[0]!.gate.reject(new Error("cancelled old command")); await flush();
  expect(f.runs.map(r => r.query.type)).toEqual(["git.recent-branches", "git.default-branch"]);
  f.runs[1]!.gate.resolve(result({ type: "git.default-branch" })); await flush();
  expect(f.updates.map(u => u.subscriptionId)).toEqual(["next"]);
});

test("retired identity cannot receive late result or cancel a new same-ID subscription", async () => {
  const f = fixture(); const old = f.add("one"); await flush(); old.dispose();
  const replacement = f.add("one"); old.dispose(); await flush(); expect(f.runs).toHaveLength(1);
  f.runs[0]!.gate.resolve(result(recent, "old")); await flush(); expect(f.updates).toEqual([]); expect(f.runs).toHaveLength(2);
  f.runs[1]!.gate.resolve(result(recent, "new")); await flush(); expect(f.updates[0]).toMatchObject({ result: { branches: ["new"] } }); replacement.dispose();
});

test("catalog loss is latched and queued invalid owner cannot reach runner after owner returns", async () => {
  const f = fixture(); let current = true;
  f.add("held"); f.add("later", { type: "git.base-branch" }, location, () => current); await flush();
  current = false; f.owner.reconcileOwners(); current = true;
  f.runs[0]!.gate.resolve(result(recent)); await flush();
  expect(f.runs).toHaveLength(1); expect(f.updates.map(u => u.subscriptionId)).toEqual(["held"]);
});

test("degraded coverage accompanies results; explicit recovery is selected and prepares each root once", async () => {
  const f = fixture(), remote = { ...location, local: false };
  f.add("a", recent, remote, () => true, true); f.add("b", recent, remote, () => true, true);
  f.add("healthy", recent, remote); await flush();
  f.runs[0]!.gate.resolve(result(recent)); await flush();
  expect(f.updates.map(u => u.requiresRecovery)).toEqual([true, true, false]);
  await f.owner.recover("wrong", ["a"]); await f.owner.recover("host", ["missing", "healthy"]); expect(f.prepared).toEqual([]);
  const recovery = f.owner.recover("host", ["a", "b", "healthy"], "/repo"); await flush();
  expect(f.prepared).toEqual([remote]); expect(f.runs).toHaveLength(2);
  f.runs[1]!.gate.resolve(result(recent, "recovered-read")); await recovery;
  expect(f.updates.slice(3).map(u => [u.subscriptionId, u.requiresRecovery])).toEqual([["a", true], ["b", true]]);
  const coverage = f.owner.setRequiresRecovery("host", "/repo", false); await flush();
  f.runs[2]!.gate.resolve(result(recent)); await coverage;
  expect(f.updates.slice(-2).map(u => u.requiresRecovery)).toEqual([false, false]);
});

test("branch errors emit once without automatic retry; explicit refresh retries and failed waiters settle", async () => {
  const f = fixture(); f.add("one"); await flush(); f.runs[0]!.gate.reject(new Error("Git timed out")); await flush();
  expect(f.updates[0]).toMatchObject({ phase: "failed", error: "Git timed out" }); await f.tick(5000); expect(f.runs).toHaveLength(1);
  const refresh = f.owner.refreshRepository("host", "/repo"); await f.tick(100); f.runs[1]!.gate.reject(new Error("Still unavailable")); await refresh;
  expect(f.updates).toHaveLength(2); expect(f.updates[1]).toMatchObject({ phase: "failed", error: "Still unavailable" });
});

test("callbacks cannot change shared result or revive work during shutdown, and pending refresh promises settle on removal", async () => {
  const f = fixture(); f.add("mutator", recent, location, () => true, false, update => {
    if (update.phase === "complete" && update.result.type === "git.recent-branches") update.result.branches.push("mutated");
  });
  const other = f.add("other"); await flush(); f.runs[0]!.gate.resolve(result(recent)); await flush();
  expect(f.updates[0]).toMatchObject({ result: { branches: ["main"] } });
  const refresh = f.owner.changed(location, "head"); other.dispose();
  await f.owner.dispose(); await refresh; await f.tick(1000); expect(f.runs).toHaveLength(1);
  expect(() => f.add("late")).toThrow("ended");
});

test("a different result method fails instead of publishing a false typed success", async () => {
  const f = fixture(); f.add("one"); await flush(); f.runs[0]!.gate.resolve(result({ type: "git.base-branch" })); await flush();
  expect(f.updates[0]).toMatchObject({ phase: "failed", error: "Branch query returned a different result method." });
});
