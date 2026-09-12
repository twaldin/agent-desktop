import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { searchGitBranches } from "./branch-presentation-search";
import { WorkspaceService } from "./service";
import { HostWorkspaces, parseWorkspaceQuery } from "../workspace-http";
import type { HostStore } from "../store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: {
    PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", ...env,
  } });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trimEnd();
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-starting-search-"))); roots.push(root);
  const cwd = join(root, "repo"); await mkdir(cwd); await mkdir(join(root, "no-hooks"));
  git(cwd, ["init", "--initial-branch=main"]);
  for (const [key, value] of [["user.name", "Starting Search"], ["user.email", "search@example.invalid"], ["commit.gpgSign", "false"], ["core.hooksPath", join(root, "no-hooks")]])
    git(cwd, ["config", key!, value!]);
  await writeFile(join(cwd, "tracked"), "base\n"); git(cwd, ["add", "tracked"]);
  const date = (seconds: number) => ({ GIT_AUTHOR_DATE: `${seconds} +0000`, GIT_COMMITTER_DATE: `${seconds} +0000` });
  git(cwd, ["commit", "-m", "base"], date(1700000000));
  const base = git(cwd, ["rev-parse", "HEAD"]), tree = git(cwd, ["rev-parse", "HEAD^{tree}"]);
  const newer = git(cwd, ["commit-tree", tree, "-p", base, "-m", "newer"], date(1700000100));
  const ref = (name: string, commit = base) => git(cwd, ["update-ref", name, commit]);
  ref("refs/heads/topic-local"); ref("refs/remotes/origin/topic-local", newer);
  ref("refs/remotes/origin/topic-remote", newer); ref("refs/remotes/other/topic-remote");
  ref("refs/remotes/team/origin/topic-nested", newer);
  git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/topic-remote"]);
  await writeFile(join(cwd, "tracked"), "dirty\n"); await writeFile(join(cwd, "note"), "unsent\n");
  const snapshot = async () => ({
    index: (await readFile(join(cwd, ".git/index"))).toString("base64"), head: await readFile(join(cwd, ".git/HEAD"), "utf8"),
    config: await readFile(join(cwd, ".git/config"), "utf8"), refs: git(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"]),
    reflog: await readFile(join(cwd, ".git/logs/HEAD"), "utf8"), tracked: await readFile(join(cwd, "tracked"), "utf8"), note: await readFile(join(cwd, "note"), "utf8"),
  });
  return { root, cwd, base, newer, ref, snapshot, service: new WorkspaceService(cwd) };
}

test("remote identities survive starting search while matching local names suppress remote duplicates", async () => {
  const f = await fixture(), before = await f.snapshot();
  const result = await searchGitBranches(f.cwd, "topic", 20, 30_000, undefined, true);
  expect(result.branches.map(branch => branch.ref)).toEqual([
    "refs/heads/topic-local", "refs/remotes/origin/topic-remote", "refs/remotes/team/origin/topic-nested", "refs/remotes/other/topic-remote",
  ]);
  expect(result.branches.map(branch => branch.name)).toEqual(["topic-local", "origin/topic-remote", "team/origin/topic-nested", "other/topic-remote"]);
  expect(result.branches.map(branch => branch.commit)).toEqual([f.base, f.newer, f.newer, f.base]);
  expect(result.limitReached).toBe(false);
  expect(await f.snapshot()).toEqual(before);
});

test("service matches normalized remote-qualified terms without changing checkout search", async () => {
  const f = await fixture();
  expect((await f.service.searchStartingBranches("ORIGIN remote")).branches.map(branch => branch.ref)).toEqual(["refs/remotes/origin/topic-remote"]);
  expect((await f.service.searchStartingBranches("TEAM nested")).branches.map(branch => branch.name)).toEqual(["team/origin/topic-nested"]);
  expect((await f.service.searchBranches("topic")).branches.map(branch => branch.name)).toEqual(["topic-local", "topic-remote", "origin/topic-nested"]);
  expect((await f.service.searchStartingBranches("HEAD")).branches).toEqual([]);
});

test("one combined limit retains local-first order and distinct remote slots", async () => {
  const f = await fixture(), before = await f.snapshot();
  const two = await f.service.searchStartingBranches("topic", 2);
  expect(two.branches.map(branch => branch.ref)).toEqual(["refs/heads/topic-local", "refs/remotes/origin/topic-remote"]);
  expect(two.limitReached).toBe(true);
  for (let i = 0; i < 25; i++) f.ref(`refs/heads/many-${String(i).padStart(2, "0")}`);
  const many = await f.service.searchStartingBranches("many", 100);
  expect(many.branches).toHaveLength(20); expect(many.limitReached).toBe(true);
  const after = await f.snapshot();
  expect(after.index).toBe(before.index); expect(after.head).toBe(before.head); expect(after.tracked).toBe(before.tracked);
});

test("starting query has a distinct validated protocol and never accepts empty or malformed text", () => {
  expect(parseWorkspaceQuery({ type: "git.search-starting-branches", query: " topic ", limit: 100 })).toEqual({ type: "git.search-starting-branches", query: "topic", limit: 20 });
  for (const query of ["", "  ", "x\n", 12, "x".repeat(513)])
    expect(() => parseWorkspaceQuery({ type: "git.search-starting-branches", query })).toThrow();
  for (const limit of [0, 101, 1.5, "20", null])
    expect(() => parseWorkspaceQuery({ type: "git.search-starting-branches", query: "topic", limit })).toThrow();
});

test("owning project query keeps remote refs and rejects retargeting before return", async () => {
  const f = await fixture(), nested = join(f.cwd, "app"); await mkdir(nested);
  let project = { id: "project", hostId: "host", path: nested };
  const store = { host: { id: "host" }, getProject: (id: string) => id === "project" ? project : undefined, getSession: () => undefined } as unknown as HostStore;
  const workspaces = new HostWorkspaces(store, join(f.root, "data"), () => { throw new Error("Search cannot reserve mutation"); });
  const query = parseWorkspaceQuery({ type: "git.search-starting-branches", query: "topic" });
  const original = WorkspaceService.prototype.searchStartingBranches;
  try {
    const before = await f.snapshot(), result = await workspaces.query({ projectId: "project" }, query);
    expect(result.type).toBe("git.search-starting-branches");
    if (result.type !== "git.search-starting-branches") throw new Error("Wrong response");
    expect(result.branches.map(branch => branch.ref)).toContain("refs/remotes/other/topic-remote");
    expect(await f.snapshot()).toEqual(before);
    await expect(workspaces.query({ filePath: join(f.cwd, "tracked") }, query)).rejects.toThrow();
    await expect(workspaces.query({ projectId: "absent" }, query)).rejects.toThrow();
    WorkspaceService.prototype.searchStartingBranches = async function(...args) {
      const result = await original.apply(this, args); project = { ...project, path: join(f.root, "other") }; return result;
    };
    await expect(workspaces.query({ projectId: "project" }, query)).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  } finally { WorkspaceService.prototype.searchStartingBranches = original; await workspaces.shutdownSubmissions(); }
});

test("starting search keeps abort and Git failure explicit", async () => {
  const controller = new AbortController(), reason = new Error("stop search"); controller.abort(reason);
  await expect(searchGitBranches("/nonexistent-starting-search", "topic", 20, 1000, controller.signal, true)).rejects.toBe(reason);
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-starting-no-git-"))); roots.push(root);
  await expect(new WorkspaceService(root).searchStartingBranches("topic")).rejects.toThrow();
});


test("a local ref-shaped label cannot shadow a distinct remote identity", async () => {
  const f = await fixture();
  f.ref("refs/heads/refs/remotes/origin/topic-remote");
  const result = await f.service.searchStartingBranches("topic-remote");
  expect(result.branches.map(branch => branch.ref)).toEqual([
    "refs/heads/refs/remotes/origin/topic-remote", "refs/remotes/origin/topic-remote", "refs/remotes/other/topic-remote",
  ]);
});
