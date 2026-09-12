import type { GitRepositoryChange } from "@agent-desktop/shared";

interface Read { pending: boolean; abort: AbortController; promise: Promise<unknown> }
interface Repository { identity: string; reads: Map<string, Read> }

/** One host's F4 discovery dependencies, not completed Default/Base results.
 * Callers revalidate catalog authority and observed repository identity first. */
export class DefaultBranchCache {
  private repositories = new Map<string, Repository>();
  private pending = new Set<Read>();
  private stopped = false;

  orderedRemotes(root: string, identity: string, load: (signal: AbortSignal) => Promise<string[]>, signal?: AbortSignal): Promise<string[]> {
    return this.read(root, identity, ["ordered-remotes"], async abort => [...await load(abort)], signal).then(value => [...value]);
  }
  localDefault(root: string, identity: string, remote: string, load: (signal: AbortSignal) => Promise<string | null>, signal?: AbortSignal): Promise<string | null> {
    return this.read(root, identity, ["local-default", remote], load, signal);
  }
  advertisedDefault(root: string, identity: string, remote: string, load: (signal: AbortSignal) => Promise<string | null>, signal?: AbortSignal): Promise<string | null> {
    return this.read(root, identity, ["advertised-default", remote], load, signal);
  }
  remoteBranch(root: string, identity: string, remote: string, branch: string, load: (signal: AbortSignal) => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
    return this.read(root, identity, ["remote-branch", remote, branch], load, signal);
  }

  private read<T>(root: string, identity: string, key: string[], load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.stopped) return Promise.reject(new DOMException("Default branch cache stopped.", "AbortError"));
    let repository = this.repositories.get(root);
    if (repository?.identity !== identity) {
      repository = { identity, reads: new Map() }; this.repositories.set(root, repository);
    }
    const owner = repository!, name = JSON.stringify(key);
    let read = owner.reads.get(name);
    if (!read) {
      const created: Read = { pending: true, abort: new AbortController(), promise: undefined! };
      owner.reads.set(name, created); this.pending.add(created);
      created.promise = Promise.resolve().then(() => {
        created.abort.signal.throwIfAborted(); return load(created.abort.signal);
      }).catch(error => {
        if (owner.reads.get(name) === created) owner.reads.delete(name);
        throw error; // Keep the existing operational-error contract; no failure-as-null cache.
      }).finally(() => { created.pending = false; this.pending.delete(created); });
      read = created;
    }
    // The typed public methods own their disjoint keys. F4 shares a sent read
    // independently of caller cancellation; cancellation suppresses consumption.
    return (read.promise as Promise<T>).then(value => { signal?.throwIfAborted(); return value; });
  }

  /** Matching events discard completed dependencies. Like pinned fetchQuery,
   * pending reads survive invalidation and may finish fresh for this identity.
   * Generic Git mutations and watch-health changes do not invalidate F4. */
  invalidate(root: string, kind?: GitRepositoryChange) {
    if (kind !== undefined && kind !== "config" && kind !== "remote-refs") return;
    const repository = this.repositories.get(root);
    if (!repository) return;
    for (const [key, read] of repository.reads) {
      if (!read.pending && (kind !== "remote-refs" || key !== '["ordered-remotes"]')) repository.reads.delete(key);
    }
  }
  async dispose(): Promise<void> {
    this.stopped = true; this.repositories.clear();
    const reads = [...this.pending];
    for (const read of reads) read.abort.abort();
    await Promise.allSettled(reads.map(read => read.promise));
  }
}
