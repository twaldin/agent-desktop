import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryMetadataChanges, type GitRepositoryWatchContext } from "./repository-watch";
import { WorkspaceError, WorkspaceService } from "./service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: {
    PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C",
  } });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().replace(/\n$/, "");
}
async function fixture(commit = true, separate = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-repo-watch-"))); roots.push(root);
  const cwd = join(root, "repository"); await mkdir(cwd);
  git(cwd, ["init", "--initial-branch=main", ...(separate ? [`--separate-git-dir=${join(root, "metadata")}`] : [])]);
  git(cwd, ["config", "user.name", "Watch Fixture"]); git(cwd, ["config", "user.email", "watch@example.invalid"]);
  if (commit) {
    await writeFile(join(cwd, "tracked"), "baseline\n"); git(cwd, ["add", "tracked"]);
    git(cwd, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", "baseline"]);
  }
  return { root, cwd, service: new WorkspaceService(cwd) };
}

test("unborn repository returns absent metadata paths without creating index or refs", async () => {
  const f = await fixture(false), before = git(f.cwd, ["status", "--porcelain=v1"]);
  const context = await f.service.repositoryWatchContext();
  expect(context).toEqual({ root: f.cwd, gitDir: join(f.cwd, ".git"), commonDir: join(f.cwd, ".git"),
    headPath: join(f.cwd, ".git", "HEAD"), indexPath: join(f.cwd, ".git", "index"), headRef: "refs/heads/main" });
  await expect(stat(context.indexPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(context.commonDir, context.headRef!))).rejects.toMatchObject({ code: "ENOENT" });
  expect(git(f.cwd, ["status", "--porcelain=v1"])).toBe(before);
});

test("nested workspace and linked worktree preserve separate HEAD/index and shared ref ownership", async () => {
  const f = await fixture(), nested = join(f.cwd, "nested"); await mkdir(nested);
  const linked = join(f.root, "linked"); git(f.cwd, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", "feature/topic", linked]);
  const beforeIndex = await readFile(join(f.cwd, ".git", "index")), beforeHead = git(f.cwd, ["rev-parse", "HEAD"]);
  const main = await new WorkspaceService(nested).repositoryWatchContext(), other = await new WorkspaceService(linked).repositoryWatchContext();
  expect(main.root).toBe(f.cwd); expect(other.root).toBe(linked);
  expect(other.commonDir).toBe(main.commonDir); expect(other.gitDir).not.toBe(main.gitDir);
  expect(other.gitDir).toBe(await realpath(git(linked, ["rev-parse", "--absolute-git-dir"])));
  expect(other.headPath).toBe(join(other.gitDir, "HEAD")); expect(other.indexPath).toBe(join(other.gitDir, "index"));
  expect(other.headRef).toBe("refs/heads/feature/topic");
  expect(repositoryMetadataChanges(other, join(main.commonDir, "refs", "heads", "main"), other.headRef)).toEqual(["local-refs"]);
  expect(repositoryMetadataChanges(other, join(main.commonDir, "refs", "heads", "feature", "topic"), other.headRef)).toEqual(["head"]);
  expect(repositoryMetadataChanges(main, other.indexPath, main.headRef)).toEqual([]);
  expect(repositoryMetadataChanges(other, other.indexPath, other.headRef)).toEqual(["index"]);
  expect(await readFile(main.indexPath)).toEqual(beforeIndex); expect(git(f.cwd, ["rev-parse", "HEAD"])).toBe(beforeHead);
});

test("separate Git directory and symlinked workspace use canonical owning metadata", async () => {
  const f = await fixture(true, true), alias = join(f.root, "alias"); await symlink(f.cwd, alias);
  const context = await new WorkspaceService(alias).repositoryWatchContext();
  expect(context.root).toBe(f.cwd); expect(context.commonDir).toBe(join(f.root, "metadata"));
  expect(context.gitDir).toBe(context.commonDir); expect(context.headPath).toBe(join(context.gitDir, "HEAD"));
  expect(context.indexPath).toBe(join(context.gitDir, "index"));
});

test("detached HEAD is known detached and other local refs stay local", async () => {
  const f = await fixture(); git(f.cwd, ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", "HEAD"]);
  const context = await f.service.repositoryWatchContext(); expect(context.headRef).toBeNull();
  expect(repositoryMetadataChanges(context, join(context.commonDir, "refs", "heads", "main"), context.headRef)).toEqual(["local-refs"]);
});

type GitRunner = { git(args: string[], options?: unknown): Promise<{ stdout: string; exitCode: number }> };
test("replacement of the metadata directory during discovery rejects even when paths and HEAD are equal", async () => {
  const f = await fixture(), runner = f.service as unknown as GitRunner, original = runner.git.bind(f.service);
  runner.git = async (args, options) => {
    const result = await original(args, options);
    if (args[0] === "symbolic-ref") {
      await rename(join(f.cwd, ".git"), join(f.root, "old-metadata"));
      await cp(join(f.root, "old-metadata"), join(f.cwd, ".git"), { recursive: true });
    }
    return result;
  };
  await expect(f.service.repositoryWatchContext()).rejects.toMatchObject({ code: "PATH_CHANGED" });
});

test("selected directory replacement and operational HEAD failures are not unavailable metadata", async () => {
  const f = await fixture(), runner = f.service as unknown as GitRunner, original = runner.git.bind(f.service);
  runner.git = async (args, options) => {
    if (args[0] === "symbolic-ref") throw new WorkspaceError("GIT_TIMEOUT", "controlled timeout");
    return original(args, options);
  };
  await expect(f.service.repositoryWatchContext()).rejects.toMatchObject({ code: "GIT_TIMEOUT" });
  runner.git = original;
  await rename(f.cwd, join(f.root, "old-root")); await mkdir(f.cwd);
  await expect(f.service.repositoryWatchContext()).rejects.toMatchObject({ code: "PATH_CHANGED" });
});

test("non-repository and malformed Git path responses fail rather than inventing .git", async () => {
  const f = await fixture(), runner = f.service as unknown as GitRunner, original = runner.git.bind(f.service);
  runner.git = async (args, options) => args.includes("--git-common-dir") ? { stdout: "relative/path\n", exitCode: 0 } : original(args, options);
  await expect(f.service.repositoryWatchContext()).rejects.toMatchObject({ code: "GIT_FAILED" });
  await expect(new WorkspaceService(f.root).repositoryWatchContext()).rejects.toMatchObject({ code: "GIT_FAILED" });
});

const context: GitRepositoryWatchContext = { root: "/repo", gitDir: "/repo/.git", commonDir: "/repo/.git",
  headPath: "/repo/.git/HEAD", indexPath: "/repo/.git/index", headRef: "refs/heads/main" };
test("ref classifier excludes locks and prefix neighbors, and treats unknown HEAD conservatively", () => {
  const classify = (path: string, headRef: string | null | undefined = context.headRef) => repositoryMetadataChanges(context, path, headRef);
  expect(classify("/repo/.git/refs/heads/main")).toEqual(["head"]);
  expect(classify("/repo/.git/refs/heads/feature/nested")).toEqual(["local-refs"]);
  expect(repositoryMetadataChanges(context, "/repo/.git/refs/heads/feature/nested", undefined)).toEqual(["head"]);
  expect(classify("/repo/.git/refs/heads/main.lock")).toEqual([]);
  expect(classify("/repo/.git/refs/remotes/origin/topic.lock")).toEqual([]);
  expect(classify("/repo/.git/refs/heads-else/main")).toEqual([]);
  expect(classify("/repo/.git-neighbor/refs/heads/main")).toEqual([]);
  expect(classify("refs/heads/main")).toEqual([]);
  expect(classify("/repo/.git/refs/heads")).toEqual(["head", "local-refs"]);
  expect(classify("/repo/.git/refs/remotes/origin/topic")).toEqual(["remote-refs"]);
  expect(classify("/repo/.git/packed-refs")).toEqual(["remote-refs"]);
  expect(classify("/repo/.git/FETCH_HEAD")).toEqual(["remote-refs"]);
});

test("directory replacement, config and topology events follow metadata boundaries", () => {
  const classify = (path: string) => repositoryMetadataChanges(context, path, context.headRef);
  expect(classify("/repo/.git/refs")).toEqual(["head", "local-refs", "remote-refs"]);
  for (const suffix of ["config", "shallow", "info", "info/exclude", "info/attributes", "config.worktree"])
    expect(classify(`/repo/.git/${suffix}`)).toEqual(["config"]);
  for (const suffix of ["worktrees", "worktrees/a", "worktrees/a/HEAD", "worktrees/a/commondir", "worktrees/a/gitdir", "worktrees/a/locked"])
    expect(classify(`/repo/.git/${suffix}`)).toEqual(["worktree-topology"]);
  for (const suffix of ["worktrees/a/index", "worktrees/a/logs/HEAD", "worktrees/a/locked.lock", "logs/HEAD", "objects/ab/object", "refs/tags/tag"])
    expect(classify(`/repo/.git/${suffix}`)).toEqual([]);
});
