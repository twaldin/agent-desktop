import { parseRepositoryWatchRequest, parseRepositoryWatchStatus, type RepositoryWatchRequest, type RepositoryWatchStatus, type RepositoryWatchView } from "@agent-desktop/shared";
export type { RepositoryWatchView } from "@agent-desktop/shared";
interface Observer {
  target: RepositoryWatchRequest["target"];
  listener(view: RepositoryWatchView): void;
  wireId?: string;
  view: RepositoryWatchView;
}
interface Connection {
  send(request: RepositoryWatchRequest): void;
  close(reason: string): void;
  capability: "waiting" | "supported" | "unsupported";
  wires: Map<string, Observer>;
  ids: Set<string>;
}

/** Retained desktop observers survive sockets; wire identities and readiness never do. */
export class RepositoryWatchConnection {
  #observers = new Set<Observer>();
  #connection?: Connection;
  #disposed = false;
  constructor(private hostId: string, private createId: () => string = () => crypto.randomUUID()) {}

  retain(target: RepositoryWatchRequest["target"], listener: Observer["listener"]): { inspect(): void; dispose(): void } {
    if (this.#disposed) throw new Error("Repository watch connection is disposed.");
    if (this.#observers.size >= 128) throw new Error("Too many repository watch observers.");
    const owner = parseRepositoryWatchRequest({ type: "repository-watch", version: 1, hostId: this.hostId, subscriptionId: "validate", action: "retain", target }).target;
    const observer: Observer = { target: owner, listener, view: { phase: "connecting" } };
    this.#observers.add(observer);
    this.#start(observer);
    return { inspect: () => {
      const connection = this.#connection;
      if (connection && observer.wireId && this.#observers.has(observer)) this.#send(connection, observer, "inspect");
    }, dispose: () => this.#release(observer) };
  }

  attach(transport: Pick<Connection, "send" | "close">): { receive(value: unknown): void; disconnected(error?: string): void } {
    if (this.#disposed) throw new Error("Repository watch connection is disposed.");
    const previous = this.#connection;
    const connection: Connection = { ...transport, capability: "waiting", wires: new Map(), ids: new Set() };
    this.#connection = connection;
    previous?.wires.clear();
    for (const observer of this.#observers) observer.wireId = undefined;
    previous?.close("Repository watch connection replaced.");
    for (const observer of [...this.#observers]) {
      if (this.#connection !== connection) break;
      this.#update(observer, { phase: "connecting" });
    }
    return {
      receive: value => this.#receive(connection, value),
      disconnected: error => this.#end(connection, error ?? "The repository host disconnected.", false),
    };
  }
  #update(observer: Observer, view: RepositoryWatchView): void {
    if (!this.#observers.has(observer)) return;
    observer.view = view;
    try { observer.listener({ ...view }); }
    catch (error) { console.error("Repository watch observer failed:", error); this.#release(observer); }
  }
  #start(observer: Observer): void {
    const connection = this.#connection;
    if (!connection || connection.capability === "waiting") { this.#update(observer, { phase: "connecting" }); return; }
    if (connection.capability === "unsupported") { this.#update(observer, { phase: "unsupported", error: "Repository watching is unavailable on this host." }); return; }
    let id: string;
    try {
      id = this.createId();
      parseRepositoryWatchRequest({ type: "repository-watch", version: 1, hostId: this.hostId, subscriptionId: id, target: observer.target, action: "retain" });
      if (connection.ids.has(id) || connection.ids.size >= 2048) throw new Error("Repository watch identities exhausted.");
    } catch { this.#end(connection, "Repository watch identities exhausted. Reconnect to continue.", true); return; }
    connection.ids.add(id); connection.wires.set(id, observer); observer.wireId = id;
    this.#update(observer, { phase: "pending" });
    if (this.#observers.has(observer) && observer.wireId === id) this.#send(connection, observer, "retain");
  }
  #send(connection: Connection, observer: Observer, action: RepositoryWatchRequest["action"]): void {
    if (this.#connection !== connection || !observer.wireId) return;
    try { connection.send({ type: "repository-watch", version: 1, hostId: this.hostId, subscriptionId: observer.wireId, target: { ...observer.target }, action }); }
    catch { this.#end(connection, "Repository watch request could not be sent.", true); }
  }
  #receive(connection: Connection, value: unknown): void {
    if (this.#connection !== connection || !value || typeof value !== "object") return;
    const event = value as { type?: unknown; state?: { host?: { id?: unknown }; repositoryWatches?: { version?: unknown } }; replayComplete?: unknown };
    if (event.type === "state") {
      if (event.state?.host?.id !== this.hostId) { this.#end(connection, "Repository watch host identity changed.", true); return; }
      const capability = event.state.repositoryWatches?.version === 1 ? "supported" : "unsupported";
      if (connection.capability !== "waiting") {
        if (connection.capability !== capability) this.#end(connection, "Repository watch capability changed. Reconnect to continue.", true);
        return;
      }
      if (event.replayComplete !== true) return;
      connection.capability = capability;
      for (const observer of [...this.#observers]) {
        if (this.#connection !== connection) break;
        if (this.#observers.has(observer)) this.#start(observer);
      }
      return;
    }
    if (event.type !== "repository-watch") return;
    let status: RepositoryWatchStatus;
    try { status = parseRepositoryWatchStatus(value); }
    catch { this.#end(connection, "Invalid repository watch response.", true); return; }
    if (status.hostId !== this.hostId) { this.#end(connection, "Repository watch host identity changed.", true); return; }
    const observer = connection.wires.get(status.subscriptionId);
    if (!observer) return;
    if (JSON.stringify(observer.target) !== JSON.stringify(status.target)) { this.#end(connection, "Repository watch response owner changed.", true); return; }
    // A failed/retired wire cannot become ready again without a new connection/observer.
    if (observer.view.phase === "failed") return;
    if (status.phase === "pending" && observer.view.phase === "ready") return;
    if (status.phase === "ready" || status.phase === "pending") this.#update(observer, { phase: status.phase, ...(status.error ? { error: status.error } : {}) });
    else this.#update(observer, { phase: "failed", error: status.error ?? "Repository watch is no longer available. Retain a new observer to retry." });
  }
  #end(connection: Connection, error: string, close: boolean): void {
    if (this.#connection !== connection) return;
    this.#connection = undefined; connection.wires.clear();
    const observers = [...this.#observers];
    for (const observer of observers) observer.wireId = undefined;
    // Retire other clients sharing the socket before observers may send again.
    if (close) connection.close(error);
    for (const observer of observers) {
      if (this.#connection) break;
      this.#update(observer, { phase: "disconnected", error });
    }
  }
  #release(observer: Observer): void {
    if (!this.#observers.delete(observer)) return;
    const connection = this.#connection, id = observer.wireId;
    if (connection && id) {
      connection.wires.delete(id);
      this.#send(connection, observer, "release");
    }
    observer.wireId = undefined;
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const observer of [...this.#observers]) this.#release(observer);
    this.#connection = undefined;
  }
}
