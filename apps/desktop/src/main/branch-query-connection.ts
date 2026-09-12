import { parseBranchQueryMessage, parseBranchQueryRequest, type BranchQueryRequest, type BranchQueryView, type LiveBranchQuery } from "@agent-desktop/shared";
interface Observer {
  target: BranchQueryRequest["target"]; query: LiveBranchQuery; listener(view: BranchQueryView): void;
  wireId?: string; generation: number; view: BranchQueryView;
}
interface Connection {
  send(request: BranchQueryRequest): void; close(reason: string): void;
  capability: "waiting" | "supported" | "unsupported"; wires: Map<string, Observer>; ids: Set<string>;
}
/** Logical consumers survive connections; admission and generations do not. */
export class BranchQueryConnection {
  private observers = new Set<Observer>();
  private connection?: Connection;
  private disposed = false;
  constructor(private hostId: string, private createId: () => string = () => crypto.randomUUID()) {}
  retain(target: BranchQueryRequest["target"], query: LiveBranchQuery, listener: Observer["listener"]): { inspect(): void; recover(): void; dispose(): void } {
    if (this.disposed) throw new Error("Branch query connection is disposed.");
    if (this.observers.size >= 128) throw new Error("Too many branch query observers.");
    const parsed = parseBranchQueryRequest({ type: "branch-query", version: 1, hostId: this.hostId, subscriptionId: "validate", target, query, action: "retain" });
    const observer: Observer = { target: parsed.target, query: parsed.query, listener, generation: 0, view: { phase: "connecting" } };
    this.observers.add(observer); this.start(observer);
    return { inspect: () => this.command(observer, "inspect"), recover: () => {
      if (observer.view.phase === "ready") this.command(observer, "recover");
    }, dispose: () => this.release(observer) };
  }
  attach(transport: Pick<Connection, "send" | "close">): { receive(value: unknown): void; disconnected(error?: string): void } {
    if (this.disposed) throw new Error("Branch query connection is disposed.");
    const previous = this.connection, connection: Connection = { ...transport, capability: "waiting", wires: new Map(), ids: new Set() };
    this.connection = connection; previous?.wires.clear();
    for (const observer of this.observers) { observer.wireId = undefined; observer.generation = 0; }
    previous?.close("Branch query connection replaced.");
    for (const observer of [...this.observers]) {
      if (this.connection !== connection) break;
      this.update(observer, { phase: "connecting" });
    }
    return { receive: value => this.receive(connection, value), disconnected: error => this.end(connection, error ?? "The branch query host disconnected.", false) };
  }
  private update(observer: Observer, view: BranchQueryView) {
    if (!this.observers.has(observer)) return;
    observer.view = structuredClone(view);
    try { observer.listener(structuredClone(view)); }
    catch (error) { console.error("Branch query observer failed:", error); this.release(observer); }
  }
  private start(observer: Observer) {
    if (!this.observers.has(observer)) return;
    const connection = this.connection;
    if (!connection || connection.capability === "waiting") { this.update(observer, { phase: "connecting" }); return; }
    if (connection.capability === "unsupported") { this.update(observer, { phase: "unsupported", error: "Live branch queries are unavailable on this host." }); return; }
    let id: string;
    try {
      id = this.createId();
      parseBranchQueryRequest({ type: "branch-query", version: 1, hostId: this.hostId, subscriptionId: id, target: observer.target, query: observer.query, action: "retain" });
      if (connection.ids.has(id) || connection.ids.size >= 2048) throw new Error("Branch identities exhausted.");
    } catch { this.end(connection, "Branch query identities exhausted. Reconnect to continue.", true); return; }
    connection.ids.add(id); connection.wires.set(id, observer); observer.wireId = id; observer.generation = 0;
    this.update(observer, { phase: "pending" });
    if (this.connection === connection && this.observers.has(observer) && observer.wireId === id) this.send(connection, observer, "retain");
  }
  private command(observer: Observer, action: "inspect" | "recover") {
    const connection = this.connection;
    if (connection && this.observers.has(observer) && observer.wireId) this.send(connection, observer, action);
  }
  private send(connection: Connection, observer: Observer, action: BranchQueryRequest["action"]) {
    if (this.connection !== connection || !observer.wireId) return;
    try { connection.send({ type: "branch-query", version: 1, hostId: this.hostId, subscriptionId: observer.wireId, target: { ...observer.target }, query: { ...observer.query }, action }); }
    catch { this.end(connection, "Branch query request could not be sent.", true); }
  }
  private receive(connection: Connection, value: unknown) {
    if (this.connection !== connection || !value || typeof value !== "object") return;
    const input = value as { type?: unknown; state?: { host?: { id?: unknown }; branchQueries?: { version?: unknown } }; replayComplete?: unknown };
    if (input.type === "state") {
      if (input.state?.host?.id !== this.hostId) { this.end(connection, "Branch query host identity changed.", true); return; }
      const capability = input.state.branchQueries?.version === 1 ? "supported" : "unsupported";
      if (connection.capability !== "waiting") {
        if (capability !== connection.capability) this.end(connection, "Branch query capability changed. Reconnect to continue.", true);
        return;
      }
      if (input.replayComplete !== true) return;
      connection.capability = capability;
      for (const observer of [...this.observers]) { if (this.connection !== connection) break; this.start(observer); }
      return;
    }
    if (input.type !== "branch-query") return;
    let message: ReturnType<typeof parseBranchQueryMessage>;
    try { message = parseBranchQueryMessage(value); }
    catch { this.end(connection, "Invalid branch query response.", true); return; }
    if (message.hostId !== this.hostId) { this.end(connection, "Branch query host identity changed.", true); return; }
    const observer = connection.wires.get(message.subscriptionId);
    if (!observer) return;
    if (JSON.stringify(observer.target) !== JSON.stringify(message.target) || JSON.stringify(observer.query) !== JSON.stringify(message.query)) {
      this.end(connection, "Branch query response binding changed.", true); return;
    }
    if (observer.view.phase === "failed") return;
    if (message.event === "result") {
      if (observer.view.phase !== "ready") { this.end(connection, "Branch result arrived before admission.", true); return; }
      if (message.update.generation <= observer.generation) return;
      observer.generation = message.update.generation;
      this.update(observer, { phase: "ready", update: message.update }); return;
    }
    if (message.phase === "pending") { if (observer.view.phase !== "ready") this.update(observer, { phase: "pending" }); }
    else if (message.phase === "ready") {
      this.update(observer, { phase: "ready", ...(observer.view.phase === "ready" && observer.view.update ? { update: observer.view.update } : {}), ...(message.error ? { error: message.error } : {}) });
    } else this.update(observer, { phase: "failed", error: message.error ?? "Branch query is no longer available. Retain a new observer to retry." });
  }
  private end(connection: Connection, error: string, close: boolean) {
    if (this.connection !== connection) return;
    this.connection = undefined; connection.wires.clear();
    const observers = [...this.observers];
    for (const observer of observers) { observer.wireId = undefined; observer.generation = 0; }
    // Retire other clients sharing the socket before observers may send again.
    if (close) connection.close(error);
    for (const observer of observers) { if (this.connection) break; this.update(observer, { phase: "disconnected", error }); }
  }
  private release(observer: Observer) {
    if (!this.observers.delete(observer)) return;
    const connection = this.connection, id = observer.wireId;
    if (connection && id) { connection.wires.delete(id); this.send(connection, observer, "release"); }
    observer.wireId = undefined;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const observer of [...this.observers]) this.release(observer);
    this.connection = undefined;
  }
}
