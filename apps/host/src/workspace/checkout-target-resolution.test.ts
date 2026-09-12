import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostWorkspaces, parseWorkspaceQuery } from "../workspace-http";
import type { HostStore } from "../store";
import { WorkspaceError, WorkspaceService } from "./service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" } });
  if (!result.success) throw new Error(result.stderr.toString()); return result.stdout.toString().trimEnd();
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-checkout-resolution-"))); roots.push(root);
  const cwd = join(root, "repository"); await mkdir(cwd); await mkdir(join(root, "hooks"));
  git(cwd, "init", "--initial-branch=main"); git(cwd, "config", "user.name", "Checkout Resolver");
  git(cwd, "config", "user.email", "checkout@example.invalid"); git(cwd, "config", "commit.gpgSign", "false"); git(cwd, "config", "tag.gpgSign", "false");
  git(cwd, "config", "core.hooksPath", join(root, "hooks"));
  await writeFile(join(cwd, "tracked"), "one\n"); git(cwd, "add", "tracked"); git(cwd, "commit", "-m", "first");
  const first = git(cwd, "rev-parse", "HEAD"); git(cwd, "tag", "-a", "version-one", "-m", "version one");
  await writeFile(join(cwd, "tracked"), "two\n"); git(cwd, "commit", "-am", "second");
  const head = git(cwd, "rev-parse", "HEAD");
  git(cwd, "branch", "local-topic"); git(cwd, "tag", "local-topic", first);
  git(cwd, "config", "remote.origin.url", join(root, "never-contact")); git(cwd, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(cwd, "update-ref", "refs/remotes/origin/local-topic", first);
  git(cwd, "update-ref", "refs/remotes/origin/feature/topic", head);
  git(cwd, "update-ref", "refs/remotes/other/ambiguous", first); git(cwd, "update-ref", "refs/remotes/origin/ambiguous", head);
  git(cwd, "tag", "ambiguous", first);
  await writeFile(join(cwd, "tracked"), "staged\n"); git(cwd, "add", "tracked");
  await writeFile(join(cwd, "tracked"), "unstaged\n"); await writeFile(join(cwd, "untracked"), "retain\n");
  const snapshot = async () => ({ index: (await readFile(join(cwd, ".git/index"))).toString("base64"),
    head: await readFile(join(cwd, ".git/HEAD"), "utf8"), config: await readFile(join(cwd, ".git/config"), "utf8"),
    reflog: await readFile(join(cwd, ".git/logs/HEAD"), "utf8"), refs: git(cwd, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"),
    tracked: await readFile(join(cwd, "tracked"), "utf8"), untracked: await readFile(join(cwd, "untracked"), "utf8") });
  return { root, cwd, first, head, snapshot, service: new WorkspaceService(cwd) };
}
type Runner = { git(args: string[], options?: unknown): Promise<{ stdout: string; exitCode: number }> };

test("checkout resolution parser preserves a bounded trimmed expression", () => {
  for (const expression of ["main", "feature/topic", "version-one", "HEAD~1", "--help", "refs/heads/main"])
    expect(parseWorkspaceQuery({ type: "git.resolve-checkout", expression: ` ${expression} ` })).toEqual({ type: "git.resolve-checkout", expression });
  for (const expression of ["", "  ", "bad\n", "bad\0", "x".repeat(513), null, 3])
    expect(() => parseWorkspaceQuery({ type: "git.resolve-checkout", expression })).toThrow();
});

test("checkout resolution prioritizes a local head over same-named remote and tag without writes", async () => {
  const f = await fixture(), before = await f.snapshot();
  expect(await f.service.resolveCheckoutTarget("local-topic")).toEqual({ kind: "branch", expression: "local-topic", selection: { ref: "refs/heads/local-topic", commit: f.head } });
  expect(await f.service.resolveCheckoutTarget(" main ")).toEqual({ kind: "branch", expression: "main", selection: { ref: "refs/heads/main", commit: f.head } });
  expect(await f.snapshot()).toEqual(before);
});

test("checkout resolution finds an exact unique remote and supplies its native local tracking name", async () => {
  const f = await fixture(), before = await f.snapshot();
  const target = await f.service.resolveCheckoutTarget("feature/topic");
  expect(target).toEqual({ kind: "branch", expression: "feature/topic", selection: { ref: "refs/remotes/origin/feature/topic", commit: f.head, localBranch: "feature/topic" } });
  expect(await f.snapshot()).toEqual(before);
  if (target?.kind !== "branch") throw new Error("Expected tracking target");
  // Deliberately consume the prepared target through the existing mutation in
  // this disposable Git fixture. This is not a renderer or remote-host action.
  const result = await f.service.checkoutRef(target.selection, (await f.service.gitStatus()).revision);
  expect(result.branch).toBe("feature/topic"); expect(result.head).toBe(f.head);
  expect(git(f.cwd, "for-each-ref", "--format=%(upstream)", "refs/heads/feature/topic")).toBe("refs/remotes/origin/feature/topic");
  expect(await readFile(join(f.cwd, "tracked"), "utf8")).toBe("unstaged\n");
});

test("checkout resolution rejects multiple remotes without falling through to a same-name tag", async () => {
  const f = await fixture(), before = await f.snapshot();
  await expect(f.service.resolveCheckoutTarget("ambiguous")).rejects.toMatchObject({ code: "BRANCH_AMBIGUOUS" });
  expect(await f.snapshot()).toEqual(before);
});

test("checkout resolution returns detached commit identities for tags, full refs and expressions", async () => {
  const f = await fixture(), before = await f.snapshot();
  for (const expression of ["version-one", "HEAD~1", f.first, f.first.slice(0, 12)])
    expect(await f.service.resolveCheckoutTarget(expression)).toEqual({ kind: "revision", expression, commit: f.first });
  for (const expression of ["refs/heads/local-topic", "refs/remotes/origin/feature/topic"])
    expect(await f.service.resolveCheckoutTarget(expression)).toEqual({ kind: "revision", expression, commit: f.head });
  for (const expression of ["does-not-exist", "HEAD^{tree}", "--help"])
    expect(await f.service.resolveCheckoutTarget(expression)).toBeNull();
  expect(await f.snapshot()).toEqual(before);
});

test("checkout resolution does not reinterpret a disappearing local head as a remote or tag", async () => {
  const f = await fixture(), runner = f.service as unknown as Runner, original = runner.git.bind(f.service); let removed = false;
  runner.git = async (args, options) => {
    const result = await original(args, options);
    if (!removed && args[0] === "show-ref" && args.at(-1) === "refs/heads/local-topic") { removed = true; git(f.cwd, "branch", "-D", "local-topic"); }
    return result;
  };
  await expect(f.service.resolveCheckoutTarget("local-topic")).rejects.toMatchObject({ code: "BRANCH_CHANGED" });
  expect(removed).toBe(true); expect(git(f.cwd, "branch", "--show-current")).toBe("main");
});

test("checkout resolution propagates failed enumeration and never invokes alternate resolution", async () => {
  const f = await fixture(), runner = f.service as unknown as Runner, original = runner.git.bind(f.service); let afterFailure = 0;
  for (const code of ["GIT_TIMEOUT", "GIT_OUTPUT_TOO_LARGE", "GIT_FAILED"]) for (const expression of ["local-topic", "feature/topic"]) {
    let failed = false;
    runner.git = async (args, options) => {
      if (failed) afterFailure++;
      if (args[0] === "for-each-ref") { failed = true; throw new WorkspaceError(code, "controlled enumeration failure"); }
      return original(args, options);
    };
    await expect(f.service.resolveCheckoutTarget(expression)).rejects.toMatchObject({ code });
  }
  expect(afterFailure).toBe(0); runner.git = original;
});

test("chosen branch rejects malformed exact object records before peeling", async () => {
  const f = await fixture(), runner = f.service as unknown as Runner, original = runner.git.bind(f.service);
  for (const record of ["refs/heads/local-topic\0not-an-object\n", `refs/heads/local-topic\0${f.head}\0extra\n`, `refs/heads/local-topic\0${f.head}\nrefs/heads/local-topic\0${f.head}\n`]) {
    let supplied = false, laterCalls = 0;
    runner.git = async (args, options) => {
      if (supplied) laterCalls++;
      if (args.includes("--format=%(refname)%00%(objectname)")) { supplied = true; return { exitCode: 0, stdout: record }; }
      return original(args, options);
    };
    await expect(f.service.resolveCheckoutTarget("local-topic")).rejects.toMatchObject({ code: "GIT_FAILED" });
    expect(supplied).toBe(true); expect(laterCalls).toBe(0);
  }
});

for (const remote of [false, true]) test(`chosen ${remote ? "remote" : "local"} ref disappearance cannot resolve a full-ref shadow tag`, async () => {
  const f = await fixture(), expression = remote ? "feature/topic" : "local-topic";
  const ref = remote ? "refs/remotes/origin/feature/topic" : "refs/heads/local-topic";
  const shadow = `refs/tags/${ref}`;
  git(f.cwd, "update-ref", shadow, f.first);
  const runner = f.service as unknown as Runner, original = runner.git.bind(f.service);
  let removed = false, afterRemoval: Awaited<ReturnType<typeof f.snapshot>> | undefined;
  runner.git = async (args, options) => {
    const result = await original(args, options);
    const discovered = remote ? args[0] === "for-each-ref" && args.includes("--count=2")
      : args[0] === "show-ref" && args.at(-1) === ref;
    if (!removed && discovered) {
      removed = true; git(f.cwd, "update-ref", "-d", ref);
      // Actual Git demonstrates why peeling the full name is unsafe here.
      expect(git(f.cwd, "rev-parse", "--verify", `${ref}^{commit}`)).toBe(f.first);
      afterRemoval = await f.snapshot();
    }
    return result;
  };
  await expect(f.service.resolveCheckoutTarget(expression)).rejects.toMatchObject({ code: "BRANCH_CHANGED" });
  expect(removed).toBe(true); expect(afterRemoval).toBeDefined();
  expect(await f.snapshot()).toEqual(afterRemoval!);
  expect(git(f.cwd, "show-ref", "--verify", "--hash", shadow)).toBe(f.first);
});

test("checkout resolution query fences project and session delivery without reserving a mutation", async () => {
  const f = await fixture(), nested = join(f.cwd, "app"); await mkdir(nested);
  let project = { id: "project", hostId: "host", path: nested }, session = { id: "session", hostId: "host", projectId: "project", cwd: nested };
  const store = { host: { id: "host" }, getProject: (id: string) => id === "project" ? project : undefined,
    getSession: (id: string) => id === "session" ? session : undefined } as unknown as HostStore;
  const workspaces = new HostWorkspaces(store, join(f.root, "data"), () => { throw new Error("No query mutation reservation"); });
  const query = parseWorkspaceQuery({ type: "git.resolve-checkout", expression: "main" }), original = WorkspaceService.prototype.resolveCheckoutTarget;
  try {
    const expected = { type: "git.resolve-checkout" as const, target: { kind: "branch" as const, expression: "main", selection: { ref: "refs/heads/main", commit: f.head } } };
    expect(await workspaces.query({ projectId: "project" }, query)).toEqual(expected); expect(await workspaces.query({ sessionId: "session" }, query)).toEqual(expected);
    await expect(workspaces.query({ filePath: join(f.cwd, "tracked") }, query)).rejects.toThrow();
    WorkspaceService.prototype.resolveCheckoutTarget = async function(...args) { const result = await original.apply(this, args); project = { ...project, path: f.root }; return result; };
    await expect(workspaces.query({ projectId: "project" }, query)).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
    WorkspaceService.prototype.resolveCheckoutTarget = async function(...args) { const result = await original.apply(this, args); session = { ...session, cwd: f.root }; return result; };
    await expect(workspaces.query({ sessionId: "session" }, { type: "git.resolve-checkout", expression: "absent" })).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  } finally { WorkspaceService.prototype.resolveCheckoutTarget = original; await workspaces.shutdownSubmissions(); }
});
