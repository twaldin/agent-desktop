import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../store";
import { HostWorkspaces } from "../workspace-http";
import { WorkspaceService } from "./service";
import { RecentBranchCache } from "./recent-branch-cache";
import type { MetadataWatchIO } from "./repository-metadata-watcher";
import type { BranchQueryUpdate } from "./branch-live-queries";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function git(cwd: string, ...args: string[]) {
  const child = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "-C", cwd, ...args], {
    stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  });
  if (child.exitCode) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
}
async function until(check: () => boolean) {
  for (let i = 0; i < 600 && !check(); i++) await new Promise<void>(resolve => setTimeout(resolve, 5));
  if (!check()) throw new Error("Controlled branch read did not settle.");
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-read-cache-"))), repo = join(root, "repo"), data = join(root, "data");
  await mkdir(repo); git(repo, "init", "-q", "--initial-branch=main"); git(repo, "commit", "--allow-empty", "-qm", "fixture");
  git(repo, "branch", "topic");
  let scans = 0, remoteLists = 0, failOpen = false;
  const servicePrototype = WorkspaceService.prototype as unknown as { git(args: string[], options?: unknown): Promise<unknown> };
  const original = servicePrototype.git;
  servicePrototype.git = function(args, options) {
    if (args[0] === "for-each-ref" && args.includes("--sort=-committerdate")) scans++;
    if (args[0] === "remote" && args.length === 1) remoteLists++;
    return original.call(this, args, options);
  };
  cleanups.push(async () => { servicePrototype.git = original; await rm(root, { recursive: true, force: true }); });
  const timers: { cancelled: boolean; run(): void }[] = [];
  const opened: { path: string; changed(name: string | null, renamed: boolean): void; fail(error: Error): void; closed: boolean }[] = [];
  const io: MetadataWatchIO = {
    now: () => 0, directoryIdentity: async path => path, directories: async () => [],
    async open(path, _recursive, changed) {
      if (failOpen) throw new Error("Controlled coverage gap");
      let resolve!: (error: Error | undefined) => void;
      const closed = new Promise<Error | undefined>(yes => { resolve = yes; });
      const item = { path, changed, fail: resolve, closed: false }; opened.push(item);
      return { closed, dispose: async () => { item.closed = true; resolve(undefined); } };
    },
    schedule(run) { const timer = { cancelled: false, run }; timers.push(timer); return () => { timer.cancelled = true; }; },
  };
  const store = new HostStore(data), host = new HostWorkspaces(store, data, () => () => {}, undefined, undefined, undefined, undefined, io);
  const project = store.addProject({ path: repo }), target = { projectId: project.id };
  cleanups.push(async () => { await host.shutdownRepositoryWatches(); await host.shutdownSubmissions(); store.close(); });
  return { repo, host, target, opened, get scans() { return scans; }, get remoteLists() { return remoteLists; },
    set failOpen(value: boolean) { failOpen = value; },
    async tick() { for (const timer of [...timers]) if (!timer.cancelled) { timer.cancelled = true; timer.run(); } await new Promise<void>(r => setImmediate(r)); },
    async subscribe(limit: number) {
      const updates: BranchQueryUpdate[] = [];
      const lease = await host.subscribeBranchQuery(target, { type: "git.recent-branches", limit }, new AbortController().signal, u => updates.push(u), false);
      await until(() => updates.length > 0); return { updates, lease };
    },
  };
}

test("actual service shares the full recent scan with default fallback but still performs base discovery", async () => {
  const f = await fixture(), service = new WorkspaceService(f.repo), cache = new RecentBranchCache(), reads = { cache, isLive: () => true };
  cleanups.push(() => cache.dispose());
  const one = await service.recentBranches(1, undefined, reads);
  const two = await service.recentBranches(100, undefined, reads);
  expect(one).toHaveLength(1); expect(two).toEqual(["main", "topic"]); expect(f.scans).toBe(1);
  expect(await service.defaultBranch(undefined, reads)).toBe("main");
  expect(await service.defaultBranch(undefined, reads)).toBe("main");
  expect(f.scans).toBe(1); expect(f.remoteLists).toBe(2);
  git(f.repo, "branch", "new-topic"); cache.invalidate(f.repo, "local-refs");
  expect(await service.recentBranches(100, undefined, reads)).toContain("new-topic"); expect(f.scans).toBe(2);
});

test("live readers share completed scans across limits; one-shot reads keep a separate mode", async () => {
  const f = await fixture(), first = await f.subscribe(1);
  expect(first.updates[0]).toMatchObject({ phase: "complete", requiresRecovery: false });
  // Beyond the short-lived cache lifetime, a healthy live scan remains reusable.
  await new Promise<void>(r => setTimeout(r, 270));
  const second = await f.subscribe(100);
  expect(second.updates[0]).toMatchObject({ phase: "complete", result: { branches: ["main", "topic"] } });
  expect(f.scans).toBe(1);
  expect(await f.host.query(f.target, { type: "git.recent-branches", limit: 100 })).toMatchObject({ branches: ["main", "topic"] });
  expect(f.scans).toBe(2);
  git(f.repo, "branch", "from-event");
  f.opened.find(w => w.path.endsWith("/refs/heads"))!.changed("from-event", false); await f.tick();
  await until(() => first.updates.length === 2 && second.updates.length === 2);
  expect(second.updates[1]).toMatchObject({ phase: "complete", result: { branches: expect.arrayContaining(["from-event"]) } });
  expect(f.scans).toBe(3);
  await first.lease.dispose(); await second.lease.dispose();
  git(f.repo, "branch", "while-unwatched");
  const reopened = await f.subscribe(100);
  expect(reopened.updates[0]).toMatchObject({ result: { branches: expect.arrayContaining(["while-unwatched"]) } });
  expect(f.scans).toBe(4); await reopened.lease.dispose();
});

test("actual Git mutation invalidates cached reads even without a metadata callback", async () => {
  const f = await fixture(), first = await f.subscribe(1);
  await writeFile(join(f.repo, "note"), "private fixture\n");
  await f.host.mutate(f.target, { type: "git.stage", paths: ["note"] });
  const second = await f.subscribe(100);
  expect(second.updates[0]).toMatchObject({ phase: "complete" }); expect(f.scans).toBe(2);
  expect(git(f.repo, "diff", "--cached", "--name-only")).toBe("note");
  await first.lease.dispose(); await second.lease.dispose();
});

test("degraded watch reads do not borrow healthy live entries and healthy return starts a fresh generation", async () => {
  const f = await fixture(), first = await f.subscribe(1);
  f.failOpen = true;
  f.opened.find(w => w.path.endsWith("/refs/heads"))!.fail(new Error("controlled watch loss"));
  await until(() => first.updates.some(u => u.requiresRecovery));
  git(f.repo, "branch", "during-gap");
  await new Promise<void>(r => setTimeout(r, 270));
  const second = await f.subscribe(100);
  expect(second.updates[0]).toMatchObject({ requiresRecovery: true, result: { branches: expect.arrayContaining(["during-gap"]) } });
  const prior = f.scans;
  f.failOpen = false; await f.tick();
  await until(() => second.updates.at(-1)?.requiresRecovery === false);
  expect(f.scans).toBe(prior + 1);
  await first.lease.dispose(); await second.lease.dispose();
});
