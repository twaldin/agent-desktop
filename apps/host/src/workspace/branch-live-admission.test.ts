import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../store";
import { HostWorkspaces } from "../workspace-http";
import { WorkspaceService } from "./service";
import type { MetadataWatchIO } from "./repository-metadata-watcher";
import type { BranchQueryUpdate } from "./branch-live-queries";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(check: () => boolean) { for (let i = 0; i < 300 && !check(); i++) await new Promise<void>(done => setTimeout(done, 5)); if (!check()) throw new Error("Controlled branch subscription did not settle."); }
function git(cwd: string, ...args: string[]) {
  const child = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode) throw new Error(child.stderr.toString()); return child.stdout.toString().trim();
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-live-admission-"))), repo = join(root, "repo"), nested = join(repo, "nested"), data = join(root, "data");
  await mkdir(nested, { recursive: true }); git(repo, "init", "-q", "--initial-branch=main"); git(repo, "commit", "--allow-empty", "-qm", "fixture");
  let now = 0, failOpen = false, openGate: ReturnType<typeof deferred> | undefined, readGate: ReturnType<typeof deferred> | undefined;
  const gates: ReturnType<typeof deferred>[] = [], opened: { path: string; changed(name: string | null, renamed: boolean): void; closes: number; queryAbortedOnClose?: boolean }[] = [];
  const timers: { at: number; cancelled: boolean; run(): void }[] = [], reads: { cwd: string; signal?: AbortSignal }[] = [];
  const io: MetadataWatchIO = {
    now: () => now, directoryIdentity: async path => path, directories: async () => [],
    async open(path, _recursive, changed) {
      if (failOpen) throw new Error("controlled acquisition failure");
      const closed = deferred(), item = { path, changed, closes: 0, queryAbortedOnClose: undefined as boolean | undefined }; opened.push(item); await openGate?.promise;
      return { closed: closed.promise.then(() => undefined), async dispose() { item.queryAbortedOnClose = reads.at(-1)?.signal?.aborted; item.closes++; closed.resolve(); } };
    },
    schedule(run, milliseconds) { const timer = { at: now + milliseconds, cancelled: false, run }; timers.push(timer); return () => { timer.cancelled = true; }; },
  };
  const original = WorkspaceService.prototype.recentBranches;
  WorkspaceService.prototype.recentBranches = async function (limit, signal, cache) { reads.push({ cwd: this.cwd, signal }); await readGate?.promise; return original.call(this, limit, signal, cache); };
  const store = new HostStore(data), workspaces = new HostWorkspaces(store, data, () => () => {}, undefined, undefined, undefined, undefined, io);
  const project = store.addProject({ path: repo }), session = { id: "session", hostId: store.host.id, projectId: project.id, cwd: nested, title: "Fixture", status: "idle" as const, sessionFile: join(root, "unused.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false };
  store.upsertSession(session);
  cleanups.push(async () => { for (const gate of gates) gate.resolve(); await workspaces.shutdownRepositoryWatches(); await workspaces.shutdownSubmissions(); store.close(); WorkspaceService.prototype.recentBranches = original; await rm(root, { recursive: true, force: true }); });
  return { root, repo, store, project, session, workspaces, reads, opened,
    holdOpen() { const gate = deferred(); gates.push(gate); openGate = gate; return gate; },
    holdRead() { const gate = deferred(); gates.push(gate); readGate = gate; return gate; },
    set failOpen(value: boolean) { failOpen = value; },
    async tick(ms = 1000) { now += ms; for (const timer of [...timers]) if (!timer.cancelled && timer.at <= now) { timer.cancelled = true; timer.run(); } await new Promise<void>(done => setImmediate(done)); },
  };
}
const recent = { type: "git.recent-branches", limit: 10 } as const;

test("watch acquisition precedes actual branch query and cancelled setup drains without registering", async () => {
  const f = await fixture(), gate = f.holdOpen(), abort = new AbortController(), updates: BranchQueryUpdate[] = [];
  const pending = f.workspaces.subscribeBranchQuery({ projectId: f.project.id }, recent, abort.signal, u => updates.push(u), false).then(() => "ready", e => e.name);
  await until(() => f.opened.length === 1); expect(f.reads).toEqual([]); expect(updates).toEqual([]);
  abort.abort(); gate.resolve(); expect(await pending).toBe("AbortError");
  expect(f.reads).toEqual([]); expect(f.opened.every(w => w.closes === 1)).toBe(true);
});

test("real project and nested session share one read/watch then receive metadata-driven updates and independent release", async () => {
  const f = await fixture(), gate = f.holdRead(), a: BranchQueryUpdate[] = [], b: BranchQueryUpdate[] = [];
  const first = await f.workspaces.subscribeBranchQuery({ projectId: f.project.id }, recent, new AbortController().signal, u => a.push(u), false);
  const second = await f.workspaces.subscribeBranchQuery({ sessionId: f.session.id }, recent, new AbortController().signal, u => b.push(u), false);
  await until(() => f.reads.length > 0); expect(f.reads).toHaveLength(1); expect(f.opened).toHaveLength(6);
  gate.resolve(); await until(() => a.length === 1 && b.length === 1);
  expect(a[0]).toMatchObject({ phase: "complete", requiresRecovery: false, result: { branches: ["main"] } });
  expect(b[0]).toMatchObject({ phase: "complete", result: { branches: ["main"] } });
  git(f.repo, "branch", "topic"); f.opened.find(w => w.path.endsWith("/refs/heads"))!.changed("topic", false); await f.tick();
  await until(() => a.length === 2 && b.length === 2); expect(f.reads).toHaveLength(2);
  expect(a[1]).toMatchObject({ phase: "complete", result: { branches: expect.arrayContaining(["main", "topic"]) } });
  await first.dispose(); expect(f.opened.every(w => w.closes === 0)).toBe(true);
  git(f.repo, "branch", "later"); f.opened.find(w => w.path.endsWith("/refs/heads"))!.changed("later", false); await f.tick();
  await until(() => b.length === 3); expect(a).toHaveLength(2); expect(f.reads).toHaveLength(3);
  await second.dispose(); expect(f.opened.every(w => w.closes === 1)).toBe(true);
});

test("owner loss during setup cannot revive after original catalog bytes return", async () => {
  const f = await fixture(), gate = f.holdOpen(), updates: BranchQueryUpdate[] = [];
  const pending = f.workspaces.subscribeBranchQuery({ sessionId: f.session.id }, recent, new AbortController().signal, u => updates.push(u), false).then(() => "ready", e => e.name);
  await until(() => f.opened.length === 1);
  f.store.upsertSession({ ...f.session, sessionFile: join(f.root, "replacement.jsonl") });
  const reconcile = f.workspaces.reconcileRepositoryWatchOwners(); f.store.upsertSession(f.session);
  gate.resolve(); await reconcile; expect(await pending).toBe("AbortError"); expect(updates).toEqual([]); expect(f.reads).toEqual([]);
});

test("catalog loss cancels an admitted read before watch release and late read cannot publish", async () => {
  const f = await fixture(), gate = f.holdRead(), updates: BranchQueryUpdate[] = [];
  await f.workspaces.subscribeBranchQuery({ sessionId: f.session.id }, recent, new AbortController().signal, u => updates.push(u), false);
  await until(() => f.reads.length === 1); f.store.upsertSession({ ...f.session, sessionFile: join(f.root, "replacement.jsonl") });
  await f.workspaces.reconcileRepositoryWatchOwners(); f.store.upsertSession(f.session);
  expect(f.reads[0]!.signal!.aborted).toBe(true); expect(f.opened.every(w => w.closes === 1 && w.queryAbortedOnClose)).toBe(true);
  gate.resolve(); await f.workspaces.shutdownRepositoryWatches(); expect(updates).toEqual([]);
});

test("degraded acquisition is explicit and recovering watch refreshes actual query result", async () => {
  const f = await fixture(), updates: BranchQueryUpdate[] = []; f.failOpen = true;
  const lease = await f.workspaces.subscribeBranchQuery({ projectId: f.project.id }, recent, new AbortController().signal, u => updates.push(u), false);
  await until(() => updates.length === 1); expect(updates[0]).toMatchObject({ phase: "complete", requiresRecovery: true, result: { branches: ["main"] } });
  await lease.recover(); expect(updates).toHaveLength(2); expect(updates[1]).toMatchObject({ requiresRecovery: true });
  f.failOpen = false; await f.tick(); await until(() => updates.some(u => u.phase === "complete" && !u.requiresRecovery));
  expect(f.opened).toHaveLength(6); await lease.dispose(); await lease.closed; expect(lease.signal.aborted).toBe(true);
  await expect(lease.recover()).rejects.toMatchObject({ name: "AbortError" }); expect(f.opened.every(w => w.closes === 1)).toBe(true);
});

test("unsupported targets/queries fail before watch allocation; actual base/default readers retain result type", async () => {
  const f = await fixture(), updates: BranchQueryUpdate[] = [], signal = new AbortController().signal;
  await expect(f.workspaces.subscribeBranchQuery({ filePath: join(f.repo, "a") }, recent, signal, u => updates.push(u), false)).rejects.toMatchObject({ code: "INVALID_QUERY" });
  await expect(f.workspaces.subscribeBranchQuery({ projectId: "missing" }, recent, signal, u => updates.push(u), false)).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  await expect(f.workspaces.subscribeBranchQuery({ projectId: f.project.id }, { type: "git.status" }, signal, u => updates.push(u), false)).rejects.toMatchObject({ code: "INVALID_QUERY" });
  expect(f.opened).toEqual([]);
  const base = await f.workspaces.subscribeBranchQuery({ projectId: f.project.id }, { type: "git.base-branch" }, signal, u => updates.push(u), false);
  const main = await f.workspaces.subscribeBranchQuery({ projectId: f.project.id }, { type: "git.default-branch" }, signal, u => updates.push(u), false);
  await until(() => updates.length === 2);
  expect(updates).toEqual(expect.arrayContaining([expect.objectContaining({ result: { type: "git.base-branch", base: null } }), expect.objectContaining({ result: { type: "git.default-branch", branch: "main" } })]));
  await base.dispose(); await main.dispose();
});

test("shutdown waits for pending acquisition cleanup and cannot return a late lease", async () => {
  const f = await fixture(), gate = f.holdOpen(); let stopped = false;
  const pending = f.workspaces.subscribeBranchQuery({ projectId: f.project.id }, recent, new AbortController().signal, () => {}, false).then(() => "ready", e => e.name);
  await until(() => f.opened.length === 1);
  const shutdown = f.workspaces.shutdownRepositoryWatches().then(() => { stopped = true; }); await new Promise<void>(done => setImmediate(done));
  expect(stopped).toBe(false); gate.resolve(); await shutdown; expect(await pending).toBe("AbortError");
  expect(f.opened.every(w => w.closes === 1)).toBe(true); expect(f.reads).toEqual([]);
});

test("retained reader rejects same-path directory replacement instead of adopting a foreign repository", async () => {
  const f = await fixture(), updates: BranchQueryUpdate[] = [];
  await f.workspaces.subscribeBranchQuery({ projectId: f.project.id }, recent, new AbortController().signal, u => updates.push(u), false);
  await until(() => updates.length === 1);
  await rename(f.repo, join(f.root, "original-repo")); await mkdir(f.repo); git(f.repo, "init", "-q", "--initial-branch=foreign"); git(f.repo, "commit", "--allow-empty", "-qm", "foreign");
  f.opened[0]!.changed("HEAD", false); await f.tick(); await until(() => updates.some(u => u.phase === "failed"));
  expect(updates.filter(u => u.phase === "complete")).toHaveLength(1);
  expect(updates.at(-1)).toMatchObject({ phase: "failed", error: expect.stringContaining("changed identity") });
});

test("real branch reader preflight honors an already-aborted signal for recent/base/default", async () => {
  const f = await fixture(), reader = new WorkspaceService(f.repo), abort = new AbortController(); abort.abort();
  await expect(reader.recentBranches(10, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  await expect(reader.baseBranch(abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  await expect(reader.defaultBranch(abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(git(f.repo, "status", "--porcelain")).toBe("");
});

for (const stage of ["root", "metadata"] as const) test(`cancelled admission stops held ${stage} discovery before actual Git continuation`, async () => {
  const f = await fixture(), gate = deferred(), abort = new AbortController(), updates: BranchQueryUpdate[] = [];
  let entered = false, continued = false;
  const original = WorkspaceService.prototype.gitRootService;
  WorkspaceService.prototype.gitRootService = async function (signal) {
    if (stage === "root") { entered = true; await gate.promise; }
    const reader = await original.call(this, signal);
    if (stage === "root") continued = true;
    else {
      const context = reader.repositoryWatchContext;
      reader.repositoryWatchContext = async function (contextSignal) {
        entered = true; await gate.promise;
        const result = await context.call(this, contextSignal);
        continued = true;
        return result;
      };
    }
    return reader;
  };
  cleanups.push(async () => { gate.resolve(); WorkspaceService.prototype.gitRootService = original; });
  const pending = f.workspaces.subscribeBranchQuery({ projectId: f.project.id }, recent, abort.signal, u => updates.push(u), false).then(() => "ready", e => e.name);
  await until(() => entered); expect(f.opened).toHaveLength(6);
  abort.abort(); gate.resolve();
  expect(await pending).toBe("AbortError");
  expect(continued).toBe(false);
  expect(f.reads).toEqual([]); expect(updates).toEqual([]);
  expect(f.opened.every(w => w.closes === 1)).toBe(true);
});

test("same-root joiner is checked against captured shared watch paths before query admission", async () => {
  const f = await fixture(), updates: BranchQueryUpdate[] = [];
  const first = await f.workspaces.retainRepositoryWatch({ projectId: f.project.id }, new AbortController().signal);
  expect(f.opened).toHaveLength(6);
  const moved = join(f.root, "moved-git");
  await rename(join(f.repo, ".git"), moved); await writeFile(join(f.repo, ".git"), `gitdir: ${moved}\n`);
  const joined = await f.workspaces.subscribeBranchQuery({ sessionId: f.session.id }, recent, new AbortController().signal, u => updates.push(u), false)
    .then(lease => ({ kind: "ready" as const, lease }), error => ({ kind: "failed" as const, code: error.code }));
  // Drain a buggy admitted lease before asserting, so the old result is a real
  // admission mismatch, not a hanging fixture or cleanup failure.
  if (joined.kind === "ready") await joined.lease.dispose();
  expect(joined).toMatchObject({ kind: "failed", code: "WORKSPACE_CHANGED" });
  expect(f.reads).toEqual([]); expect(updates).toEqual([]);
  expect(f.opened).toHaveLength(6); expect(f.opened.every(w => w.closes === 0)).toBe(true);
  await first.dispose(); expect(f.opened.every(w => w.closes === 1)).toBe(true);
  const fresh = await f.workspaces.subscribeBranchQuery({ sessionId: f.session.id }, recent, new AbortController().signal, u => updates.push(u), false);
  await until(() => updates.length === 1);
  expect(updates[0]).toMatchObject({ phase: "complete", result: { branches: ["main"] } });
  expect(f.opened.slice(6).some(w => w.path === moved)).toBe(true);
  await fresh.dispose();
});
