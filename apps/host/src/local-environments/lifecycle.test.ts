import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../store";
import { HostWorkspaces } from "../workspace-http";
import { LocalEnvironmentStore } from "./index";
import { serializeLocalEnvironment } from "@agent-desktop/shared";
import { WorktreeEnvironmentLifecycle, type PrepareEnvironmentWorktree } from "./lifecycle";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(setup: string, cleanup: string, namespace = ".agent-desktop") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-environment-lifecycle-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), data = join(root, "data");
  await mkdir(source);
  const git = (...args: string[]) => exec("git", ["--no-optional-locks", "-C", source, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.name", "Environment fixture"); await git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(source, "README.md"), "source content\n");
  await git("add", "README.md"); await git("commit", "-m", "Initial fixture");
  const store = new HostStore(data); cleanups.push(() => store.close());
  const project = store.addProject({ path: source, name: "Environment fixture" });
  const configStore = new LocalEnvironmentStore(source);
  const saved = await configStore.save({ configPath: join(source, namespace, "environments", "environment.toml"), expectedRevision: null, raw: serializeLocalEnvironment({ version: 1, name: "Fixture", setup: { script: setup }, cleanup: { script: cleanup } }) });
  if (saved.type !== "saved") throw new Error("Fixture config save failed");
  const workspaces = new HostWorkspaces(store, data, () => () => {});
  const lifecycle = new WorktreeEnvironmentLifecycle(store, workspaces, { timeoutMs: 5_000 });
  const input: PrepareEnvironmentWorktree = { commandId: crypto.randomUUID(), projectId: project.id, draft: { id: "new-conversation", revision: 0 },
    startingState: { type: "branch", branchName: "main" }, environment: { configPath: saved.configPath, revision: saved.revision } };
  const before = { index: await readFile(join(source, ".git", "index")), head: (await git("rev-parse", "HEAD")).stdout, status: (await git("status", "--porcelain=v1", "--untracked-files=all")).stdout };
  return { root, source, data, store, project, configStore, saved, workspaces, lifecycle, input, git, before };
}

for (const namespace of [".agent-desktop", ".codex"]) test(`${namespace}: actual setup is revision-pinned, runs once, captures private exports and cleanup precedes removal`, async () => {
  const f = await fixture('printf "setup\\n" >> setup-count\nexport ENVIRONMENT_FIXTURE_VALUE=private-value', 'rm setup-count', namespace);
  const ready = await f.lifecycle.prepare(f.input);
  expect(ready.phase).toBe("setup-succeeded");
  expect(f.store.environmentPreparations.getOutput(ready.id)).toMatchObject({ lifecycle: "setup", finished: true });
  expect(await readFile(join(ready.worktreePath, "setup-count"), "utf8")).toBe("setup\n");
  expect(ready.environmentDelta?.set.ENVIRONMENT_FIXTURE_VALUE).toBe("private-value");
  expect(await f.lifecycle.prepare(f.input)).toEqual(ready);
  expect(await readFile(join(ready.worktreePath, "setup-count"), "utf8")).toBe("setup\n");
  expect(JSON.stringify(f.store.environmentPreparations.public(ready))).not.toContain("private-value");
  // A later source configuration edit must not replace the captured cleanup.
  await f.configStore.save({ configPath: f.saved.configPath, expectedRevision: f.saved.revision, raw: serializeLocalEnvironment({ version: 1, name: "Changed", setup: { script: "exit 9" }, cleanup: { script: "exit 7" } }) });
  const cleaned = await f.lifecycle.cleanup(ready.id, ready.revision);
  expect(cleaned.phase).toBe("cleanup-succeeded");
  expect(f.store.environmentPreparations.getOutput(cleaned.id)).toMatchObject({ lifecycle: "cleanup", finished: true });
  expect(await access(join(ready.worktreePath, "setup-count")).then(() => true, () => false)).toBe(false);
  expect(await f.lifecycle.cleanup(cleaned.id, cleaned.revision)).toEqual(cleaned);
  const listing = await f.workspaces.query({ projectId: f.project.id }, { type: "git.worktrees" });
  if (listing.type !== "git.worktrees") throw new Error("Missing registered worktrees");
  const relativePath = listing.worktrees.find(tree => tree.path === ready.worktreePath)?.managedRelativePath;
  if (!relativePath) throw new Error("Missing managed removal path");
  // Explicit removal preserves the copied configuration in a durable Git ref.
  await f.workspaces.mutate({ projectId: f.project.id }, { type: "worktree.remove", path: relativePath });
  const snapshotRef = `refs/agent-desktop/snapshots/${createHash('sha1').update(ready.worktreePath).digest('hex')}`;
  expect((await f.git("show", `${snapshotRef}:${namespace}/environments/environment.toml`)).stdout).toBe(ready.environment!.raw);
  f.store.environmentPreparations.transition(cleaned.id, cleaned.revision, { type: "removed" });
  expect(await access(ready.worktreePath).then(() => true, () => false)).toBe(false);
  expect(await readFile(join(f.source, ".git", "index"))).toEqual(f.before.index);
  expect((await f.git("rev-parse", "HEAD")).stdout).toBe(f.before.head);
  expect(await readFile(join(f.source, "README.md"), "utf8")).toBe("source content\n");
  expect(f.store.listSessions()).toHaveLength(0);
}, 30_000);

test("failed setup preserves one worktree and requires an explicit current-revision retry", async () => {
  const f = await fixture('printf "attempt\\n" >> setup-count\n[ -f allow-setup ]', 'exit 8');
  const failed = await f.lifecycle.prepare(f.input);
  expect(failed.phase).toBe("setup-failed");
  expect(failed.setupResult?.exitCode).toBe(1);
  expect(f.store.listSessions()).toHaveLength(0);
  expect(await f.lifecycle.prepare(f.input)).toEqual(failed);
  expect(await readFile(join(failed.worktreePath, "setup-count"), "utf8")).toBe("attempt\n");
  await expect(f.lifecycle.retrySetup(failed.id, failed.revision - 1)).rejects.toThrow("current failed setup");
  await writeFile(join(failed.worktreePath, "allow-setup"), "");
  const retried = await f.lifecycle.retrySetup(failed.id, failed.revision);
  expect(retried.phase).toBe("setup-succeeded");
  expect(retried.worktreePath).toBe(failed.worktreePath);
  expect(await readFile(join(failed.worktreePath, "setup-count"), "utf8")).toBe("attempt\nattempt\n");
  const cleanup = await f.lifecycle.cleanup(retried.id, retried.revision);
  expect(cleanup.phase).toBe("cleanup-failed");
  expect(cleanup.cleanupResult?.exitCode).toBe(8);
  expect(await access(failed.worktreePath).then(() => true, () => false)).toBe(true);
  expect((await f.workspaces.query({ projectId: f.project.id }, { type: "git.worktrees" }))).toMatchObject({ worktrees: expect.arrayContaining([expect.objectContaining({ path: failed.worktreePath })]) });
}, 30_000);

test("stale configuration is rejected before even a managed directory or preparation exists", async () => {
  const f = await fixture("touch must-not-exist", "");
  await f.configStore.save({ configPath: f.saved.configPath, expectedRevision: f.saved.revision, raw: serializeLocalEnvironment({ version: 1, name: "Changed", setup: { script: "exit 0" } }) });
  await expect(f.lifecycle.prepare(f.input)).rejects.toThrow("environment changed");
  expect(f.store.environmentPreparations.list()).toHaveLength(0);
  expect(await access(join(f.data, "worktrees")).then(() => true, () => false)).toBe(false);
  expect(await readFile(join(f.source, ".git", "index"))).toEqual(f.before.index);
}, 30_000);

test("a starting branch without the nested project retains the checkout without running setup or falling back to its root", async () => {
  const f = await fixture("touch must-not-exist", "");
  const nested = join(f.source, "nested"); await mkdir(nested);
  const project = f.store.addProject({ path: nested });
  const inherited = await new LocalEnvironmentStore(nested).read(f.saved.configPath);
  expect(inherited.configPath).toBe(f.saved.configPath);
  await expect(f.lifecycle.prepare({ ...f.input, projectId: project.id })).rejects.toThrow("captured worktree directory is missing");
  const [retained] = f.store.environmentPreparations.list();
  expect(retained).toMatchObject({ phase: "unknown", uncertainOperation: "worktree-create" });
  expect(await access(join(retained!.worktreePath, "must-not-exist")).then(() => true, () => false)).toBe(false);
  expect(await access(join(nested, "must-not-exist")).then(() => true, () => false)).toBe(false);
  expect(await readFile(join(f.source, ".git", "index"))).toEqual(f.before.index);
}, 30_000);

for (const selectNested of [false, true]) test(`nested workspace inherits root setup and reparses ${selectNested ? "newly selected nested" : "materialized root"} cleanup`, async () => {
  const f = await fixture('printf "%s\\n" "$PWD" "$CODEX_SOURCE_TREE_PATH" "$CODEX_WORKTREE_PATH" > setup-paths', 'exit 8');
  const nested = join(f.source, "apps/web"); await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "README.md"), "nested content\n");
  await f.git("add", "apps/web/README.md"); await f.git("commit", "-m", "Nested project fixture");
  const index = await readFile(join(f.source, ".git/index")), head = (await f.git("rev-parse", "HEAD")).stdout;
  const project = f.store.addProject({ path: nested });
  const ready = await f.lifecycle.prepare({ ...f.input, projectId: project.id });
  const workspace = join(ready.worktreePath, "apps/web");
  expect(ready).toMatchObject({ version: 2, phase: "setup-succeeded", sourceRoot: nested,
    directories: { sourceGitRoot: f.source, workspaceRelativePath: "apps/web", configCwdRelativePath: "" } });
  expect((await readFile(join(ready.worktreePath, "setup-paths"), "utf8")).trim().split("\n")).toEqual([ready.worktreePath, nested, workspace]);
  expect(ready.environment?.configPath).toBe(join(ready.worktreePath, ".agent-desktop/environments/environment.toml"));
  expect(ready.selectedEnvironment?.configPath).toBe(f.saved.configPath);
  expect(await readFile(ready.environment!.configPath, "utf8")).toBe((await f.configStore.read(f.saved.configPath)).raw);
  const managedConfig = new LocalEnvironmentStore(workspace);
  const cleanupPath = selectNested ? join(workspace, ".agent-desktop/environments/cleanup.toml") : ready.environment!.configPath;
  const saved = await managedConfig.save({ configPath: cleanupPath, expectedRevision: selectNested ? null : ready.environment!.revision,
    raw: serializeLocalEnvironment({ version: 1, name: "Managed cleanup", setup: { script: "" }, cleanup: { script: 'printf "%s\\n" "$PWD" "$CODEX_WORKTREE_PATH" > cleanup-paths' } }) });
  expect(saved.type).toBe("saved");
  if (selectNested) f.store.putActionEnvironmentSelection(ready.worktreePath, cleanupPath, 0);
  const cleaned = await f.lifecycle.cleanup(ready.id, ready.revision);
  expect(cleaned.phase).toBe("cleanup-succeeded");
  const cleanupCwd = selectNested ? workspace : ready.worktreePath;
  expect((await readFile(join(cleanupCwd, "cleanup-paths"), "utf8")).trim().split("\n")).toEqual([cleanupCwd, workspace]);
  expect(await readFile(join(f.source, ".git/index"))).toEqual(index);
  expect((await f.git("rev-parse", "HEAD")).stdout).toBe(head);
  expect(f.store.listSessions()).toHaveLength(0);
}, 30_000);

test("a lost receipt after real Git creation records uncertainty immediately and never replays", async () => {
  const f = await fixture("touch setup-must-not-run", "");
  const create = f.workspaces.createPreparedSessionWorktree.bind(f.workspaces);
  let dispatches = 0;
  f.workspaces.createPreparedSessionWorktree = async (...args) => {
    dispatches++;
    await create(...args);
    throw new Error("Injected receipt loss after real Git creation");
  };
  await expect(f.lifecycle.prepare(f.input)).rejects.toThrow("receipt loss");
  const unknown = f.store.environmentPreparations.get(f.input.commandId)!;
  expect(unknown).toMatchObject({ phase: "unknown", uncertainOperation: "worktree-create" });
  expect(await access(join(unknown.worktreePath, "README.md")).then(() => true, () => false)).toBe(true);
  expect(await access(join(unknown.worktreePath, "setup-must-not-run")).then(() => true, () => false)).toBe(false);
  expect(await f.lifecycle.prepare(f.input)).toEqual(unknown);
  expect(dispatches).toBe(1);
  await expect(f.lifecycle.retrySetup(unknown.id, unknown.revision)).rejects.toThrow("current failed setup");
  expect(f.store.listSessions()).toHaveLength(0);
}, 30_000);
