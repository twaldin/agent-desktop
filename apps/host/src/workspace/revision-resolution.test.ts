import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceService, WorkspaceError } from "./service";
import { HostWorkspaces, parseWorkspaceQuery } from "../workspace-http";
import type { HostStore } from "../store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: {
    PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C",
  } });
  if (!r.success) throw new Error(r.stderr.toString());
  return r.stdout.toString().trimEnd();
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-revision-resolution-"))); roots.push(root);
  const cwd = join(root, "repository"); await mkdir(cwd); await mkdir(join(root, "hooks"));
  git(cwd, "init", "--initial-branch=main"); git(cwd, "config", "user.name", "Revision Fixture");
  git(cwd, "config", "user.email", "revision@example.invalid"); git(cwd, "config", "commit.gpgSign", "false");
  git(cwd, "config", "tag.gpgSign", "false"); git(cwd, "config", "core.hooksPath", join(root, "hooks"));
  await writeFile(join(cwd, "tracked"), "one\n"); git(cwd, "add", "tracked"); git(cwd, "commit", "-m", "one");
  const first = git(cwd, "rev-parse", "HEAD"); git(cwd, "tag", "lightweight"); git(cwd, "tag", "-a", "annotated", "-m", "annotated");
  await writeFile(join(cwd, "tracked"), "two\n"); git(cwd, "commit", "-am", "two");
  const head = git(cwd, "rev-parse", "HEAD"); git(cwd, "update-ref", "refs/remotes/origin/main", head);
  await writeFile(join(cwd, "tracked"), "staged\n"); git(cwd, "add", "tracked");
  await writeFile(join(cwd, "tracked"), "unstaged\n"); await writeFile(join(cwd, "untracked"), "retained\n");
  const service = new WorkspaceService(cwd);
  const snapshot = async () => ({ index: (await readFile(join(cwd, ".git/index"))).toString("base64"),
    head: await readFile(join(cwd, ".git/HEAD"), "utf8"), config: await readFile(join(cwd, ".git/config"), "utf8"),
    reflog: await readFile(join(cwd, ".git/logs/HEAD"), "utf8"), refs: git(cwd, "for-each-ref", "--format=%(refname)%00%(objectname)"),
    tracked: await readFile(join(cwd, "tracked"), "utf8"), untracked: await readFile(join(cwd, "untracked"), "utf8") });
  return { root, cwd, service, first, head, snapshot };
}

test("revision request preserves one bounded expression without interpreting it as options", () => {
  for (const expression of ["HEAD~1", "refs/tags/annotated", "--help", "HEAD^{commit}", ":/one"]) {
    expect(parseWorkspaceQuery({ type: "git.resolve-revision", expression: ` ${expression} ` }))
      .toEqual({ type: "git.resolve-revision", expression });
  }
  for (const expression of ["", " ", "x\n", "x\0", 3, null, "x".repeat(513)])
    expect(() => parseWorkspaceQuery({ type: "git.resolve-revision", expression })).toThrow();
});

test("actual Git resolves local tags, object IDs and revision expressions without changing workspace bytes", async () => {
  const f = await fixture(), before = await f.snapshot();
  for (const expression of ["lightweight", "annotated", "refs/tags/annotated", f.first, f.first.slice(0, 12), "HEAD~1", "HEAD@{1}"]) {
    expect(await f.service.resolveRevision(expression)).toEqual({ expression, commit: f.first });
  }
  for (const expression of ["HEAD", "refs/heads/main", "origin/main", "refs/remotes/origin/main"])
    expect(await f.service.resolveRevision(expression)).toEqual({ expression, commit: f.head });
  for (const expression of ["absent-target", "HEAD^{tree}", "HEAD:tracked", "--help", "--output=/tmp/no", "HEAD..HEAD~1"])
    expect(await f.service.resolveRevision(expression)).toBeNull();
  expect(await f.snapshot()).toEqual(before);
});

test("resolution is fresh after a moved tag and reports Git operational failures rather than absence", async () => {
  const f = await fixture();
  expect((await f.service.resolveRevision("lightweight"))?.commit).toBe(f.first);
  git(f.cwd, "tag", "-f", "lightweight", f.head);
  expect((await f.service.resolveRevision("lightweight"))?.commit).toBe(f.head);
  // Exercise failure classification at the actual service query boundary. The
  // command runner is controlled; these are not induced OS timeout/limit tests.
  const runner = f.service as unknown as { git: (...args: unknown[]) => Promise<unknown> };
  const original = runner.git.bind(f.service);
  for (const code of ["GIT_TIMEOUT", "GIT_OUTPUT_TOO_LARGE", "GIT_FAILED"]) {
    runner.git = async (...args) => {
      if ((args[0] as string[]).includes("--no-lazy-fetch")) throw new WorkspaceError(code, "controlled operational failure");
      return original(...args);
    };
    await expect(f.service.resolveRevision("HEAD")).rejects.toMatchObject({ code });
  }
  runner.git = original;
});

test("missing promisor object is not fetched during local revision resolution", async () => {
  const f = await fixture();
  // A real loose commit becomes absent while its ref remains in a repository
  // configured with a promisor remote. The no-lazy-fetch option forbids repair.
  git(f.cwd, "remote", "add", "origin", join(f.root, "unavailable-remote"));
  git(f.cwd, "config", "remote.origin.promisor", "true");
  await rm(join(f.cwd, ".git/objects", f.first.slice(0, 2), f.first.slice(2)));
  const before = await f.snapshot();
  const trace = join(f.root, "resolution-trace.jsonl");
  const runner = f.service as unknown as { git: (args: string[], options?: { env?: NodeJS.ProcessEnv; validExitCodes?: number[] }) => Promise<unknown> };
  const original = runner.git.bind(f.service);
  runner.git = (args, options) => original(args, { ...options, env: { ...options?.env, GIT_TRACE2_EVENT: trace } });
  try { expect(await f.service.resolveRevision("lightweight")).toBeNull(); }
  finally { runner.git = original; }
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(events.some(event => event.event === "start" && event.argv.includes("--no-lazy-fetch"))).toBe(true);
  expect(events.filter(event => event.event === "child_start" && event.argv?.includes("fetch"))).toHaveLength(0);
  expect(await f.snapshot()).toEqual(before);
});

test("owning-host resolution rejects standalone targets and catalog retarget after either found or absent result", async () => {
  const f = await fixture(), nested = join(f.cwd, "app"); await mkdir(nested);
  let project = { id: "project", hostId: "host", path: nested };
  const store = { host: { id: "host" }, getProject: (id: string) => id === "project" ? project : undefined,
    getSession: () => undefined } as unknown as HostStore;
  const host = new HostWorkspaces(store, join(f.root, "data"), () => { throw new Error("Read-only resolution cannot reserve mutation"); });
  const target = { projectId: "project" }, query = { type: "git.resolve-revision" as const, expression: "annotated" };
  expect(await host.query(target, query)).toEqual({ type: query.type, revision: { expression: "annotated", commit: f.first } });
  await expect(host.query({ filePath: join(f.cwd, "tracked") }, query)).rejects.toThrow();
  const original = WorkspaceService.prototype.resolveRevision;
  WorkspaceService.prototype.resolveRevision = async function (...args) {
    const result = await original.apply(this, args); project = { ...project, path: join(f.root, "different") }; return result;
  };
  try {
    for (const expression of ["annotated", "absent-target"]) {
      project = { ...project, path: nested };
      await expect(host.query(target, { ...query, expression })).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
    }
  } finally { WorkspaceService.prototype.resolveRevision = original; await host.shutdownSubmissions(); }
});
