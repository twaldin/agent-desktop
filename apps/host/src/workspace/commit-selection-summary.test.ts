import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService } from "./service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-selection-summary-"))); roots.push(root);
  const cwd = join(root, "project"), hooks = join(root, "hooks"); await mkdir(cwd); await mkdir(hooks);
  git(cwd, "init", "-q", "--initial-branch=main");
  git(cwd, "config", "user.name", "Selection Summary Fixture"); git(cwd, "config", "user.email", "summary@example.invalid");
  git(cwd, "config", "core.hooksPath", hooks); git(cwd, "config", "commit.gpgSign", "false");
  await writeFile(join(cwd, "tracked.txt"), "base\n"); git(cwd, "add", "tracked.txt"); git(cwd, "commit", "-qm", "base");
  const service = new WorkspaceService(cwd);
  const snapshot = async () => ({ index: await readFile(join(cwd, ".git/index")), head: git(cwd, "rev-parse", "HEAD"),
    refs: git(cwd, "show-ref"), config: await readFile(join(cwd, ".git/config")), working: await readFile(join(cwd, "tracked.txt")) });
  return { cwd, service, snapshot };
}

test("host totals describe one final tree for mixed staged/working edits and multiline untracked content", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "tracked.txt"), "staged\n"); git(f.cwd, "add", "tracked.txt");
  await writeFile(join(f.cwd, "tracked.txt"), "working\n"); await writeFile(join(f.cwd, "untracked.txt"), "new one\nnew two\n");
  const revision = (await f.service.gitStatus()).revision, before = await f.snapshot();
  const staged = await f.service.summarizeCommitSelection("staged", revision);
  const included = await f.service.summarizeCommitSelection("include-unstaged", revision);
  expect(staged).toMatchObject({ selectionMode: "staged", reviewedRevision: revision, additions: 1, deletions: 1, files: 1, binaryFiles: 0 });
  expect(included).toMatchObject({ selectionMode: "include-unstaged", reviewedRevision: revision, additions: 3, deletions: 1, files: 2, binaryFiles: 0 });
  expect(git(f.cwd, "show", `${staged.selectedTree}:tracked.txt`)).toBe("staged");
  expect(git(f.cwd, "show", `${included.selectedTree}:tracked.txt`)).toBe("working");
  expect(git(f.cwd, "show", `${included.selectedTree}:untracked.txt`)).toBe("new one\nnew two");
  expect(await f.snapshot()).toEqual(before);
  expect(await readFile(join(f.cwd, "untracked.txt"), "utf8")).toBe("new one\nnew two\n");
});

test("opposing staged and working edits produce an exact zero summary without making an empty commit valid", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "tracked.txt"), "staged\n"); git(f.cwd, "add", "tracked.txt"); await writeFile(join(f.cwd, "tracked.txt"), "base\n");
  const revision = (await f.service.gitStatus()).revision, before = await f.snapshot();
  expect(await f.service.summarizeCommitSelection("include-unstaged", revision)).toMatchObject({ selectedTree: git(f.cwd, "rev-parse", "HEAD^{tree}"), additions: 0, deletions: 0, binaryFiles: 0, files: 0 });
  await expect(f.service.prepareCommitSelection("include-unstaged", revision)).rejects.toMatchObject({ code: "NO_CHANGES" });
  expect(await f.snapshot()).toEqual(before);
});

test("selection summary includes binary and rename entries without inventing changed lines", async () => {
  const f = await fixture(); git(f.cwd, "config", "diff.renames", "true");
  git(f.cwd, "mv", "tracked.txt", "renamed.txt"); await writeFile(join(f.cwd, "binary.bin"), Buffer.from([0, 1, 255, 0]));
  const index = await readFile(join(f.cwd, ".git/index")), head = git(f.cwd, "rev-parse", "HEAD");
  const result = await f.service.summarizeCommitSelection("include-unstaged", (await f.service.gitStatus()).revision);
  expect(result).toMatchObject({ additions: 0, deletions: 0, binaryFiles: 1, files: 2 });
  expect(git(f.cwd, "show", `${result.selectedTree}:renamed.txt`)).toBe("base");
  expect(await readFile(join(f.cwd, ".git/index"))).toEqual(index); expect(git(f.cwd, "rev-parse", "HEAD")).toBe(head);
});

test("stale revision is rejected even when the requested selection would be empty", async () => {
  const f = await fixture(); const revision = (await f.service.gitStatus()).revision;
  await writeFile(join(f.cwd, "tracked.txt"), "changed\n"); git(f.cwd, "add", "tracked.txt"); git(f.cwd, "commit", "-qm", "changed");
  await expect(f.service.summarizeCommitSelection("staged", revision)).rejects.toMatchObject({ code: "GIT_REVISION_CONFLICT" });
  const current = (await f.service.gitStatus()).revision;
  expect(await f.service.summarizeCommitSelection("staged", current)).toMatchObject({ additions: 0, deletions: 0, files: 0 });
});

test("conflicts remain unavailable rather than a zero summary", async () => {
  const f = await fixture(); git(f.cwd, "checkout", "-qb", "other");
  await writeFile(join(f.cwd, "tracked.txt"), "other\n"); git(f.cwd, "commit", "-qam", "other"); git(f.cwd, "checkout", "-q", "main");
  await writeFile(join(f.cwd, "tracked.txt"), "main\n"); git(f.cwd, "commit", "-qam", "main");
  const merged = Bun.spawnSync(["git", "-C", f.cwd, "merge", "--no-edit", "other"], { stdout: "pipe", stderr: "pipe" }); expect(merged.exitCode).toBe(1);
  const revision = (await f.service.gitStatus()).revision, before = await f.snapshot();
  await expect(f.service.summarizeCommitSelection("include-unstaged", revision)).rejects.toMatchObject({ code: "COMMIT_SELECTION_CONFLICT" });
  expect(await f.snapshot()).toEqual(before);
});
