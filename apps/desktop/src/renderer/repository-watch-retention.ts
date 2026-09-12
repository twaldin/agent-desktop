import { parseRepositoryWatchRequest, type DesktopBridge, type RepositoryWatchObserverStatus, type RepositoryWatchRequest, type RepositoryWatchView } from "@agent-desktop/shared";

type Bridge = Pick<DesktopBridge, "repositoryWatch" | "subscribeRepositoryWatch">;
type Listener = (view: RepositoryWatchView) => void;
interface Ticket { request: RepositoryWatchRequest }
export const REPOSITORY_WATCH_RELEASE_DELAY = 250;
export const REPOSITORY_WATCH_RETRY_DELAY = 1000;

/** One committed workspace's enabled query observers. Ordinary query results
 * remain owned by their query controllers, independently of watch readiness. */
export class RepositoryWatchRetention {
  private listeners = new Set<{ listener: Listener }>();
  private ticket?: Ticket;
  private retiring?: Ticket;
  private draining?: Promise<void>;
  private unsubscribe?: () => void;
  private releaseTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private starting = false;
  private disposed = false;
  private view: RepositoryWatchView = { phase: "released" };
  private owner: RepositoryWatchRequest;
  constructor(private bridge: Bridge, hostId: string, target: RepositoryWatchRequest["target"]) {
    this.owner = parseRepositoryWatchRequest({ type: "repository-watch", version: 1, hostId, target, action: "retain", subscriptionId: "owner" });
  }
  getSnapshot(): RepositoryWatchView { return { ...this.view }; }
  retain(listener: Listener): () => void {
    if (this.disposed) throw new Error("Repository watch owner is disposed.");
    clearTimeout(this.releaseTimer); this.releaseTimer = undefined;
    const observer = { listener }; this.listeners.add(observer);
    this.notify(observer);
    void this.start();
    let released = false;
    return () => {
      if (released) return; released = true; this.listeners.delete(observer);
      if (this.listeners.size || this.disposed) return;
      clearTimeout(this.retryTimer); this.retryTimer = undefined;
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = undefined;
        if (!this.listeners.size) { this.retire(); void this.drain().catch(error => { this.publish({ phase: "failed", error: error instanceof Error ? error.message : String(error) }); }); }
      }, REPOSITORY_WATCH_RELEASE_DELAY);
    };
  }
  private notify(observer: { listener: Listener }) {
    if (!this.listeners.has(observer)) return;
    try { observer.listener({ ...this.view }); }
    catch (error) { console.error("Repository watch query observer failed:", error); }
  }
  private publish(view: RepositoryWatchView) {
    this.view = view;
    for (const observer of [...this.listeners]) this.notify(observer);
  }
  private retire() {
    // Invalidate callbacks before releasing the old ID. New acquisition waits
    // for main's release acknowledgement; a rejected release cannot be bypassed.
    if (this.ticket) { this.retiring = this.ticket; this.ticket = undefined; }
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.publish({ phase: "released" });
  }
  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    const ticket = this.retiring;
    if (!ticket) return Promise.resolve();
    const promise = Promise.resolve().then(() => {
      if (!this.bridge.repositoryWatch) throw new Error("Repository watch release is unavailable.");
      return this.bridge.repositoryWatch({ ...ticket.request, target: { ...ticket.request.target }, action: "release" });
    }).then(() => { if (this.retiring === ticket) this.retiring = undefined; });
    this.draining = promise;
    void promise.finally(() => { if (this.draining === promise) this.draining = undefined; }).catch(() => {});
    return promise;
  }
  private scheduleRetry() {
    if (this.disposed || !this.listeners.size || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.start(); }, REPOSITORY_WATCH_RETRY_DELAY);
  }
  private fail(ticket: Ticket, error: unknown) {
    if (this.ticket !== ticket) return;
    // Observer notifications can synchronously retain again. Gate admission
    // before retiring or publishing, not after control has left this owner.
    this.scheduleRetry();
    this.retire();
    this.publish({ phase: "failed", error: error instanceof Error ? error.message : String(error) });
  }
  private receive(ticket: Ticket, status: RepositoryWatchObserverStatus) {
    if (this.ticket !== ticket || this.disposed || status?.hostId !== ticket.request.hostId || status?.subscriptionId !== ticket.request.subscriptionId) return;
    let owner: RepositoryWatchRequest;
    try { owner = parseRepositoryWatchRequest({ ...ticket.request, target: status.target }); }
    catch { this.fail(ticket, new Error("Invalid repository watch response owner.")); return; }
    if (JSON.stringify(owner.target) !== JSON.stringify(ticket.request.target)) return;
    const view = status.view;
    if (!view || !["connecting", "pending", "ready", "failed", "disconnected", "unsupported", "released", "unavailable"].includes(view.phase)
      || view.error !== undefined && (typeof view.error !== "string" || view.error.length > 1000)) {
      this.fail(ticket, new Error("Invalid repository watch response.")); return;
    }
    if (["failed", "released", "unavailable"].includes(view.phase)) { this.fail(ticket, new Error(view.error ?? "Repository watch ended.")); return; }
    this.publish({ ...view });
  }
  private async start() {
    if (this.disposed || !this.listeners.size || this.ticket || this.starting || this.retryTimer) return;
    if (!this.bridge.repositoryWatch || !this.bridge.subscribeRepositoryWatch) {
      this.publish({ phase: "unsupported", error: "Repository watching is unavailable in this desktop." }); return;
    }
    this.starting = true;
    try {
      await this.drain();
      if (this.disposed || !this.listeners.size || this.retryTimer) return;
      const ticket: Ticket = { request: { ...this.owner, target: { ...this.owner.target }, subscriptionId: crypto.randomUUID() } };
      this.ticket = ticket;
      this.publish({ phase: "connecting" });
      if (this.ticket !== ticket || this.disposed) return;
      try {
        this.unsubscribe = this.bridge.subscribeRepositoryWatch(status => this.receive(ticket, status));
        if (this.ticket !== ticket || this.disposed) { this.unsubscribe?.(); this.unsubscribe = undefined; return; }
        // Status subscription precedes dispatch. Invoke completion is not ready.
        void this.bridge.repositoryWatch({ ...ticket.request, target: { ...ticket.request.target } }).catch(error => this.fail(ticket, error));
      } catch (error) { this.fail(ticket, error); }
    } catch (error) {
      if (!this.disposed) this.publish({ phase: "failed", error: error instanceof Error ? error.message : String(error) });
      this.scheduleRetry();
    } finally { this.starting = false; }
  }
  /** Owner replacement/unmount bypasses the ordinary last-observer grace. */
  dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true; this.listeners.clear(); clearTimeout(this.releaseTimer); clearTimeout(this.retryTimer);
      this.releaseTimer = this.retryTimer = undefined; this.retire();
    }
    return this.drain();
  }
}
