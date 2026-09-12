import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryWatchSubscriptions } from "./repository-watch-subscriptions";
import type { MetadataWatchIO } from "./repository-metadata-watcher";
import type { GitRepositoryWatchContext } from "./repository-watch";
import { HostStore } from "../store";
import { HostWorkspaces } from "../workspace-http";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const flush = () => new Promise<void>(done => setImmediate(done));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function context(root = "/repo"): GitRepositoryWatchContext {
  return { root, gitDir: `${root}/.git`, commonDir: `${root}/.git`, headPath: `${root}/.git/HEAD`, indexPath: `${root}/.git/index`, headRef: "refs/heads/main" };
}
function fakeIO() {
  let now = 0, openGate: Promise<void> | undefined, closeGate: Promise<void> | undefined, failClose = false, failOpen = false;
  const timers: { callback(): void; at: number; cancelled: boolean }[] = [];
  const opened: { path: string; changed(name: string | null, renamed: boolean): void; closes: number }[] = [];
  const io: MetadataWatchIO = {
    now: () => now, directoryIdentity: async path => path, directories: async () => [],
    async open(path, _recursive, changed) {
      if (failOpen) throw new Error("controlled open failure");
      const closed = deferred<Error | undefined>(), item = { path, changed, closes: 0 }; opened.push(item);
      await openGate;
      return { closed: closed.promise, async dispose() { item.closes++; await closeGate; closed.resolve(undefined); if (failClose) throw new Error("controlled close failure"); } };
    },
    schedule(callback, milliseconds) { const timer = { callback, at: now + milliseconds, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
  };
  return { io, opened, set openGate(value: Promise<void> | undefined) { openGate = value; }, set closeGate(value: Promise<void> | undefined) { closeGate = value; }, set failClose(value: boolean) { failClose = value; }, set failOpen(value: boolean) { failOpen = value; },
    async tick(milliseconds = 1000) {
      const end = now + milliseconds;
      for (;;) { const timer = timers.filter(timer => !timer.cancelled && timer.at <= end).sort((a, b) => a.at - b.at)[0]; if (!timer) break;
        now = timer.at; timer.cancelled = true; timer.callback(); await flush(); }
      now = end; await flush();
    },
  };
}
function fixture() {
  const io = fakeIO(), versions = new Map<string, number>(), events: string[] = [], kinds: string[] = [];
  let read = async (_id: string) => context(), deliveries: Promise<void> | undefined;
  const registry = new RepositoryWatchSubscriptions({
    resolve: target => {
      const id = "projectId" in target ? target.projectId : target.sessionId, admitted = versions.get(id);
      return { isCurrent: () => versions.get(id) === admitted, readContext: () => read(id) };
    },
    changed: async (target, kind) => { events.push("projectId" in target ? target.projectId : target.sessionId); kinds.push(kind); await deliveries; },
    recoveryChanged: () => {},
  }, io.io);
  cleanups.push(() => registry.dispose());
  return { registry, io, versions, events, kinds, set read(value: (id: string) => Promise<GitRepositoryWatchContext>) { read = value; }, set deliveries(value: Promise<void> | undefined) { deliveries = value; } };
}

test("concurrent catalog subscribers share one watch, deduplicate target delivery, and release independently", async () => {
  const f = fixture(), a = new AbortController(), b = new AbortController(), duplicate = new AbortController();
  const leases = await Promise.all([f.registry.retain({ projectId: "a" }, a.signal), f.registry.retain({ sessionId: "b" }, b.signal), f.registry.retain({ projectId: "a" }, duplicate.signal)]);
  expect(f.io.opened).toHaveLength(6);
  f.io.opened[0]!.changed("HEAD", false); await f.io.tick(); expect(f.events.sort()).toEqual(["a", "b"]);
  a.abort(); await leases[0]!.dispose(); expect(f.io.opened.every(item => item.closes === 0)).toBe(true);
  await leases[2]!.dispose(); expect(f.io.opened.every(item => item.closes === 0)).toBe(true);
  await leases[1]!.dispose(); expect(f.io.opened.every(item => item.closes === 1)).toBe(true);
});

test("linked roots sharing common metadata retain distinct HEAD/index resources", async () => {
  const f = fixture(); f.read = async id => id === "a" ? context() : { ...context("/linked"), commonDir: "/repo/.git", gitDir: "/repo/.git/worktrees/linked", headPath: "/repo/.git/worktrees/linked/HEAD", indexPath: "/repo/.git/worktrees/linked/index" };
  await f.registry.retain({ projectId: "a" }, new AbortController().signal);
  await f.registry.retain({ projectId: "b" }, new AbortController().signal);
  expect(f.io.opened.filter(item => item.path === "/repo/.git")).toHaveLength(2);
  f.io.opened.find(item => item.path === "/repo/.git/worktrees/linked")!.changed("HEAD", false);
  await f.io.tick(); expect(f.events).toEqual(["b", "b"]); expect(f.kinds).toEqual(["head", "worktree-topology"]);
});

test("same root shares its first metadata paths until final release, even after the creator leaves", async () => {
  const f = fixture(), moved = { ...context(), gitDir: "/metadata", commonDir: "/metadata", headPath: "/metadata/HEAD", indexPath: "/metadata/index" };
  f.read = async id => id === "a" ? context() : moved;
  const a = await f.registry.retain({ projectId: "a" }, new AbortController().signal);
  const b = await f.registry.retain({ projectId: "b" }, new AbortController().signal);
  expect(f.io.opened.map(item => item.path)).toEqual(["/repo/.git", "/repo/.git/refs", "/repo/.git/refs/heads", "/repo/.git/refs/remotes", "/repo/.git/info", "/repo/.git/worktrees"]);
  await a.dispose();
  f.io.opened[0]!.changed("HEAD", false); await f.io.tick();
  expect(b.error).toBeUndefined(); expect(f.events).toEqual(["b"]);
  f.events.length = f.kinds.length = 0;
  f.io.opened.find(item => item.path === "/repo/.git/refs/heads")!.changed("any-branch", false); await f.io.tick();
  expect(f.kinds).toEqual(["head"]); expect(f.events).toEqual(["b"]);
  expect(f.io.opened).toHaveLength(6);
  await b.dispose(); expect(f.io.opened.every(item => item.closes === 1)).toBe(true);
  await f.registry.retain({ projectId: "b" }, new AbortController().signal);
  expect(f.io.opened.slice(6).map(item => item.path)).toEqual(["/metadata", "/metadata/refs", "/metadata/refs/heads", "/metadata/refs/remotes", "/metadata/info", "/metadata/worktrees"]);
});

test("root sharing keeps refreshed HEAD classification when the current reader matches admitted paths", async () => {
  const f = fixture(); let headRef = "refs/heads/main";
  f.read = async () => ({ ...context(), headRef });
  const a = await f.registry.retain({ projectId: "a" }, new AbortController().signal);
  await f.registry.retain({ sessionId: "b" }, new AbortController().signal); await a.dispose();
  headRef = "refs/heads/topic";
  f.io.opened[0]!.changed("HEAD", false); await f.io.tick(); f.events.length = f.kinds.length = 0;
  const heads = f.io.opened.find(item => item.path === "/repo/.git/refs/heads")!;
  heads.changed("topic", false); await f.io.tick(); expect(f.kinds).toEqual(["head"]);
  f.kinds.length = 0; heads.changed("main", false); await f.io.tick(); expect(f.kinds).toEqual(["local-refs"]);
  expect(f.io.opened).toHaveLength(6);
});

test("same-root replacement waits for disposal then rediscovers metadata, excluding retired callbacks", async () => {
  const f = fixture(), gate = deferred<void>();
  const a = await f.registry.retain({ projectId: "a" }, new AbortController().signal);
  f.io.closeGate = gate.promise; const closing = a.dispose();
  f.read = async () => ({ ...context(), commonDir: "/replacement", gitDir: "/replacement", headPath: "/replacement/HEAD", indexPath: "/replacement/index" });
  let ready = false; const next = f.registry.retain({ projectId: "b" }, new AbortController().signal).then(lease => { ready = true; return lease; });
  await flush(); const whileClosing = { ready, opened: f.io.opened.length };
  gate.resolve(); await closing; await next;
  expect(whileClosing).toEqual({ ready: false, opened: 6 });
  expect(f.io.opened.slice(6).every(item => item.path.startsWith("/replacement"))).toBe(true);
  f.io.opened[0]!.changed("HEAD", false); await f.io.tick(); expect(f.events).toEqual([]);
  f.io.opened[6]!.changed("HEAD", false); await f.io.tick(); expect(f.events).toEqual(["b"]);
});

test("aborted discovery creates no watch and cannot revive when discovery finishes", async () => {
  const f = fixture(), gate = deferred<GitRepositoryWatchContext>(), abort = new AbortController(); f.read = () => gate.promise;
  const pending = f.registry.retain({ projectId: "a" }, abort.signal).then(() => "ready", error => error.name);
  await flush(); abort.abort(); gate.resolve(context()); expect(await pending).toBe("AbortError"); expect(f.io.opened).toEqual([]);
});

test("replacement subscriber reuses a starting resource before final release completes", async () => {
  const f = fixture(), gate = deferred<void>(), abort = new AbortController(); f.io.openGate = gate.promise;
  const old = f.registry.retain({ projectId: "a" }, abort.signal).then(() => "ready", error => error.name);
  await flush(); expect(f.io.opened).toHaveLength(1); abort.abort();
  let ready = false; const next = f.registry.retain({ projectId: "b" }, new AbortController().signal).then(lease => { ready = true; return lease; });
  await flush(); expect(ready).toBe(false); expect(f.io.opened).toHaveLength(1);
  f.io.openGate = undefined; gate.resolve(); expect(await old).toBe("AbortError"); await next;
  expect(f.io.opened).toHaveLength(6); expect(f.io.opened.every(item => item.closes === 0)).toBe(true);
  f.io.opened[0]!.changed("HEAD", false); await f.io.tick(); expect(f.events).toEqual(["b"]);
});

test("observed catalog loss retires only that subscriber even if its original tuple returns", async () => {
  const f = fixture();
  const a = await f.registry.retain({ projectId: "a" }, new AbortController().signal);
  await f.registry.retain({ projectId: "b" }, new AbortController().signal);
  f.versions.set("a", 1); await f.registry.reconcileOwners(); f.versions.delete("a");
  f.io.opened[0]!.changed("HEAD", false); await f.io.tick(); expect(f.events).toEqual(["b"]); expect(a.error).toContain("ended");
  expect(f.io.opened.every(item => item.closes === 0)).toBe(true);
});

test("last release drains outstanding event delivery and shutdown refuses new subscriptions", async () => {
  const f = fixture(), gate = deferred<void>(); f.deliveries = gate.promise;
  const lease = await f.registry.retain({ projectId: "a" }, new AbortController().signal);
  f.io.opened[0]!.changed("HEAD", false); await f.io.tick(); expect(f.events).toEqual(["a"]);
  let done = false; const closing = lease.dispose().then(() => { done = true; }); await flush(); expect(done).toBe(false);
  gate.resolve(); await closing; await f.registry.dispose();
  await expect(f.registry.retain({ projectId: "b" }, new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("failed disposal stays reported but a fresh subscription can recover after it settles", async () => {
  const f = fixture(), lease = await f.registry.retain({ projectId: "a" }, new AbortController().signal), gate = deferred<void>();
  f.io.failClose = true; f.io.closeGate = gate.promise;
  const release = lease.dispose().then(() => "ok", error => error.name);
  let ready = false; const next = f.registry.retain({ projectId: "b" }, new AbortController().signal).then(lease => { ready = true; return lease; });
  await flush(); expect(ready).toBe(false); expect(f.io.opened).toHaveLength(6);
  gate.resolve(); expect(await release).toBe("AggregateError"); await next;
  expect(f.io.opened).toHaveLength(12); expect(f.io.opened.slice(0, 6).every(item => item.closes === 1)).toBe(true);
  f.io.opened[0]!.changed("HEAD", false); await f.io.tick(); expect(f.events).toEqual([]);
  f.io.failClose = false; f.io.closeGate = undefined;
  await expect(f.registry.dispose()).rejects.toBeInstanceOf(AggregateError);
  cleanups.pop(); // Historical disposal error was asserted; all current fake sessions also closed.
});

test("settled startup exposes degraded coverage and later reports recovered coverage", async () => {
  const f = fixture(); f.io.failOpen = true;
  const lease = await f.registry.retain({ projectId: "a" }, new AbortController().signal);
  expect(lease.error).toBe("controlled open failure"); expect(f.io.opened).toEqual([]);
  f.io.failOpen = false; await f.io.tick(); expect(lease.error).toBeUndefined(); expect(f.io.opened).toHaveLength(6);
});

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(result.stderr.toString());
}
test("HostWorkspaces binds actual catalog ownership before discovery and after session retarget", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "watch-subscriptions-"))), repo = join(root, "repo"), nested = join(repo, "nested"), data = join(root, "data");
  await mkdir(nested, { recursive: true }); git(repo, "init", "-q", "--initial-branch=main");
  const store = new HostStore(data), io = fakeIO(), targets: unknown[] = [], deliveredKinds: unknown[] = [];
  const workspaces = new HostWorkspaces(store, data, () => () => {}, undefined, undefined, undefined, { changed: (target, kind) => { targets.push(target); deliveredKinds.push(kind); }, generate: async () => { throw new Error("No generation permitted"); } }, io.io);
  cleanups.push(async () => { await workspaces.shutdownRepositoryWatches(); await workspaces.shutdownSubmissions(); store.close(); await rm(root, { recursive: true, force: true }); });
  const project = store.addProject({ path: repo });
  const session = { id: "session-a", hostId: store.host.id, projectId: project.id, cwd: nested, title: "Watch fixture", status: "idle" as const, sessionFile: join(root, "unused.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false };
  store.upsertSession(session);
  await expect(workspaces.retainRepositoryWatch({ projectId: "missing" }, new AbortController().signal)).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  expect(() => workspaces.retainRepositoryWatch({ filePath: join(repo, "a.txt") }, new AbortController().signal)).toThrow("catalogued");
  const projectLease = await workspaces.retainRepositoryWatch({ projectId: project.id }, new AbortController().signal);
  const sessionLease = await workspaces.retainRepositoryWatch({ sessionId: session.id }, new AbortController().signal);
  expect(io.opened).toHaveLength(6); targets.length = deliveredKinds.length = 0;
  io.opened[0]!.changed("HEAD", false); await io.tick(); expect(targets).toContainEqual({ projectId: project.id }); expect(targets).toContainEqual({ sessionId: session.id }); expect(deliveredKinds).toEqual(["head", "head"]);
  targets.length = 0; store.upsertSession({ ...session, sessionFile: join(root, "replacement.jsonl") });
  await workspaces.reconcileRepositoryWatchOwners(); store.upsertSession(session);
  io.opened[0]!.changed("HEAD", false); await io.tick(); expect(targets).toEqual([{ projectId: project.id }]); expect(sessionLease.error).toContain("ended");
  await projectLease.dispose(); expect(io.opened.every(item => item.closes === 1)).toBe(true);
});


test("shutdown waits for pending discovery without allowing late watch creation", async () => {
  const f = fixture(), gate = deferred<GitRepositoryWatchContext>(); f.read = () => gate.promise;
  const pending = f.registry.retain({ projectId: "a" }, new AbortController().signal).then(() => "ready", error => error.name);
  await flush(); let disposed = false; const stopping = f.registry.dispose().then(() => { disposed = true; });
  await flush(); expect(disposed).toBe(false); expect(f.io.opened).toEqual([]);
  gate.resolve(context()); await stopping; expect(await pending).toBe("AbortError"); expect(f.io.opened).toEqual([]);
});

test("catalog loss during held acquisition denies readiness and drains the late resource", async () => {
  const f = fixture(), gate = deferred<void>(); f.io.openGate = gate.promise;
  const pending = f.registry.retain({ projectId: "a" }, new AbortController().signal).then(() => "ready", error => error.name);
  await flush(); expect(f.io.opened).toHaveLength(1);
  f.versions.set("a", 1); const reconcile = f.registry.reconcileOwners(); f.versions.delete("a");
  gate.resolve(); await reconcile; expect(await pending).toBe("AbortError");
  expect(f.io.opened).toHaveLength(1); expect(f.io.opened[0]!.closes).toBe(1);
  f.io.opened[0]!.changed("HEAD", false); await f.io.tick(); expect(f.events).toEqual([]);
});


test("one host serializes different repository setups and skips an abandoned queued entry", async () => {
  const f = fixture(), gate = deferred<void>(); f.io.openGate = gate.promise; f.read = async id => context(`/${id}`);
  const first = f.registry.retain({ projectId: "a" }, new AbortController().signal);
  await flush(); expect(f.io.opened.map(item => item.path)).toEqual(["/a/.git"]);
  const abort = new AbortController(); const abandoned = f.registry.retain({ projectId: "b" }, abort.signal).then(() => "ready", error => error.name);
  const third = f.registry.retain({ projectId: "c" }, new AbortController().signal);
  await flush(); const whileHeld = f.io.opened.map(item => item.path); abort.abort();
  f.io.openGate = undefined; gate.resolve(); await Promise.all([first, third]); expect(await abandoned).toBe("AbortError");
  expect(whileHeld).toEqual(["/a/.git"]);
  expect(f.io.opened.map(item => item.path)).toEqual([
    "/a/.git", "/a/.git/refs", "/a/.git/refs/heads", "/a/.git/refs/remotes", "/a/.git/info", "/a/.git/worktrees",
    "/c/.git", "/c/.git/refs", "/c/.git/refs/heads", "/c/.git/refs/remotes", "/c/.git/info", "/c/.git/worktrees",
  ]);
});

test("final normal abort finishes admitted setup then disposes when nobody rejoins", async () => {
  const f = fixture(), gate = deferred<void>(), abort = new AbortController(); f.io.openGate = gate.promise;
  const pending = f.registry.retain({ projectId: "a" }, abort.signal).then(() => "ready", error => error.name);
  await flush(); abort.abort(); f.io.openGate = undefined; gate.resolve(); expect(await pending).toBe("AbortError");
  expect(f.io.opened).toHaveLength(6); expect(f.io.opened.every(item => item.closes === 1)).toBe(true);
  await f.io.tick(); expect(f.events).toEqual([]);
});

test("catalog loss during a zero-subscriber starting interval retires it across loss-return", async () => {
  const f = fixture(), gate = deferred<void>(), abort = new AbortController(); f.io.openGate = gate.promise;
  const first = f.registry.retain({ projectId: "a" }, abort.signal).then(() => "ready", error => error.name);
  await flush(); abort.abort(); f.versions.set("a", 1);
  const retired = f.registry.reconcileOwners(); f.versions.delete("a");
  const replacement = f.registry.retain({ projectId: "b" }, new AbortController().signal);
  await flush(); expect(f.io.opened).toHaveLength(1);
  f.io.openGate = undefined; gate.resolve(); await retired; expect(await first).toBe("AbortError"); await replacement;
  expect(f.io.opened).toHaveLength(7); expect(f.io.opened[0]!.closes).toBe(1);
  f.io.opened[0]!.changed("HEAD", false); await f.io.tick(); expect(f.events).toEqual([]);
});


test("one host's setup queue cannot block another host registry", async () => {
  const first = fixture(), second = fixture(), gate = deferred<void>(); first.io.openGate = gate.promise;
  const pending = first.registry.retain({ projectId: "a" }, new AbortController().signal);
  await flush(); expect(first.io.opened).toHaveLength(1);
  await second.registry.retain({ projectId: "a" }, new AbortController().signal); expect(second.io.opened).toHaveLength(6);
  first.io.openGate = undefined; gate.resolve(); await pending;
});

test("failed abandoned setup disposal does not poison the next repository setup", async () => {
  const f = fixture(), gate = deferred<void>(), abort = new AbortController(); f.read = async id => context(`/${id}`); f.io.openGate = gate.promise;
  const first = f.registry.retain({ projectId: "a" }, abort.signal).then(() => "ready", error => error.name);
  await flush(); abort.abort(); f.io.failClose = true;
  const next = f.registry.retain({ projectId: "b" }, new AbortController().signal);
  await flush(); expect(f.io.opened).toHaveLength(1);
  f.io.openGate = undefined; gate.resolve(); expect(await first).toBe("AggregateError"); await next;
  expect(f.io.opened.filter(item => item.path.startsWith("/a/")).every(item => item.closes === 1)).toBe(true);
  expect(f.io.opened.filter(item => item.path.startsWith("/b/"))).toHaveLength(6);
  f.io.failClose = false; await expect(f.registry.dispose()).rejects.toBeInstanceOf(AggregateError); cleanups.pop();
});
