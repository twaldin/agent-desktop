import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchSearchPatterns, searchGitBranches } from "./branch-presentation-search";
import { WorkspaceService } from "./service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: {
    PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", ...env,
  } });
  if (!result.success) throw new Error(result.stderr.toString()); return result.stdout.toString().trimEnd();
}
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "agent-presentation-search-"))); roots.push(cwd);
  await mkdir(join(cwd, "no-hooks")); git(cwd, ["init", "--initial-branch=main"]);
  for (const [key, value] of [["user.name", "Search Fixture"], ["user.email", "search@example.invalid"], ["commit.gpgSign", "false"], ["core.hooksPath", join(cwd, "no-hooks")]]) git(cwd, ["config", key!, value!]);
  await writeFile(join(cwd, "tracked"), "base\n"); git(cwd, ["add", "tracked"]);
  const dates = (seconds: number) => ({ GIT_AUTHOR_DATE: `${seconds} +0000`, GIT_COMMITTER_DATE: `${seconds} +0000` });
  git(cwd, ["commit", "-m", "base"], dates(1700000000));
  const base = git(cwd, ["rev-parse", "HEAD"]), tree = git(cwd, ["rev-parse", "HEAD^{tree}"]);
  const newer = git(cwd, ["commit-tree", tree, "-p", base, "-m", "newer"], dates(1700000100));
  const newest = git(cwd, ["commit-tree", tree, "-p", newer, "-m", "newest"], dates(1700000200));
  const ref = (name: string, commit = base) => git(cwd, ["update-ref", name, commit]);
  ref("refs/heads/topic", base); ref("refs/heads/topic-extra", newer);
  ref("refs/heads/feature/foo-bar", newest); ref("refs/heads/feature/foo.bar", newer);
  ref("refs/remotes/origin/topic", newest); ref("refs/remotes/other/topic", newest);
  ref("refs/remotes/origin/remote_topic", newest); ref("refs/remotes/other/remote_topic", newer);
  ref("refs/remotes/origin/topic-last", base); ref("refs/remotes/origin/feature/Key-λ", newest);
  git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/topic"]);
  await writeFile(join(cwd, "tracked"), "dirty\n"); await writeFile(join(cwd, "untracked"), "keep\n");
  const snapshot = async () => ({ index: (await readFile(join(cwd, ".git/index"))).toString("base64"), head: await readFile(join(cwd, ".git/HEAD"), "utf8"),
    config: await readFile(join(cwd, ".git/config"), "utf8"), refs: git(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"]),
    reflog: await readFile(join(cwd, ".git/logs/HEAD"), "utf8"), tracked: await readFile(join(cwd, "tracked"), "utf8"), untracked: await readFile(join(cwd, "untracked"), "utf8") });
  return { cwd, base, newer, newest, ref, snapshot, service: new WorkspaceService(cwd) };
}

test("remote pattern optimization retains longest eligible term and Kelvin K matching", () => {
  expect(branchSearchPatterns(false, ["topic"])).toEqual(["refs/heads"]);
  expect(branchSearchPatterns(true, ["λ", "a"])).toEqual(["refs/remotes"]);
  expect(branchSearchPatterns(true, ["key", "topic"])).toEqual(["refs/remotes/**/*[tT][oO][pP][iI][cC]*", "refs/remotes/**/*[tT][oO][pP][iI][cC]*/**"]);
  expect(branchSearchPatterns(true, ["key"])[0]).toBe("refs/remotes/**/*[kKK][eE][yY]*");
});

test("service presentation matches separated terms instead of literal substring and retains tip order", async () => {
  const f = await fixture(), before = await f.snapshot();
  const result = await f.service.searchBranches("BAR foo", 20);
  expect(result.branches.map(branch => branch.name)).toEqual(["feature/foo-bar", "feature/foo.bar"]);
  expect(result.branches.map(branch => branch.commit)).toEqual([f.newest, f.newer]);
  expect(result.limitReached).toBe(false); expect(await f.snapshot()).toEqual(before);
});

test("local tips precede newer remote tips, without exact promotion or duplicate short names", async () => {
  const f = await fixture(), before = await f.snapshot();
  const result = await f.service.searchBranches("topic", 20);
  expect(result.branches.map(branch => branch.name)).toEqual(["topic-extra", "topic", "remote_topic", "topic-last"]);
  expect(result.branches[2]).toMatchObject({ ref: "refs/remotes/origin/remote_topic", commit: f.newest, remote: true });
  expect(result.limitReached).toBe(false); expect(await f.snapshot()).toEqual(before);
});

test("service enforces native20 cap and reports cap attainment, not unobserved extra matches", async () => {
  const f = await fixture();
  for (let i = 0; i < 25; i++) f.ref(`refs/heads/many-${String(i).padStart(2, "0")}`);
  const before = await f.snapshot(), result = await f.service.searchBranches("many", 100);
  expect(result.branches).toHaveLength(20); expect(result.limitReached).toBe(true);
  expect(result.branches.every(branch => !branch.remote)).toBe(true);
  expect((await f.service.searchBranches("main", 1))).toMatchObject({ limitReached: true });
  expect(await f.snapshot()).toEqual(before);
});

test("remote short names retain Unicode and omit remote HEAD, namespace, and unmatched input", async () => {
  const f = await fixture();
  expect((await f.service.searchBranches("KEY λ")).branches.map(branch => branch.name)).toEqual(["feature/Key-λ"]);
  for (const query of ["origin", "refs/remotes", "HEAD", "...---", "--help"])
    expect((await f.service.searchBranches(query)).branches).toEqual([]);
});

test("pre-aborted search propagates the caller reason without inspecting a nonexistent cwd", async () => {
  const controller = new AbortController(), reason = new Error("cancelled inspection"); controller.abort(reason);
  await expect(searchGitBranches("/nonexistent-branch-search-fixture", "topic", 20, 1000, controller.signal)).rejects.toBe(reason);
});

test("abort after Git child admission rejects the query and preserves repository state", async () => {
  const f = await fixture(), before = await f.snapshot(), controller = new AbortController(), reason = new Error("stop admitted search");
  const pending = searchGitBranches(f.cwd, "topic", 20, 30_000, controller.signal);
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(await f.snapshot()).toEqual(before);
});

test("Git command failure is an error rather than an empty search result", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "agent-no-repository-"))); roots.push(cwd);
  await expect(searchGitBranches(cwd, "topic", 20, 30_000)).rejects.toMatchObject({ code: "GIT_FAILED" });
});

test("stream record bound counts UTF8 bytes and rejects an oversized real packed ref", async () => {
  const f = await fixture(), packed = `${f.base} refs/heads/oversize-${"λ".repeat(550_000)}\n`;
  await writeFile(join(f.cwd, ".git/packed-refs"), packed);
  expect(git(f.cwd, ["for-each-ref", "--format=%(refname)", "refs/heads"]).includes("oversize-")).toBe(true);
  await expect(searchGitBranches(f.cwd, "oversize", 20, 30_000)).rejects.toMatchObject({ code: "GIT_OUTPUT_TOO_LARGE" });
  expect(await readFile(join(f.cwd, ".git/packed-refs"), "utf8")).toBe(packed);
});

test("tip-date search refuses missing promisor objects without a fetch subprocess", async () => {
  const f = await fixture(), trace = join(f.cwd, "search-trace.jsonl"), previousTrace = process.env.GIT_TRACE2_EVENT;
  git(f.cwd, ["remote", "add", "origin", join(f.cwd, "unavailable-remote")]);
  git(f.cwd, ["config", "remote.origin.promisor", "true"]);
  await rm(join(f.cwd, ".git/objects", f.base.slice(0, 2), f.base.slice(2)));
  process.env.GIT_TRACE2_EVENT = trace;
  try { await expect(f.service.searchBranches("topic")).rejects.toMatchObject({ code: "GIT_FAILED" }); }
  finally { if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = previousTrace; }
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(events.some(event => event.event === "start" && event.argv.includes("--no-lazy-fetch") && event.argv.includes("for-each-ref"))).toBe(true);
  expect(events.filter(event => event.event === "child_start" && event.argv?.includes("fetch"))).toHaveLength(0);
});
