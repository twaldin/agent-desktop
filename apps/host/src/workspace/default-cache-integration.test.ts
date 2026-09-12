import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../store";
import { HostWorkspaces } from "../workspace-http";
import { WorkspaceError, WorkspaceService } from "./service";
import { DefaultBranchCache } from "./default-branch-cache";
import { RecentBranchCache } from "./recent-branch-cache";
import type { MetadataWatchIO } from "./repository-metadata-watcher";
import type { BranchQueryUpdate } from "./branch-live-queries";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "-C", cwd, ...args], {
    stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  });
  if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout.toString().trim();
}
async function until(check: () => boolean) {
  for (let i = 0; i < 600 && !check(); i++) await new Promise<void>(resolve => setTimeout(resolve, 5));
  if (!check()) throw new Error("Controlled default read did not settle.");
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "default-cache-"))), repo = join(root, "repo"), data = join(root, "data");
  await mkdir(repo); git(repo, "init", "-q", "--initial-branch=main"); git(repo, "commit", "--allow-empty", "-qm", "fixture");
  git(repo, "branch", "topic"); const head = git(repo, "rev-parse", "HEAD");
  const calls: string[][] = [];
  const prototype = WorkspaceService.prototype as unknown as { git(args: string[], options?: unknown): Promise<unknown> };
  const original = prototype.git;
  prototype.git = function(args, options) { calls.push([...args]); return original.call(this, args, options); };
  cleanups.push(async () => { prototype.git = original; await rm(root, { recursive: true, force: true }); });
  const cache = new DefaultBranchCache(), recent = new RecentBranchCache(), service = new WorkspaceService(repo);
  cleanups.push(async () => { await cache.dispose(); await recent.dispose(); });
  return { root, repo, data, service, head, cache, reads: { cache: recent, defaults: cache }, calls,
    count: (command: string, suffix?: string) => calls.filter(args => args[0] === command && (suffix === undefined ? args.length === 1 : args.at(-1) === suffix)).length };
}

test("actual service shares default/base discovery dependencies and revalidates every cached entrypoint", async () => {
  const f = await fixture(), remote = join(f.root, "remote.git"); await mkdir(remote);
  git(remote, "init", "--bare", "--initial-branch=main"); git(f.repo, "push", remote, "main"); git(f.repo, "remote", "add", "origin", remote);
  expect(await f.service.baseBranch(undefined, f.cache)).toEqual({ local: "main", remote: "origin" });
  expect(await f.service.defaultBranch(undefined, f.reads)).toBe("main");
  const result = await f.service.baseBranch(undefined, f.cache); result!.local = "caller-edit";
  expect(await f.service.baseBranch(undefined, f.cache)).toEqual({ local: "main", remote: "origin" });
  expect(f.count("remote")).toBe(1); expect(f.count("symbolic-ref", "refs/remotes/origin/HEAD")).toBe(1); expect(f.count("remote", "origin")).toBe(1);
  expect(f.calls.some(args => args[0] === "fetch")).toBe(false);
  const originalRepo = join(f.root, "original"); await rename(f.repo, originalRepo); await mkdir(f.repo);
  git(f.repo, "init", "-q", "--initial-branch=other");
  await expect(f.service.baseBranch(undefined, f.cache)).rejects.toMatchObject({ code: "PATH_CHANGED" });
  expect(await new WorkspaceService(f.repo).baseBranch(undefined, f.cache)).toBeNull(); expect(f.count("remote")).toBe(2);
});

test("actual service caches negative remote dependencies separately and preserves operational failures", async () => {
  const f = await fixture(); git(f.repo, "remote", "add", "origin", join(f.root, "absent"));
  git(f.repo, "update-ref", "refs/remotes/origin/master", f.head);
  expect(await f.service.baseBranch(undefined, f.cache)).toEqual({ local: "master", remote: "origin" });
  expect(await f.service.defaultBranch(undefined, f.reads)).toBe("master");
  expect(f.count("remote")).toBe(1); expect(f.count("remote", "origin")).toBe(1);
  expect(f.count("show-ref", "refs/remotes/origin/main")).toBe(1); expect(f.count("show-ref", "refs/remotes/origin/master")).toBe(1);
  git(f.repo, "update-ref", "refs/remotes/origin/main", f.head); f.cache.invalidate(f.repo, "index");
  expect(await f.service.defaultBranch(undefined, f.reads)).toBe("master");
  f.cache.invalidate(f.repo, "remote-refs"); expect(await f.service.defaultBranch(undefined, f.reads)).toBe("main");
  expect(f.count("remote")).toBe(1); expect(f.count("remote", "origin")).toBe(2);
  expect(f.count("show-ref", "refs/remotes/origin/main")).toBe(2); expect(f.count("show-ref", "refs/remotes/origin/master")).toBe(1);
  const runner = f.service as unknown as { git(args: string[], options?: unknown): Promise<unknown> }, original = runner.git.bind(f.service); let failures = 0;
  runner.git = async (args, options) => {
    if (args[0] === "remote" && args[1] === "show") { failures++; throw new WorkspaceError("GIT_TIMEOUT", "controlled timeout"); }
    return original(args, options);
  };
  f.cache.invalidate(f.repo, "remote-refs");
  await expect(f.service.baseBranch(undefined, f.cache)).rejects.toMatchObject({ code: "GIT_TIMEOUT" });
  await expect(f.service.baseBranch(undefined, f.cache)).rejects.toMatchObject({ code: "GIT_TIMEOUT" }); expect(failures).toBe(2);
  runner.git = original; git(f.repo, "remote", "remove", "origin"); f.cache.invalidate(f.repo, "config");
  expect(await f.service.baseBranch(undefined, f.cache)).toBeNull(); expect(await f.service.defaultBranch(undefined, f.reads)).toBe("main");
  expect(f.count("remote")).toBe(2);
});

test("actual HostWorkspaces shares live/one-shot dependencies, keeps them across mutation, and clears on watch events/recovery/release", async () => {
  const f = await fixture(); git(f.repo, "remote", "add", "origin", join(f.root, "unused"));
  git(f.repo, "update-ref", "refs/remotes/origin/main", f.head); git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const opened: { path: string; changed(name: string | null, renamed: boolean): void; fail(error: Error): void }[] = [], timers: { active: boolean; run(): void }[] = [];
  const io: MetadataWatchIO = {
    now: () => 0, directoryIdentity: async path => path, directories: async () => [],
    async open(path, _recursive, changed) { let finish!: (error: Error | undefined) => void;
      const closed = new Promise<Error | undefined>(resolve => { finish = resolve; }); opened.push({ path, changed, fail: finish });
      return { closed, dispose: async () => { finish(undefined); } }; },
    schedule(run) { const timer = { active: true, run }; timers.push(timer); return () => { timer.active = false; }; },
  };
  const store = new HostStore(f.data), host = new HostWorkspaces(store, f.data, () => () => {}, undefined, undefined, undefined, undefined, io);
  cleanups.push(async () => { await host.shutdownRepositoryWatches(); await host.shutdownSubmissions(); store.close(); });
  const target = { projectId: store.addProject({ path: f.repo }).id }, updates: BranchQueryUpdate[] = [];
  expect(await host.query(target, { type: "git.base-branch" })).toMatchObject({ base: { local: "main", remote: "origin" } });
  const lease = await host.subscribeBranchQuery(target, { type: "git.default-branch" }, new AbortController().signal, update => updates.push(update), false);
  await until(() => updates.length > 0); expect(updates.at(-1)).toMatchObject({ result: { branch: "main" } });
  expect(f.count("remote")).toBe(1); expect(f.count("symbolic-ref", "refs/remotes/origin/HEAD")).toBe(1);
  await writeFile(join(f.repo, "note"), "fixture"); await host.mutate(target, { type: "git.stage", paths: ["note"] });
  await host.query(target, { type: "git.base-branch" }); expect(f.count("remote")).toBe(1);
  git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/topic");
  git(f.repo, "update-ref", "refs/remotes/origin/topic", f.head);
  opened.find(watch => watch.path.endsWith("/refs/remotes"))!.changed("origin/HEAD", false);
  for (const timer of [...timers]) if (timer.active) { timer.active = false; timer.run(); }
  await until(() => updates.some(update => update.phase === "complete" && update.result?.type === "git.default-branch" && update.result.branch === "topic"));
  expect(f.count("remote")).toBe(1); expect(f.count("symbolic-ref", "refs/remotes/origin/HEAD")).toBe(2);
  opened.find(watch => watch.path.endsWith("/refs/remotes"))!.fail(new Error("controlled watch loss"));
  await until(() => updates.at(-1)?.requiresRecovery === true);
  expect(f.count("remote")).toBe(1); expect(f.count("symbolic-ref", "refs/remotes/origin/HEAD")).toBe(2);
  git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await lease.recover(); expect(updates.at(-1)).toMatchObject({ requiresRecovery: true, result: { branch: "main" } });
  expect(f.count("remote")).toBe(2); expect(f.count("symbolic-ref", "refs/remotes/origin/HEAD")).toBe(3);
  await lease.dispose(); await host.query(target, { type: "git.base-branch" });
  expect(f.count("remote")).toBe(3); expect(f.count("symbolic-ref", "refs/remotes/origin/HEAD")).toBe(4);
});
