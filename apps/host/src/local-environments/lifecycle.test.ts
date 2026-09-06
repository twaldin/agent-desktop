import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
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

async function fixture(setup: string, cleanup: string) {
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
  const saved = await configStore.save({ expectedRevision: null, raw: serializeLocalEnvironment({ version: 1, name: "Fixture", setup: { script: setup }, cleanup: { script: cleanup } }) });
  if (saved.type !== "saved") throw new Error("Fixture config save failed");
  const workspaces = new HostWorkspaces(store, data, () => () => {});
  const lifecycle = new WorktreeEnvironmentLifecycle(store, workspaces, { timeoutMs: 5_000 });
  const input: PrepareEnvironmentWorktree = { commandId: crypto.randomUUID(), projectId: project.id, draft: { id: "new-conversation", revision: 0 },
    startingState: { type: "branch", branchName: "main" }, environment: { configPath: saved.configPath, revision: saved.revision } };
  const before = { index: await readFile(join(source, ".git", "index")), head: (await git("rev-parse", "HEAD")).stdout, status: (await git("status", "--porcelain=v1", "--untracked-files=all")).stdout };
  return { root, source, data, store, project, configStore, saved, workspaces, lifecycle, input, git, before };
}

test("actual setup is revision-pinned, runs once, captures private exports and cleanup precedes removal", async () => {
  const f = await fixture('printf "setup\\n" >> setup-count\nexport ENVIRONMENT_FIXTURE_VALUE=private-value', 'rm setup-count');
  const ready = await f.lifecycle.prepare(f.input);
  expect(ready.phase).toBe("setup-succeeded");
  expect(await readFile(join(ready.worktreePath, "setup-count"), "utf8")).toBe("setup\n");
  expect(ready.environmentDelta?.set.ENVIRONMENT_FIXTURE_VALUE).toBe("private-value");
  expect(await f.lifecycle.prepare(f.input)).toEqual(ready);
  expect(await readFile(join(ready.worktreePath, "setup-count"), "utf8")).toBe("setup\n");
  expect(JSON.stringify(f.store.environmentPreparations.public(ready))).not.toContain("private-value");
  // A later source configuration edit must not replace the captured cleanup.
  await f.configStore.save({ configPath: f.saved.configPath, expectedRevision: f.saved.revision, raw: serializeLocalEnvironment({ version: 1, name: "Changed", setup: { script: "exit 9" }, cleanup: { script: "exit 7" } }) });
  const cleaned = await f.lifecycle.cleanup(ready.id, ready.revision);
  expect(cleaned.phase).toBe("cleanup-succeeded");
  expect(await access(join(ready.worktreePath, "setup-count")).then(() => true, () => false)).toBe(false);
  expect(await f.lifecycle.cleanup(cleaned.id, cleaned.revision)).toEqual(cleaned);
  const listing = await f.workspaces.query({ projectId: f.project.id }, { type: "git.worktrees" });
  if (listing.type !== "git.worktrees") throw new Error("Missing registered worktrees");
  const relativePath = listing.worktrees.find(tree => tree.path === ready.worktreePath)?.managedRelativePath;
  if (!relativePath) throw new Error("Missing managed removal path");
  await f.workspaces.mutate({ projectId: f.project.id }, { type: "worktree.remove", path: relativePath });
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

test("a lost receipt after real Git creation records uncertainty immediately and never replays", async () => {
  const f = await fixture("touch setup-must-not-run", "");
  const create = f.workspaces.createSessionWorktree.bind(f.workspaces);
  let dispatches = 0;
  f.workspaces.createSessionWorktree = async (...args) => {
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
