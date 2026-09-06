import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService, type TextDocument } from "./service";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function workspace(options: { maxTextBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agent-desktop-workspace-"));
  directories.push(directory);
  const cwd = join(directory, "project");
  const worktreeRoot = join(directory, "managed-worktrees");
  await mkdir(cwd);
  return { directory, cwd, worktreeRoot, service: new WorkspaceService(cwd, { worktreeRoot, ...options }) };
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trimEnd();
}

async function repository(commit = true) {
  const value = await workspace();
  git(value.cwd, "init", "--initial-branch=main");
  git(value.cwd, "config", "user.name", "Workspace Test");
  git(value.cwd, "config", "user.email", "workspace-tests@example.invalid");
  git(value.cwd, "config", "commit.gpgSign", "false");
  await mkdir(join(value.directory, "no-hooks"));
  git(value.cwd, "config", "core.hooksPath", join(value.directory, "no-hooks"));
  await writeFile(join(value.cwd, "tracked.txt"), "first line\n");
  if (commit) { git(value.cwd, "add", "--", "tracked.txt"); git(value.cwd, "commit", "--message", "Initial fixture"); }
  return value;
}

async function text(service: WorkspaceService, path: string): Promise<TextDocument> {
  const result = await service.readText(path);
  if (result.kind !== "text") throw new Error("Expected text fixture");
  return result;
}

describe("owning workspace files", () => {
  test("UTF-8 BOM, CRLF and executable mode survive atomic text saves", async () => {
    const { cwd, service } = await workspace();
    await writeFile(join(cwd, "script.sh"), "\uFEFF#!/bin/sh\r\necho before\r\n");
    await chmod(join(cwd, "script.sh"), 0o755);
    const initial = await text(service, "script.sh");
    expect(initial.bom).toBe(true);
    expect(initial.text).toBe("#!/bin/sh\r\necho before\r\n");
    const saved = await service.writeText("script.sh", { text: "#!/bin/sh\r\necho after\r\n", expectedRevision: initial.revision });
    expect(saved.ok).toBe(true);
    expect(await readFile(join(cwd, "script.sh"), "utf8")).toBe("\uFEFF#!/bin/sh\r\necho after\r\n");
    expect((await stat(join(cwd, "script.sh"))).mode & 0o777).toBe(0o755);
    expect((await service.list()).map(entry => entry.name)).toEqual(["script.sh"]);
  });

  test("concurrent clients and external edits cause revision conflicts without overwriting work", async () => {
    const { cwd, service } = await workspace();
    const second = new WorkspaceService(cwd);
    await writeFile(join(cwd, "draft.txt"), "base");
    const initial = await text(service, "draft.txt");
    const attempts = await Promise.all([
      service.writeText("draft.txt", { text: "first client draft", expectedRevision: initial.revision }),
      second.writeText("draft.txt", { text: "second client draft", expectedRevision: initial.revision }),
    ]);
    expect(attempts.filter(result => result.ok)).toHaveLength(1);
    const winner = attempts.find(result => result.ok)!;
    const loser = attempts.find(result => !result.ok)!;
    expect(loser).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    if (!winner.ok || loser.ok) throw new Error("Invalid competing-save outcome");
    expect(loser.current).toEqual(winner.document);
    expect(await readFile(join(cwd, "draft.txt"), "utf8")).toBe(winner.document.text);
    await writeFile(join(cwd, "draft.txt"), "edited in another application");
    expect(await second.writeText("draft.txt", { text: "unsaved editor contents", expectedRevision: winner.document.revision }))
      .toMatchObject({ ok: false, current: { kind: "text", text: "edited in another application" } });
    expect(await readFile(join(cwd, "draft.txt"), "utf8")).toBe("edited in another application");
  });

  test("create-only revisions cannot replace an existing file", async () => {
    const { service } = await workspace();
    expect(await service.writeText("new.txt", { text: "new contents", expectedRevision: null })).toMatchObject({ ok: true });
    expect(await service.writeText("new.txt", { text: "replacement", expectedRevision: null })).toMatchObject({ ok: false, current: { text: "new contents" } });
    expect(await service.writeText("missing.txt", { text: "wrong base", expectedRevision: "0".repeat(64) })).toMatchObject({ ok: false, current: null });
  });

  test("symlinks inside the root work while outside targets and traversal are rejected", async () => {
    const { directory, cwd, service } = await workspace();
    await writeFile(join(cwd, "target.txt"), "inside");
    await writeFile(join(directory, "outside.txt"), "outside must survive");
    await symlink("target.txt", join(cwd, "inside-link"));
    await symlink(join(directory, "outside.txt"), join(cwd, "outside-link"));
    await symlink(directory, join(cwd, "outside-directory"));
    await symlink("missing", join(cwd, "broken-link"));
    expect(await service.stat("outside-link")).toMatchObject({ kind: "symlink", linkState: "outside" });
    expect(await service.stat("broken-link")).toMatchObject({ kind: "symlink", linkState: "missing" });
    const initial = await text(service, "inside-link");
    expect(await service.writeText("inside-link", { text: "changed inside", expectedRevision: initial.revision })).toMatchObject({ ok: true });
    expect((await lstat(join(cwd, "inside-link"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(cwd, "target.txt"), "utf8")).toBe("changed inside");
    for (const path of ["../outside.txt", join(directory, "outside.txt"), "outside-link"]) {
      await expect(service.readText(path)).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
      await expect(service.writeText(path, { text: "forbidden", expectedRevision: null })).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
    }
    await expect(service.list("outside-directory")).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
    await expect(service.writeText("broken-link", { text: "forbidden", expectedRevision: null })).rejects.toMatchObject({ code: "BROKEN_SYMLINK" });
    expect(await readFile(join(directory, "outside.txt"), "utf8")).toBe("outside must survive");
  });

  test("binary, non-UTF8 encoding, oversized and special files have explicit outcomes", async () => {
    const { cwd, service } = await workspace({ maxTextBytes: 16 });
    await writeFile(join(cwd, "binary"), Buffer.from([1, 0, 255]));
    await writeFile(join(cwd, "utf16"), Buffer.from([0xff, 0xfe, 65, 0]));
    await writeFile(join(cwd, "large"), "x".repeat(17));
    const binary = await service.readText("binary");
    expect(binary).toMatchObject({ kind: "binary", size: 3 });
    await expect(service.writeText("binary", { text: "overwrite", expectedRevision: binary.revision })).rejects.toMatchObject({ code: "NOT_UTF8_TEXT" });
    expect(await service.readText("utf16")).toMatchObject({ kind: "unsupported-encoding", encoding: "utf16le" });
    expect(await service.readText("large")).toMatchObject({ kind: "too-large", size: 17, maximumBytes: 16, revision: null });
    await expect(service.writeText("too-large", { text: "x".repeat(17), expectedRevision: null })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(service.readText(".")).rejects.toMatchObject({ code: "NOT_REGULAR_FILE" });
    const fifo = Bun.spawnSync(["mkfifo", join(cwd, "fifo")], { stdout: "pipe", stderr: "pipe" });
    expect(fifo.success).toBe(true);
    await expect(service.readText("fifo")).rejects.toMatchObject({ code: "NOT_REGULAR_FILE" });
  });

  test("read-only files report native permission errors and retain contents", async () => {
    const { cwd, service } = await workspace();
    await writeFile(join(cwd, "read-only.txt"), "protected contents");
    await chmod(join(cwd, "read-only.txt"), 0o444);
    const original = await text(service, "read-only.txt");
    await expect(service.writeText("read-only.txt", { text: "replacement", expectedRevision: original.revision })).rejects.toMatchObject({ code: "EACCES" });
    expect(await readFile(join(cwd, "read-only.txt"), "utf8")).toBe("protected contents");
    expect((await stat(join(cwd, "read-only.txt"))).mode & 0o777).toBe(0o444);
  });
});

describe("actual local Git operations", () => {
  test("branch checkout uses the reviewed status and preserves compatible tracked and untracked edits", async () => {
    const { cwd, service } = await repository();
    git(cwd, "branch", "feature");
    await writeFile(join(cwd, "tracked.txt"), "compatible local edit\n");
    await writeFile(join(cwd, "untracked.txt"), "untracked local edit\n");
    const reviewed = await service.gitStatus();
    const switched = await service.checkout("feature", reviewed.revision);
    expect(switched).toMatchObject({ branch: "feature", head: reviewed.head });
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("compatible local edit\n");
    expect(await readFile(join(cwd, "untracked.txt"), "utf8")).toBe("untracked local edit\n");

    git(cwd, "commit", "--allow-empty", "--message", "External HEAD change");
    await expect(service.checkout("main", reviewed.revision)).rejects.toMatchObject({ code: "GIT_REVISION_CONFLICT" });
    expect(git(cwd, "branch", "--show-current")).toBe("feature");
  });

  test("branch checkout refuses destructive, remote, symbolic and option-like targets, while creation starts at reviewed HEAD", async () => {
    const { cwd, service } = await repository();
    git(cwd, "checkout", "-b", "conflicting");
    await writeFile(join(cwd, "tracked.txt"), "committed on target\n");
    git(cwd, "add", "tracked.txt"); git(cwd, "commit", "--message", "Target content");
    git(cwd, "checkout", "main");
    await writeFile(join(cwd, "tracked.txt"), "must survive rejection\n");
    let reviewed = await service.gitStatus();
    await expect(service.checkout("conflicting", reviewed.revision)).rejects.toMatchObject({ code: "GIT_FAILED" });
    expect(git(cwd, "branch", "--show-current")).toBe("main");
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("must survive rejection\n");

    await writeFile(join(cwd, "tracked.txt"), "first line\n");
    git(cwd, "checkout", "-b", "ignored-target");
    await writeFile(join(cwd, "ignored.txt"), "target branch content\n");
    git(cwd, "add", "ignored.txt"); git(cwd, "commit", "--message", "Target tracks ignored path");
    git(cwd, "checkout", "main");
    await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
    git(cwd, "add", ".gitignore"); git(cwd, "commit", "--message", "Ignore local fixture");
    await writeFile(join(cwd, "ignored.txt"), "ignored local work must survive\n");
    reviewed = await service.gitStatus();
    await expect(service.checkout("ignored-target", reviewed.revision)).rejects.toMatchObject({ code: "GIT_FAILED" });
    expect(git(cwd, "branch", "--show-current")).toBe("main");
    expect(await readFile(join(cwd, "ignored.txt"), "utf8")).toBe("ignored local work must survive\n");

    git(cwd, "update-ref", "refs/remotes/origin/topic", git(cwd, "rev-parse", "HEAD"));
    git(cwd, "symbolic-ref", "refs/heads/alias", "refs/heads/main");
    reviewed = await service.gitStatus();
    await expect(service.checkout("origin/topic", reviewed.revision)).rejects.toMatchObject({ code: "BRANCH_NOT_FOUND" });
    await expect(service.checkout("alias", reviewed.revision)).rejects.toMatchObject({ code: "SYMBOLIC_BRANCH" });
    await expect(service.checkout("--detach", reviewed.revision)).rejects.toMatchObject({ code: "INVALID_BRANCH" });
    await expect(service.checkout("@{-1}", reviewed.revision, true)).rejects.toMatchObject({ code: "INVALID_BRANCH" });

    const head = reviewed.head;
    const created = await service.checkout("new-local", reviewed.revision, true);
    expect(created).toMatchObject({ branch: "new-local", head });
    await expect(service.checkout("new-local", created.revision, true)).rejects.toMatchObject({ code: "BRANCH_EXISTS" });
  });

  test("status handles rename paths and unusual names, stage is literal, and commits preserve native identity", async () => {
    const { cwd, service } = await repository();
    const unusual = "file with spaces\nand newline.txt";
    await writeFile(join(cwd, unusual), "untracked content\n");
    await writeFile(join(cwd, "*.txt"), "literal wildcard\n");
    await rename(join(cwd, "tracked.txt"), join(cwd, "renamed file.txt"));
    git(cwd, "add", "--", "tracked.txt", "renamed file.txt");
    const status = await service.gitStatus();
    expect(status.branch).toBe("main");
    expect(status.entries).toContainEqual(expect.objectContaining({ path: "renamed file.txt", originalPath: "tracked.txt", indexStatus: "R" }));
    expect(status.entries).toContainEqual(expect.objectContaining({ path: unusual, kind: "untracked" }));
    await service.stage(["*.txt"]);
    expect(git(cwd, "diff", "--cached", "--name-only", "-z").split("\0")).toContain("*.txt");
    expect(git(cwd, "diff", "--cached", "--name-only", "-z").split("\0")).not.toContain(unusual);
    const committed = await service.commit("Preserve configured identity\n\nActual fixture commit.");
    expect(committed.commit).toBe(git(cwd, "rev-parse", "HEAD"));
    expect(git(cwd, "log", "-1", "--format=%an <%ae>")).toBe("Workspace Test <workspace-tests@example.invalid>");
    expect(git(cwd, "log", "-1", "--format=%B")).not.toContain("Co-authored-by");
    expect((await service.branches()).find(branch => branch.name === "main")).toMatchObject({ current: true, remote: false });
  });

  test("working and staged diffs are independent and unstage preserves later file edits", async () => {
    const { cwd, service } = await repository();
    await writeFile(join(cwd, "tracked.txt"), "staged version\n");
    await service.stage(["tracked.txt"]);
    await writeFile(join(cwd, "tracked.txt"), "later unstaged edit\n");
    expect((await service.diff({ staged: true, path: "tracked.txt" })).patch).toContain("+staged version");
    expect((await service.diff({ path: "tracked.txt" })).patch).toContain("+later unstaged edit");
    await service.unstage(["tracked.txt"]);
    expect((await service.diff({ staged: true })).patch).toBe("");
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("later unstaged edit\n");
    await writeFile(join(cwd, "new.txt"), "new untracked line\n");
    expect((await service.diff({ path: "new.txt" })).patch).toContain("+new untracked line");
    await writeFile(join(cwd, "new.bin"), Buffer.from([0, 1, 2]));
    expect(await service.diff({ path: "new.bin" })).toMatchObject({ binary: true });
  });

  test("unborn repositories unstage without losing newer working files", async () => {
    const { cwd, service } = await repository(false);
    expect((await service.gitStatus()).head).toBeNull();
    await service.stage(["tracked.txt"]);
    await writeFile(join(cwd, "tracked.txt"), "newer than staged\n");
    await service.unstage(["tracked.txt"]);
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("newer than staged\n");
    expect((await service.gitStatus()).entries).toContainEqual(expect.objectContaining({ path: "tracked.txt", kind: "untracked" }));
  });

  test("a second client's staged changes reject stale commit and unstage without losing the index", async () => {
    const { cwd, service } = await repository();
    const second = new WorkspaceService(cwd);
    await writeFile(join(cwd, "tracked.txt"), "first client staged content\n");
    const reviewed = await service.stage(["tracked.txt"]);
    await writeFile(join(cwd, "second-client.txt"), "second client staged content\n");
    const current = await second.stage(["second-client.txt"]);
    const head = git(cwd, "rev-parse", "HEAD");
    expect(current.revision).not.toBe(reviewed.revision);
    await expect(service.commit("Stale review", reviewed.revision)).rejects.toMatchObject({ code: "GIT_REVISION_CONFLICT" });
    await expect(service.unstage(["tracked.txt"], reviewed.revision)).rejects.toMatchObject({ code: "GIT_REVISION_CONFLICT" });
    expect(git(cwd, "rev-parse", "HEAD")).toBe(head);
    expect(git(cwd, "show", ":second-client.txt")).toBe("second client staged content");
    await writeFile(join(cwd, "tracked.txt"), "later working content stays unstaged\n");
    expect((await service.gitStatus()).revision).toBe(current.revision);
    await service.commit("Reviewed current index", current.revision);
    expect(git(cwd, "show", "HEAD:tracked.txt")).toBe("first client staged content");
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("later working content stays unstaged\n");
    const afterCommit = await service.gitStatus();
    git(cwd, "commit", "--allow-empty", "-m", "External HEAD-only change");
    expect((await service.gitStatus()).revision).not.toBe(afterCommit.revision);
    await expect(second.commit("Stale HEAD review", afterCommit.revision)).rejects.toMatchObject({ code: "GIT_REVISION_CONFLICT" });
  });

  test("merge conflict status preserves paths and the actual conflicted index", async () => {
    const { cwd, service } = await repository();
    git(cwd, "checkout", "-b", "other");
    await writeFile(join(cwd, "tracked.txt"), "other branch line\n");
    git(cwd, "add", "tracked.txt"); git(cwd, "commit", "-m", "Other branch change");
    git(cwd, "checkout", "main");
    await writeFile(join(cwd, "tracked.txt"), "main branch line\n");
    git(cwd, "add", "tracked.txt"); git(cwd, "commit", "-m", "Main branch change");
    const merged = Bun.spawnSync(["git", "-C", cwd, "merge", "--no-edit", "other"], { stdout: "pipe", stderr: "pipe" });
    expect(merged.exitCode).toBe(1);
    expect((await service.gitStatus()).entries).toContainEqual(expect.objectContaining({ path: "tracked.txt", kind: "conflict", indexStatus: "U", worktreeStatus: "U" }));
    expect(git(cwd, "ls-files", "--unmerged")).toContain("tracked.txt");
    await expect(service.commit("Unresolved merge", (await service.gitStatus()).revision)).rejects.toMatchObject({ code: "GIT_FAILED" });
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toContain("<<<<<<< HEAD");
  });

  test("deleted directory paths can be staged, while parent-repo and outside symlinks cannot expand authority", async () => {
    const { directory, cwd, service } = await repository();
    await mkdir(join(cwd, "deleted"));
    await writeFile(join(cwd, "deleted/file.txt"), "delete me\n");
    git(cwd, "add", "."); git(cwd, "commit", "-m", "Add deletion fixture");
    await rm(join(cwd, "deleted"), { recursive: true });
    expect((await service.stage(["deleted/file.txt"])).entries).toContainEqual(expect.objectContaining({ path: "deleted/file.txt", indexStatus: "D" }));
    await service.unstage(["deleted/file.txt"]);
    expect((await service.gitStatus()).entries).toContainEqual(expect.objectContaining({ path: "deleted/file.txt", worktreeStatus: "D" }));
    await symlink(directory, join(cwd, "outside"));
    await expect(service.stage(["outside/anything.txt"])).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
    await mkdir(join(cwd, "nested"));
    await expect(new WorkspaceService(join(cwd, "nested")).gitStatus()).rejects.toMatchObject({ code: "GIT_ROOT_OUTSIDE_WORKSPACE" });
  });

  test("managed worktrees use actual branches and reject dirty, ignored, locked or unowned removal", async () => {
    const { directory, cwd, worktreeRoot, service } = await repository();
    await writeFile(join(cwd, ".gitignore"), "ignored.txt\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "Ignore fixture");
    const tree = await service.createWorktree({ path: "feature", newBranch: "feature-work" });
    expect(tree).toMatchObject({ branch: "feature-work", managed: true, detached: false });
    expect(git(tree.path, "branch", "--show-current")).toBe("feature-work");
    await writeFile(join(tree.path, "tracked.txt"), "uncommitted work\n");
    await expect(service.removeWorktree("feature")).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
    expect(await readFile(join(tree.path, "tracked.txt"), "utf8")).toBe("uncommitted work\n");
    await writeFile(join(tree.path, "tracked.txt"), "first line\n");
    await writeFile(join(tree.path, "ignored.txt"), "ignored content must survive\n");
    await expect(service.removeWorktree("feature")).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
    await rm(join(tree.path, "ignored.txt"));
    git(cwd, "worktree", "lock", tree.path);
    await expect(service.removeWorktree("feature")).rejects.toMatchObject({ code: "WORKTREE_LOCKED" });
    git(cwd, "worktree", "unlock", tree.path);
    const unowned = join(directory, "external-worktree");
    git(cwd, "worktree", "add", "--detach", unowned);
    const canonicalUnowned = await realpath(unowned);
    expect((await service.worktrees()).find(item => item.path === canonicalUnowned)?.managed).toBe(false);
    await expect(service.removeWorktree("../external-worktree")).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
    await symlink(unowned, join(worktreeRoot, "outside-link"));
    await expect(service.removeWorktree("outside-link")).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
    await service.removeWorktree("feature");
    await expect(stat(tree.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(git(cwd, "show-ref", "--verify", "refs/heads/feature-work")).toContain("refs/heads/feature-work");
    expect((await stat(unowned)).isDirectory()).toBe(true);
  });

  test("managed worktree creation uses literal branch names instead of checkout-history expansion", async () => {
    const { cwd, worktreeRoot, service } = await repository();
    git(cwd, "checkout", "-b", "previous-topic");
    git(cwd, "checkout", "main");
    git(cwd, "branch", "-D", "previous-topic");
    const before = await service.worktrees();
    await expect(service.createWorktree({ path: "history-expansion", newBranch: "@{-1}" })).rejects.toMatchObject({ code: "INVALID_BRANCH" });
    expect(await service.worktrees()).toEqual(before);
    expect(await Bun.file(join(worktreeRoot, "history-expansion", ".git")).exists()).toBe(false);
    expect(git(cwd, "branch", "--list", "previous-topic").trim()).toBe("");
    const created = await service.createWorktree({ path: "literal-topic", newBranch: "literal-topic" });
    expect(git(created.path, "branch", "--show-current").trim()).toBe("literal-topic");
    await service.removeWorktree("literal-topic");
  });

  test("session worktrees start detached from an exact local branch without copying source edits", async () => {
    const { cwd, service } = await repository();
    const branchCommit = git(cwd, "rev-parse", "HEAD");
    git(cwd, "branch", "clean-start", branchCommit);
    await writeFile(join(cwd, "tracked.txt"), "source edit must stay local\n");
    await writeFile(join(cwd, "untracked.txt"), "source-only untracked file\n");

    const tree = await service.createSessionWorktree("session-clean", { type: "branch", branchName: "clean-start" });
    expect(tree).toMatchObject({ head: branchCommit, branch: null, detached: true, managed: true, managedRelativePath: "session-clean" });
    expect(git(tree.path, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    expect(await readFile(join(tree.path, "tracked.txt"), "utf8")).toBe("first line\n");
    expect(await Bun.file(join(tree.path, "untracked.txt")).exists()).toBe(false);
    expect(git(cwd, "branch", "--show-current")).toBe("main");
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("source edit must stay local\n");
    expect(await readFile(join(cwd, "untracked.txt"), "utf8")).toBe("source-only untracked file\n");
  });

  test("working-tree session snapshot preserves source index and copies tracked, staged, untracked, binary, mode and symlink state", async () => {
    const { cwd, service } = await repository();
    await writeFile(join(cwd, ".gitignore"), "ignored.bin\n");
    await writeFile(join(cwd, "deleted.txt"), "delete this\n");
    git(cwd, "add", "--", ".gitignore", "deleted.txt"); git(cwd, "commit", "--message", "Snapshot fixtures");
    const head = git(cwd, "rev-parse", "HEAD");
    await writeFile(join(cwd, "tracked.txt"), "staged version\n"); git(cwd, "add", "--", "tracked.txt");
    await writeFile(join(cwd, "tracked.txt"), "unstaged version\n");
    await rm(join(cwd, "deleted.txt"));
    const binary = Buffer.from([0, 255, 1, 254, 2, 253]);
    await writeFile(join(cwd, "binary.dat"), binary);
    await writeFile(join(cwd, "executable.sh"), "#!/bin/sh\necho snapshot\n"); await chmod(join(cwd, "executable.sh"), 0o755);
    await symlink("tracked.txt", join(cwd, "tracked-link"));
    await writeFile(join(cwd, "ignored.bin"), "ignored source data\n");
    const indexPath = git(cwd, "rev-parse", "--git-path", "index");
    const indexFile = indexPath.startsWith("/") ? indexPath : join(cwd, indexPath);
    const statusBefore = git(cwd, "status", "--porcelain=v2", "-z", "--untracked-files=all"), indexBefore = await readFile(indexFile);

    const tree = await service.createSessionWorktree("session-dirty", { type: "working-tree" });
    expect(tree).toMatchObject({ head, branch: null, detached: true, managed: true, managedRelativePath: "session-dirty" });
    expect(await readFile(indexFile)).toEqual(indexBefore);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(head);
    expect(git(cwd, "status", "--porcelain=v2", "-z", "--untracked-files=all")).toBe(statusBefore);
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("unstaged version\n");
    expect(await readFile(join(tree.path, "tracked.txt"), "utf8")).toBe("unstaged version\n");
    expect(git(tree.path, "show", ":tracked.txt")).toBe("staged version");
    expect(await Bun.file(join(tree.path, "deleted.txt")).exists()).toBe(false);
    expect(await readFile(join(tree.path, "binary.dat"))).toEqual(binary);
    expect((await stat(join(tree.path, "executable.sh"))).mode & 0o777).toBe(0o755);
    expect(await readlink(join(tree.path, "tracked-link"))).toBe("tracked.txt");
    expect(await Bun.file(join(tree.path, "ignored.bin")).exists()).toBe(false);
    const copied = await new WorkspaceService(tree.path).gitStatus();
    expect(copied.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "tracked.txt", indexStatus: "M", worktreeStatus: "M", kind: "tracked" }),
      expect.objectContaining({ path: "deleted.txt", indexStatus: ".", worktreeStatus: "D", kind: "tracked" }),
      expect.objectContaining({ path: "binary.dat", kind: "untracked" }),
      expect.objectContaining({ path: "executable.sh", kind: "untracked" }),
      expect.objectContaining({ path: "tracked-link", kind: "untracked" }),
    ]));
  });

  test("session snapshot rejects conflicts and dirty submodules before creation, and a destination collision preserves existing data", async () => {
    const conflicted = await repository();
    git(conflicted.cwd, "checkout", "-b", "conflict-side");
    await writeFile(join(conflicted.cwd, "tracked.txt"), "side\n"); git(conflicted.cwd, "add", "tracked.txt"); git(conflicted.cwd, "commit", "-m", "Side");
    git(conflicted.cwd, "checkout", "main");
    await writeFile(join(conflicted.cwd, "tracked.txt"), "main\n"); git(conflicted.cwd, "add", "tracked.txt"); git(conflicted.cwd, "commit", "-m", "Main");
    expect(Bun.spawnSync(["git", "-C", conflicted.cwd, "merge", "conflict-side"], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(1);
    await expect(conflicted.service.createSessionWorktree("conflicted", { type: "working-tree" })).rejects.toMatchObject({ code: "WORKTREE_SNAPSHOT_CONFLICT" });
    expect(await Bun.file(join(conflicted.worktreeRoot, "conflicted")).exists()).toBe(false);

    const submodule = await repository();
    const nested = join(submodule.directory, "nested-repository"); await mkdir(nested);
    git(nested, "init", "--initial-branch=main"); git(nested, "config", "user.name", "Workspace Test"); git(nested, "config", "user.email", "workspace-tests@example.invalid");
    await writeFile(join(nested, "nested.txt"), "nested baseline\n"); git(nested, "add", "nested.txt"); git(nested, "commit", "-m", "Nested");
    git(submodule.cwd, "-c", "protocol.file.allow=always", "submodule", "add", nested, "vendor/nested"); git(submodule.cwd, "commit", "-am", "Add submodule");
    await writeFile(join(submodule.cwd, "vendor/nested/nested.txt"), "dirty nested file\n");
    await expect(submodule.service.createSessionWorktree("dirty-submodule", { type: "working-tree" })).rejects.toMatchObject({ code: "WORKTREE_SNAPSHOT_SUBMODULE" });
    expect(await Bun.file(join(submodule.worktreeRoot, "dirty-submodule")).exists()).toBe(false);

    await mkdir(submodule.worktreeRoot, { recursive: true });
    const occupied = join(submodule.worktreeRoot, "occupied"); await mkdir(occupied); await writeFile(join(occupied, "keep.txt"), "keep me\n");
    await expect(submodule.service.createSessionWorktree("occupied", { type: "branch", branchName: "main" })).rejects.toMatchObject({ code: "WORKTREE_EXISTS" });
    expect(await readFile(join(occupied, "keep.txt"), "utf8")).toBe("keep me\n");
    await expect(submodule.service.createSessionWorktree("injected", { type: "branch", branchName: "--guess" })).rejects.toMatchObject({ code: "INVALID_BRANCH" });
    expect(await Bun.file(join(submodule.worktreeRoot, "injected")).exists()).toBe(false);
    const concurrent = await Promise.allSettled([
      submodule.service.createSessionWorktree("serialized", { type: "branch", branchName: "main" }),
      submodule.service.createSessionWorktree("serialized", { type: "branch", branchName: "main" }),
    ]);
    expect(concurrent.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(concurrent.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "WORKTREE_EXISTS" } });
    expect((await submodule.service.worktrees()).filter(tree => tree.managedRelativePath === "serialized")).toHaveLength(1);
  });

  test("detached worktree commits need a surviving reference before removal", async () => {
    const { cwd, service } = await repository();
    const tree = await service.createWorktree({ path: "detached" });
    expect(tree.detached).toBe(true);
    await writeFile(join(tree.path, "tracked.txt"), "detached committed work\n");
    git(tree.path, "add", "tracked.txt"); git(tree.path, "commit", "-m", "Detached fixture commit");
    await expect(service.removeWorktree("detached")).rejects.toMatchObject({ code: "UNREFERENCED_COMMITS" });
    git(cwd, "branch", "preserved-detached", git(tree.path, "rev-parse", "HEAD"));
    await service.removeWorktree("detached");
    expect(git(cwd, "show-ref", "--verify", "refs/heads/preserved-detached")).toContain("refs/heads/preserved-detached");
  });

  test('a native checkout hook failure preserves the created session worktree and reports an uncertain outcome', async () => {
    const { cwd, directory, worktreeRoot, service } = await repository();
    await writeFile(join(directory, 'no-hooks', 'post-checkout'), '#!/bin/sh\nexit 17\n', { mode: 0o755 });
    await expect(service.createSessionWorktree('hook-failed', { type: 'branch', branchName: 'main' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    const target = join(worktreeRoot, 'hook-failed');
    expect(await readFile(join(target, 'tracked.txt'), 'utf8')).toBe('first line\n');
    expect(git(target, 'rev-parse', 'HEAD')).toBe(git(cwd, 'rev-parse', 'HEAD'));
    const canonicalTarget = await realpath(target);
    expect((await service.worktrees()).filter(tree => tree.path === canonicalTarget)).toHaveLength(1);
    await expect(service.createSessionWorktree('hook-failed', { type: 'working-tree' })).rejects.toMatchObject({ code: 'WORKTREE_EXISTS' });
    expect(await readFile(join(target, 'tracked.txt'), 'utf8')).toBe('first line\n');
  });
});
