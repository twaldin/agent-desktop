import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceError, WorkspaceService } from "./service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

async function repository(commit = true) {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-commit-selection-")); roots.push(root);
  const cwd = join(root, "project"), hooks = join(root, "hooks");
  await mkdir(cwd); await mkdir(hooks);
  git(cwd, "init", "-q", "--initial-branch=main");
  git(cwd, "config", "user.name", "Commit Selection Fixture");
  git(cwd, "config", "user.email", "commit-selection@example.invalid");
  git(cwd, "config", "commit.gpgSign", "false");
  git(cwd, "config", "core.hooksPath", hooks);
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  if (commit) { git(cwd, "add", "tracked.txt"); git(cwd, "commit", "-qm", "initial"); }
  return { root, cwd, service: new WorkspaceService(cwd) };
}

async function indexBytes(cwd: string): Promise<Buffer | null> {
  const path = git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "index");
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function treeFile(cwd: string, tree: string, path: string): Buffer {
  const result = Bun.spawnSync(["git", "-C", cwd, "show", `${tree}:${path}`], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return Buffer.from(result.stdout);
}

async function expectCode(operation: Promise<unknown>, code: string) {
  try { await operation; throw new Error(`Expected ${code}`); }
  catch (error) { expect(error).toBeInstanceOf(WorkspaceError); expect((error as WorkspaceError).code).toBe(code); }
}

test("staged-only and include-unstaged capture distinct trees without touching live state", async () => {
  const fixture = await repository();
  await writeFile(join(fixture.cwd, "tracked.txt"), "staged\n"); git(fixture.cwd, "add", "tracked.txt");
  await writeFile(join(fixture.cwd, "tracked.txt"), "working\n");
  const revision = (await fixture.service.gitStatus()).revision;
  const beforeIndex = await indexBytes(fixture.cwd), beforeHead = git(fixture.cwd, "rev-parse", "HEAD");
  const staged = await fixture.service.prepareCommitSelection("staged", revision);
  const included = await fixture.service.prepareCommitSelection("include-unstaged", revision);
  try {
    expect(treeFile(fixture.cwd, staged.selectedTree, "tracked.txt").toString()).toBe("staged\n");
    expect(treeFile(fixture.cwd, included.selectedTree, "tracked.txt").toString()).toBe("working\n");
    expect(staged.selectedPaths).toEqual(["tracked.txt"]);
    expect(included.selectedPaths).toEqual(["tracked.txt"]);
    expect(await indexBytes(fixture.cwd)).toEqual(beforeIndex);
    expect(git(fixture.cwd, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(await readFile(join(fixture.cwd, "tracked.txt"), "utf8")).toBe("working\n");
    await expect(lstat(`${included.privateIndexPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await staged.dispose(); await included.dispose(); }
});

test("include-unstaged captures untracked, deleted, binary, executable and symlink state while omitting ignored files", async () => {
  const fixture = await repository();
  await writeFile(join(fixture.cwd, ".gitignore"), "ignored.bin\n");
  await writeFile(join(fixture.cwd, "deleted.txt"), "delete me\n");
  git(fixture.cwd, "add", ".gitignore", "deleted.txt"); git(fixture.cwd, "commit", "-qm", "fixtures");
  await rm(join(fixture.cwd, "deleted.txt"));
  await writeFile(join(fixture.cwd, "binary.bin"), Buffer.from([0, 1, 2, 0, 255]));
  await writeFile(join(fixture.cwd, "run.sh"), "#!/bin/sh\necho selected\n", { mode: 0o755 });
  await symlink("tracked.txt", join(fixture.cwd, "link"));
  await writeFile(join(fixture.cwd, "ignored.bin"), "ignored\n");
  const beforeIndex = await indexBytes(fixture.cwd);
  const selection = await fixture.service.prepareCommitSelection("include-unstaged", (await fixture.service.gitStatus()).revision);
  try {
    expect(selection.selectedPaths).toEqual(["binary.bin", "deleted.txt", "link", "run.sh"]);
    expect(selection.numstat).toContain("-\t-\tbinary.bin");
    expect(selection.diff).toContain("Binary files /dev/null and b/binary.bin differ");
    expect(git(fixture.cwd, "ls-tree", selection.selectedTree, "run.sh")).toStartWith("100755 blob");
    expect(git(fixture.cwd, "ls-tree", selection.selectedTree, "link")).toStartWith("120000 blob");
    expect(git(fixture.cwd, "ls-tree", selection.selectedTree, "ignored.bin")).toBe("");
    expect(await indexBytes(fixture.cwd)).toEqual(beforeIndex);
  } finally { await selection.dispose(); }
});

test("validation ignores later working edits for staged-only and rejects them for include-unstaged", async () => {
  const fixture = await repository();
  await writeFile(join(fixture.cwd, "tracked.txt"), "staged\n"); git(fixture.cwd, "add", "tracked.txt");
  const revision = (await fixture.service.gitStatus()).revision;
  const staged = await fixture.service.prepareCommitSelection("staged", revision);
  const included = await fixture.service.prepareCommitSelection("include-unstaged", revision);
  await writeFile(join(fixture.cwd, "tracked.txt"), "later working edit\n");
  try {
    await staged.assertCurrent();
    await expectCode(included.assertCurrent(), "GIT_CHANGED");
  } finally { await staged.dispose(); await included.dispose(); }
});

test("include-unstaged fences raw bytes for a staged path even when Git's stat cache stays clean", async () => {
  const fixture = await repository();
  git(fixture.cwd, "config", "core.trustctime", "false");
  git(fixture.cwd, "config", "core.checkStat", "minimal");
  const path = join(fixture.cwd, "tracked.txt");
  await writeFile(path, "stageA\n");
  const old = new Date("2020-01-02T03:04:05.000Z");
  await utimes(path, old, old);
  git(fixture.cwd, "add", "tracked.txt");
  const stagedMetadata = await stat(path);
  expect(git(fixture.cwd, "ls-files", "-m", "-d", "-o", "--exclude-standard", "--", ".")).toBe("");
  const selection = await fixture.service.prepareCommitSelection("include-unstaged", (await fixture.service.gitStatus()).revision);
  await writeFile(path, "stageB\n");
  await utimes(path, stagedMetadata.atime, stagedMetadata.mtime);
  expect(git(fixture.cwd, "ls-files", "-m", "-d", "-o", "--exclude-standard", "--", ".")).toBe("");
  try { await expectCode(selection.assertCurrent(), "GIT_CHANGED"); }
  finally { await selection.dispose(); }
});

test("detached HEAD preparation records a null branch without changing HEAD", async () => {
  const fixture = await repository();
  git(fixture.cwd, "checkout", "-q", "--detach");
  await writeFile(join(fixture.cwd, "tracked.txt"), "detached staged\n");
  git(fixture.cwd, "add", "tracked.txt");
  const head = git(fixture.cwd, "rev-parse", "HEAD");
  const selection = await fixture.service.prepareCommitSelection("staged", (await fixture.service.gitStatus()).revision);
  try {
    expect(selection).toMatchObject({ branch: null, head, selectedPaths: ["tracked.txt"] });
    await selection.assertCurrent();
    expect(git(fixture.cwd, "rev-parse", "HEAD")).toBe(head);
  } finally { await selection.dispose(); }
});

test("validation rejects changed live index and branch and dispose is idempotent", async () => {
  const fixture = await repository();
  await writeFile(join(fixture.cwd, "tracked.txt"), "selected\n"); git(fixture.cwd, "add", "tracked.txt");
  const first = await fixture.service.prepareCommitSelection("staged", (await fixture.service.gitStatus()).revision);
  await writeFile(join(fixture.cwd, "extra.txt"), "extra\n"); git(fixture.cwd, "add", "extra.txt");
  await expectCode(first.assertCurrent(), "GIT_CHANGED");
  const privateIndex = first.privateIndexPath;
  await first.dispose(); await first.dispose();
  await expect(lstat(privateIndex)).rejects.toMatchObject({ code: "ENOENT" });

  git(fixture.cwd, "reset", "-q", "--hard", "HEAD");
  await writeFile(join(fixture.cwd, "tracked.txt"), "selected again\n"); git(fixture.cwd, "add", "tracked.txt");
  const second = await fixture.service.prepareCommitSelection("staged", (await fixture.service.gitStatus()).revision);
  git(fixture.cwd, "branch", "other"); git(fixture.cwd, "switch", "-q", "other");
  try { await expectCode(second.assertCurrent(), "GIT_CHANGED"); }
  finally { await second.dispose(); }

  git(fixture.cwd, "switch", "-q", "main");
  const third = await fixture.service.prepareCommitSelection("staged", (await fixture.service.gitStatus()).revision);
  await writeFile(third.privateIndexPath, "tampered private index\n");
  try { await expectCode(third.assertCurrent(), "GIT_CHANGED"); }
  finally { await third.dispose(); }
});

test("normal required clean filters populate the selected private tree and preserve the live index", async () => {
  const fixture = await repository();
  git(fixture.cwd, "config", "filter.upper.clean", "tr a-z A-Z");
  git(fixture.cwd, "config", "filter.upper.smudge", "cat");
  git(fixture.cwd, "config", "filter.upper.required", "true");
  await writeFile(join(fixture.cwd, ".gitattributes"), "filtered.txt filter=upper\n");
  await writeFile(join(fixture.cwd, "filtered.txt"), "lowercase\n");
  const beforeIndex = await indexBytes(fixture.cwd);
  const selection = await fixture.service.prepareCommitSelection("include-unstaged", (await fixture.service.gitStatus()).revision);
  try {
    expect(treeFile(fixture.cwd, selection.selectedTree, "filtered.txt").toString()).toBe("LOWERCASE\n");
    expect(await readFile(join(fixture.cwd, "filtered.txt"), "utf8")).toBe("lowercase\n");
    expect(await indexBytes(fixture.cwd)).toEqual(beforeIndex);
  } finally { await selection.dispose(); }
});

test("unborn repositories prepare an include-unstaged tree without creating a live index or commit", async () => {
  const fixture = await repository(false);
  const beforeIndex = await indexBytes(fixture.cwd);
  const selection = await fixture.service.prepareCommitSelection("include-unstaged", (await fixture.service.gitStatus()).revision);
  try {
    expect(selection).toMatchObject({ head: null, branch: "main", selectedPaths: ["tracked.txt"] });
    expect(treeFile(fixture.cwd, selection.selectedTree, "tracked.txt").toString()).toBe("base\n");
    expect(await indexBytes(fixture.cwd)).toEqual(beforeIndex);
    expect(Bun.spawnSync(["git", "-C", fixture.cwd, "rev-parse", "--verify", "--quiet", "HEAD"]).exitCode).toBe(1);
  } finally { await selection.dispose(); }
});

test("include-unstaged fails explicitly for hidden index flags while staged-only remains available", async () => {
  const fixture = await repository();
  await writeFile(join(fixture.cwd, "tracked.txt"), "staged\n"); git(fixture.cwd, "add", "tracked.txt");
  git(fixture.cwd, "update-index", "--assume-unchanged", "tracked.txt");
  const revision = (await fixture.service.gitStatus()).revision;
  const beforeIndex = await indexBytes(fixture.cwd);
  const staged = await fixture.service.prepareCommitSelection("staged", revision);
  try { expect(staged.selectedPaths).toEqual(["tracked.txt"]); }
  finally { await staged.dispose(); }
  await expectCode(fixture.service.prepareCommitSelection("include-unstaged", revision), "COMMIT_SELECTION_HIDDEN_CHANGES_UNSUPPORTED");
  expect(await indexBytes(fixture.cwd)).toEqual(beforeIndex);
});

test("include-unstaged reports sparse and split-index repositories as open unsupported states", async () => {
  const sparse = await repository();
  git(sparse.cwd, "config", "core.sparseCheckout", "true");
  await expectCode(sparse.service.prepareCommitSelection("include-unstaged", (await sparse.service.gitStatus()).revision),
    "COMMIT_SELECTION_SPARSE_UNSUPPORTED");

  const split = await repository();
  git(split.cwd, "update-index", "--split-index");
  await expectCode(split.service.prepareCommitSelection("include-unstaged", (await split.service.gitStatus()).revision),
    "COMMIT_SELECTION_SPLIT_INDEX_UNSUPPORTED");
});
