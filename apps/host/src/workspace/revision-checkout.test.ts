import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceService } from "./service";
import { HostWorkspaces, parseWorkspaceMutation } from "../workspace-http";
import type { HostStore } from "../store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: {
    PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C",
  } });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trimEnd();
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-revision-checkout-"))); roots.push(root);
  const cwd = join(root, "repository"), hooks = join(root, "hooks"); await mkdir(cwd); await mkdir(hooks);
  git(cwd, "init", "--initial-branch=main"); git(cwd, "config", "user.name", "Revision Fixture");
  git(cwd, "config", "user.email", "revision@example.invalid"); git(cwd, "config", "commit.gpgSign", "false");
  git(cwd, "config", "tag.gpgSign", "false"); git(cwd, "config", "core.hooksPath", hooks);
  await writeFile(join(cwd, "tracked"), "one\n"); await writeFile(join(cwd, "stable"), "stable\n");
  git(cwd, "add", "."); git(cwd, "commit", "-m", "one"); const first = git(cwd, "rev-parse", "HEAD");
  git(cwd, "tag", "-a", "v1", "-m", "one");
  await writeFile(join(cwd, "tracked"), "two\n"); git(cwd, "commit", "-am", "two"); const head = git(cwd, "rev-parse", "HEAD");
  const service = new WorkspaceService(cwd), revision = { expression: "v1", commit: first };
  const snapshot = async () => ({ index: (await readFile(join(cwd, ".git/index"))).toString("base64"),
    head: await readFile(join(cwd, ".git/HEAD"), "utf8"), config: await readFile(join(cwd, ".git/config"), "utf8"),
    reflog: await readFile(join(cwd, ".git/logs/HEAD"), "utf8"), refs: git(cwd, "for-each-ref", "--format=%(refname)%00%(objectname)"),
    tracked: await readFile(join(cwd, "tracked"), "utf8"), stable: await readFile(join(cwd, "stable"), "utf8") });
  return { root, cwd, hooks, first, head, service, revision, snapshot };
}

test("revision checkout parser requires exact commit and status identities", () => {
  const revision = { expression: " v1 ", commit: "a".repeat(40) }, expectedRevision = "b".repeat(64);
  expect(parseWorkspaceMutation({ type: "git.checkout-revision", revision, expectedRevision }))
    .toEqual({ type: "git.checkout-revision", revision: { ...revision, expression: "v1" }, expectedRevision });
  for (const value of [null, {}, { expression: "HEAD", commit: "HEAD" }, { expression: "x\0", commit: revision.commit }])
    expect(() => parseWorkspaceMutation({ type: "git.checkout-revision", revision: value, expectedRevision })).toThrow();
  expect(() => parseWorkspaceMutation({ type: "git.checkout-revision", revision, expectedRevision: "stale" })).toThrow();
});

test("revision checkout detaches at reviewed tag commit and retains compatible staged and unstaged edits", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "stable"), "staged\n"); git(f.cwd, "add", "stable");
  await writeFile(join(f.cwd, "stable"), "unstaged\n"); await writeFile(join(f.cwd, "untracked"), "retained\n");
  const config = await readFile(join(f.cwd, ".git/config"), "utf8"), refs = git(f.cwd, "show-ref"), status = await f.service.gitStatus();
  const result = await f.service.checkoutRevision(f.revision, status.revision);
  expect(result).toMatchObject({ branch: null, head: f.first });
  expect(await readFile(join(f.cwd, "tracked"), "utf8")).toBe("one\n");
  expect(await readFile(join(f.cwd, "stable"), "utf8")).toBe("unstaged\n");
  expect(git(f.cwd, "show", ":stable")).toBe("staged");
  expect(await readFile(join(f.cwd, "untracked"), "utf8")).toBe("retained\n");
  expect(await readFile(join(f.cwd, ".git/config"), "utf8")).toBe(config); expect(git(f.cwd, "show-ref")).toBe(refs);
  const before = await f.snapshot(); let admitted = 0, switches = 0;
  const runner = f.service as unknown as { git: (args: string[], options?: unknown) => Promise<unknown> };
  const original = runner.git.bind(f.service);
  runner.git = (args, options) => { if (args.includes("switch")) switches++; return original(args, options); };
  expect((await f.service.checkoutRevision(f.revision, result.revision, () => admitted++)).head).toBe(f.first);
  expect(admitted).toBe(1); expect(switches).toBe(0); expect(await f.snapshot()).toEqual(before);
});

test("revision checkout rejects missing or moved target, stale status and dirty conflict before losing source state", async () => {
  const f = await fixture(), status = await f.service.gitStatus(), before = await f.snapshot();
  await expect(f.service.checkoutRevision({ ...f.revision, expression: "absent" }, status.revision)).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
  await expect(f.service.checkoutRevision({ ...f.revision, commit: f.head }, status.revision)).rejects.toMatchObject({ code: "REVISION_CHANGED" });
  expect(await f.snapshot()).toEqual(before);
  await writeFile(join(f.cwd, "tracked"), "dirty\n"); git(f.cwd, "add", "tracked"); const dirty = await f.snapshot();
  await expect(f.service.checkoutRevision(f.revision, status.revision)).rejects.toMatchObject({ code: "GIT_REVISION_CONFLICT" });
  await expect(f.service.checkoutRevision(f.revision, (await f.service.gitStatus()).revision)).rejects.toMatchObject({ code: "GIT_CHECKOUT_BLOCKED", conflictedPaths: ["tracked"] });
  expect(await f.snapshot()).toEqual(dirty);
});

test("revision checkout rechecks status after resolution and never dispatches a moved expression", async () => {
  const f = await fixture(), status = await f.service.gitStatus();
  const original = f.service.resolveRevision.bind(f.service);
  f.service.resolveRevision = async input => { const result = await original(input); await writeFile(join(f.cwd, "tracked"), "changed during resolution\n"); git(f.cwd, "add", "tracked"); return result; };
  await expect(f.service.checkoutRevision(f.revision, status.revision)).rejects.toMatchObject({ code: "GIT_REVISION_CONFLICT" });
  expect(git(f.cwd, "branch", "--show-current")).toBe("main");
  f.service.resolveRevision = original;
  git(f.cwd, "restore", "--staged", "--worktree", "tracked"); const refreshed = await f.service.gitStatus();
  const result = await f.service.checkoutRevision(f.revision, refreshed.revision, () => { git(f.cwd, "tag", "-f", "v1", f.head); });
  expect(result).toMatchObject({ branch: null, head: f.first });
  expect(git(f.cwd, "rev-parse", "v1")).toBe(f.head);
  expect(git(f.cwd, "reflog", "--format=%gs").split("\n").filter(row => row.startsWith("checkout:"))).toHaveLength(1);
});

test("revision checkout owner is revalidated even for no-op and reservations release after refusal", async () => {
  const f = await fixture(); let project = { id: "project", hostId: "host", path: f.cwd }, reservations = 0, releases = 0;
  const store = { host: { id: "host" }, getProject: () => project, getSession: () => undefined } as unknown as HostStore;
  const host = new HostWorkspaces(store, join(f.root, "data"), () => { reservations++; return () => { releases++; }; });
  try {
    let status = await f.service.gitStatus();
    const result = await host.mutate({ projectId: "project" }, { type: "git.checkout-revision", revision: f.revision, expectedRevision: status.revision });
    expect(result).toMatchObject({ type: "git.checkout-revision", status: { branch: null, head: f.first } });
    status = await f.service.gitStatus(); const before = await f.snapshot();
    const original = WorkspaceService.prototype.resolveRevision;
    WorkspaceService.prototype.resolveRevision = async function (...args) { const result = await original.apply(this, args); project = { ...project, path: join(f.root, "replacement") }; return result; };
    try { await expect(host.mutate({ projectId: "project" }, { type: "git.checkout-revision", revision: f.revision, expectedRevision: status.revision })).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" }); }
    finally { WorkspaceService.prototype.resolveRevision = original; }
    expect(await f.snapshot()).toEqual(before); expect(reservations).toBe(2); expect(releases).toBe(2);
    await expect(host.mutate({ filePath: join(f.cwd, "tracked") }, { type: "git.checkout-revision", revision: f.revision, expectedRevision: status.revision })).rejects.toThrow();
  } finally { await host.shutdownSubmissions(); }
});

test("revision checkout verifies post-hook state and records unconfirmed changed state as unknown", async () => {
  const f = await fixture();
  await writeFile(join(f.hooks, "post-checkout"), '#!/bin/sh\ngit symbolic-ref HEAD refs/heads/main\nexit 1\n');
  await chmod(join(f.hooks, "post-checkout"), 0o755);
  const status = await f.service.gitStatus();
  await expect(f.service.checkoutRevision(f.revision, status.revision)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(git(f.cwd, "branch", "--show-current")).toBe("main");
  expect(await readFile(join(f.cwd, "tracked"), "utf8")).toBe("one\n");
});

test("revision checkout refuses overwriting an ignored working file", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "blocked"), "target\n"); git(f.cwd, "add", "blocked"); git(f.cwd, "commit", "-m", "target file");
  const commit = git(f.cwd, "rev-parse", "HEAD"); git(f.cwd, "switch", "--detach", f.head);
  await writeFile(join(f.cwd, ".git/info/exclude"), "blocked\n"); await writeFile(join(f.cwd, "blocked"), "ignored local data\n");
  const before = await f.snapshot(), status = await f.service.gitStatus();
  await expect(f.service.checkoutRevision({ expression: commit, commit }, status.revision)).rejects.toMatchObject({ code: "GIT_CHECKOUT_BLOCKED", conflictedPaths: ["blocked"] });
  expect(await readFile(join(f.cwd, "blocked"), "utf8")).toBe("ignored local data\n");
  expect(await f.snapshot()).toEqual(before);
});

test("revision checkout keeps an unverified successful dispatch unknown without replay", async () => {
  const f = await fixture(), status = await f.service.gitStatus();
  const reader = f.service as unknown as { readGitStatus: () => Promise<unknown> };
  const original = reader.readGitStatus.bind(f.service); let reads = 0;
  reader.readGitStatus = () => { if (++reads === 2) throw new Error("controlled receipt observation failure"); return original(); };
  try { await expect(f.service.checkoutRevision(f.revision, status.revision)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" }); }
  finally { reader.readGitStatus = original; }
  expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.first);
  expect(git(f.cwd, "branch", "--show-current")).toBe("");
  expect(git(f.cwd, "reflog", "--format=%gs").split("\n").filter(row => row.startsWith("checkout:"))).toHaveLength(1);
});
