import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBranchReviewRequest, type BranchReview } from "../../../../packages/shared/src/branch-review";
import { readBranchReview, type BranchReviewPorts } from "./branch-review";
import { WorkspaceService } from "./service";
import { parseReviewPatch } from "../../../desktop/src/renderer/review-model";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function native(cwd: string, args: string[]) {
  return execFileSync("git", ["--no-pager", "--literal-pathspecs", "-c", "color.ui=false", "-C", cwd, ...args], {
    encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
  });
}
async function fixture(unborn = false) {
  const cwd = await mkdtemp(join(tmpdir(), "branch-review-")); roots.push(cwd);
  const git = (args: string[]) => native(cwd, args);
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.name", "Branch Review Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "core.filemode", "true"]);
  const write = (path: string, value: string | Uint8Array) => writeFile(join(cwd, path), value);
  if (!unborn) {
    await write("file.txt", "original\n"); await write("delete.txt", "delete me\n"); await write("rename.txt", "keep this exact rename content\n");
    git(["add", "--all"]); git(["commit", "--quiet", "-m", "base"]);
  }
  const service = new WorkspaceService(cwd);
  const privateService = service as unknown as BranchReviewPorts & { repositoryReadContext(): Promise<{ identity: string }>; indexState(): Promise<{ revision: string }> };
  const ports: BranchReviewPorts = {
    git: (args, options) => privateService.git(args, options),
    requireGitRoot: () => privateService.requireGitRoot(),
    baseBranch: () => service.baseBranch(),
    cwd: service.cwd,
    readFence: async () => JSON.stringify([(await privateService.repositoryReadContext()).identity, (await privateService.indexState()).revision]),
  };
  return { cwd, git, write, ports, service };
}
function available(result: BranchReview): asserts result is Extract<BranchReview, { state: "available" }> { expect(result.state).toBe("available"); if (result.state !== "available") throw new Error(result.reason); }

test("branch review compares merge-base with working tree, including committed/staged/unstaged cancellation", async () => {
  const f = await fixture(), base = f.git(["rev-parse", "HEAD"]).trim();
  f.git(["checkout", "--quiet", "-b", "feature"]);
  await f.write("file.txt", "committed\n"); f.git(["commit", "--quiet", "-am", "feature"]);
  f.git(["checkout", "--quiet", "main"]); await f.write("main-only.txt", "not a feature change\n"); f.git(["add", "--all"]); f.git(["commit", "--quiet", "-m", "main diverges"]);
  f.git(["checkout", "--quiet", "feature"]);
  const committed = await readBranchReview(f.ports, { baseBranch: "main" }); available(committed);
  expect(committed.mergeBase).toBe(base); expect(committed.patch).toContain("+committed"); expect(committed.files.map(file => file.path)).toEqual(["file.txt"]);
  await f.write("file.txt", "staged\n"); f.git(["add", "file.txt"]); await f.write("file.txt", "working\n");
  const beforeIndex = await readFile(join(f.cwd, ".git/index"));
  const review = await readBranchReview(f.ports, { baseBranch: "main" }); available(review);
  expect(review.patch).toBe(f.git(["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--ignore-submodules=none", "--unified=3", base, "--"]));
  expect(review.patch).toContain("+working"); expect(review.patch).not.toContain("+staged"); expect(review.patch).not.toContain("main-only");
  expect(await readFile(join(f.cwd, ".git/index"))).toEqual(beforeIndex);
  await f.write("file.txt", "original\n");
  const cancelled = await readBranchReview(f.ports, { baseBranch: "main" }); available(cancelled);
  expect(cancelled.files).toEqual([]); expect(cancelled.patch).toBe("");
});

test("untracked text, empty, binary, quoted unicode/newline paths and symlinks retain inventory and relative native patches", async () => {
  const f = await fixture();
  const odd = 'snow☃ tab\tquote"line\n.txt';
  await f.write(odd, "new text\n"); await f.write("empty.txt", ""); await f.write("binary.bin", Buffer.from([0, 1, 255]));
  const outside = await mkdtemp(join(tmpdir(), "branch-review-outside-")); roots.push(outside);
  await writeFile(join(outside, "secret"), "must not follow symlink\n"); await symlink(join(outside, "secret"), join(f.cwd, "link"));
  const result = await readBranchReview(f.ports, { baseBranch: "main" }); available(result);
  expect(result.files).toHaveLength(4); expect(result.files.find(file => file.path === "empty.txt")).toMatchObject({ additions: 0, deletions: 0, untracked: true });
  expect(result.files.find(file => file.path === "binary.bin")).toMatchObject({ additions: null, deletions: null });
  expect(result.patch).not.toContain(f.cwd); expect(result.patch).not.toContain("must not follow symlink"); expect(result.patch).toContain("new file mode 120000"); expect(result.binary).toBe(true);
  const scoped = await readBranchReview(f.ports, { baseBranch: "main", path: odd }); available(scoped);
  expect(scoped.files).toEqual(result.files); expect(scoped.revision).toBe(result.revision); expect(scoped.patch).toContain("+new text"); expect(scoped.patch).not.toContain("binary.bin"); expect(scoped.binary).toBe(false);
  const empty = await readBranchReview(f.ports, { baseBranch: "main", path: "empty.txt" }); available(empty); expect(empty.patch).toContain("new file mode 100644");
});

test("rename, deletion, mode-only and tracked binary changes match native Git with scoped rename", async () => {
  const f = await fixture();
  await f.write("binary.bin", Buffer.from([0, 1])); f.git(["add", "binary.bin"]); f.git(["commit", "--quiet", "-m", "binary base"]);
  f.git(["checkout", "--quiet", "-b", "feature"]); f.git(["mv", "rename.txt", "renamed.txt"]); f.git(["rm", "--quiet", "delete.txt"]);
  await chmod(join(f.cwd, "file.txt"), 0o755); await f.write("binary.bin", Buffer.from([0, 2]));
  const result = await readBranchReview(f.ports, { baseBranch: "main" }); available(result);
  expect(result.files.find(file => file.path === "renamed.txt")).toMatchObject({ status: "R", previousPath: "rename.txt", additions: 0, deletions: 0 });
  expect(result.files.find(file => file.path === "delete.txt")).toMatchObject({ status: "D", deletions: 1 });
  expect(result.files.find(file => file.path === "file.txt")).toMatchObject({ status: "M", additions: 0, deletions: 0 });
  expect(result.files.find(file => file.path === "binary.bin")?.additions).toBeNull();
  const scoped = await readBranchReview(f.ports, { baseBranch: "main", path: "renamed.txt", context: 0 }); available(scoped);
  expect(scoped.revision).toBe(result.revision); expect(scoped.files).toEqual(result.files); expect(scoped.patch).toContain("rename from rename.txt"); expect(scoped.patch).not.toContain("delete.txt");
});

test("remote default retains its namespace despite local branch name collisions", async () => {
  const f = await fixture(), base = f.git(["rev-parse", "HEAD"]).trim();
  f.git(["remote", "add", "origin", "/does-not-exist-no-network"]); f.git(["update-ref", "refs/remotes/origin/main", base]); f.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  f.git(["checkout", "--quiet", "-b", "feature"]); await f.write("file.txt", "feature change\n"); f.git(["commit", "--quiet", "-am", "feature"]);
  f.git(["branch", "--force", "main", "HEAD"]); f.git(["branch", "origin/main", "HEAD"]);
  const result = await readBranchReview(f.ports); available(result);
  expect(result).toMatchObject({ requestedBase: null, baseBranch: "origin/main", baseCommit: base, mergeBase: base, currentBranch: "feature" }); expect(result.patch).toContain("+feature change");
  const explicit = await readBranchReview(f.ports, { baseBranch: "main" }); available(explicit); expect(explicit.files).toEqual([]);
  const fullRemote = await readBranchReview(f.ports, { baseBranch: "refs/remotes/origin/main" }); available(fullRemote); expect(fullRemote.baseCommit).toBe(base);
});

test("unavailable head/default/ref/history are distinct and detached HEAD remains reviewable", async () => {
  const unborn = await fixture(true); expect(await readBranchReview(unborn.ports, { baseBranch: "main" })).toMatchObject({ state: "unavailable", reason: "head_unavailable" });
  const f = await fixture(); expect(await readBranchReview(f.ports)).toMatchObject({ state: "unavailable", reason: "default_branch_unavailable" });
  expect(await readBranchReview(f.ports, { baseBranch: "unknown" })).toMatchObject({ state: "unavailable", reason: "base_ref_unavailable", requestedBase: "unknown" });
  expect(await readBranchReview(f.ports, { baseBranch: "--output=/tmp/not-an-option" })).toMatchObject({ state: "unavailable", reason: "base_ref_unavailable" });
  f.git(["checkout", "--quiet", "--orphan", "other"]); f.git(["commit", "--quiet", "-m", "unrelated"]);
  expect(await readBranchReview(f.ports, { baseBranch: "main" })).toMatchObject({ state: "unavailable", reason: "merge_base_unavailable" });
  f.git(["checkout", "--quiet", "--detach", "main"]); await f.write("file.txt", "detached edit\n");
  const detached = await readBranchReview(f.ports, { baseBranch: "main" }); available(detached); expect(detached.currentBranch).toBeNull(); expect(detached.patch).toContain("+detached edit");
});

test("explicit missing local base resolves only a cached remote without fetching", async () => {
  const f = await fixture(), base = f.git(["rev-parse", "HEAD"]).trim(); f.git(["remote", "add", "upstream", "/fixture-no-network"]); f.git(["update-ref", "refs/remotes/upstream/trunk", base]);
  await f.write("file.txt", "edited\n");
  const commands: string[][] = [], ports = { ...f.ports, git: (args: string[], options: Parameters<BranchReviewPorts["git"]>[1]) => { commands.push(args); return f.ports.git(args, options); } };
  const result = await readBranchReview(ports, { baseBranch: "trunk" }); available(result);
  expect(result).toMatchObject({ requestedBase: "trunk", baseBranch: "upstream/trunk", baseCommit: base });
  expect(commands.some(args => args.includes("fetch") || args.includes("ls-remote"))).toBe(false);
});

for (const change of ["working", "base", "head", "index", "untracked", "owner"] as const) {
  test(`read fence rejects a changed ${change} during patch generation`, async () => {
    const f = await fixture(); f.git(["branch", "review-base"]); f.git(["checkout", "--quiet", "-b", "feature"]);
    await f.write("file.txt", "before\n"); f.git(["commit", "--quiet", "-am", "feature"]); await f.write("file.txt", "dirty!\n");
    let fired = false, extraFence = "";
    const ports: BranchReviewPorts = { ...f.ports, readFence: async () => await f.ports.readFence() + extraFence, git: async (args, options) => {
      const value = await f.ports.git(args, options);
      if (!fired && args.includes("--unified=3")) {
        fired = true;
        if (change === "working") { const metadata = await lstat(join(f.cwd, "file.txt")); await f.write("file.txt", "other!\n"); await utimes(join(f.cwd, "file.txt"), metadata.atime, metadata.mtime); }
        if (change === "base") f.git(["update-ref", "refs/heads/review-base", "HEAD"]);
        if (change === "head") f.git(["update-ref", "HEAD", "main"]);
        if (change === "index") f.git(["add", "file.txt"]);
        if (change === "untracked") await f.write("arrived.txt", "late\n");
        if (change === "owner") extraFence = "changed";
      }
      return value;
    } };
    await expect(readBranchReview(ports, { baseBranch: "review-base" })).rejects.toMatchObject({ code: "GIT_CHANGED" }); expect(fired).toBe(true);
  });
}

test("timeouts and output failures propagate as errors instead of an empty successful review", async () => {
  const f = await fixture();
  for (const code of ["GIT_TIMEOUT", "GIT_OUTPUT_TOO_LARGE"]) {
    const ports: BranchReviewPorts = { ...f.ports, git: async (args, options) => {
      if (args.includes("--raw")) throw Object.assign(new Error(code), { code });
      return f.ports.git(args, options);
    } };
    await expect(readBranchReview(ports, { baseBranch: "main" })).rejects.toMatchObject({ code });
  }
});

test("strict request validation rejects traversal, unknown fields and malformed context", () => {
  expect(parseBranchReviewRequest({ baseBranch: " main ", path: 'snow☃\n".txt', context: 0 })).toEqual({ baseBranch: "main", path: 'snow☃\n".txt', context: 0 });
  for (const input of [null, [], { staged: true }, { baseBranch: "" }, { baseBranch: "main\n" }, { path: "../file" }, { path: "/file" }, { context: -1 }, { context: 1001 }, { context: 0.5 }]) expect(() => parseBranchReviewRequest(input)).toThrow();
});


test("deleted parent directories and recreated untracked paths retain one selectable inventory row", async () => {
  const f = await fixture(); await mkdir(join(f.cwd, "nested")); await f.write("nested/deleted.txt", "gone\n"); f.git(["add", "--all"]); f.git(["commit", "--quiet", "-m", "nested base"]);
  f.git(["rm", "--quiet", "-r", "nested", "file.txt"]); await f.write("file.txt", "restored untracked\n");
  const result = await readBranchReview(f.ports, { baseBranch: "main" }); available(result);
  expect(result.files.filter(file => file.path === "file.txt")).toHaveLength(1);
  expect(result.files.find(file => file.path === "file.txt")).toMatchObject({ status: "M", untracked: true, additions: 1, deletions: 1 });
  expect(result.files.find(file => file.path === "nested/deleted.txt")).toMatchObject({ status: "D" });
  const scoped = await readBranchReview(f.ports, { baseBranch: "main", path: "file.txt" }); available(scoped);
  expect(scoped.revision).toBe(result.revision); expect(scoped.patch).toContain("-original"); expect(scoped.patch).toContain("+restored untracked");
});

test("missing refs and default changes are fenced even when the comparison is unavailable", async () => {
  const f = await fixture();
  let reads = 0;
  const ports: BranchReviewPorts = { ...f.ports, git: async (args, options) => {
    const result = await f.ports.git(args, options);
    if (args.includes("missing^{commit}") && ++reads === 1) f.git(["branch", "missing"]);
    return result;
  } };
  await expect(readBranchReview(ports, { baseBranch: "missing" })).rejects.toMatchObject({ code: "GIT_CHANGED" });
  let defaults = 0;
  await expect(readBranchReview({ ...f.ports, baseBranch: async () => ++defaults === 1 ? null : { remote: "origin", local: "main" } })).rejects.toMatchObject({ code: "GIT_CHANGED" });
});


test("repository diff prefix preferences cannot erase native a/b path identity", async () => {
  const f = await fixture(); f.git(["config", "diff.noprefix", "true"]); await f.write("file.txt", "changed\n"); await f.write("new.txt", "new\n");
  const result = await readBranchReview(f.ports, { baseBranch: "main" }); available(result);
  expect(result.patch).toContain("diff --git a/file.txt b/file.txt"); expect(result.patch).toContain("diff --git a/new.txt b/new.txt");
});


test("fallback respects configured origin-first candidates, slash branch names and orphan remote refs", async () => {
  const f = await fixture(), base = f.git(["rev-parse", "HEAD"]).trim();
  await f.write("file.txt", "next commit\n"); f.git(["commit", "--quiet", "-am", "next"]); const next = f.git(["rev-parse", "HEAD"]).trim();
  f.git(["remote", "add", "aaa", "/fixture-no-network"]); f.git(["remote", "add", "origin", "/fixture-no-network"]);
  f.git(["update-ref", "refs/remotes/aaa/team/topic", next]); f.git(["update-ref", "refs/remotes/origin/team/topic", base]);
  const slash = await readBranchReview(f.ports, { baseBranch: "team/topic" }); available(slash);
  expect(slash).toMatchObject({ requestedBase: "team/topic", baseBranch: "origin/team/topic", baseCommit: base });
  f.git(["update-ref", "refs/remotes/orphan/lost", base]);
  expect(await readBranchReview(f.ports, { baseBranch: "lost" })).toMatchObject({ state: "unavailable", reason: "base_ref_unavailable" });
  const explicit = await readBranchReview(f.ports, { baseBranch: "refs/remotes/orphan/lost" }); available(explicit); expect(explicit.baseCommit).toBe(base);
  f.git(["branch", "team/topic", next]);
  const direct = await readBranchReview(f.ports, { baseBranch: "team/topic" }); available(direct); expect(direct.baseCommit).toBe(next); expect(direct.baseBranch).toBe("team/topic");
});

test("fallback keeps native short remote candidate precedence and known remote prefix expansion", async () => {
  const f = await fixture(), base = f.git(["rev-parse", "HEAD"]).trim();
  await f.write("file.txt", "next commit\n"); f.git(["commit", "--quiet", "-am", "next"]); const next = f.git(["rev-parse", "HEAD"]).trim();
  f.git(["remote", "add", "origin", "/fixture-no-network"]); f.git(["remote", "add", "upstream", "/fixture-no-network"]);
  f.git(["branch", "origin/trunk", next]); f.git(["update-ref", "refs/remotes/origin/trunk", base]);
  const collision = await readBranchReview(f.ports, { baseBranch: "trunk" }); available(collision);
  expect(collision).toMatchObject({ baseBranch: "origin/trunk", baseCommit: next });
  // Requested origin/missing is unresolved. The origin candidate must be the
  // exact remote namespace, never origin/origin/missing.
  f.git(["update-ref", "refs/remotes/origin/origin/missing", next]); f.git(["update-ref", "refs/remotes/upstream/origin/missing", base]);
  const commands: string[][] = [], ports: BranchReviewPorts = { ...f.ports, git: (args, options) => { commands.push(args); return f.ports.git(args, options); } };
  const prefixed = await readBranchReview(ports, { baseBranch: "origin/missing" }); available(prefixed);
  expect(prefixed).toMatchObject({ baseBranch: "upstream/origin/missing", baseCommit: base });
  const candidates = commands.filter(args => args.includes("rev-parse")).map(args => args.at(-1));
  expect(candidates).toContain("refs/remotes/origin/missing^{commit}"); expect(candidates).not.toContain("origin/origin/missing^{commit}"); expect(candidates).not.toContain("refs/remotes/origin/origin/missing^{commit}");
  expect(commands.some(args => args.includes("for-each-ref") && args.includes("--format=%(upstream:short)") && args.includes("refs/heads/origin/missing"))).toBe(true);
});

test("selecting either rename alias retains the same native rename patch and full inventory", async () => {
  const f = await fixture(); f.git(["mv", "rename.txt", "renamed.txt"]);
  const current = await readBranchReview(f.ports, { baseBranch: "main", path: "renamed.txt" }); available(current);
  const previous = await readBranchReview(f.ports, { baseBranch: "main", path: "rename.txt" }); available(previous);
  expect(previous.patch).toBe(current.patch); expect(previous.patch).toContain("rename from rename.txt"); expect(previous.patch).toContain("rename to renamed.txt");
  expect(previous.files).toEqual(current.files); expect(previous.revision).toBe(current.revision);
});


test("branch-only POSIX ownership preserves backslash and globlike names through native Git and renderer parsing", async () => {
  const f = await fixture();
  await mkdir(join(f.cwd, "nested\\folder"));
  const names = ["slash\\name.txt", "literal\\123.txt", "tab\tline\n☃.txt", "[ab]*?.txt", ":(glob)*.txt", "nested\\folder/child\\file.txt"];
  for (const name of names) await f.write(name, `original ${JSON.stringify(name)}\n`);
  f.git(["add", "--all"]); f.git(["commit", "--quiet", "-m", "special filename base"]);
  for (const name of names) await f.write(name, `updated ${JSON.stringify(name)}\n`);
  await f.write("untracked\\name.txt", "untracked backslash\n");
  const result = await readBranchReview(f.ports, { baseBranch: "main" }); available(result);
  const expected = [...names, "untracked\\name.txt"].sort();
  expect(result.files.map(file => file.path).sort()).toEqual(expected);
  expect(parseReviewPatch(result.patch, "special-names").files.map(file => file.metadata.name).sort()).toEqual(expected);
  for (const name of expected) {
    const scoped = await readBranchReview(f.ports, { baseBranch: "main", path: name }); available(scoped);
    const parsed = parseReviewPatch(scoped.patch, `scoped:${name}`);
    expect(parsed.files.map(file => file.metadata.name)).toEqual([name]);
    expect(scoped.files).toEqual(result.files); expect(scoped.revision).toBe(result.revision);
  }
  // Generic mutating routes retain their stricter existing path contract.
  await expect(f.service.stage(["slash\\name.txt"])).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
});

test("branch-specific parent ownership rejects escaped ancestors while preserving final symlinks and missing ancestors", async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), "branch-review-path-outside-")); roots.push(outside);
  await writeFile(join(outside, "secret.txt"), "outside contents\n"); await symlink(outside, join(f.cwd, "escape"));
  await expect(readBranchReview(f.ports, { baseBranch: "main", path: "escape/secret.txt" })).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
  const finalLink = await readBranchReview(f.ports, { baseBranch: "main", path: "escape" }); available(finalLink);
  expect(finalLink.files.map(file => file.path)).toContain("escape");
  // Native no-index emits no patch when this symlink targets a directory.
  // Inventory remains authoritative; the renderer must show an explicit row.
  expect(finalLink.patch).toBe(""); expect(finalLink.patch).not.toContain("outside contents");
  const absent = await readBranchReview(f.ports, { baseBranch: "main", path: "missing/parents/file.txt" }); available(absent); expect(absent.patch).toBe("");
  expect(parseBranchReviewRequest({ path: "literal\\name" })).toEqual({ path: "literal\\name" });
});


test("literal-backslash parent directories and ordinary symlink aliases preserve owning-root containment", async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), "branch-review-literal-outside-")); roots.push(outside);
  await mkdir(join(f.cwd, "nested\\folder")); await f.write("nested\\folder/file.txt", "inside\n");
  await symlink("nested\\folder", join(f.cwd, "alias")); await writeFile(join(f.cwd, ".git/info/exclude"), "alias\n");
  const aliased = await readBranchReview(f.ports, { baseBranch: "main", path: "alias/file.txt" }); available(aliased);
  expect(aliased.files.some(file => file.path === "nested\\folder/file.txt")).toBe(true);
  await symlink(join(f.cwd, "nested\\folder/file.txt"), join(f.cwd, "link\\inside"));
  const final = await readBranchReview(f.ports, { baseBranch: "main", path: "link\\inside" }); available(final);
  expect(final.patch).toContain("new file mode 120000"); expect(final.patch).not.toContain("+inside\n");
  await symlink(join(outside, "not-created"), join(f.cwd, "dangling\\outside"));
  await expect(readBranchReview(f.ports, { baseBranch: "main", path: "dangling\\outside/secret.txt" })).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
  await symlink(outside, join(f.cwd, "link\\outside"));
  await expect(readBranchReview(f.ports, { baseBranch: "main", path: "link\\outside/secret.txt" })).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
});
