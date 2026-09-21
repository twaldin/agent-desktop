import { afterEach, expect, test } from "bun:test";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceService } from "./service";
import { GitCommitReviewReader } from "./git-commit-review";
import { HostWorkspaces, parseWorkspaceQuery } from "../workspace-http";
import type { HostStore } from "../store";
import { createGitCommitReviewFixture } from "../../../../scripts/acceptance/git-commit-review-fixture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const value = await createGitCommitReviewFixture(); roots.push(value.root); return { ...value, service: new WorkspaceService(value.cwd) }; }

test("owning service lists the branch range and reads selected historical content without repository writes", async () => {
  const f = await fixture(), before = await f.snapshot(), list = await f.service.commitReviewCommits("main");
  expect(list.commits.map(row => row.commit)).toEqual([f.merge, f.firstParent, f.side, f.empty, f.changed]);
  const selection = { repositoryId: list.repositoryId, commit: f.changed }, review = await f.service.commitReview(selection);
  expect(review.parent).toBe(f.first);
  expect((await f.service.commitReviewDiff(selection, { path: f.path, previousPath: f.oldPath })).patch).toContain("+original updated line 20");
  expect((await f.service.commitReviewCommits("HEAD")).commits).toEqual([]);
  expect((await f.service.commitReviewCommits("missing-base")).commits).toEqual([]);
  expect(await f.snapshot()).toEqual(before);
});

test("Commit default base uses cached remote refs without remote advertisement or fetching", async () => {
  const f = await fixture();
  f.git(["remote", "add", "origin", join(f.root, "unavailable-remote")]);
  f.git(["update-ref", "refs/remotes/origin/main", f.first]);
  const before = await f.snapshot(), result = await f.service.commitReviewCommits();
  expect(result.commits.map(row => row.commit)).toContain(f.changed);
  expect(result.mergeBase).toBe(f.first);
  expect(await f.snapshot()).toEqual(before);
});

test("missing HEAD objects are errors, not authoritative empty history; unborn HEAD remains empty", async () => {
  const f = await fixture();
  const object = join(f.cwd, ".git", "objects", f.merge.slice(0, 2), f.merge.slice(2)), backup = join(f.root, "head-object");
  await rename(object, backup);
  try { await expect(f.service.commitReviewCommits("main")).rejects.toThrow(); }
  finally { await rename(backup, object); }
  expect((await f.service.commitReviewCommits("main")).commits.map(row => row.commit)).toContain(f.changed);
  f.git(["symbolic-ref", "HEAD", "refs/heads/unborn"]);
  expect(await f.service.commitReviewCommits("main")).toMatchObject({ head: null, commits: [] });
});

test("list read refuses a base ref moved after resolution instead of returning mismatched picker contents", async () => {
  const f = await fixture(), original = GitCommitReviewReader.prototype.commits;
  GitCommitReviewReader.prototype.commits = async function (...args) {
    const value = await original.apply(this, args);
    f.git(["update-ref", "refs/heads/main", f.changed]);
    return value;
  };
  try { await expect(f.service.commitReviewCommits("main")).rejects.toMatchObject({ code: "GIT_CHANGED" }); }
  finally { GitCommitReviewReader.prototype.commits = original; }
});

test("nested project Commit requests retain root paths and fail when catalog owner is retargeted", async () => {
  const f = await fixture();
  let project = { id: "project", hostId: "host", path: join(f.cwd, "src") };
  const store = { host: { id: "host" }, getProject: (id: string) => id === "project" ? project : undefined, getSession: () => undefined } as unknown as HostStore;
  const host = new HostWorkspaces(store, join(f.root, "data"), () => { throw new Error("Commit review cannot reserve mutations"); });
  try {
    const response = await host.query({ projectId: "project" }, { type: "git.commit-review-commits", baseBranch: "main" });
    if (response.type !== "git.commit-review-commits") throw new Error("Wrong list response");
    const selection = { repositoryId: response.list.repositoryId, commit: f.changed };
    const review = await host.query({ projectId: "project" }, { type: "git.commit-review", selection });
    expect(review.type === "git.commit-review" && review.review.files.some(file => file.path === f.path)).toBe(true);
    await expect(host.query({ filePath: join(f.cwd, f.path) }, { type: "git.commit-review", selection })).rejects.toThrow();
    const original = WorkspaceService.prototype.commitReview;
    WorkspaceService.prototype.commitReview = async function (...args) { const value = await original.apply(this, args); project = { ...project, path: f.cwd }; return value; };
    try { await expect(host.query({ projectId: "project" }, { type: "git.commit-review", selection })).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" }); }
    finally { WorkspaceService.prototype.commitReview = original; }
  } finally { await host.shutdownSubmissions(); }
});

test("immutable requests reject mutable revisions, escapes and replaced repositories", async () => {
  const f = await fixture(), list = await f.service.commitReviewCommits("main"), selection = { repositoryId: list.repositoryId, commit: f.changed };
  expect(() => parseWorkspaceQuery({ type: "git.commit-review", selection: { ...selection, commit: "HEAD" } })).toThrow();
  expect(() => parseWorkspaceQuery({ type: "git.commit-review-diff", selection, file: { path: "../outside" } })).toThrow();
  await expect(f.service.commitReview({ ...selection, repositoryId: "e".repeat(64) })).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  await rename(f.cwd, `${f.cwd}-old`); await mkdir(f.cwd);
  await expect(f.service.commitReview(selection)).rejects.toMatchObject({ code: "PATH_CHANGED" });
});
