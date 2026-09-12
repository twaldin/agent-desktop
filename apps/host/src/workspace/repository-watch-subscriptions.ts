import type { GitSubmissionTarget } from "@agent-desktop/shared";
import { RepositoryMetadataWatcher, type MetadataWatchIO } from "./repository-metadata-watcher";
import type { GitRepositoryChange, GitRepositoryWatchContext } from "./repository-watch";

export interface RepositoryWatchLease { readonly error: string | undefined; dispose(): Promise<void> }
export interface RepositoryWatchContextLease extends RepositoryWatchLease { readonly context: GitRepositoryWatchContext }
interface Owner { isCurrent(): boolean; readContext(): Promise<GitRepositoryWatchContext> }
interface Subscription {
  target: GitSubmissionTarget; owner: Owner; signal: AbortSignal; abort(): void;
  released: boolean; ready: Promise<void>; release?: Promise<void>; entry?: Entry;
}
interface Entry {
  key: string; context: GitRepositoryWatchContext; subscribers: Set<Subscription>; watcher: RepositoryMetadataWatcher;
  ready: Promise<void>; closing?: Promise<void>;
  phase: "queued" | "starting" | "ready" | "retired"; startOwner: Owner;
}
function metadataKey(context: GitRepositoryWatchContext): string {
  return JSON.stringify([context.root, context.commonDir, context.gitDir, context.headPath, context.indexPath]);
}
function cancelled(): Error { return new DOMException("Repository watch subscription ended.", "AbortError"); }

/** One host's catalog subscriptions. Canonical repository resources are shared;
 * each subscriber keeps its own admitted catalog owner and abort lifetime. */
export class RepositoryWatchSubscriptions {
  #entries = new Map<string, Entry>();
  #subscriptions = new Set<Subscription>();
  #failures = new Set<unknown>();
  #disposed = false;
  #setup: Promise<void> = Promise.resolve();
  #disposal?: Promise<void>;
  constructor(private options: {
    resolve(target: GitSubmissionTarget): Owner;
    changed(target: GitSubmissionTarget, kind: GitRepositoryChange): Promise<void> | void;
    repositoryReleased?(context: GitRepositoryWatchContext): void;
    repositoryChanged?(context: GitRepositoryWatchContext, kind: GitRepositoryChange): void;
    repositoryRecoveryChanged?(context: GitRepositoryWatchContext, error: string | undefined): void;
    recoveryChanged(target: GitSubmissionTarget, error: string | undefined): void;
  }, private io?: MetadataWatchIO) {}

  async retain(target: GitSubmissionTarget, signal: AbortSignal): Promise<RepositoryWatchContextLease> {
    if (this.#disposed || signal.aborted) throw cancelled();
    const snapshot = { ...target };
    const subscription: Subscription = { target: snapshot, owner: this.options.resolve(snapshot), signal,
      released: false, ready: Promise.resolve(), abort: () => { void this.#release(subscription).catch(() => {}); } };
    this.#subscriptions.add(subscription);
    signal.addEventListener("abort", subscription.abort, { once: true });
    subscription.ready = Promise.resolve().then(() => this.#attach(subscription));
    try { await subscription.ready; if (!this.#current(subscription)) throw cancelled(); }
    catch (error) { await this.#release(subscription); throw error; }
    const registry = this;
    return { get context() { return { ...subscription.entry!.context }; }, get error() { return registry.#current(subscription) ? subscription.entry?.watcher.error : "Repository watch subscription ended."; },
      dispose: () => this.#release(subscription) };
  }
  /** Only the actual shared entry can establish cache coverage. */
  isHealthy(context: GitRepositoryWatchContext): boolean {
    const entry = this.#entries.get(context.root);
    return !!entry && entry.phase === "ready" && this.#live(entry)
      && metadataKey(entry.context) === metadataKey(context) && entry.watcher.error === undefined;
  }
  #current(subscription: Subscription): boolean {
    if (subscription.released) return false;
    const ownerCurrent = subscription.owner.isCurrent();
    if (!this.#disposed && !subscription.signal.aborted && ownerCurrent) return true;
    void this.#release(subscription, !ownerCurrent).catch(() => {});
    return false;
  }
  #currentSubscribers(entry: Entry): Subscription[] {
    return [...entry.subscribers].filter(subscription => this.#current(subscription));
  }
  #live(entry: Entry): boolean {
    if (this.#disposed || entry.closing || entry.phase === "retired" || this.#entries.get(entry.key) !== entry) return false;
    if (this.#currentSubscribers(entry).length > 0) return true;
    // A normal abort releases the observer, not an already admitted setup.
    // Its original catalog owner may finish setup until the final refcount check.
    if (entry.phase !== "starting") return false;
    if (entry.startOwner.isCurrent()) return true;
    void this.#close(entry).catch(() => {});
    return false;
  }
  async #attach(subscription: Subscription): Promise<void> {
    if (!this.#current(subscription)) throw cancelled();
    const context = await subscription.owner.readContext();
    if (!this.#current(subscription)) throw cancelled();
    // This registry already belongs to exactly one host. Metadata paths are
    // captured by the first root entry, not additional sharing-key dimensions.
    const key = context.root;
    let entry = this.#entries.get(key);
    if (entry?.closing) {
      await entry.closing.catch(() => {});
      return this.#attach(subscription); // Rediscover after the previous disposal attempt settles.
    }
    if (!entry) {
      const created: Entry = { key, context: { ...context }, subscribers: new Set(), ready: Promise.resolve(), watcher: undefined!, phase: "queued", startOwner: subscription.owner };
      created.watcher = new RepositoryMetadataWatcher({
        isCurrent: () => this.#live(created),
        readContext: async () => {
          const owner = this.#currentSubscribers(created)[0]?.owner
            ?? (created.phase === "starting" && created.startOwner.isCurrent() ? created.startOwner : undefined);
          if (!owner) throw cancelled();
          const current = await owner.readContext();
          // Reuse the established paths until final release, as the root owner
          // does upstream. HEAD remains live only when read from those paths;
          // a different tuple cannot narrow their local-ref invalidations.
          return { ...created.context, headRef: metadataKey(current) === metadataKey(created.context) ? current.headRef : undefined };
        },
        changed: async (_context, kind) => {
          if (!this.#live(created)) return;
          this.options.repositoryChanged?.({ ...created.context }, kind);
          const seen = new Set<string>();
          const deliveries = this.#currentSubscribers(created).map(async subscriber => {
            const targetKey = JSON.stringify(subscriber.target);
            if (!this.#current(subscriber) || seen.has(targetKey)) return;
            seen.add(targetKey); await this.options.changed({ ...subscriber.target }, kind);
          });
          const results = await Promise.allSettled(deliveries);
          const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
          if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Repository invalidation delivery failed.");
        },
        recoveryChanged: error => {
          if (!this.#live(created)) return;
          this.options.repositoryRecoveryChanged?.({ ...created.context }, error);
          const seen = new Set<string>();
          for (const subscriber of this.#currentSubscribers(created)) {
            const targetKey = JSON.stringify(subscriber.target);
            if (!this.#current(subscriber) || seen.has(targetKey)) continue;
            seen.add(targetKey); this.options.recoveryChanged({ ...subscriber.target }, error);
          }
        },
      }, this.io);
      entry = created; this.#entries.set(key, created);
      created.ready = this.#setup.then(async () => {
        if (this.#disposed || created.closing) return;
        const starter = this.#currentSubscribers(created)[0];
        if (!starter) return;
        created.startOwner = starter.owner; created.phase = "starting";
        try { await created.watcher.refresh(); }
        finally { if (created.phase === "starting") created.phase = "ready"; }
        if (created.subscribers.size === 0) await this.#close(created);
      });
      // Setup failures belong to that entry; they cannot poison the host queue.
      this.#setup = created.ready.catch(() => {});
    }
    subscription.entry = entry; entry.subscribers.add(subscription);
    await entry.ready;
    if (!this.#current(subscription)) throw cancelled();
  }
  #close(entry: Entry): Promise<void> {
    if (entry.closing) return entry.closing;
    entry.phase = "retired";
    let resolve!: () => void, reject!: (error: unknown) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    entry.closing = completion.catch(error => {
      this.#failures.add(error); throw error;
    }).finally(() => {
      if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    });
    // Install the retained drain before notifying, but invalidate synchronously
    // before any await can permit another read or repository lifetime.
    const errors: unknown[] = [];
    try { this.options.repositoryReleased?.({ ...entry.context }); }
    catch (error) { errors.push(error); }
    void Promise.resolve().then(() => entry.watcher.dispose()).catch(error => { errors.push(error); }).then(() => {
      if (errors.length) reject(errors.length === 1 ? errors[0] : new AggregateError(errors, "Repository retirement failed."));
      else resolve();
    });
    return entry.closing;
  }
  #release(subscription: Subscription, ownerLost = false): Promise<void> {
    if (subscription.release) return subscription.release;
    subscription.released = true;
    subscription.signal.removeEventListener("abort", subscription.abort);
    const entry = subscription.entry;
    entry?.subscribers.delete(subscription);
    const closing = entry && entry.subscribers.size === 0
      ? ownerLost || this.#disposed ? this.#close(entry)
        : entry.ready.catch(() => {}).then(() => entry.subscribers.size === 0 ? this.#close(entry) : undefined)
      : Promise.resolve();
    subscription.release = Promise.allSettled([subscription.ready, closing]).then(results => {
      this.#subscriptions.delete(subscription);
      // Admission failure belongs to retain(); disposal still reports resource-close failure.
      const result = results[1]!;
      if (result.status === "rejected") throw result.reason;
    });
    return subscription.release;
  }
  /** Call on catalog publication as well as checking before asynchronous work.
   * Once an owner loss is observed, later restoration cannot revive its lease. */
  async reconcileOwners(): Promise<void> {
    const retired: Promise<void>[] = [];
    for (const subscription of this.#subscriptions) if (!this.#current(subscription)) retired.push(this.#release(subscription));
    for (const entry of this.#entries.values()) if (entry.phase === "starting" && !this.#live(entry) && entry.closing) retired.push(entry.closing);
    await Promise.all(retired);
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    this.#disposal = Promise.allSettled([...this.#subscriptions].map(subscription => this.#release(subscription))).then(() => {
      if (this.#failures.size) throw new AggregateError([...this.#failures], "Repository subscriptions could not all be disposed.");
    });
    return this.#disposal;
  }
}
