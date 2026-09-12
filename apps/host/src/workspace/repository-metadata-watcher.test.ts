import { afterEach, expect, test } from "bun:test";
import { dirname } from "node:path";
import { RepositoryMetadataWatcher, type MetadataWatchIO } from "./repository-metadata-watcher";
import type { GitRepositoryChange, GitRepositoryWatchContext } from "./repository-watch";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = () => new Promise<void>(done => setImmediate(done));
const owned: RepositoryMetadataWatcher[] = [];
afterEach(async () => { await Promise.all(owned.splice(0).map(watcher => watcher.dispose())); });
function fixture() {
  let context: GitRepositoryWatchContext = { root: "/repo", gitDir: "/repo/.git", commonDir: "/repo/.git", headPath: "/repo/.git/HEAD", indexPath: "/repo/.git/index", headRef: "refs/heads/main" };
  let current = true, now = 0, reads = 0;
  const identities = new Map(["/repo/.git", "/repo/.git/refs", "/repo/.git/refs/heads", "/repo/.git/refs/remotes", "/repo/.git/info"].map(path => [path, `${path}:inode1`]));
  const attempts: { path: string; at: number }[] = [];
  const failedPaths = new Set<string>();
  const timers: { at: number; cancelled: boolean; callback(): void }[] = [];
  const opened: { path: string; recursive: boolean; changed(name: string | null, renamed?: boolean): void; finish(error?: Error): void; closes: number; session: Awaited<ReturnType<MetadataWatchIO["open"]>> }[] = [];
  const events: { context: Omit<GitRepositoryWatchContext, "headRef">; kind: GitRepositoryChange }[] = [], errors: (string | undefined)[] = [];
  let read = async () => context, openGate: ReturnType<typeof deferred<void>> | undefined, failedPath: string | undefined;
  let emit = async (_kind: GitRepositoryChange) => {};
  const io: MetadataWatchIO = {
    now: () => now,
    async directoryIdentity(path) { return identities.get(path) ?? null; },
    async directories(path) { return [...identities.keys()].filter(child => dirname(child) === path); },
    async open(path, recursive, changed) {
      attempts.push({ path, at: now });
      if (path === failedPath || failedPaths.has(path)) throw new Error("controlled watch startup failure");
      const closed = deferred<Error | undefined>();
      const item = { path, recursive, changed: (name: string | null, renamed = false) => changed(name, renamed), finish: closed.resolve, closes: 0,
        session: { closed: closed.promise, async dispose() { item.closes++; closed.resolve(undefined); } } };
      opened.push(item); await openGate?.promise; return item.session;
    },
    schedule(callback, delay) { const timer = { at: now + delay, cancelled: false, callback }; timers.push(timer); return () => { timer.cancelled = true; }; },
  };
  const watcher = new RepositoryMetadataWatcher({ readContext: () => { reads++; return read(); }, isCurrent: () => current,
    changed: async (context, kind) => { events.push({ context, kind }); await emit(kind); }, recoveryChanged: error => errors.push(error) }, io);
  owned.push(watcher);
  return { watcher, identities, opened, events, errors, timers, attempts, failedPaths,
    get reads() { return reads; }, set context(value: GitRepositoryWatchContext) { context = value; }, get context() { return context; },
    set current(value: boolean) { current = value; }, set read(value: () => Promise<GitRepositoryWatchContext>) { read = value; },
    set openGate(value: ReturnType<typeof deferred<void>> | undefined) { openGate = value; }, set failedPath(value: string | undefined) { failedPath = value; },
    set emit(value: (kind: GitRepositoryChange) => Promise<void>) { emit = value; },
    active(path: string) { const item = opened.findLast(item => item.path === path && item.closes === 0); if (!item) throw new Error(`No active watch: ${path}`); return item; },
    async tick(milliseconds: number) {
      const end = now + milliseconds;
      for (;;) {
        const next = timers.filter(timer => !timer.cancelled && timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at; next.cancelled = true; next.callback(); await flush();
      }
      now = end; await flush();
    },
  };
}

test("metadata targets share exact directory watches and preserve recursive ref coverage", async () => {
  const f = fixture(); await f.watcher.refresh();
  expect(f.watcher.error).toBeUndefined(); expect(f.errors).toEqual([undefined]);
  expect(f.opened.map(item => [item.path, item.recursive])).toEqual([
    ["/repo/.git", false], ["/repo/.git/refs", false], ["/repo/.git/refs/heads", true], ["/repo/.git/refs/remotes", true], ["/repo/.git/info", false],
  ]);
  await f.watcher.refresh(); expect(f.opened).toHaveLength(5); expect(f.events).toEqual([]);
  await f.watcher.dispose(); expect(f.opened.every(item => item.closes === 1)).toBe(true);
});

test("each change kind coalesces for one second while unrelated refs/locks do not publish", async () => {
  const f = fixture(); await f.watcher.refresh();
  const local = f.active("/repo/.git/refs/heads"), remote = f.active("/repo/.git/refs/remotes");
  local.changed("topic"); local.changed("topic"); local.changed("main.lock"); local.changed("../../objects/nope");
  remote.changed("origin/topic"); remote.changed("origin/topic.lock");
  await f.tick(999); expect(f.events).toEqual([]);
  await f.tick(1); expect(f.events.map(event => event.kind)).toEqual(["local-refs", "remote-refs"]);
  expect(f.events[0]!.context).toEqual({ root: "/repo", gitDir: "/repo/.git", commonDir: "/repo/.git", headPath: "/repo/.git/HEAD", indexPath: "/repo/.git/index" });
});

test("events during a held emission queue a later emission and dispose drains the current delivery", async () => {
  const f = fixture(), gate = deferred<void>(); await f.watcher.refresh(); f.emit = async () => gate.promise;
  const local = f.active("/repo/.git/refs/heads"); local.changed("topic"); await f.tick(1000);
  expect(f.events).toHaveLength(1); local.changed("other"); await f.tick(5000); expect(f.events).toHaveLength(1);
  gate.resolve(); await flush(); f.emit = async () => {}; await f.tick(999); expect(f.events).toHaveLength(1);
  await f.tick(1); expect(f.events).toHaveLength(2);
  const last = deferred<void>(); f.emit = async () => last.promise; local.changed("last"); await f.tick(1000);
  let disposed = false; const disposal = f.watcher.dispose().then(() => { disposed = true; });
  await flush(); expect(disposed).toBe(false); local.changed("too-late"); last.resolve(); await disposal;
  await f.tick(5000); expect(f.events).toHaveLength(3); expect(f.opened.every(item => item.closes === 1)).toBe(true);
});

test("missing optional metadata is covered by parents and new worktree children are observed", async () => {
  const f = fixture(); f.identities.delete("/repo/.git/refs/remotes"); await f.watcher.refresh();
  expect(f.watcher.error).toBeUndefined();
  f.identities.set("/repo/.git/refs/remotes", "new"); f.active("/repo/.git/refs").changed("remotes", true); await f.watcher.refresh();
  expect(f.active("/repo/.git/refs/remotes").recursive).toBe(true);
  f.identities.set("/repo/.git/worktrees", "trees"); f.identities.set("/repo/.git/worktrees/a", "tree-a");
  f.active("/repo/.git").changed("worktrees", true); await f.watcher.refresh();
  expect(f.active("/repo/.git/worktrees/a").recursive).toBe(false);
  const old = f.active("/repo/.git/worktrees/a"); f.identities.delete(old.path);
  f.active("/repo/.git/worktrees").changed("a", true); await f.watcher.refresh(); expect(old.closes).toBe(1);
  await f.tick(1000); f.events.length = 0; old.changed("HEAD"); await f.tick(1000); expect(f.events).toEqual([]);
});

test("same-path directory replacement retires old callback before reusing its logical target", async () => {
  const f = fixture(); await f.watcher.refresh(); const old = f.active("/repo/.git/refs/heads");
  f.identities.set(old.path, "replacement-inode"); f.active("/repo/.git/refs").changed("heads", true); await f.watcher.refresh();
  expect(old.closes).toBe(1); expect(f.active(old.path)).not.toBe(old);
  await f.tick(1000); f.events.length = 0;
  old.changed("late-retired"); await f.tick(1000); expect(f.events).toEqual([]);
  f.active(old.path).changed("new"); await f.tick(1000); expect(f.events.map(event => event.kind)).toEqual(["local-refs"]);
});

test("unexpected watch closure is visible, retries with backoff, and invalidates coverage gaps", async () => {
  const f = fixture(); await f.watcher.refresh(); const closed = f.active("/repo/.git/refs/heads");
  closed.finish(new Error("controlled watch error")); await flush(); expect(f.watcher.error).toBe("controlled watch error");
  f.failedPath = closed.path; await f.tick(999); expect(f.reads).toBe(1);
  await f.tick(1); expect(f.watcher.error).toBe("controlled watch startup failure"); expect(f.reads).toBe(2);
  f.failedPath = undefined; await f.tick(1999); expect(f.reads).toBe(2); await f.tick(1); expect(f.reads).toBe(3);
  expect(f.watcher.error).toBeUndefined(); await f.tick(1000);
  expect(new Set(f.events.map(event => event.kind))).toEqual(new Set(["config", "head", "index", "local-refs", "remote-refs", "worktree-topology"]));
});

test("a watch acquired after disposal is closed and disposal waits for acquisition", async () => {
  const f = fixture(), gate = deferred<void>(); f.openGate = gate;
  const start = f.watcher.refresh(); await flush(); expect(f.opened).toHaveLength(1);
  let disposed = false; const disposal = f.watcher.dispose().then(() => { disposed = true; }); await flush(); expect(disposed).toBe(false);
  gate.resolve(); await Promise.all([start, disposal]); expect(f.opened[0]!.closes).toBe(1);
  f.opened[0]!.changed("HEAD"); await f.tick(2000); expect(f.events).toEqual([]); expect(f.errors).toEqual([]);
});

test("observed owner loss permanently retires the watcher even if the owner predicate later returns", async () => {
  const f = fixture(); await f.watcher.refresh(); const old = f.active("/repo/.git");
  f.current = false; old.changed("HEAD"); await f.watcher.dispose(); f.current = true;
  old.changed("HEAD"); await f.watcher.refresh(); await f.tick(2000);
  expect(f.events).toEqual([]); expect(f.opened).toHaveLength(5); expect(f.opened.every(item => item.closes === 1)).toBe(true);
});

test("changed Git metadata owner cannot silently replace an established watch context", async () => {
  const f = fixture(); await f.watcher.refresh(); const original = f.context;
  f.context = { ...original, commonDir: "/foreign" }; f.identities.set("/foreign", "foreign"); await f.watcher.refresh();
  expect(f.watcher.error).toContain("identity changed"); expect(f.opened.some(item => item.path === "/foreign")).toBe(false);
  f.active("/repo/.git/refs/heads").changed("topic"); await f.tick(1000); expect(f.events).toEqual([]);
  f.context = original; await f.watcher.refresh(); await f.tick(1000); expect(f.events).toHaveLength(6);
});

test("HEAD change during a held read stays unknown until a subsequent context read", async () => {
  const f = fixture(); await f.watcher.refresh(); const gate = deferred<GitRepositoryWatchContext>(), original = f.context;
  let hold = true; f.read = () => hold ? gate.promise : Promise.resolve(f.context);
  const scan = f.watcher.refresh(); await flush();
  f.active("/repo/.git").changed("HEAD"); f.active("/repo/.git/refs/heads").changed("topic");
  await f.tick(1000); expect(f.events.map(event => event.kind)).toEqual(["head"]);
  f.context = { ...original, headRef: "refs/heads/topic" }; hold = false; gate.resolve(original); await scan;
  f.events.length = 0; f.active("/repo/.git/refs/heads").changed("main"); await f.tick(1000);
  expect(f.events.map(event => event.kind)).toEqual(["local-refs"]);
});

test("delivery rejection retains invalidation for explicit recovery instead of reporting healthy coverage", async () => {
  const f = fixture(); await f.watcher.refresh(); f.emit = async () => { throw new Error("controlled delivery error"); };
  f.active("/repo/.git/refs/heads").changed("topic"); await f.tick(1000); expect(f.watcher.error).toBe("controlled delivery error");
  f.emit = async () => {}; await f.tick(2000); expect(f.watcher.error).toBeUndefined();
  expect(f.events.filter(event => event.kind === "local-refs")).toHaveLength(2);
});

test("unnamed watch events invalidate the target scope and rescan without treating null as a path", async () => {
  const f = fixture(); await f.watcher.refresh();
  const before = f.reads; f.active("/repo/.git/refs/heads").changed(null); await f.watcher.refresh();
  expect(f.reads).toBeGreaterThan(before); await f.tick(1000);
  expect(f.events.map(event => event.kind)).toEqual(["head", "local-refs"]);
  expect(f.watcher.error).toBeUndefined();
});

test("healthy targets continue invalidating while another target reports incomplete coverage", async () => {
  const f = fixture(); f.failedPath = "/repo/.git/refs/remotes"; await f.watcher.refresh();
  expect(f.watcher.error).toBe("controlled watch startup failure");
  f.active("/repo/.git/refs/heads").changed("topic"); await f.tick(1000);
  expect(f.events.map(event => event.kind)).toEqual(["local-refs"]);
  expect(f.watcher.error).toBe("controlled watch startup failure");
});

test("directory replacement during acquisition closes the just-acquired session and exposes recovery", async () => {
  const f = fixture(), gate = deferred<void>(); f.openGate = gate;
  const starting = f.watcher.refresh(); await flush(); const acquired = f.opened[0]!;
  f.identities.set(acquired.path, "replacement"); f.openGate = undefined; gate.resolve(); await starting;
  expect(acquired.closes).toBe(1); expect(f.watcher.error).toContain("changed while its watch was acquired");
  await f.watcher.refresh(); expect(f.watcher.error).toContain("changed while its watch was acquired");
  await f.tick(1000); expect(f.watcher.error).toBeUndefined();
  expect(f.active(acquired.path)).not.toBe(acquired);
});

test("late acquisition disposal failure rejects the collective disposal instead of becoming success", async () => {
  const f = fixture(), gate = deferred<void>(); f.openGate = gate;
  const starting = f.watcher.refresh(); await flush(); const acquired = f.opened[0]!;
  const original = acquired.session.dispose;
  acquired.session.dispose = async () => { await original(); throw new Error("controlled close failure"); };
  const disposal = f.watcher.dispose(); gate.resolve(); await starting;
  await expect(disposal).rejects.toBeInstanceOf(AggregateError);
  expect(acquired.closes).toBe(1);
  // The expected rejection is the test outcome; there are no fake resources
  // remaining for the ordinary successful-disposal afterEach helper.
  owned.splice(owned.indexOf(f.watcher), 1);
});


test("target retries remain independent across staggered failures and unrelated rescans", async () => {
  const f = fixture(), local = "/repo/.git/refs/heads", remote = "/repo/.git/refs/remotes";
  await f.watcher.refresh();
  f.failedPaths.add(local); f.active(local).finish(new Error("local unavailable")); await flush();
  await f.tick(500);
  f.failedPaths.add(remote); f.active(remote).finish(new Error("remote unavailable")); await flush();
  await f.tick(500); // Local failed at 1000; its next attempt is 3000.
  await f.watcher.refresh();
  expect(f.attempts.filter(item => item.path === local).map(item => item.at)).toEqual([0, 1000]);
  expect(f.attempts.filter(item => item.path === remote).map(item => item.at)).toEqual([0]);
  await f.tick(500);
  expect(f.attempts.filter(item => item.path === remote).map(item => item.at)).toEqual([0, 1500]);
  f.failedPaths.delete(local); await f.tick(1500);
  expect(f.attempts.filter(item => item.path === local).map(item => item.at)).toEqual([0, 1000, 3000]);
  expect(f.watcher.error).toBeDefined();
  f.failedPaths.delete(remote); await f.tick(500);
  expect(f.attempts.filter(item => item.path === remote).map(item => item.at)).toEqual([0, 1500, 3500]);
  expect(f.watcher.error).toBeUndefined();
});

test("each target caps its delay and resets only after thirty seconds of healthy coverage", async () => {
  const f = fixture(), local = "/repo/.git/refs/heads";
  f.failedPaths.add(local); await f.watcher.refresh();
  await f.tick(123_000);
  expect(f.attempts.filter(item => item.path === local).map(item => item.at)).toEqual([0, 1000, 3000, 7000, 15000, 31000, 63000, 123000]);
  f.failedPaths.delete(local); await f.tick(60_000); // Recovery at 183000 does not itself reset the delay.
  await f.tick(29_999); f.active(local).finish(new Error("short-lived")); await flush();
  const before = f.attempts.length;
  await f.tick(59_999); expect(f.attempts).toHaveLength(before);
  await f.tick(1); expect(f.attempts.filter(item => item.path === local).at(-1)?.at).toBe(272999);
  await f.tick(30_000); f.active(local).finish(new Error("healthy interval")); await flush();
  const healthy = f.attempts.length;
  await f.tick(999); expect(f.attempts).toHaveLength(healthy);
  await f.tick(1); expect(f.attempts.filter(item => item.path === local).at(-1)?.at).toBe(303999);
});

test("target removal and owner disposal cancel retries and reject late timer delivery", async () => {
  const f = fixture(), child = "/repo/.git/worktrees/a";
  f.identities.set("/repo/.git/worktrees", "trees"); f.identities.set(child, "child");
  f.failedPaths.add(child); await f.watcher.refresh();
  const retiredTimer = f.timers.find(timer => !timer.cancelled)!;
  f.identities.delete(child); await f.watcher.refresh(); expect(retiredTimer.cancelled).toBe(true);
  const before = f.reads; retiredTimer.callback(); await flush(); expect(f.reads).toBe(before);
  f.failedPaths.add("/repo/.git/refs/heads"); f.active("/repo/.git/refs/heads").finish(); await flush();
  const pending = f.timers.filter(timer => !timer.cancelled);
  await f.watcher.dispose(); expect(pending.every(timer => timer.cancelled)).toBe(true);
  for (const timer of pending) timer.callback();
  await f.tick(60_000); expect(f.reads).toBe(before);
});
