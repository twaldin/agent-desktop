import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostWorkspaces, parseWorkspaceQuery } from "../workspace-http";
import type { HostStore } from "../store";
import { WorkspaceError, WorkspaceService } from "./service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function git(cwd: string, args: string[], extra: Record<string, string> = {}, input?: string): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe", stderr: "pipe", ...(input === undefined ? {} : { stdin: Buffer.from(input) }),
    env: { PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", ...extra },
  });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trimEnd();
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-recent-branches-"))); roots.push(root);
  const cwd = join(root, "repository"); await mkdir(cwd); await mkdir(join(root, "hooks"));
  git(cwd, ["init", "--initial-branch=main"]);
  git(cwd, ["config", "user.name", "Recent Fixture"]); git(cwd, ["config", "user.email", "recent@example.invalid"]);
  git(cwd, ["config", "commit.gpgSign", "false"]); git(cwd, ["config", "core.hooksPath", join(root, "hooks")]);
  await writeFile(join(cwd, "tracked"), "committed\n"); git(cwd, ["add", "tracked"]);
  const date = (year: number) => ({ GIT_AUTHOR_DATE: `${year}-01-01T00:00:00Z`, GIT_COMMITTER_DATE: `${year}-01-01T00:00:00Z` });
  git(cwd, ["commit", "-m", "oldest"], date(2000));
  const oldest = git(cwd, ["rev-parse", "HEAD"]), tree = git(cwd, ["rev-parse", "HEAD^{tree}"]);
  const middle = git(cwd, ["commit-tree", tree, "-m", "middle"], date(2001));
  const newest = git(cwd, ["commit-tree", tree, "-m", "newest"], date(2002));
  git(cwd, ["update-ref", "refs/heads/a-middle", middle]); git(cwd, ["update-ref", "refs/heads/z-newest", newest]);
  git(cwd, ["update-ref", "refs/remotes/origin/remote-only", newest]); git(cwd, ["update-ref", "refs/tags/tag-only", newest]);
  git(cwd, ["checkout", "a-middle"]); git(cwd, ["checkout", "main"]);
  await writeFile(join(cwd, "tracked"), "staged\n"); git(cwd, ["add", "tracked"]);
  await writeFile(join(cwd, "tracked"), "unstaged\n"); await writeFile(join(cwd, "untracked"), "retain\n");
  const snapshot = async () => ({ index: (await readFile(join(cwd, ".git/index"))).toString("base64"),
    head: await readFile(join(cwd, ".git/HEAD"), "utf8"), config: await readFile(join(cwd, ".git/config"), "utf8"),
    reflog: await readFile(join(cwd, ".git/logs/HEAD"), "utf8"), refs: git(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"]),
    tracked: await readFile(join(cwd, "tracked"), "utf8"), untracked: await readFile(join(cwd, "untracked"), "utf8") });
  return { root, cwd, oldest, newest, snapshot, service: new WorkspaceService(cwd) };
}

test("recent branch request clamps integer limits and rejects malformed input", () => {
  expect(parseWorkspaceQuery({ type: "git.recent-branches" })).toEqual({ type: "git.recent-branches", limit: 100 });
  for (const [input, limit] of [[0, 1], [-4, 1], [1, 1], [10, 10], [100, 100], [1000, 100]])
    expect(parseWorkspaceQuery({ type: "git.recent-branches", limit: input })).toEqual({ type: "git.recent-branches", limit });
  for (const limit of [null, "10", 1.5, NaN, Infinity, {}])
    expect(() => parseWorkspaceQuery({ type: "git.recent-branches", limit })).toThrow();
});

test("recent branches use actual tip dates rather than name or checkout order and preserve working bytes", async () => {
  const f = await fixture(), before = await f.snapshot();
  expect(await f.service.recentBranches()).toEqual(["z-newest", "a-middle", "main"]);
  expect(await f.service.recentBranches(2)).toEqual(["z-newest", "a-middle"]);
  expect(await f.service.recentBranches(0)).toEqual(["z-newest"]);
  expect(await f.snapshot()).toEqual(before);
  git(f.cwd, ["update-ref", "refs/heads/z-newest", f.oldest]);
  const changed = await f.snapshot();
  expect((await f.service.recentBranches())[0]).toBe("a-middle");
  expect(await f.snapshot()).toEqual(changed);
});

test("recent branches retain Git short-ref spelling and cap local results at one hundred", async () => {
  const f = await fixture();
  git(f.cwd, ["update-ref", "refs/tags/z-newest", f.newest]);
  expect((await f.service.recentBranches())[0]).toBe("heads/z-newest");
  git(f.cwd, ["update-ref", "--stdin"], {}, Array.from({ length: 105 }, (_, i) => `update refs/heads/topic-${String(i).padStart(3, "0")} ${f.newest}\n`).join(""));
  const before = await f.snapshot();
  const result = await f.service.recentBranches(500);
  expect(result).toHaveLength(100); expect(new Set(result).size).toBe(100);
  expect(result).not.toContain("remote-only"); expect(result).not.toContain("tag-only");
  expect(await f.snapshot()).toEqual(before);
});

test("recent branches distinguish an unborn empty repository from operational failure", async () => {
  const f = await fixture(), empty = join(f.root, "empty"); await mkdir(empty); git(empty, ["init", "--initial-branch=main"]);
  expect(await new WorkspaceService(empty).recentBranches()).toEqual([]);
  const runner = f.service as unknown as { git: (args: string[], options?: unknown) => Promise<unknown> };
  const original = runner.git.bind(f.service); let listCalls = 0;
  for (const code of ["GIT_TIMEOUT", "GIT_OUTPUT_TOO_LARGE", "GIT_FAILED"]) {
    runner.git = async (args, options) => {
      if (args[0] === "for-each-ref") { ++listCalls; throw new WorkspaceError(code, "controlled list failure"); }
      return original(args, options);
    };
    await expect(f.service.recentBranches()).rejects.toMatchObject({ code });
  }
  expect(listCalls).toBe(3);
  runner.git = original;
});

test("recent branches query retains project and session ownership across nested Git resolution", async () => {
  const f = await fixture(), nested = join(f.cwd, "app"); await mkdir(nested);
  let project = { id: "project", hostId: "host", path: nested };
  let session = { id: "session", projectId: "project", hostId: "host", cwd: nested };
  const store = { host: { id: "host" }, getProject: (id: string) => id === "project" ? project : undefined,
    getSession: (id: string) => id === "session" ? session : undefined } as unknown as HostStore;
  const workspaces = new HostWorkspaces(store, join(f.root, "data"), () => { throw new Error("Read-only query cannot reserve a mutation"); });
  const query = parseWorkspaceQuery({ type: "git.recent-branches", limit: 2 });
  const original = WorkspaceService.prototype.recentBranches;
  try {
    expect(await workspaces.query({ projectId: "project" }, query)).toEqual({ type: "git.recent-branches", branches: ["z-newest", "a-middle"] });
    expect(await workspaces.query({ sessionId: "session" }, query)).toEqual({ type: "git.recent-branches", branches: ["z-newest", "a-middle"] });
    await expect(workspaces.query({ filePath: join(f.cwd, "tracked") }, query)).rejects.toThrow();
    await expect(workspaces.query({ projectId: "missing" }, query)).rejects.toThrow();
    WorkspaceService.prototype.recentBranches = async function(...args) { const result = await original.apply(this, args); project = { ...project, path: f.root }; return result; };
    await expect(workspaces.query({ projectId: "project" }, query)).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
    WorkspaceService.prototype.recentBranches = async function(...args) { const result = await original.apply(this, args); session = { ...session, cwd: f.root }; return result; };
    await expect(workspaces.query({ sessionId: "session" }, query)).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  } finally { WorkspaceService.prototype.recentBranches = original; await workspaces.shutdownSubmissions(); }
});
