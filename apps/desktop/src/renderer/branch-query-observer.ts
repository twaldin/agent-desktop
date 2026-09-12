import { parseBranchQueryObserverStatus, parseBranchQueryRequest, type BranchQueryObserverView, type BranchQueryRequest, type DesktopBridge, type LiveBranchQuery } from "@agent-desktop/shared";

type Bridge = Pick<DesktopBridge, "branchQuery" | "subscribeBranchQuery">;
/** One explicit committed renderer lifetime. Construction performs no IO. */
export class BranchQueryObserver {
  private request: BranchQueryRequest;
  private view: BranchQueryObserverView = { phase: "connecting" };
  private started = false;
  private disposed = false;
  private terminal = false;
  private sent = false;
  private unsubscribe?: () => void;
  private admission?: Promise<void>;
  private release?: Promise<void>;
  private recovery?: Promise<void>;
  constructor(private bridge: Bridge, hostId: string, target: BranchQueryRequest["target"], query: LiveBranchQuery,
    private listener: (view: BranchQueryObserverView) => void, id: string = crypto.randomUUID()) {
    this.request = parseBranchQueryRequest({ type: "branch-query", version: 1, hostId, target, query, subscriptionId: id, action: "retain" });
  }
  getSnapshot(): BranchQueryObserverView { return structuredClone(this.view); }
  private publish(view: BranchQueryObserverView) {
    if (this.disposed) return;
    this.view = structuredClone(view);
    try { this.listener(structuredClone(view)); }
    catch (error) { console.error("Branch query renderer listener failed:", error); }
  }
  private fail(error: unknown) {
    if (this.disposed || this.terminal) return;
    this.terminal = true;
    this.publish({ phase: "failed", error: error instanceof Error ? error.message : String(error) });
  }
  private send(action: BranchQueryRequest["action"]): Promise<void> {
    return Promise.resolve().then(() => {
      // Retirement can overtake a queued inspect/recovery; release must still run.
      if (action !== "release" && (this.disposed || this.terminal)) return;
      if (!this.bridge.branchQuery) throw new Error("Branch query transport is unavailable.");
      if (action === "retain") this.sent = true;
      return this.bridge.branchQuery({ ...this.request, target: { ...this.request.target }, query: { ...this.request.query }, action });
    });
  }
  start(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.started) return this.admission ?? Promise.resolve();
    this.started = true;
    if (!this.bridge.branchQuery || !this.bridge.subscribeBranchQuery) {
      this.terminal = true; this.publish({ phase: "unsupported", error: "Live branch queries are unavailable in this desktop." }); return Promise.resolve();
    }
    this.publish({ phase: "connecting" });
    if (this.disposed) return Promise.resolve();
    try {
      const unsubscribe = this.bridge.subscribeBranchQuery(status => {
        if (this.disposed || this.terminal || status?.hostId !== this.request.hostId || status?.subscriptionId !== this.request.subscriptionId) return;
        let parsed: ReturnType<typeof parseBranchQueryObserverStatus>;
        try { parsed = parseBranchQueryObserverStatus(status); }
        catch (error) { this.fail(error); return; }
        if (JSON.stringify(parsed.target) !== JSON.stringify(this.request.target) || JSON.stringify(parsed.query) !== JSON.stringify(this.request.query)) {
          this.fail(new Error("Branch query response belongs to a different owner.")); return;
        }
        if (["failed", "released", "unavailable"].includes(parsed.view.phase)) this.terminal = true;
        this.publish(parsed.view);
      });
      // A synchronous delivery may already have installed disposal. Hand the
      // returned cleanup to that microtask so its failure stays on the release.
      this.unsubscribe = unsubscribe;
      if (this.disposed) return Promise.resolve();
      // Listener registration precedes dispatch. Invocation completion is not ready.
      this.admission = this.send("retain").catch(error => this.fail(error));
    } catch (error) { this.fail(error); }
    return this.admission ?? Promise.resolve();
  }
  inspect(): Promise<void> {
    if (!this.sent || this.disposed || this.terminal) return Promise.resolve();
    return this.send("inspect").catch(error => this.fail(error));
  }
  recover(): Promise<void> {
    if (!this.sent || this.disposed || this.terminal || this.view.phase !== "ready") return Promise.resolve();
    if (this.recovery) return this.recovery;
    const pending = this.send("recover").catch(error => this.fail(error));
    this.recovery = pending;
    void pending.finally(() => { if (this.recovery === pending) this.recovery = undefined; });
    return pending;
  }
  /** A fulfilled release acknowledges main's retirement, not native OS cleanup. */
  dispose(): Promise<void> {
    if (this.release) return this.release;
    this.disposed = true;
    this.view = { phase: "released" };
    // Install the shared disposal before cleanup can synchronously reenter it.
    // Read the cleanup inside the microtask: subscribe may still be returning it.
    this.release = Promise.allSettled([Promise.resolve().then(() => {
      const unsubscribe = this.unsubscribe; this.unsubscribe = undefined;
      unsubscribe?.();
    }), this.sent ? this.send("release") : Promise.resolve()]).then(results => {
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map(r => r.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "Branch query renderer cleanup failed.");
    });
    return this.release;
  }
}
