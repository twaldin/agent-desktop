import type { GitRepositoryChange } from "@agent-desktop/shared";

interface Read {
  abort: AbortController;
  consumers: Set<object>;
  promise: Promise<string[]>;
  value?: string[];
  completedAt?: number;
  expiry?: ReturnType<typeof setTimeout>;
}
interface Repository { identity: string; live?: Read; short?: Read }

/** One host's full top-100 recent-branch reads. Catalog admission and repository
 * identity discovery remain the caller's responsibility on every read. */
export class RecentBranchCache {
  private repositories = new Map<string, Repository>();
  private pending = new Set<Promise<string[]>>();
  private stopped = false;
  constructor(private now: () => number = Date.now) {}

  read(root: string, identity: string, live: boolean, scan: (signal: AbortSignal) => Promise<string[]>, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    if (this.stopped) return Promise.reject(new DOMException("Branch read cache stopped.", "AbortError"));
    let repository = this.repositories.get(root);
    if (repository?.identity !== identity) {
      this.invalidate(root);
      repository = { identity }; this.repositories.set(root, repository);
    }
    const owner = repository!, mode = live ? "live" : "short";
    let read = owner[mode];
    if (read?.abort.signal.aborted || !live && read?.completedAt !== undefined && this.now() - read.completedAt >= 250) {
      this.remove(owner, mode); read = undefined;
    }
    if (!read) {
      const created: Read = { abort: new AbortController(), consumers: new Set(), promise: undefined! };
      owner[mode] = created;
      created.promise = Promise.resolve().then(() => {
        created.abort.signal.throwIfAborted();
        return scan(created.abort.signal);
      }).then(value => {
        const copy = [...value];
        if (this.repositories.get(root) === owner && owner[mode] === created && !created.abort.signal.aborted) {
          created.value = copy; created.completedAt = this.now();
          if (!live) {
            created.expiry = setTimeout(() => { if (owner[mode] === created) this.remove(owner, mode); }, 250);
            created.expiry.unref?.();
          }
        }
        return copy;
      }).catch(error => {
        if (owner[mode] === created) this.remove(owner, mode);
        throw error; // A failed scan never becomes a cached empty success.
      }).finally(() => { this.pending.delete(created.promise); });
      this.pending.add(created.promise); read = created;
    }
    const current = read, consumer = {};
    current.consumers.add(consumer);
    const detach = (aborted: boolean) => {
      current.consumers.delete(consumer);
      if (aborted && current.consumers.size === 0) {
        current.abort.abort(signal?.reason);
        if (owner[mode] === current) this.remove(owner, mode);
      }
    };
    const abort = () => detach(true);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    return (current.value === undefined ? current.promise : Promise.resolve(current.value)).then(value => {
      signal?.throwIfAborted(); return [...value];
    }).finally(() => { signal?.removeEventListener("abort", abort); detach(false); });
  }

  private remove(repository: Repository, mode: "live" | "short") {
    clearTimeout(repository[mode]?.expiry); delete repository[mode];
  }
  /** Undefined covers explicit recovery, mutation and last-watch release.
   * In-flight callers may finish, but a retired entry cannot populate a new one. */
  invalidate(root: string, kind?: GitRepositoryChange) {
    const repository = this.repositories.get(root);
    if (!repository || kind === "worktree-topology") return;
    this.remove(repository, "short");
    if (kind === undefined || ["config", "head", "local-refs", "remote-refs"].includes(kind)) this.remove(repository, "live");
    if (kind === undefined) this.repositories.delete(root);
  }
  watchHealthChanged(root: string) {
    const repository = this.repositories.get(root);
    if (repository) this.remove(repository, "live");
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    for (const root of this.repositories.keys()) this.invalidate(root);
    // Sent scans are also awaited by their owning query. Do not claim that a
    // subprocess ignoring cancellation has stopped when the last observer left.
    await Promise.allSettled([...this.pending]);
  }
}
