import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalEnvironmentStore } from "./index";
import { materializeWorktreeEnvironment, syncWorktreeEnvironmentSelection, worktreeEnvironmentConfigKey, type WorktreeEnvironmentSnapshot } from "./worktree-config";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const raw = (name: string) => `version = 1\nname = "${name}"\n[setup]\nscript = "printf ready"\n`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
const maybeGit = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout.trimEnd(), stderr: result.stderr.trimEnd() };
};

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-worktree-config-"))); roots.push(root);
  const source = join(root, "source"), workspace = join(source, "apps", "web"), managed = join(root, "managed");
  await mkdir(workspace, { recursive: true });
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Worktree config fixture"); git(source, "config", "user.email", "fixture@example.invalid");
  git(source, "config", "commit.gpgSign", "false"); git(source, "config", "fixture.preserved", "yes");
  await writeFile(join(root, "empty-global-ignore"), ""); git(source, "config", "core.excludesFile", join(root, "empty-global-ignore"));
  await writeFile(join(workspace, "README.md"), "workspace\n");
  git(source, "add", "."); git(source, "commit", "-m", "Base");
  const createWorktree = (name: string, ref = "HEAD") => { const path = join(managed, name); git(source, "worktree", "add", "--detach", path, ref); return path; };
  const writeConfig = async (value: string) => {
    const path = join(workspace, ".agent-desktop", "environments", "environment.toml");
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); return path;
  };
  const snapshot = async (path: string): Promise<WorktreeEnvironmentSnapshot> => new LocalEnvironmentStore(workspace).read(path);
  const input = (worktreeGitRoot: string, selected: WorktreeEnvironmentSnapshot | null) => ({ sourceWorkspaceRoot: workspace, sourceGitRoot: source, worktreeGitRoot, selected });
  return { root, source, workspace, managed, createWorktree, writeConfig, snapshot, input };
}

function assertSelectionIsolation(source: string, worktree: string, expected: string, sourceExpected: string | null = null) {
  expect(git(worktree, "config", "--worktree", "--get", worktreeEnvironmentConfigKey)).toBe(expected);
  const sourceSelection = maybeGit(source, "config", "--worktree", "--get", worktreeEnvironmentConfigKey);
  expect(sourceSelection.code).toBe(sourceExpected === null ? 1 : 0);
  if (sourceExpected !== null) expect(sourceSelection.stdout).toBe(sourceExpected);
  expect(maybeGit(source, "config", "--file", join(source, ".git", "config"), "--get", worktreeEnvironmentConfigKey).code).toBe(1);
  expect(git(source, "config", "fixture.preserved")).toBe("yes");
}

test("an existing branch config wins and its exact content is selected only for the managed worktree", async () => {
  const f = await fixture();
  const configPath = await f.writeConfig(raw("Branch version"));
  git(f.source, "add", "."); git(f.source, "commit", "-m", "Branch config"); git(f.source, "branch", "branch-config");
  await writeFile(configPath, raw("Source version")); git(f.source, "add", "."); git(f.source, "commit", "-m", "Source config update");
  const selected = await f.snapshot(configPath), worktree = f.createWorktree("existing", "branch-config");
  git(f.source, "config", "extensions.worktreeConfig", "true");
  git(f.source, "config", "--worktree", worktreeEnvironmentConfigKey, "source-selection-stays");
  const before = { head: git(f.source, "rev-parse", "HEAD"), index: await readFile(join(f.source, ".git", "index")), file: await readFile(configPath, "utf8") };

  const result = await materializeWorktreeEnvironment(f.input(worktree, selected));
  expect(result).toMatchObject({ source: "existing", configPath: join(worktree, "apps", "web", ".agent-desktop", "environments", "environment.toml"), environment: { name: "Branch version" } });
  expect(result.raw).toBe(raw("Branch version"));
  assertSelectionIsolation(f.source, worktree, result.configPath!, "source-selection-stays");
  expect(await readFile(configPath, "utf8")).toBe(before.file); expect(await readFile(join(f.source, ".git", "index"))).toEqual(before.index); expect(git(f.source, "rev-parse", "HEAD")).toBe(before.head);
});

test("a tracked config absent from the selected commit becomes durable explicit no-environment", async () => {
  const f = await fixture();
  git(f.source, "branch", "before-config");
  const configPath = await f.writeConfig(raw("Tracked later")); git(f.source, "add", "."); git(f.source, "commit", "-m", "Tracked config");
  const selected = await f.snapshot(configPath), worktree = f.createWorktree("absent", "before-config");
  const result = await materializeWorktreeEnvironment(f.input(worktree, selected));
  expect(result).toEqual({ configPath: null, revision: null, raw: null, environment: null, source: "none" });
  expect(await Bun.file(join(worktree, "apps", "web", ".agent-desktop", "environments", "environment.toml")).exists()).toBe(false);
  assertSelectionIsolation(f.source, worktree, "__none__");
  expect(git(worktree, "config", "--worktree", "--get", worktreeEnvironmentConfigKey)).toBe("__none__");
});

test("untracked configs copy exclusively, while an ignore mismatch retains the verified source snapshot", async () => {
  const copied = await fixture();
  const copiedPath = await copied.writeConfig(raw("Untracked")), copiedSnapshot = await copied.snapshot(copiedPath), copiedTree = copied.createWorktree("copied");
  const copiedResult = await materializeWorktreeEnvironment(copied.input(copiedTree, copiedSnapshot));
  expect(copiedResult).toMatchObject({ source: "copied", environment: { name: "Untracked" } });
  expect(await readFile(copiedResult.configPath!, "utf8")).toBe(copiedSnapshot.raw);
  assertSelectionIsolation(copied.source, copiedTree, copiedResult.configPath!);

  const retained = await fixture();
  await writeFile(join(retained.source, ".gitignore"), "**/.agent-desktop/environments/environment.toml\n");
  const retainedPath = await retained.writeConfig(raw("Ignored only in source")), retainedSnapshot = await retained.snapshot(retainedPath), retainedTree = retained.createWorktree("retained");
  const retainedResult = await materializeWorktreeEnvironment(retained.input(retainedTree, retainedSnapshot));
  expect(retainedResult).toMatchObject({ source: "source", configPath: retainedPath, revision: retainedSnapshot.revision, raw: retainedSnapshot.raw, environment: { name: "Ignored only in source" } });
  expect(await Bun.file(join(retainedTree, "apps", "web", ".agent-desktop", "environments", "environment.toml")).exists()).toBe(false);
  assertSelectionIsolation(retained.source, retainedTree, retainedPath);
});

test("target ignore permits copying, while a target symlink fails without touching its destination or selection", async () => {
  const ignored = await fixture();
  await writeFile(join(ignored.source, ".gitignore"), "**/.agent-desktop/environments/environment.toml\n"); git(ignored.source, "add", ".gitignore"); git(ignored.source, "commit", "-m", "Ignore config");
  const ignoredPath = await ignored.writeConfig(raw("Ignored both")), ignoredSnapshot = await ignored.snapshot(ignoredPath), ignoredTree = ignored.createWorktree("ignored");
  expect(await materializeWorktreeEnvironment(ignored.input(ignoredTree, ignoredSnapshot))).toMatchObject({ source: "copied", environment: { name: "Ignored both" } });

  const linked = await fixture();
  const linkedPath = await linked.writeConfig(raw("Unsafe target")), linkedSnapshot = await linked.snapshot(linkedPath), linkedTree = linked.createWorktree("linked");
  const target = join(linkedTree, "apps", "web", ".agent-desktop", "environments", "environment.toml"), outside = join(linked.root, "outside.toml");
  await mkdir(dirname(target), { recursive: true }); await writeFile(outside, "outside survives\n"); await symlink(outside, target);
  await expect(materializeWorktreeEnvironment(linked.input(linkedTree, linkedSnapshot))).rejects.toMatchObject({ code: "INVALID_TARGET" });
  expect(await readFile(outside, "utf8")).toBe("outside survives\n");
  expect(maybeGit(linkedTree, "config", "--worktree", "--get", worktreeEnvironmentConfigKey).code).not.toBe(0);
});

test("worktree config is not enabled when a common core.worktree value would change interpretation", async () => {
  const f = await fixture(), worktree = f.createWorktree("core-worktree");
  git(f.source, "config", "core.worktree", f.source);
  await expect(materializeWorktreeEnvironment(f.input(worktree, null))).rejects.toMatchObject({ code: "UNSAFE_WORKTREE_CONFIG" });
  expect(maybeGit(f.source, "config", "--get", "extensions.worktreeConfig").code).toBe(1);
  expect(maybeGit(worktree, "config", "--worktree", "--get", worktreeEnvironmentConfigKey).code).not.toBe(0);
  expect(git(f.source, "config", "core.worktree")).toBe(f.source);
});

test("an unrelated Git repository is rejected before either repository is changed", async () => {
  const f = await fixture();
  const configPath = await f.writeConfig(raw("Wrong repository")), selected = await f.snapshot(configPath);
  const unrelated = join(f.root, "unrelated");
  await mkdir(unrelated);
  git(unrelated, "init", "-b", "main");
  git(unrelated, "config", "user.name", "Unrelated fixture"); git(unrelated, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(unrelated, "README.md"), "unrelated\n"); git(unrelated, "add", "."); git(unrelated, "commit", "-m", "Base");
  const sourceHead = git(f.source, "rev-parse", "HEAD"), unrelatedHead = git(unrelated, "rev-parse", "HEAD");

  await expect(materializeWorktreeEnvironment(f.input(unrelated, selected))).rejects.toMatchObject({ code: "UNRELATED_WORKTREE" });

  expect(git(f.source, "rev-parse", "HEAD")).toBe(sourceHead);
  expect(git(unrelated, "rev-parse", "HEAD")).toBe(unrelatedHead);
  expect(maybeGit(f.source, "config", "--get", "extensions.worktreeConfig").code).toBe(1);
  expect(maybeGit(unrelated, "config", "--get", "extensions.worktreeConfig").code).toBe(1);
  expect(maybeGit(unrelated, "config", "--get", worktreeEnvironmentConfigKey).code).toBe(1);
});

test("selection mirror persists explicit null and is visible after a fresh Git process", async () => {
  const f = await fixture(), worktree = f.createWorktree("explicit-null");
  await syncWorktreeEnvironmentSelection(f.source, worktree, null);
  expect(git(worktree, "config", "--worktree", "--get", worktreeEnvironmentConfigKey)).toBe("__none__");
});

test("shared target mirrors serialize and skip a matching Git value", async () => {
  const f = await fixture(), worktree = f.createWorktree("shared-target");
  const first = join(worktree, "first.toml"), second = join(worktree, "second.toml");
  await Promise.all([
    syncWorktreeEnvironmentSelection(f.source, worktree, async () => { await Bun.sleep(10); return first; }),
    syncWorktreeEnvironmentSelection(f.source, worktree, () => second),
  ]);
  expect(git(worktree, "config", "--worktree", "--get", worktreeEnvironmentConfigKey)).toBe(second);
  await syncWorktreeEnvironmentSelection(f.source, worktree, second);
  expect(git(worktree, "config", "--worktree", "--get", worktreeEnvironmentConfigKey)).toBe(second);
});

test("a locked Git config blocks mirroring and the same desired value can be retried", async () => {
  const f = await fixture(), worktree = f.createWorktree("mirror-repair");
  const desired = join(worktree, "repair.toml");
  git(f.source, "config", "extensions.worktreeConfig", "true");
  const lock = git(worktree, "rev-parse", "--git-path", "config.worktree") + ".lock";
  await writeFile(lock, "fixture lock");
  try {
    await expect(syncWorktreeEnvironmentSelection(f.source, worktree, desired)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  } finally { await rm(lock); }
  expect(maybeGit(worktree, "config", "--worktree", "--get", worktreeEnvironmentConfigKey).code).not.toBe(0);
  await syncWorktreeEnvironmentSelection(f.source, worktree, desired);
  expect(git(worktree, "config", "--worktree", "--get", worktreeEnvironmentConfigKey)).toBe(desired);
});
