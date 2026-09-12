import { watch } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { repositoryMetadataChanges, type GitRepositoryChange, type GitRepositoryWatchContext } from "./repository-watch";

interface WatchSession { closed: Promise<Error | undefined>; dispose(): Promise<void> }
export interface MetadataWatchIO {
  now(): number;
  directoryIdentity(path: string): Promise<string | null>;
  directories(path: string): Promise<string[]>;
  open(path: string, recursive: boolean, changed: (name: string | null, renamed: boolean) => void): Promise<WatchSession>;
  schedule(callback: () => void, milliseconds: number): () => void;
}
const nativeIO: MetadataWatchIO = {
  now: Date.now,
  async directoryIdentity(path) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory()) throw new Error("Git metadata watch target is not a directory.");
      return `${info.dev}:${info.ino}`;
    } catch (error) { if (missing(error)) return null; throw error; }
  },
  async directories(path) {
    try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join(path, entry.name)); }
    catch (error) { if (missing(error)) return []; throw error; }
  },
  async open(path, recursive, changed) {
    const watcher = watch(path, { recursive }, (event, name) => changed(name, event === "rename"));
    watcher.unref();
    let failure: Error | undefined;
    const closed = new Promise<Error | undefined>(done => {
      watcher.once("close", () => done(failure));
      watcher.once("error", error => { failure = error; watcher.close(); });
    });
    return { closed, async dispose() { watcher.close(); await closed; } };
  },
  schedule(callback, milliseconds) { const timer = setTimeout(callback, milliseconds); timer.unref(); return () => clearTimeout(timer); },
};
function missing(error: unknown): boolean { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? ""); }
function sameRepository(a: GitRepositoryWatchContext, b: GitRepositoryWatchContext): boolean {
  return a.root === b.root && a.gitDir === b.gitDir && a.commonDir === b.commonDir && a.headPath === b.headPath && a.indexPath === b.indexPath;
}
const allKinds: GitRepositoryChange[] = ["config", "head", "index", "local-refs", "remote-refs", "worktree-topology"];
interface Target { path: string; recursive: boolean; optional: boolean; kinds: Set<GitRepositoryChange>; generation: number; identity?: string; session?: WatchSession; retryDelay: number; retry?: () => void; error?: string }

/** One repository's metadata watches. The future subscription registry owns
 * catalog authorization, refcounts and delivery; this object owns OS resources. */
export class RepositoryMetadataWatcher {
  #targets = new Map<string, Target>();
  #context?: GitRepositoryWatchContext;
  #headRef: string | null | undefined;
  #headVersion = 0;
  #ready = false;
  #disposed = false;
  #scan?: Promise<void>;
  #scanAgain = false;
  #retry?: () => void;
  #retryDelay = 1000;
  #timers = new Map<GitRepositoryChange, () => void>();
  #pending = new Set<GitRepositoryChange>();
  #emissions = new Map<GitRepositoryChange, Promise<void>>();
  #dispose?: Promise<void>;
  #closeFailures: unknown[] = [];
  #error: string | undefined = "Repository metadata watching has not started.";
  constructor(private options: {
    readContext(): Promise<GitRepositoryWatchContext>;
    isCurrent(): boolean;
    changed(context: Omit<GitRepositoryWatchContext, "headRef">, kind: GitRepositoryChange): Promise<void> | void;
    recoveryChanged(error: string | undefined): void;
  }, private io: MetadataWatchIO = nativeIO) {}

  get error(): string | undefined { return this.#error; }
  #live(): boolean {
    if (this.#disposed) return false;
    if (this.options.isCurrent()) return true;
    void this.dispose().catch(error => this.options.recoveryChanged(error instanceof Error ? error.message : "Repository watch disposal failed."));
    return false;
  }
  #report(error: string | undefined): void {
    if (this.#disposed || this.#error === error) return;
    this.#error = error; this.options.recoveryChanged(error);
  }
  #scheduleRetry(): void {
    if (!this.#live() || this.#retry) return;
    const delay = this.#retryDelay; this.#retryDelay = Math.min(60_000, delay * 2);
    this.#retry = this.io.schedule(() => { this.#retry = undefined; void this.refresh(); }, delay);
  }
  #scheduleTargetRetry(key: string, target: Target): void {
    if (!this.#live() || this.#targets.get(key) !== target || target.retry) return;
    const delay = target.retryDelay; target.retryDelay = Math.min(60_000, delay * 2);
    target.retry = this.io.schedule(() => {
      target.retry = undefined;
      if (this.#live() && this.#targets.get(key) === target) void this.refresh();
    }, delay);
  }
  async #close(session?: WatchSession): Promise<void> {
    try { await session?.dispose(); }
    catch (error) { this.#closeFailures.push(error); throw error; }
  }

  /** Reuses active directory watches. A successful recovery invalidates all
   * metadata kinds because changes during the coverage gap are unknowable. */
  refresh(): Promise<void> {
    if (!this.#live()) return this.dispose();
    this.#scanAgain = true;
    if (this.#scan) return this.#scan;
    const scan = (async () => {
      while (this.#scanAgain && this.#live()) {
        this.#scanAgain = false;
        try { await this.#reconcile(); }
        catch (error) {
          this.#ready = false;
          this.#report(error instanceof Error ? error.message : "Repository metadata watching failed.");
          this.#scheduleRetry();
        }
      }
    })();
    this.#scan = scan;
    void scan.finally(() => { if (this.#scan === scan) this.#scan = undefined; });
    return scan;
  }

  async #reconcile(): Promise<void> {
    const headVersion = this.#headVersion;
    const context = await this.options.readContext();
    if (!this.#live()) return;
    if (this.#context && !sameRepository(this.#context, context)) throw new Error("The watched repository identity changed. Subscribe again from its current owner.");
    const recovering = this.#context !== undefined && this.#error !== undefined;
    this.#context ??= { ...context };
    this.#headRef = headVersion === this.#headVersion ? context.headRef : undefined;
    this.#ready = true;
    const desired = new Map<string, Target>();
    const add = (path: string, recursive: boolean, optional: boolean, kinds: GitRepositoryChange[]) => {
      const key = JSON.stringify([path, recursive]), target = desired.get(key);
      if (target) { kinds.forEach(kind => target.kinds.add(kind)); target.optional &&= optional; }
      else desired.set(key, { path, recursive, optional, kinds: new Set(kinds), generation: 0, retryDelay: 1000 });
    };
    add(context.commonDir, false, false, allKinds);
    add(context.gitDir, false, false, ["head", "index", "config", "worktree-topology"]);
    add(dirname(context.headPath), false, false, ["head"]);
    add(dirname(context.indexPath), false, false, ["index"]);
    add(join(context.commonDir, "refs"), false, true, ["head", "local-refs", "remote-refs"]);
    add(join(context.commonDir, "refs", "heads"), true, true, ["head", "local-refs"]);
    add(join(context.commonDir, "refs", "remotes"), true, true, ["remote-refs"]);
    add(join(context.commonDir, "info"), false, true, ["config"]);
    const worktrees = join(context.commonDir, "worktrees");
    add(worktrees, false, true, ["worktree-topology"]);
    // Observe the parent before listing its children; creation during the read
    // queues another scan instead of falling into a list/watch gap.
    const initialTargets = new Set(desired.keys());
    const failures = await this.#updateTargets(desired, false);
    if (!this.#live()) return;
    let listed = false;
    try { for (const path of await this.io.directories(worktrees)) add(path, false, true, ["worktree-topology"]); listed = true; }
    catch (error) { failures.push(error instanceof Error ? error.message : "Git worktree metadata could not be listed."); }
    failures.push(...await this.#updateTargets(desired, listed, initialTargets));
    if (!this.#live()) return;
    if (failures.length) {
      this.#report(failures[0]); this.#scheduleRetry();
      for (const kind of this.#pending) this.#scheduleEmission(kind);
      return;
    }
    this.#retry?.(); this.#retry = undefined; this.#retryDelay = 1000;
    const targetError = [...this.#targets.values()].find(target => target.error)?.error;
    this.#report(targetError);
    if (recovering && !targetError) allKinds.forEach(kind => this.#enqueue(kind));
    for (const kind of this.#pending) this.#scheduleEmission(kind);
  }

  async #updateTargets(desired: Map<string, Target>, remove: boolean, alreadyChecked = new Set<string>()): Promise<string[]> {
    const failures: string[] = [];
    if (remove) for (const [key, target] of this.#targets) if (!desired.has(key)) {
      this.#targets.delete(key); target.retry?.(); target.retry = undefined;
      try { await this.#close(target.session); }
      catch (error) { failures.push(error instanceof Error ? error.message : "Git metadata watch could not be closed."); }
    }
    for (const [key, plan] of desired) {
      if (!this.#live()) return failures;
      if (alreadyChecked.has(key)) continue;
      let target = this.#targets.get(key);
      if (!target) { target = plan; this.#targets.set(key, target); }
      else { target.kinds = plan.kinds; target.optional = plan.optional; }
      // A scan for another directory must not consume this target's backoff.
      if (target.retry) continue;
      try {
        const identity = await this.io.directoryIdentity(target.path);
        if (!this.#live()) return failures;
        if (identity === null || target.identity !== identity) {
          if (target.identity !== undefined) target.kinds.forEach(kind => this.#enqueue(kind));
          target.generation++;
          const session = target.session; target.session = undefined; target.identity = identity ?? undefined;
          await this.#close(session);
        }
        if (identity === null) {
          if (!target.optional) throw new Error("A required Git metadata directory is unavailable.");
          target.error = undefined;
          continue;
        }
        if (target.session) continue;
        const owned = target, generation = ++target.generation;
        const session = await this.io.open(target.path, target.recursive, (name, renamed) => {
          if (this.#live() && this.#targets.get(key) === owned && owned.generation === generation) this.#changed(owned, name, renamed);
        });
        if (!this.#live() || this.#targets.get(key) !== owned) { await this.#close(session); return failures; }
        try {
          if (await this.io.directoryIdentity(owned.path) !== identity) throw new Error("A Git metadata directory changed while its watch was acquired.");
        } catch (error) { owned.generation++; await this.#close(session); throw error; }
        if (!this.#live()) { await this.#close(session); return failures; }
        target.session = session;
        if (target.error) target.kinds.forEach(kind => this.#enqueue(kind));
        target.error = undefined;
        const startedAt = this.io.now();
        void session.closed.then(error => {
          if (!this.#live() || this.#targets.get(key) !== owned || owned.session !== session) return;
          owned.session = undefined; owned.generation++;
          if (this.io.now() - startedAt >= 30_000) owned.retryDelay = 1000;
          owned.error = error?.message ?? "A Git metadata watch closed unexpectedly.";
          this.#report(owned.error); this.#scheduleTargetRetry(key, owned);
        });
      } catch (error) {
        target.error = error instanceof Error ? error.message : "Git metadata watch could not be started.";
        this.#scheduleTargetRetry(key, target);
      }
    }
    return failures;
  }

  #changed(target: Target, name: string | null, renamed: boolean): void {
    const context = this.#context!;
    const path = name === null ? null : resolve(target.path, name);
    if (path !== null) {
      const suffix = relative(target.path, path);
      if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) return;
    }
    if (path === null || path === context.headPath || path === join(context.commonDir, "HEAD")) { this.#headRef = undefined; this.#headVersion++; }
    const kinds = path === null ? [...target.kinds] : repositoryMetadataChanges(context, path, this.#headRef);
    kinds.forEach(kind => this.#enqueue(kind));
    if (renamed || path === null || path === context.headPath || path === join(context.commonDir, "HEAD")
      || [...this.#targets.values()].some(target => target.path === path) || dirname(path) === join(context.commonDir, "worktrees")) void this.refresh();
  }
  #enqueue(kind: GitRepositoryChange): void { this.#pending.add(kind); this.#scheduleEmission(kind); }
  #scheduleEmission(kind: GitRepositoryChange): void {
    if (!this.#live() || !this.#ready || this.#timers.has(kind) || this.#emissions.has(kind)) return;
    this.#timers.set(kind, this.io.schedule(() => {
      this.#timers.delete(kind);
      if (!this.#live() || !this.#ready) return;
      this.#pending.delete(kind);
      const emission = Promise.resolve().then(async () => {
        if (!this.#live()) return;
        if (!this.#ready) { this.#pending.add(kind); return; }
        const { headRef: _headRef, ...identity } = this.#context!;
        await this.options.changed(identity, kind);
      }).catch(error => {
        this.#pending.add(kind); this.#ready = false;
        this.#report(error instanceof Error ? error.message : "Repository change delivery failed."); this.#scheduleRetry();
      }).finally(() => {
        this.#emissions.delete(kind);
        if (this.#pending.has(kind)) this.#scheduleEmission(kind);
      });
      this.#emissions.set(kind, emission);
    }, 1000));
  }

  dispose(): Promise<void> {
    if (this.#dispose) return this.#dispose;
    this.#disposed = true; this.#ready = false;
    this.#retry?.(); this.#retry = undefined;
    for (const cancel of this.#timers.values()) cancel(); this.#timers.clear(); this.#pending.clear();
    const closing = [...this.#targets.values()].map(target => { target.retry?.(); target.retry = undefined; return this.#close(target.session); }); this.#targets.clear();
    this.#dispose = Promise.allSettled([...closing, this.#scan, ...this.#emissions.values()]).then(results => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      const causes = [...new Set([...this.#closeFailures, ...failures.map(result => result.reason)])];
      if (causes.length) throw new AggregateError(causes, "Repository watches could not all be disposed.");
    });
    return this.#dispose;
  }
}
