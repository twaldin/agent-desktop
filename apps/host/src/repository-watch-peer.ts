import { parseRepositoryWatchRequest, type RepositoryWatchRequest, type RepositoryWatchStatus } from "@agent-desktop/shared";
import type { RepositoryWatchLease } from "./workspace/repository-watch-subscriptions";

interface RetainedWatch {
  request: RepositoryWatchRequest;
  abort: AbortController;
  phase: RepositoryWatchStatus["phase"];
  error?: string;
  start?: Promise<RepositoryWatchLease>;
  lease?: RepositoryWatchLease;
  release?: Promise<void>;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

/** Owns only this authenticated socket's leases, including acquisition still in flight. */
export class RepositoryWatchPeer {
  #entries = new Map<string, RetainedWatch>();
  #disposed = false;
  #disposal?: Promise<void>;
  #failures = new Set<unknown>();
  constructor(private options: {
    hostId: string;
    isCurrent(): boolean;
    retain(target: RepositoryWatchRequest["target"], signal: AbortSignal): Promise<RepositoryWatchLease>;
    send(status: RepositoryWatchStatus): void;
    close(reason: string): void;
  }) {}

  #current(): boolean {
    if (this.#disposed) return false;
    if (this.options.isCurrent()) return true;
    this.#close("Repository watch connection ended.");
    return false;
  }
  #close(reason: string): void {
    // Cancel synchronously, before a socket close callback or late acquisition can run.
    void this.dispose().catch(() => {});
    this.options.close(reason);
  }
  #publish(entry: RetainedWatch): void {
    if (!this.#current()) return;
    const error = entry.phase === "ready" ? entry.lease?.error : entry.error;
    try {
      this.options.send({ type: "repository-watch", version: 1, hostId: this.options.hostId,
        subscriptionId: entry.request.subscriptionId, target: { ...entry.request.target }, phase: entry.phase,
        ...(error ? { error: error.slice(0, 1000) } : {}) });
    } catch { this.#close("Repository watch delivery failed."); }
  }

  receive(raw: string): void {
    if (!this.#current()) return;
    let request: RepositoryWatchRequest;
    try {
      if (Buffer.byteLength(raw) > 1024) throw new Error("Repository watch request is too large.");
      request = parseRepositoryWatchRequest(JSON.parse(raw));
      if (request.hostId !== this.options.hostId) throw new Error("Repository watch host changed.");
    } catch { this.#close("Invalid repository watch request or host."); return; }
    let entry = this.#entries.get(request.subscriptionId);
    if (entry && JSON.stringify(entry.request.target) !== JSON.stringify(request.target)) {
      this.#close("Repository watch subscription owner changed."); return;
    }
    if (!entry) {
      entry = { request, abort: new AbortController(), phase: "unavailable" };
      if (request.action === "inspect") { this.#publish(entry); return; }
      // Retired IDs remain tombstones. Reconnecting creates a new identity domain.
      if (this.#entries.size >= 2048) { this.#close("Repository watch connection history is full. Reconnect to continue."); return; }
      this.#entries.set(request.subscriptionId, entry);
      if (request.action === "retain") {
        const active = [...this.#entries.values()].filter(item => ["pending", "ready", "releasing"].includes(item.phase)).length;
        if (active >= 128) { entry.phase = "failed"; entry.error = "Too many repository watches on this connection."; }
        else this.#start(entry);
      }
    }
    if (request.action === "release") void this.#release(entry).catch(() => {});
    this.#publish(entry);
  }

  #start(entry: RetainedWatch): void {
    entry.phase = "pending";
    entry.start = Promise.resolve().then(() => {
      if (!this.#current() || entry.abort.signal.aborted) throw new DOMException("Repository watch ended.", "AbortError");
      return this.options.retain(entry.request.target, entry.abort.signal);
    });
    void entry.start.then(lease => {
      entry.lease = lease;
      if (entry.phase !== "pending" || !this.#current()) return;
      entry.phase = "ready"; this.#publish(entry);
    }, error => {
      if (entry.phase !== "pending" || !this.#current()) return;
      entry.phase = "failed"; entry.error = message(error); this.#publish(entry);
    });
  }
  #release(entry: RetainedWatch): Promise<void> {
    if (entry.release) return entry.release;
    const acquisitionFailed = entry.phase === "failed";
    entry.phase = "releasing";
    entry.abort.abort();
    entry.release = (async () => {
      try {
        const lease = await entry.start;
        await lease?.dispose();
      } catch (error) {
        if (!acquisitionFailed && !(error instanceof Error && error.name === "AbortError")) {
          entry.error = message(error); this.#failures.add(error);
        }
      } finally {
        entry.start = undefined; entry.lease = undefined;
        entry.phase = "released"; this.#publish(entry);
      }
    })();
    return entry.release;
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    this.#disposal = Promise.all([...this.#entries.values()].map(entry => this.#release(entry))).then(() => {
      if (this.#failures.size) throw new AggregateError([...this.#failures], "Repository watch connection cleanup failed.");
    });
    return this.#disposal;
  }
}
