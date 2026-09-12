import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceService } from "./service";
import { HostWorkspaces, parseWorkspaceMutation } from "../workspace-http";
import type { HostStore } from "../store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: {
    PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C",
  } });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trimEnd();
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-ref-checkout-"))); roots.push(root);
  const cwd = join(root, "repository"); await mkdir(cwd); await mkdir(join(root, "no-hooks"));
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.name", "Branch Fixture"); git(cwd, "config", "user.email", "branch@example.invalid");
  git(cwd, "config", "commit.gpgSign", "false"); git(cwd, "config", "core.hooksPath", join(root, "no-hooks"));
  await writeFile(join(cwd, "tracked"), "committed\n"); git(cwd, "add", "tracked"); git(cwd, "commit", "-m", "fixture");
  const head = git(cwd, "rev-parse", "HEAD");
  // Native tracking uses the local remote configuration; no remote process/fetch.
  git(cwd, "remote", "add", "origin", join(root, "never-contacted"));
  git(cwd, "update-ref", "refs/remotes/origin/topic", head);
  const service = new WorkspaceService(cwd);
  const selection = { ref: "refs/remotes/origin/topic", commit: head, localBranch: "topic" };
  const snapshot = async () => ({
    index: (await readFile(join(cwd, ".git/index"))).toString("base64"),
    head: await readFile(join(cwd, ".git/HEAD"), "utf8"), config: await readFile(join(cwd, ".git/config"), "utf8"),
    refs: git(cwd, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"),
    file: await readFile(join(cwd, "tracked"), "utf8"),
  });
  return { root, cwd, head, service, selection, snapshot };
}

test("ref checkout parser requires exact reviewed identity and explicit remote local name", () => {
  const commit = "a".repeat(40), expectedRevision = "b".repeat(64);
  expect(parseWorkspaceMutation({ type: "git.checkout-ref", selection: { ref: "refs/heads/topic", commit }, expectedRevision }))
    .toEqual({ type: "git.checkout-ref", selection: { ref: "refs/heads/topic", commit }, expectedRevision });
  for (const selection of [null, { ref: "topic", commit }, { ref: "refs/tags/v1", commit },
    { ref: "refs/remotes/origin/topic", commit }, { ref: "refs/heads/topic", commit, localBranch: "rename" },
    { ref: "refs/heads/topic", commit: "HEAD" }, { ref: "refs/remotes/origin/topic", commit, localBranch: "--detach" },
    { ref: "refs/heads/topic\n", commit }]) {
    expect(() => parseWorkspaceMutation({ type: "git.checkout-ref", selection, expectedRevision })).toThrow();
  }
  expect(() => parseWorkspaceMutation({ type: "git.checkout-ref", selection: { ref: "refs/heads/topic", commit }, expectedRevision: "old" })).toThrow();
});

test("actual remote selection creates one explicit local tracking branch and retains compatible edits", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "tracked"), "local edit\n"); await writeFile(join(f.cwd, "untracked"), "retain\n");
  const status = await f.service.gitStatus();
  const result = await f.service.checkoutRef(f.selection, status.revision);
  expect(result).toMatchObject({ branch: "topic", head: f.head });
  expect(git(f.cwd, "for-each-ref", "--format=%(upstream)", "refs/heads/topic")).toBe(f.selection.ref);
  expect(git(f.cwd, "config", "branch.topic.remote")).toBe("origin");
  expect(git(f.cwd, "config", "branch.topic.merge")).toBe("refs/heads/topic");
  expect(await readFile(join(f.cwd, "tracked"), "utf8")).toBe("local edit\n");
  expect(await readFile(join(f.cwd, "untracked"), "utf8")).toBe("retain\n");
  expect(git(f.cwd, "reflog", "--format=%gs").split("\n").filter(line => line.startsWith("checkout:"))).toEqual(["checkout: moving from main to topic"]);
  const local = await f.service.checkoutRef({ ref: "refs/heads/main", commit: f.head }, result.revision);
  expect(local.branch).toBe("main");
});

test("local collision, stale ref, symbolic ref and invalid history expression do not mutate the repository", async () => {
  const f = await fixture(); git(f.cwd, "branch", "topic");
  let status = await f.service.gitStatus(), before = await f.snapshot();
  await expect(f.service.checkoutRef(f.selection, status.revision)).rejects.toMatchObject({ code: "BRANCH_EXISTS" });
  expect(await f.snapshot()).toEqual(before);
  git(f.cwd, "symbolic-ref", "refs/remotes/origin/alias", f.selection.ref);
  before = await f.snapshot();
  await expect(f.service.checkoutRef({ ...f.selection, ref: "refs/remotes/origin/alias", localBranch: "alias" }, status.revision)).rejects.toMatchObject({ code: "SYMBOLIC_BRANCH" });
  await expect(f.service.checkoutRef({ ...f.selection, commit: "f".repeat(40), localBranch: "new" }, status.revision)).rejects.toMatchObject({ code: "BRANCH_CHANGED" });
  await expect(f.service.checkoutRef({ ...f.selection, ref: "refs/remotes/origin/absent", localBranch: "new" }, status.revision)).rejects.toMatchObject({ code: "BRANCH_NOT_FOUND" });
  await expect(f.service.checkoutRef({ ...f.selection, localBranch: "@{-1}" }, status.revision)).rejects.toThrow();
  expect(await f.snapshot()).toEqual(before);
  git(f.cwd, "commit", "--allow-empty", "-m", "external change");
  before = await f.snapshot();
  await expect(f.service.checkoutRef({ ...f.selection, localBranch: "new" }, status.revision)).rejects.toMatchObject({ code: "GIT_REVISION_CONFLICT" });
  expect(await f.snapshot()).toEqual(before);
});

test("dirty conflict preserves source bytes and reports failure without creating a branch", async () => {
  const f = await fixture();
  git(f.cwd, "switch", "-c", "target-content"); await writeFile(join(f.cwd, "tracked"), "remote content\n");
  git(f.cwd, "add", "tracked"); git(f.cwd, "commit", "-m", "different content");
  const target = git(f.cwd, "rev-parse", "HEAD"); git(f.cwd, "update-ref", f.selection.ref, target);
  git(f.cwd, "switch", "main"); await writeFile(join(f.cwd, "tracked"), "local content to retain\n");
  const status = await f.service.gitStatus(), before = await f.snapshot();
  await expect(f.service.checkoutRef({ ...f.selection, commit: target }, status.revision)).rejects.toMatchObject({ code: "GIT_CHECKOUT_BLOCKED", conflictedPaths: ["tracked"] });
  expect(await f.snapshot()).toEqual(before);
});

test("host ref checkout revalidates catalog owner at dispatch and always releases reservation", async () => {
  const f = await fixture(); let project = { id: "project", hostId: "host", path: f.cwd }, reservations = 0, releases = 0;
  const store = { host: { id: "host" }, getProject: () => project, getSession: () => undefined } as unknown as HostStore;
  const host = new HostWorkspaces(store, join(f.root, "data"), () => { reservations++; return () => { releases++; }; });
  const status = await f.service.gitStatus(), before = await f.snapshot();
  const original = WorkspaceService.prototype.branches;
  WorkspaceService.prototype.branches = async function() { const result = await original.call(this); project = { ...project, path: join(f.root, "replaced") }; return result; };
  try {
    await expect(host.mutate({ projectId: "project" }, { type: "git.checkout-ref", selection: f.selection, expectedRevision: status.revision })).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  } finally { WorkspaceService.prototype.branches = original; }
  expect(reservations).toBe(1); expect(releases).toBe(1); expect(await f.snapshot()).toEqual(before);
  project = { ...project, path: f.cwd };
  const result = await host.mutate({ projectId: "project" }, { type: "git.checkout-ref", selection: f.selection, expectedRevision: status.revision });
  expect(result).toMatchObject({ type: "git.checkout-ref", status: { branch: "topic", head: f.head } });
  expect(reservations).toBe(2); expect(releases).toBe(2);
  await expect(host.mutate({ filePath: join(f.cwd, "tracked") }, { type: "git.checkout-ref", selection: f.selection, expectedRevision: status.revision })).rejects.toThrow();
  await host.shutdownSubmissions();
});


test("post-checkout hook returning HEAD to source retains unknown branch/config outcome", async () => {
  const f = await fixture();
  const hook = join(f.root, "no-hooks/post-checkout");
  await writeFile(hook, '#!/bin/sh\ngit symbolic-ref HEAD refs/heads/main\nexit 1\n'); await chmod(hook, 0o755);
  const status = await f.service.gitStatus();
  await expect(f.service.checkoutRef(f.selection, status.revision)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(git(f.cwd, "branch", "--show-current")).toBe("main");
  expect(git(f.cwd, "show-ref", "--verify", "--hash", "refs/heads/topic")).toBe(f.head);
  expect(git(f.cwd, "config", "branch.topic.remote")).toBe("origin");
});

test("ref changed after admission cannot be reported as the reviewed commit", async () => {
  const f = await fixture();
  git(f.cwd, "commit", "--allow-empty", "-m", "later commit");
  const later = git(f.cwd, "rev-parse", "HEAD"), status = await f.service.gitStatus();
  // Deliberate external ref update in the final synchronous admission callback.
  await expect(f.service.checkoutRef(f.selection, status.revision, () => { git(f.cwd, "update-ref", f.selection.ref, later); }))
    .rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(git(f.cwd, "branch", "--show-current")).toBe("topic");
  expect(git(f.cwd, "rev-parse", "HEAD")).toBe(later);
  expect(git(f.cwd, "reflog", "--format=%gs").split("\n").filter(line => line.startsWith("checkout:"))).toHaveLength(1);
});
