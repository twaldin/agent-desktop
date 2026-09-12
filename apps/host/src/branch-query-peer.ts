import { parseBranchQueryRequest, parseBranchQueryUpdate, type BranchQueryMessage, type BranchQueryRequest, type BranchQueryResultUpdate } from "@agent-desktop/shared";
import type { BranchQueryLease } from "./workspace-http";
import type { BranchQueryUpdate } from "./workspace/branch-live-queries";

type Phase = Extract<BranchQueryMessage, { event: "status" }>["phase"];
interface Entry {
  request: BranchQueryRequest; abort: AbortController; phase: Phase; error?: string;
  start?: Promise<BranchQueryLease>; lease?: BranchQueryLease; release?: Promise<void>;
  update?: BranchQueryResultUpdate; recovery?: Promise<void>;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000) || "Branch query failed.";
/** Per-authenticated-connection history; wire IDs never become host registry IDs. */
export class BranchQueryPeer {
  private entries = new Map<string, Entry>();
  private disposed = false;
  private disposal?: Promise<void>;
  private failures = new Set<unknown>();
  constructor(private options: {
    hostId: string; isCurrent(): boolean;
    subscribe(target: BranchQueryRequest["target"], query: BranchQueryRequest["query"], signal: AbortSignal, emit: (update: BranchQueryUpdate) => void): Promise<BranchQueryLease>;
    send(update: BranchQueryMessage): void; close(reason: string): void;
  }) {}
  private current(): boolean {
    if (this.disposed) return false;
    if (this.options.isCurrent()) return true;
    this.close("Branch query authorization ended."); return false;
  }
  private close(reason: string) { void this.dispose().catch(() => {}); this.options.close(reason); }
  private publish(entry: Entry, result = false) {
    if (!this.current()) return;
    const { action: _, ...request } = entry.request;
    try {
      this.options.send(result && entry.update ? { ...structuredClone(request), event: "result", update: structuredClone(entry.update) }
        : { ...structuredClone(request), event: "status", phase: entry.phase, ...(entry.error ? { error: entry.error } : {}) });
    } catch { this.close("Branch query result delivery failed."); }
  }
  receive(raw: string) {
    if (!this.current()) return;
    let request: BranchQueryRequest;
    try {
      if (Buffer.byteLength(raw) > 1024) throw new Error("Oversized request.");
      request = parseBranchQueryRequest(JSON.parse(raw));
      if (request.hostId !== this.options.hostId) throw new Error("Foreign host.");
    } catch { this.close("Invalid branch query request or host."); return; }
    let entry = this.entries.get(request.subscriptionId);
    if (entry && (JSON.stringify(entry.request.target) !== JSON.stringify(request.target) || JSON.stringify(entry.request.query) !== JSON.stringify(request.query))) {
      this.close("Branch query subscription binding changed."); return;
    }
    if (!entry) {
      entry = { request, abort: new AbortController(), phase: "unavailable" };
      if (request.action === "inspect" || request.action === "recover") { this.publish(entry); return; }
      if (this.entries.size >= 2048) { this.close("Branch query history is full. Reconnect to continue."); return; }
      this.entries.set(request.subscriptionId, entry);
      if (request.action === "retain") {
        const active = [...this.entries.values()].filter(value => ["pending", "ready", "releasing"].includes(value.phase)).length;
        if (active >= 128) { entry.phase = "failed"; entry.error = "Too many live branch queries on this connection."; }
        else this.start(entry);
      }
    }
    if (request.action === "release") void this.release(entry).catch(() => {});
    else if (request.action === "recover" && entry.phase === "ready" && !entry.recovery) this.recover(entry);
    this.publish(entry);
    if (entry.phase === "ready" && entry.update) this.publish(entry, true);
  }
  private start(entry: Entry) {
    entry.phase = "pending";
    entry.start = Promise.resolve().then(() => {
      if (!this.current() || entry.abort.signal.aborted) throw new DOMException("Branch subscription ended.", "AbortError");
      return this.options.subscribe(entry.request.target, entry.request.query, entry.abort.signal, update => {
        if (!this.current() || entry.abort.signal.aborted || entry.lease?.signal.aborted || !["pending", "ready"].includes(entry.phase)) return;
        let parsed: BranchQueryResultUpdate;
        try {
          const { subscriptionId: _, ...payload } = update;
          parsed = parseBranchQueryUpdate(payload.phase === "failed" ? { ...payload, error: message(payload.error) } : payload, entry.request.query);
        } catch { this.close("Invalid owned branch result."); return; }
        if (entry.update && parsed.generation <= entry.update.generation) return;
        entry.update = parsed;
        if (entry.phase === "ready") this.publish(entry, true);
      });
    });
    void entry.start.then(lease => {
      entry.lease = lease;
      void lease.closed.then(() => {
        if (!this.current() || entry.phase !== "ready") return;
        entry.phase = "unavailable"; entry.update = undefined;
        this.publish(entry);
      });
      if (entry.phase !== "pending" || !this.current()) return;
      if (lease.signal.aborted) { entry.phase = "unavailable"; entry.update = undefined; this.publish(entry); return; }
      entry.phase = "ready"; this.publish(entry);
      if (entry.update) this.publish(entry, true);
    }, error => {
      if (entry.phase !== "pending" || !this.current()) return;
      entry.phase = "failed"; entry.error = message(error); this.publish(entry);
    });
  }
  private recover(entry: Entry) {
    entry.error = undefined;
    entry.recovery = Promise.resolve().then(() => {
      if (!this.current() || entry.phase !== "ready" || entry.abort.signal.aborted) return;
      return entry.lease!.recover();
    }).catch(error => {
      if (!this.current() || entry.phase !== "ready") {
        // Cancellation may reject normally, but an operational recovery error
        // after release still belongs to this peer's cleanup accounting.
        if (!(error instanceof Error && error.name === "AbortError")) { entry.error = message(error); this.failures.add(error); }
        return;
      }
      entry.error = message(error); this.publish(entry);
    }).finally(() => { entry.recovery = undefined; });
  }
  private release(entry: Entry): Promise<void> {
    if (entry.release) return entry.release;
    const acquisitionFailed = entry.phase === "failed";
    entry.phase = "releasing"; entry.update = undefined; entry.abort.abort();
    entry.release = (async () => {
      // Neither independent drain may skip the other when it rejects.
      const results = await Promise.allSettled([entry.start?.then(lease => lease.dispose()), entry.recovery]);
      for (const result of results) {
        if (result.status !== "rejected") continue;
        const error = result.reason;
        if (!acquisitionFailed && !(error instanceof Error && error.name === "AbortError")) { entry.error = message(error); this.failures.add(error); }
      }
      entry.lease = undefined; entry.start = undefined; entry.phase = "released"; this.publish(entry);
    })();
    return entry.release;
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = Promise.all([...this.entries.values()].map(entry => this.release(entry))).then(() => {
      if (this.failures.size) throw new AggregateError([...this.failures], "Branch query peer cleanup failed.");
    });
    return this.disposal;
  }
}
