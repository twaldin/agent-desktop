import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import { HostWorkspaces, parseWorkspaceQuery } from "./workspace-http";
import { WorkspaceError, WorkspaceService } from "./workspace/service";
import type { GitReviewSummary } from "../../../packages/shared/src/workspace";

const roots: string[] = [], stores: HostStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function fixture(commit = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-review-summary-"))); roots.push(root);
  const cwd = join(root, "source"), hooks = join(root, "hooks"); await mkdir(cwd); await mkdir(hooks);
  git(cwd, "init", "-q", "--initial-branch=main");
  git(cwd, "config", "user.name", "Review Fixture"); git(cwd, "config", "user.email", "review@example.invalid");
  git(cwd, "config", "core.hooksPath", hooks); git(cwd, "config", "commit.gpgSign", "false");
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  if (commit) { git(cwd, "add", "."); git(cwd, "commit", "-qm", "initial"); }
  const service = new WorkspaceService(cwd);
  const snapshot = async () => ({ index: await readFile(join(cwd, ".git/index")), head: git(cwd, "rev-parse", "HEAD"), refs: git(cwd, "show-ref"), config: await readFile(join(cwd, ".git/config")), work: await readFile(join(cwd, "tracked.txt")) });
  return { root, cwd, service, snapshot };
}
function totals(summary: GitReviewSummary) { return summary.files.reduce((result, file) => [result[0]! + (file.additions ?? 0), result[1]! + (file.deletions ?? 0)], [0, 0]); }

test("actual Git review keeps staged and unstaged cancellation, while selected commit tree is empty", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "tracked.txt"), "base\nstaged\n"); git(f.cwd, "add", ".");
  await writeFile(join(f.cwd, "tracked.txt"), "base\n");
  const before = await f.snapshot();
  const staged = await f.service.reviewSummary("staged"), unstaged = await f.service.reviewSummary("unstaged");
  expect(totals(staged)).toEqual([1, 0]); expect(totals(unstaged)).toEqual([0, 1]);
  expect(staged.files[0]).toEqual({ path: "tracked.txt", previousPath: null, additions: 1, deletions: 0 });
  expect(unstaged).toMatchObject({ stagedCount: 1, unstagedCount: 1, untrackedCount: 0 });
  expect(await f.snapshot()).toEqual(before);
  const commit = await f.service.summarizeCommitSelection("include-unstaged", staged.revision);
  expect([commit.additions, commit.deletions, commit.files]).toEqual([0, 0, 0]);
});

test("NUL-delimited rename and path bytes, deletion, untracked binary/empty/link and ignored content", async () => {
  const f = await fixture(), oldPath = "old\tline\nname.txt", newPath = "new\tline\nname.txt";
  await writeFile(join(f.cwd, oldPath), "one\ntwo\nthree\n"); await writeFile(join(f.cwd, "deleted.txt"), "deleted\n");
  await writeFile(join(f.cwd, ".gitignore"), "ignored.txt\n"); git(f.cwd, "add", "."); git(f.cwd, "commit", "-qm", "files");
  await rename(join(f.cwd, oldPath), join(f.cwd, newPath)); git(f.cwd, "add", ".");
  await rm(join(f.cwd, "deleted.txt")); await writeFile(join(f.cwd, "binary.bin"), Buffer.from([0, 1, 255]));
  await writeFile(join(f.cwd, "empty.txt"), ""); await writeFile(join(f.cwd, "new.txt"), "a\nb\n");
  await writeFile(join(f.cwd, "ignored.txt"), "must not count\n");
  await writeFile(join(f.root, "outside.txt"), "outside\n".repeat(40)); await symlink("../outside.txt", join(f.cwd, "outside-link"));
  const before = await f.snapshot();
  expect((await f.service.reviewSummary("staged")).files).toContainEqual({ path: newPath, previousPath: oldPath, additions: 0, deletions: 0 });
  const unstaged = await f.service.reviewSummary("unstaged");
  for (const file of [
    { path: "deleted.txt", previousPath: null, additions: 0, deletions: 1 },
    { path: "binary.bin", previousPath: null, additions: null, deletions: null },
    { path: "empty.txt", previousPath: null, additions: 0, deletions: 0 },
    { path: "new.txt", previousPath: null, additions: 2, deletions: 0 },
    { path: "outside-link", previousPath: null, additions: 1, deletions: 0 },
  ]) expect(unstaged.files).toContainEqual(file);
  expect(unstaged.files.some(file => file.path === "ignored.txt")).toBe(false);
  expect(unstaged).toMatchObject({ stagedCount: 1, unstagedCount: 1, untrackedCount: 4 });
  expect(await f.snapshot()).toEqual(before);
});

test("unborn staged additions and missing untracked-directory support stay explicit", async () => {
  const f = await fixture(false); git(f.cwd, "add", ".");
  expect(totals(await f.service.reviewSummary("staged"))).toEqual([1, 0]);
  const nested = join(f.cwd, "embedded"); await mkdir(nested); git(nested, "init", "-q");
  await expect(f.service.reviewSummary("unstaged")).rejects.toMatchObject({ code: "REVIEW_FILE_UNSUPPORTED" });
});

test("unmerged working changes are one unknown row", async () => {
  const f = await fixture(); git(f.cwd, "checkout", "-qb", "other");
  await writeFile(join(f.cwd, "tracked.txt"), "other\n"); git(f.cwd, "commit", "-qam", "other");
  git(f.cwd, "checkout", "-q", "main"); await writeFile(join(f.cwd, "tracked.txt"), "main\n"); git(f.cwd, "commit", "-qam", "main");
  const merge = Bun.spawnSync(["git", "-C", f.cwd, "merge", "other"], { stdout: "pipe", stderr: "pipe" }); expect(merge.exitCode).toBe(1);
  const before = await f.snapshot();
  expect((await f.service.reviewSummary("unstaged")).files).toEqual([{ path: "tracked.txt", previousPath: null, additions: null, deletions: null }]);
  expect(await f.snapshot()).toEqual(before);
});

// Exercise malformed child output and failures through the actual service read,
// without executing any hostile Git executable or modifying process environment.
test("malformed/overflow stats and operational errors never become successful zero totals", async () => {
  const f = await fixture();
  const native = f.service as unknown as { git(args: string[], options?: unknown): Promise<{ stdout: string; exitCode: number }> };
  const run = native.git.bind(f.service);
  for (const output of ["1\t2\tunterminated", "-\t2\tbad\0", "1\t2\t\0old\0", "9007199254740992\t0\tbig\0", "garbage\0"]) {
    native.git = async (args, options) => args.includes("--numstat") ? { stdout: output, exitCode: 0 } : run(args, options);
    await expect(f.service.reviewSummary("staged")).rejects.toMatchObject({ code: "GIT_FAILED" });
  }
  native.git = async (args, options) => { if (args.includes("--numstat")) throw new WorkspaceError("GIT_TIMEOUT", "fixture"); return run(args, options); };
  await expect(f.service.reviewSummary("staged")).rejects.toMatchObject({ code: "GIT_TIMEOUT" });
});

test("HEAD/index/status movement across a summary rejects the observed result", async () => {
  const f = await fixture();
  const native = f.service as unknown as { git(args: string[], options?: unknown): Promise<{ stdout: string; exitCode: number }> };
  const run = native.git.bind(f.service); let changed = false;
  native.git = async (args, options) => {
    const result = await run(args, options);
    if (!changed && args.includes("--numstat")) { changed = true; await writeFile(join(f.cwd, "tracked.txt"), "changed\n"); git(f.cwd, "add", "."); }
    return result;
  };
  await expect(f.service.reviewSummary("staged")).rejects.toMatchObject({ code: "GIT_CHANGED" });
});

test("missing untracked stats and cross-file count overflow cannot masquerade as valid totals", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "new-a"), "a\n"); await writeFile(join(f.cwd, "new-b"), "b\n");
  const native = f.service as unknown as { git(args: string[], options?: unknown): Promise<{ stdout: string; exitCode: number }> };
  const run = native.git.bind(f.service);
  native.git = async (args, options) => args.includes("--no-index") ? { stdout: "", exitCode: 1 } : run(args, options);
  await expect(f.service.reviewSummary("unstaged")).rejects.toMatchObject({ code: "GIT_FAILED" });
  native.git = async (args, options) => args.includes("--no-index") ? { stdout: "9007199254740991\t0\tfile\0", exitCode: 1 } : run(args, options);
  await expect(f.service.reviewSummary("unstaged")).rejects.toMatchObject({ code: "GIT_FAILED" });
});

async function owners() {
  const f = await fixture(); await mkdir(join(f.cwd, "nested"));
  const sessionCwd = join(f.root, "session"); git(f.cwd, "worktree", "add", "-qb", "session", sessionCwd);
  await writeFile(join(f.cwd, "project-note"), "one\n"); await writeFile(join(sessionCwd, "session-note"), "two\nthree\n");
  const store = new HostStore(join(f.root, "data")); stores.push(store); const project = store.addProject({ path: join(f.cwd, "nested") });
  const session = { id: "review-session", hostId: store.host.id, projectId: project.id, cwd: sessionCwd, title: "Review", status: "idle" as const, sessionFile: join(f.root, "unused.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false };
  store.upsertSession(session);
  const workspaces = new HostWorkspaces(store, join(f.root, "data"), () => { throw new Error("read-only query must not reserve a mutation"); });
  return { ...f, store, project, session, workspaces };
}

test("query follows nested project/session authority and refuses standalone and invalid sources", async () => {
  const f = await owners();
  for (const [target, additions] of [[{ projectId: f.project.id }, 1], [{ sessionId: f.session.id }, 2]] as const) {
    const result = await f.workspaces.query(target, parseWorkspaceQuery({ type: "git.review-summary", source: "unstaged" }));
    expect(result.type).toBe("git.review-summary"); if (result.type !== "git.review-summary") throw new Error("wrong response");
    expect(totals(result.summary)).toEqual([additions, 0]);
  }
  await expect(f.workspaces.query({ filePath: join(f.cwd, "tracked.txt") }, { type: "git.review-summary", source: "staged" })).rejects.toThrow("standalone file");
  for (const source of [undefined, null, "uncommitted", true]) expect(() => parseWorkspaceQuery({ type: "git.review-summary", source })).toThrow("staged or unstaged");
});

test("catalog retarget during async read cannot publish the prior owner's summary", async () => {
  const f = await owners(), original = WorkspaceService.prototype.reviewSummary;
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { reached = resolve; });
  WorkspaceService.prototype.reviewSummary = async function(source) { const result = await original.call(this, source); reached(); await gate; return result; };
  try {
    const pending = f.workspaces.query({ sessionId: f.session.id }, { type: "git.review-summary", source: "unstaged" });
    await entered; f.store.upsertSession({ ...f.session, cwd: f.cwd }); release();
    await expect(pending).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  } finally { release(); WorkspaceService.prototype.reviewSummary = original; }
});
