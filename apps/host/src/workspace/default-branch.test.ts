import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostWorkspaces, parseWorkspaceQuery } from "../workspace-http";
import type { HostStore } from "../store";
import { WorkspaceError, WorkspaceService } from "./service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function git(cwd: string, args: string[], extra: Record<string, string> = {}): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", ...extra } });
  if (!result.success) throw new Error(result.stderr.toString()); return result.stdout.toString().trimEnd();
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-default-branch-"))); roots.push(root);
  const cwd = join(root, "repository"); await mkdir(cwd); await mkdir(join(root, "hooks"));
  git(cwd, ["init", "--initial-branch=main"]); git(cwd, ["config", "user.name", "Default Fixture"]);
  git(cwd, ["config", "user.email", "default@example.invalid"]); git(cwd, ["config", "commit.gpgSign", "false"]);
  git(cwd, ["config", "core.hooksPath", join(root, "hooks")]);
  await writeFile(join(cwd, "tracked"), "committed\n"); git(cwd, ["add", "tracked"]);
  git(cwd, ["commit", "-m", "old"], { GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" });
  const head = git(cwd, ["rev-parse", "HEAD"]), tree = git(cwd, ["rev-parse", "HEAD^{tree}"]);
  const newer = git(cwd, ["commit-tree", tree, "-m", "new"], { GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" });
  await writeFile(join(cwd, "tracked"), "staged\n"); git(cwd, ["add", "tracked"]);
  await writeFile(join(cwd, "tracked"), "unstaged\n"); await writeFile(join(cwd, "untracked"), "retain\n");
  async function remote(name: string, branch: string | null = null) {
    const path = join(root, `${name}.git`); await mkdir(path); git(path, ["init", "--bare", "--initial-branch=unborn"]);
    if (branch) { git(cwd, ["push", path, `${head}:refs/heads/${branch}`]); git(path, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]); }
    git(cwd, ["remote", "add", name, path]); return path;
  }
  const snapshot = async () => ({ index: (await readFile(join(cwd, ".git/index"))).toString("base64"),
    head: await readFile(join(cwd, ".git/HEAD"), "utf8"), config: await readFile(join(cwd, ".git/config"), "utf8"),
    reflog: await readFile(join(cwd, ".git/logs/HEAD"), "utf8"), refs: git(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"]),
    tracked: await readFile(join(cwd, "tracked"), "utf8"), untracked: await readFile(join(cwd, "untracked"), "utf8") });
  return { root, cwd, head, newer, remote, snapshot, service: new WorkspaceService(cwd) };
}
type Runner = { git(args: string[], options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; validExitCodes?: number[] }): Promise<{ stdout: string; exitCode: number }> };

test("default branch uses origin first and local symbolic defaults without contacting any remote", async () => {
  const f = await fixture(); await f.remote("alpha", "alpha-default"); await f.remote("origin", "origin-default");
  git(f.cwd, ["update-ref", "refs/remotes/alpha/alpha-default", f.head]); git(f.cwd, ["symbolic-ref", "refs/remotes/alpha/HEAD", "refs/remotes/alpha/alpha-default"]);
  git(f.cwd, ["update-ref", "refs/remotes/origin/local-choice", f.head]); git(f.cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/local-choice"]);
  const runner = f.service as unknown as Runner, original = runner.git.bind(f.service); let remoteCalls = 0;
  runner.git = async (args, options) => { if (args[0] === "remote" && args[1] === "show") { remoteCalls++; throw new Error("Unexpected remote discovery"); } return original(args, options); };
  const before = await f.snapshot(); expect(await f.service.defaultBranch()).toBe("local-choice"); expect(remoteCalls).toBe(0); expect(await f.snapshot()).toEqual(before);
});

test("default branch reads a bare local remote advertisement without fetching or modifying working state", async () => {
  const f = await fixture(), remote = await f.remote("origin", "release/default");
  const before = await f.snapshot(), remoteBefore = git(remote, ["for-each-ref", "--format=%(refname)%00%(objectname)"]);
  const runner = f.service as unknown as Runner, original = runner.git.bind(f.service), calls: string[][] = [];
  runner.git = async (args, options) => { calls.push(args); if (args[0] === "remote" && args[1] === "show") {
    expect(options?.timeoutMs).toBe(10_000); expect(options?.env).toMatchObject({ LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" });
  } return original(args, options); };
  expect(await f.service.defaultBranch()).toBe("release/default");
  expect(calls.filter(args => args[0] === "remote" && args[1] === "show")).toEqual([["remote", "show", "--", "origin"]]);
  expect(calls.some(args => args.includes("fetch"))).toBe(false);
  expect(await f.snapshot()).toEqual(before); expect(git(remote, ["for-each-ref", "--format=%(refname)%00%(objectname)"])).toBe(remoteBefore);
});

test("default branch tries remote main then master before advancing to the next remote", async () => {
  const f = await fixture(); await f.remote("alpha", "later"); await f.remote("origin");
  git(f.cwd, ["update-ref", "refs/remotes/origin/master", f.head]); git(f.cwd, ["update-ref", "refs/remotes/origin/main", f.head]);
  expect(await f.service.defaultBranch()).toBe("main");
  git(f.cwd, ["update-ref", "-d", "refs/remotes/origin/main"]); expect(await f.service.defaultBranch()).toBe("master");
  git(f.cwd, ["update-ref", "-d", "refs/remotes/origin/master"]); expect(await f.service.defaultBranch()).toBe("later");
});

test("default branch fallback only considers the first ten recent local heads", async () => {
  const f = await fixture(); expect(await f.service.defaultBranch()).toBe("main");
  git(f.cwd, ["update-ref", "refs/heads/master", f.newer]); expect(await f.service.defaultBranch()).toBe("master");
  git(f.cwd, ["update-ref", "-d", "refs/heads/master"]);
  for (let i = 0; i < 11; i++) git(f.cwd, ["update-ref", `refs/heads/new-${i}`, f.newer]);
  expect(await f.service.defaultBranch()).toBeNull();
  const empty = join(f.root, "empty"); await mkdir(empty); git(empty, ["init", "--initial-branch=main"]);
  expect(await new WorkspaceService(empty).defaultBranch()).toBeNull();
});

test("default branch permits a normal failed advertisement fallback but preserves operational failures", async () => {
  const f = await fixture(); git(f.cwd, ["remote", "add", "origin", join(f.root, "does-not-exist")]);
  git(f.cwd, ["update-ref", "refs/remotes/origin/master", f.head]); expect(await f.service.defaultBranch()).toBe("master");
  const runner = f.service as unknown as Runner, original = runner.git.bind(f.service); let readsAfterFailure = 0;
  for (const code of ["GIT_TIMEOUT", "GIT_OUTPUT_TOO_LARGE", "GIT_FAILED"]) {
    let failed = false;
    runner.git = async (args, options) => {
      if (failed) readsAfterFailure++;
      if (args[0] === "remote" && args[1] === "show") { failed = true; throw new WorkspaceError(code, "controlled operational failure"); }
      return original(args, options);
    };
    await expect(f.service.defaultBranch()).rejects.toMatchObject({ code });
  }
  expect(readsAfterFailure).toBe(0); runner.git = original;
});

test("default branch query revalidates its project or session owner even for a null result", async () => {
  const f = await fixture(), nested = join(f.cwd, "app"); await mkdir(nested);
  let project = { id: "project", hostId: "host", path: nested }, session = { id: "session", hostId: "host", projectId: "project", cwd: nested };
  const store = { host: { id: "host" }, getProject: (id: string) => id === "project" ? project : undefined,
    getSession: (id: string) => id === "session" ? session : undefined } as unknown as HostStore;
  const workspaces = new HostWorkspaces(store, join(f.root, "data"), () => { throw new Error("No mutation reservation"); });
  const query = parseWorkspaceQuery({ type: "git.default-branch" }), original = WorkspaceService.prototype.defaultBranch;
  try {
    expect(await workspaces.query({ projectId: "project" }, query)).toEqual({ type: "git.default-branch", branch: "main" });
    expect(await workspaces.query({ sessionId: "session" }, query)).toEqual({ type: "git.default-branch", branch: "main" });
    await expect(workspaces.query({ filePath: join(f.cwd, "tracked") }, query)).rejects.toThrow();
    WorkspaceService.prototype.defaultBranch = async function() { const result = await original.call(this); project = { ...project, path: f.root }; return result; };
    await expect(workspaces.query({ projectId: "project" }, query)).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
    git(f.cwd, ["branch", "-m", "topic"]);
    WorkspaceService.prototype.defaultBranch = async function() { const result = await original.call(this); expect(result).toBeNull(); session = { ...session, cwd: f.root }; return result; };
    await expect(workspaces.query({ sessionId: "session" }, query)).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  } finally { WorkspaceService.prototype.defaultBranch = original; await workspaces.shutdownSubmissions(); }
});
