import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HostStore } from "../store";
import { HostWorkspaces } from "../workspace-http";
import { WorkspaceService } from "../workspace/service";
import { WorktreeEnvironmentLifecycle, type PrepareEnvironmentWorktree } from "./lifecycle";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const environment = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", cwd, ...args], { env: environment, stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
type GitOptions = { cwd?: string; env?: NodeJS.ProcessEnv; validExitCodes?: number[]; timeoutMs?: number; signal?: AbortSignal; assertCurrent?: () => void };
type GitRunner = { git(args: string[], options?: GitOptions): Promise<{ stdout: string; exitCode: number }> };

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "prepared-starting-ref-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), upstream = join(root, "upstream"), bare = join(root, "bare"), data = join(root, "data");
  for (const cwd of [source, upstream]) {
    await mkdir(cwd); git(cwd, "init", "-b", "main");
    git(cwd, "config", "user.name", "Prepared ref fixture"); git(cwd, "config", "user.email", "fixture@example.invalid");
    git(cwd, "config", "commit.gpgSign", "false"); git(cwd, "config", "core.hooksPath", join(root, "no-hooks"));
  }
  // Materialization may legitimately enable this extension. Seed it before the
  // source-byte baseline so this test can distinguish unrelated source changes.
  git(source, "config", "extensions.worktreeConfig", "true");
  await writeFile(join(source, "README.md"), "source\n"); git(source, "add", "README.md"); git(source, "commit", "-m", "source");
  git(source, "clone", "--bare", source, bare); git(source, "remote", "add", "origin", bare);
  git(upstream, "remote", "add", "origin", bare); git(upstream, "fetch", "origin"); git(upstream, "reset", "--hard", "origin/main");
  const advance = async () => {
    git(upstream, "checkout", "-B", "topic");
    await writeFile(join(upstream, "README.md"), `remote ${crypto.randomUUID()}\n`);
    git(upstream, "add", "README.md"); git(upstream, "commit", "-m", "remote update"); git(upstream, "push", "origin", "HEAD:refs/heads/topic");
    return git(upstream, "rev-parse", "HEAD");
  };
  const first = await advance(); git(source, "fetch", "origin", "+refs/heads/topic:refs/remotes/origin/topic");
  let store = new HostStore(data);
  cleanups.push(() => store.close());
  const project = store.addProject({ path: source, name: "Prepared ref" });
  let workspaces = new HostWorkspaces(store, data, () => () => {});
  let lifecycle = new WorktreeEnvironmentLifecycle(store, workspaces);
  const input: PrepareEnvironmentWorktree = { commandId: crypto.randomUUID(), projectId: project.id,
    draft: { id: "new-conversation", revision: 7 }, environment: null,
    startingState: { type: "branch", branchName: "topic", remoteRef: "refs/remotes/origin/topic" } };
  const calls: string[][] = [];
  const prototype = WorkspaceService.prototype as unknown as GitRunner;
  const original = prototype.git;
  let beforeGit: ((args: string[], options: GitOptions) => Promise<void> | void) | undefined;
  let afterGit: ((args: string[], options: GitOptions) => Promise<void> | void) | undefined;
  prototype.git = async function (args, options = {}) {
    calls.push([...args]); await beforeGit?.(args, options);
    const result = await original.call(this, args, { ...options, env: { ...environment, ...options.env } });
    await afterGit?.(args, options); return result;
  };
  cleanups.push(() => { prototype.git = original; });
  const checkpoint = async () => ({ index: await readFile(join(source, ".git/index")), head: await readFile(join(source, ".git/HEAD")),
    config: await readFile(join(source, ".git/config")), file: await readFile(join(source, "README.md")) });
  const saved = async () => {
    const directories = await workspaces.directoryContext(project.id, null);
    const name = `chat-${createHash("sha256").update(input.commandId).digest("hex")}`;
    const worktreePath = await workspaces.sessionWorktreeDestination(project.id, name, directories);
    return store.createEnvironmentPreparation({ id: input.commandId, projectId: project.id, sourceRoot: source, worktreePath,
      startingState: input.startingState, draft: input.draft, environment: null, directories });
  };
  return { root, source, upstream, data, project, input, first, calls, checkpoint, saved, advance,
    get store() { return store; }, get workspaces() { return workspaces; }, get lifecycle() { return lifecycle; },
    before(callback: typeof beforeGit) { beforeGit = callback; }, after(callback: typeof afterGit) { afterGit = callback; },
    reopen() { store.close(); store = new HostStore(data); workspaces = new HostWorkspaces(store, data, () => () => {}); lifecycle = new WorktreeEnvironmentLifecycle(store, workspaces); },
  };
}

test("durable creation refreshes saved remote intent once at its recorded destination", async () => {
  const f = await fixture(), next = await f.advance(), before = await f.checkpoint();
  const observed: string[] = [];
  f.before(args => {
    if (args[0] === "fetch" || args[0] === "worktree" && args[1] === "add") {
      const record = f.store.environmentPreparations.get(f.input.commandId)!;
      expect(record).toMatchObject({ phase: "worktree-creating", startingState: f.input.startingState, draft: f.input.draft });
      observed.push(args[0]!);
    }
  });
  const ready = await f.lifecycle.prepare(f.input);
  expect(ready).toMatchObject({ phase: "worktree-created", version: 2, startingState: f.input.startingState });
  expect(git(ready.worktreePath, "rev-parse", "HEAD")).toBe(next);
  expect(next).not.toBe(f.first);
  expect(await readFile(join(ready.worktreePath, "README.md"))).toEqual(await readFile(join(f.upstream, "README.md")));
  expect(observed).toEqual(["fetch", "worktree"]);
  const dispatched = f.calls.length;
  expect(await f.lifecycle.prepare(f.input)).toEqual(ready);
  expect(f.calls.length).toBe(dispatched);
  expect(await f.checkpoint()).toEqual(before);
  expect(f.store.listSessions()).toHaveLength(0);
});

test("validated preparation resumes after store reopen using saved identity and ref", async () => {
  const f = await fixture(), saved = await f.saved(), next = await f.advance();
  f.reopen();
  const ready = await f.lifecycle.continuePreparation(saved.id, saved.revision);
  expect(ready).toMatchObject({ id: saved.id, worktreePath: saved.worktreePath, startingState: saved.startingState, draft: saved.draft, phase: "worktree-created" });
  expect(git(ready.worktreePath, "rev-parse", "HEAD")).toBe(next);
  expect(f.calls.filter(args => args[0] === "fetch")).toHaveLength(1);
  expect(f.calls.filter(args => args[0] === "worktree" && args[1] === "add")).toHaveLength(1);
  expect(f.store.listSessions()).toHaveLength(0);
});

test("lost fetch receipt retains unknown across reobserve and store reopen without creation replay", async () => {
  const f = await fixture(), next = await f.advance(), before = await f.checkpoint();
  f.after(args => { if (args[0] === "fetch") throw new Error("lost-real-fetch-receipt"); });
  await expect(f.lifecycle.prepare(f.input)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  const unknown = f.store.environmentPreparations.get(f.input.commandId)!;
  expect(unknown).toMatchObject({ phase: "unknown", uncertainOperation: "worktree-create", startingState: f.input.startingState, draft: f.input.draft });
  expect(git(f.source, "rev-parse", "refs/remotes/origin/topic")).toBe(next);
  expect(await access(unknown.worktreePath).then(() => true, () => false)).toBe(false);
  f.after(undefined); const dispatched = f.calls.length;
  expect(await f.lifecycle.prepare(f.input)).toEqual(unknown);
  await expect(f.lifecycle.continuePreparation(unknown.id, unknown.revision)).rejects.toThrow("unknown outcome");
  f.reopen();
  expect(await f.lifecycle.prepare(f.input)).toEqual(unknown);
  await expect(f.lifecycle.continuePreparation(unknown.id, unknown.revision)).rejects.toThrow("unknown outcome");
  expect(f.calls.length).toBe(dispatched);
  expect(f.calls.filter(args => args[0] === "fetch")).toHaveLength(1);
  expect(f.calls.filter(args => args[0] === "worktree" && args[1] === "add")).toHaveLength(0);
  expect(await f.checkpoint()).toEqual(before);
});

test("bridge rejects wrong phase, stale revision, retargeted owner and cancellation before Git dispatch", async () => {
  const f = await fixture(), saved = await f.saved(); f.calls.length = 0;
  await expect(f.workspaces.createPreparedSessionWorktree(saved.id, saved.revision)).rejects.toMatchObject({ code: "PREPARATION_CHANGED" });
  const admitted = f.store.environmentPreparations.transition(saved.id, saved.revision, { type: "worktree-create.started" });
  await expect(f.workspaces.createPreparedSessionWorktree(admitted.id, saved.revision)).rejects.toMatchObject({ code: "PREPARATION_CHANGED" });
  const readProject = f.store.getProject.bind(f.store);
  f.store.getProject = id => { const p = readProject(id); return p ? { ...p, path: f.upstream } : p; };
  await expect(f.workspaces.createPreparedSessionWorktree(admitted.id, admitted.revision)).rejects.toMatchObject({ code: "PREPARATION_CHANGED" });
  f.store.getProject = readProject;
  const abort = new AbortController(); abort.abort(new Error("cancelled-admission"));
  await expect(f.workspaces.createPreparedSessionWorktree(admitted.id, admitted.revision, abort.signal)).rejects.toThrow("cancelled-admission");
  expect(f.calls).toHaveLength(0);
  expect(f.store.environmentPreparations.get(admitted.id)).toEqual(admitted);
});

test("catalog ownership loss during a resolver read prevents fetch and leaves retained uncertainty", async () => {
  const f = await fixture(), readProject = f.store.getProject.bind(f.store);
  f.after(args => { if (args[0] === "remote") f.store.getProject = id => { const p = readProject(id); return p ? { ...p, path: f.upstream } : p; }; });
  await expect(f.lifecycle.prepare(f.input)).rejects.toMatchObject({ code: "PREPARATION_CHANGED" });
  expect(f.calls.filter(args => args[0] === "fetch")).toHaveLength(0);
  expect(f.store.environmentPreparations.get(f.input.commandId)).toMatchObject({ phase: "unknown", uncertainOperation: "worktree-create" });
});

test("destination parent replacement after real fetch cannot create in the replacement directory", async () => {
  const f = await fixture(), next = await f.advance();
  f.after(async args => {
    if (args[0] !== "fetch") return;
    const record = f.store.environmentPreparations.get(f.input.commandId)!;
    const parent = dirname(record.worktreePath);
    await rename(parent, `${parent}-original`); await mkdir(parent);
  });
  await expect(f.lifecycle.prepare(f.input)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  const unknown = f.store.environmentPreparations.get(f.input.commandId)!;
  expect(unknown).toMatchObject({ phase: "unknown", uncertainOperation: "worktree-create" });
  expect(git(f.source, "rev-parse", "refs/remotes/origin/topic")).toBe(next);
  expect(f.calls.filter(args => args[0] === "worktree" && args[1] === "add")).toHaveLength(0);
  expect(await access(unknown.worktreePath).then(() => true, () => false)).toBe(false);
});

test("abort after a real fetch preserves its effects and unknown preparation without adding a worktree", async () => {
  const f = await fixture(), next = await f.advance(), abort = new AbortController();
  const lifecycle = new WorktreeEnvironmentLifecycle(f.store, f.workspaces, { signal: abort.signal });
  f.after(args => { if (args[0] === "fetch") abort.abort(new Error("cancel-after-fetch")); });
  await expect(lifecycle.prepare(f.input)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  const unknown = f.store.environmentPreparations.get(f.input.commandId)!;
  expect(unknown).toMatchObject({ phase: "unknown", startingState: f.input.startingState });
  expect(git(f.source, "rev-parse", "refs/remotes/origin/topic")).toBe(next);
  expect(f.calls.filter(args => args[0] === "worktree" && args[1] === "add")).toHaveLength(0);
  expect(await f.lifecycle.prepare(f.input)).toEqual(unknown);
  expect(f.calls.filter(args => args[0] === "fetch")).toHaveLength(1);
});

test("admitted nested working-tree snapshot still preserves source index and dirty files", async () => {
  const f = await fixture(), nested = join(f.source, "apps/demo");
  await mkdir(nested, { recursive: true }); await writeFile(join(nested, "note"), "committed\n");
  git(f.source, "add", "apps/demo/note"); git(f.source, "commit", "-m", "nested project");
  await writeFile(join(nested, "note"), "staged\n"); git(f.source, "add", "apps/demo/note");
  await writeFile(join(nested, "note"), "staged\nunstaged\n"); await writeFile(join(nested, "untracked"), "retained\n");
  const project = f.store.addProject({ path: nested }), before = await f.checkpoint();
  const beforeStatus = git(f.source, "status", "--porcelain=v1");
  const ready = await f.lifecycle.prepare({ ...f.input, projectId: project.id, startingState: { type: "working-tree" } });
  expect(ready).toMatchObject({ phase: "worktree-created", sourceRoot: nested, directories: { sourceGitRoot: f.source, workspaceRelativePath: "apps/demo" } });
  expect(git(ready.worktreePath, "show", ":apps/demo/note")).toBe("staged");
  expect(await readFile(join(ready.worktreePath, "apps/demo/note"), "utf8")).toBe("staged\nunstaged\n");
  expect(await readFile(join(ready.worktreePath, "apps/demo/untracked"), "utf8")).toBe("retained\n");
  expect(await f.checkpoint()).toEqual(before);
  expect(git(f.source, "status", "--porcelain=v1")).toBe(beforeStatus);
  expect(await readFile(join(nested, "note"), "utf8")).toBe("staged\nunstaged\n");
  expect(f.calls.filter(args => args[0] === "fetch" || args[0] === "ls-remote")).toHaveLength(0);
  expect(f.store.listSessions()).toHaveLength(0);
});
