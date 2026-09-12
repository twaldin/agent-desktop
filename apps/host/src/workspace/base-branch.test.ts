import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostWorkspaces, parseWorkspaceQuery } from "../workspace-http";
import type { HostStore } from "../store";
import { WorkspaceError, WorkspaceService } from "./service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" } });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trimEnd();
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-base-branch-"))); roots.push(root);
  const cwd = join(root, "repository"); await mkdir(cwd); git(cwd, ["init", "--initial-branch=main"]);
  git(cwd, ["config", "user.name", "Base Fixture"]); git(cwd, ["config", "user.email", "base@example.invalid"]);
  await writeFile(join(cwd, "tracked"), "committed\n"); git(cwd, ["add", "tracked"]); git(cwd, ["commit", "-m", "baseline"]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  return { root, cwd, head, service: new WorkspaceService(cwd) };
}

test("base branch keeps the selected remote, including remote names containing slashes", async () => {
  const f = await fixture();
  git(f.cwd, ["remote", "add", "origin/team", join(f.root, "unused-remote")]);
  git(f.cwd, ["update-ref", "refs/remotes/origin/team/release/default", f.head]);
  git(f.cwd, ["symbolic-ref", "refs/remotes/origin/team/HEAD", "refs/remotes/origin/team/release/default"]);
  expect(await f.service.baseBranch()).toEqual({ local: "release/default", remote: "origin/team" });
});

test("base branch has no local fallback while default branch retains its bounded local fallback", async () => {
  const f = await fixture();
  expect(await f.service.baseBranch()).toBeNull();
  expect(await f.service.defaultBranch()).toBe("main");
});

test("base branch checks origin first and preserves normal failed-advertisement fallback", async () => {
  const f = await fixture();
  const runner = f.service as unknown as { git: (args: string[], options?: unknown) => Promise<{ stdout: string; exitCode: number }> };
  (f.service as unknown as { requireGitRoot: () => Promise<void> }).requireGitRoot = async () => {};
  runner.git = async args => {
    if (args[0] === "remote" && args.length === 1) return { stdout: "alpha\norigin\n", exitCode: 0 };
    if (args[0] === "symbolic-ref") return { stdout: "", exitCode: 1 };
    if (args[0] === "remote" && args[1] === "show") return { stdout: "", exitCode: 1 };
    if (args[0] === "show-ref") return { stdout: "", exitCode: args.at(-1) === "refs/remotes/origin/master" ? 0 : 1 };
    throw new Error(`Unexpected Git read: ${args.join(" ")}`);
  };
  expect(await f.service.baseBranch()).toEqual({ local: "master", remote: "origin" });
});

test("base branch query is owner-bound and rejects a retargeted project after the read", async () => {
  const f = await fixture(), nested = join(f.cwd, "app"); await mkdir(nested);
  let project = { id: "project", hostId: "host", path: nested };
  const store = { host: { id: "host" }, getProject: (id: string) => id === "project" ? project : undefined } as unknown as HostStore;
  const workspaces = new HostWorkspaces(store, join(f.root, "data"), () => { throw new Error("No mutation reservation"); });
  const query = parseWorkspaceQuery({ type: "git.base-branch" }), original = WorkspaceService.prototype.baseBranch,
    originalContext = WorkspaceService.prototype.gitWorkspaceContext;
  try {
    WorkspaceService.prototype.gitWorkspaceContext = async function() { return { gitRoot: this.cwd, workspaceRelativePath: "" }; };
    expect(await workspaces.query({ projectId: "project" }, query)).toEqual({ type: "git.base-branch", base: null });
    await expect(workspaces.query({ filePath: join(f.cwd, "tracked") }, query)).rejects.toThrow();
    WorkspaceService.prototype.baseBranch = async function() { const result = await original.call(this); project = { ...project, path: f.root }; return result; };
    await expect(workspaces.query({ projectId: "project" }, query)).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  } finally { WorkspaceService.prototype.baseBranch = original; WorkspaceService.prototype.gitWorkspaceContext = originalContext; await workspaces.shutdownSubmissions(); }
});

test("base branch leaves operational discovery failures visible", async () => {
  const f = await fixture();
  const service = f.service as unknown as { git: (args: string[], options?: unknown) => Promise<{ stdout: string; exitCode: number }> };
  (f.service as unknown as { requireGitRoot: () => Promise<void> }).requireGitRoot = async () => {};
  service.git = async args => {
    if (args[0] === "remote" && args.length === 1) return { stdout: "origin\n", exitCode: 0 };
    if (args[0] === "symbolic-ref") return { stdout: "", exitCode: 1 };
    if (args[0] === "remote" && args[1] === "show") throw new WorkspaceError("GIT_TIMEOUT", "controlled timeout");
    throw new Error(`Unexpected Git read: ${args.join(" ")}`);
  };
  await expect(f.service.baseBranch()).rejects.toMatchObject({ code: "GIT_TIMEOUT" });
});
