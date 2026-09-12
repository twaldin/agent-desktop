import { parseNativeMcpAppResponse, type DesktopBridge, type McpJson, type NativeMcpAppRequest, type NativeMcpAppResource, type NativeMcpAppSelection } from "@agent-desktop/shared";
import type { McpDockApp } from "./mcp-app-dock";
interface Operation { id: string; closed: boolean; opening: Promise<NativeMcpAppResource>; closing?: Promise<void>; closeFailed?: boolean; operationErrors?: number; warningShown?: boolean; initialResult?: Promise<Record<string, McpJson>>; initialArguments?: Record<string, McpJson> }
export class McpAppController {
  #operation?: Operation;
  #disposed = false;
  #connected = false;
  #listeners = new Set<() => void>();
  subscribeClose(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  constructor(readonly bridge: DesktopBridge, readonly hostId: string, readonly sessionId: string, readonly app: McpDockApp) {}
  connected(value: boolean): void { this.#connected = value; if (!value && this.#operation) void this.#close(this.#operation).catch(() => {}); }
  #current(operation: Operation): void {
    if (this.#disposed || !this.#connected || this.#operation !== operation || operation.closed) throw new Error("The original MCP app connection is unavailable. Open the app again deliberately.");
  }
  open(selection?: NativeMcpAppSelection): Promise<NativeMcpAppResource> {
    if (this.#disposed || !this.#connected || !this.bridge.sessionMcpApp || !this.bridge.getSessionMcp) return Promise.reject(new Error("Connect to this app’s original session host."));
    const previous = this.#operation, previousWarning = previous?.warningShown === true;
    if (previous && !previous.closed) return previous.opening;
    const operation = { id: crypto.randomUUID(), closed: false } as Operation;
    // Reserve synchronously, including the initial close barrier. A second open
    // joins this exact attempt and a close before dispatch cancels it.
    this.#operation = operation;
    operation.opening = Promise.resolve().then(async () => {
      if (previous) {
        // A deliberate Open can retry only the idempotent original close.
        if (previous.closeFailed) { previous.closing = undefined; previous.closeFailed = false; }
        await this.#close(previous);
        this.#reportClose(previous, previousWarning);
      }
      this.#current(operation);
      if (!selection) {
        const snapshot = (await this.bridge.getSessionMcp!(this.sessionId, this.hostId)).value;
        this.#current(operation);
        if (!snapshot?.canOpenApps || !snapshot.servers.some(server => server.status === "connected" && server.name === this.app.serverName
          && (this.app.source?.type === "artifact" || (this.app.source?.type === "file" ? server.fileViewers : server.apps)?.some(app => app.toolName === this.app.toolName && app.resourceUri === this.app.resourceUri)))) throw new Error("This app is not available from its original server.");
        selection = { epoch: snapshot.epoch, expectedRevision: snapshot.revision, serverName: this.app.serverName, toolName: this.app.toolName, resourceUri: this.app.resourceUri };
      }
      this.#current(operation);
      const request = { type: "open" as const, channelId: operation.id, selection, ...(this.app.source ? { source: this.app.source } : {}) };
      const response = parseNativeMcpAppResponse(await this.bridge.sessionMcpApp!(this.sessionId, request, this.hostId), request);
      this.#current(operation);
      if (response.type !== "opened") throw new Error("Invalid MCP app opening result.");
      if (response.initialResult) operation.initialResult = Promise.resolve(response.initialResult);
      operation.initialArguments = response.initialArguments;
      return response.resource;
    });
    void operation.opening.catch(() => { operation.closed = true; void this.#close(operation).catch(() => {}); });
    return operation.opening;
  }
  initialResult(): Promise<Record<string, McpJson>> {
    const operation = this.#operation;
    if (!operation) return Promise.reject(new Error("Open the MCP app first."));
    this.#current(operation);
    if (this.app.source?.type === "artifact" && !operation.initialResult) return Promise.reject(new Error("The saved app result is unavailable. Its tool cannot be replayed."));
    return operation.initialResult ??= this.request("tools/call", { name: this.app.toolName, arguments: operation.initialArguments ?? {} });
  }
  initialArguments(): Record<string, McpJson> | undefined { return this.#operation?.initialArguments ?? (this.app.source?.type === "artifact" ? undefined : {}); }
  async request(method: Extract<NativeMcpAppRequest, { type: "request" }>["method"], params: Record<string, McpJson>): Promise<Record<string, McpJson>> {
    const operation = this.#operation;
    if (!operation) throw new Error("Open the MCP app first.");
    this.#current(operation); await operation.opening; this.#current(operation);
    const request = { type: "request" as const, channelId: operation.id, requestId: crypto.randomUUID(), method, params };
    const response = parseNativeMcpAppResponse(await this.bridge.sessionMcpApp!(this.sessionId, request, this.hostId), request);
    this.#current(operation);
    if (response.type !== "result") throw new Error("Invalid MCP app response.");
    return response.value;
  }
  async close(): Promise<void> {
    const operation = this.#operation;
    if (!operation) return;
    const warningKnown = operation.warningShown === true;
    if (operation.closeFailed) { operation.closing = undefined; operation.closeFailed = false; }
    await this.#close(operation); this.#reportClose(operation, warningKnown);
  }
  #reportClose(operation: Operation, warningKnown: boolean): void {
    if (operation.operationErrors && !warningKnown) {
      operation.warningShown = true;
      throw new Error("The app channel is closed, but a pending operation ended with an error. Its effect is not confirmed and was not retried. Close again to dismiss, or deliberately open a new channel.");
    }
  }
  #close(operation: Operation): Promise<void> {
    if (operation.closing) return operation.closing;
    operation.closed = true;
    operation.closing = (async () => {
      // Opening can be in transit. Its settlement precedes close, including an
      // ambiguous transport error; never let a late open create an orphan channel.
      await operation.opening.catch(() => {});
      const request = { type: "close" as const, channelId: operation.id };
      const response = parseNativeMcpAppResponse(await this.bridge.sessionMcpApp!(this.sessionId, request, this.hostId), request);
      if (response.type !== "closed") throw new Error("Invalid app cleanup receipt.");
      operation.operationErrors = response.operationErrors;
    })();
    for (const listener of this.#listeners) listener();
    void operation.closing.catch(() => { operation.closeFailed = true; });
    return operation.closing;
  }
  dispose(): Promise<void> { this.#disposed = true; return this.#operation ? this.#close(this.#operation) : Promise.resolve(); }
}
