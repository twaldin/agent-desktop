import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConnection, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { readResource, listResources, listResourceTemplates } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { cloneMcpJson, parseNativeMcpAppDescriptor, parseNativeMcpFileViewer, mcpViewerExtension, parseNativeMcpAppRequest, parseNativeMcpAppResource,
  type McpJson, type NativeMcpFileViewer, type NativeMcpAppDescriptor, type NativeMcpAppRequest, type NativeMcpAppResponse, type NativeMcpAppSelection, type NativeMcpAppSource } from "../../../../packages/shared/src/session-mcp-app";
import { mcpUiResourceUri, type McpArtifact } from "../../../../packages/shared/src/mcp-artifact";

function asRecord(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
export function mcpToolResource(tool: MCPToolDefinition): string | undefined {
  return mcpUiResourceUri(tool._meta);
}
/** Pinned thread entrypoints are distinct from generic tools and resources. */
export function mcpAppDescriptors(connection: MCPServerConnection): NativeMcpAppDescriptor[] {
  const icons = (connection.serverInfo.icons ?? []).filter(icon => icon.src.startsWith("https://") || icon.src.startsWith("data:image/"));
  const best = (theme: "light" | "dark") => {
    const candidates = icons.filter(icon => icon.theme === theme), fallback = icons.filter(icon => icon.theme === undefined);
    const size = (icon: typeof icons[number]) => !icon.sizes || icon.sizes.includes("any") ? Infinity : Math.max(0, ...icon.sizes.map(size => { const match = /^(\d+)x(\d+)$/.exec(size); return match ? Number(match[1]) * Number(match[2]) : 0; }));
    return [...(candidates.length ? candidates : fallback.length ? fallback : icons)].sort((a, b) => size(b) - size(a))[0]?.src;
  };
  const light = best("light"), dark = best("dark");
  return (connection.tools ?? []).flatMap(tool => {
    const entrypoints = asRecord(tool._meta?.["openai/ui"])?.entrypoints, resourceUri = mcpToolResource(tool);
    if (!resourceUri || !Array.isArray(entrypoints) || !entrypoints.some(entry => asRecord(entry)?.type === "thread")) return [];
    try { return [parseNativeMcpAppDescriptor({ toolName: tool.name, title: tool.title || tool.annotations?.title || tool.name, resourceUri, ...(light && dark ? { icon: { light, dark } } : {}) })]; }
    catch { return []; }
  });
}
export function mcpFileViewers(connection: MCPServerConnection): NativeMcpFileViewer[] {
  return (connection.tools ?? []).flatMap(tool => {
    const entries = asRecord(tool._meta?.["openai/ui"])?.entrypoints, resourceUri = mcpToolResource(tool);
    if (!resourceUri || !Array.isArray(entries)) return [];
    const extensions = entries.flatMap(value => { const entry = asRecord(value); return entry?.type === "file" && Array.isArray(entry.extensions) ? entry.extensions : []; });
    if (!extensions.length) return [];
    try { return [parseNativeMcpFileViewer({ toolName: tool.name, title: tool.title || tool.annotations?.title || tool.name, resourceUri, extensions })]; }
    catch { return []; }
  });
}
interface Operation { fingerprint: string; promise: Promise<NativeMcpAppResponse>; failure?: unknown }
interface Channel {
  id: string;
  selection: NativeMcpAppSelection;
  connection: MCPServerConnection;
  abort: AbortController;
  operations: Map<string, Operation>;
  opened?: Promise<NativeMcpAppResponse>;
  closed?: Promise<NativeMcpAppResponse>;
  retired: boolean;
  openingFingerprint: string;
  source?: NativeMcpAppSource;
  artifact?: McpArtifact;
  artifactFingerprint?: string;
  cleanupFailures?: unknown[];
}

/** One session owns every channel. All native calls use the captured connection
 * directly, so automatic MCP reconnection cannot replay an app mutation. */
export class NativeMcpApps {
  readonly #channels = new Map<string, Channel>();
  #disposed = false;
  #unsubscribe?: () => void;
  constructor(private readonly options: {
    manager?: Pick<MCPManager, "addConnectionStatusListener" | "getConnectionStatus" | "getConnection">;
    snapshot(): { epoch: string; revision: number };
    assertOwner(): void;
    artifact?(entryId: string): McpArtifact | undefined;
    filePath?(source: Extract<NativeMcpAppSource, { type: "file" }>): string;
    fileResource?(source: Extract<NativeMcpAppSource, { type: "file" }>, method: "resources/read" | "openai/resources/write", params: Record<string, McpJson>, signal: AbortSignal, assertCurrent: () => void): Promise<unknown>;
    executeTool(connection: MCPServerConnection, tool: MCPToolDefinition, args: Record<string, unknown>, signal: AbortSignal, assertOwner: () => void, metadata?: Record<string, unknown>): Promise<unknown>;
  }) {
    this.#unsubscribe = options.manager?.addConnectionStatusListener(event => {
      for (const channel of this.#channels.values()) {
        if (channel.retired || !(event.type === "connecting" ? event.serverNames.includes(channel.selection.serverName) : channel.selection.serverName === event.serverName)) continue;
        try { this.#current(channel); } catch { void this.#close(channel).catch(() => {}); }
      }
    });
  }

  #current(channel: Channel): void {
    this.options.assertOwner();
    const manager = this.options.manager;
    if (this.#disposed || channel.retired || channel.abort.signal.aborted || !manager
      || manager.getConnectionStatus(channel.selection.serverName) !== "connected"
      || manager.getConnection(channel.selection.serverName) !== channel.connection
      || !this.#sourceCurrent(channel)) {
      channel.abort.abort();
      throw new Error("The original MCP app connection is unavailable. Reopen the app deliberately after reconnecting.");
    }
  }
  #sourceCurrent(channel: Channel): boolean {
    const source = channel.source;
    if (source?.type === "file") return Boolean(this.options.fileResource && this.options.filePath && mcpFileViewers(channel.connection).some(viewer => viewer.toolName === channel.selection.toolName
      && viewer.resourceUri === channel.selection.resourceUri && mcpViewerExtension(source.path, viewer.extensions)));
    if (!channel.artifact) return mcpAppDescriptors(channel.connection).some(app => app.toolName === channel.selection.toolName && app.resourceUri === channel.selection.resourceUri);
    try { return JSON.stringify(this.options.artifact?.(channel.artifact.entryId)) === channel.artifactFingerprint; }
    catch { return false; }
  }
  #run(channel: Channel, requestId: string, fingerprint: string, work: (signal: AbortSignal) => Promise<NativeMcpAppResponse>): Promise<NativeMcpAppResponse> {
    try { this.#current(channel); } catch (error) { return Promise.reject(error); }
    const prior = channel.operations.get(requestId);
    if (prior) { if (prior.fingerprint !== fingerprint) return Promise.reject(new Error("MCP app request identity was reused with different input.")); return prior.promise; }
    try { this.#current(channel); } catch (error) { return Promise.reject(error); }
    if (channel.operations.size >= 1024) return Promise.reject(new Error("This MCP app has reached its operation limit. Reopen it deliberately."));
    if ([...channel.operations.values()].filter(operation => !settledOperations.has(operation)).length >= 8) return Promise.reject(new Error("Wait for pending MCP app operations."));
    const operation = { fingerprint } as Operation;
    // Reserve before invoking native code, including synchronously reentrant callbacks.
    channel.operations.set(requestId, operation);
    operation.promise = Promise.resolve().then(async () => {
      const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(new Error("MCP app operation timed out.")), 30_000);
      try {
        this.#current(channel);
        let value: NativeMcpAppResponse;
        try { value = await work(AbortSignal.any([channel.abort.signal, timeout.signal])); timeout.signal.throwIfAborted(); }
        catch (error) {
          if (!(channel.abort.signal.aborted && error instanceof Error && error.name === "AbortError")) operation.failure = error;
          throw error;
        }
        this.#current(channel);
        return value;
      } finally { clearTimeout(timer); settledOperations.add(operation); }
    });
    void operation.promise.catch(() => {});
    return operation.promise;
  }
  request(raw: NativeMcpAppRequest): Promise<NativeMcpAppResponse> {
    const request = parseNativeMcpAppRequest(raw), manager = this.options.manager;
    if (request.type === "close") {
      const channel = this.#channels.get(request.channelId);
      return channel ? this.#close(channel) : Promise.resolve({ type: "closed", channelId: request.channelId });
    }
    if (request.type === "open") {
      const existing = this.#channels.get(request.channelId);
      if (existing) {
        if (existing.openingFingerprint !== JSON.stringify(request)) return Promise.reject(new Error("MCP app channel identity was reused."));
        try { this.#current(existing); } catch (error) { return Promise.reject(error); }
        return existing.opened!;
      }
      this.options.assertOwner();
      const snapshot = this.options.snapshot();
      if (this.#disposed || !manager || snapshot.epoch !== request.selection.epoch || snapshot.revision !== request.selection.expectedRevision) return Promise.reject(new Error("MCP app catalogue changed before admission."));
      if (this.#channels.size >= 4096 || [...this.#channels.values()].filter(channel => !channel.retired).length >= 32) return Promise.reject(new Error("This session has reached its MCP app channel limit."));
      const connection = manager.getConnection(request.selection.serverName);
      if (!connection) return Promise.reject(new Error("MCP app server is not connected."));
      const artifact = request.source?.type === "artifact" ? this.options.artifact?.(request.source.entryId) : undefined;
      if (request.source?.type === "artifact" && (!artifact || artifact.serverName !== request.selection.serverName || artifact.toolName !== request.selection.toolName || artifact.resourceUri !== request.selection.resourceUri)) return Promise.reject(new Error("The original saved MCP result is unavailable."));
      const channel: Channel = { id: request.channelId, selection: request.selection, connection, abort: new AbortController(), operations: new Map(), retired: false,
        openingFingerprint: JSON.stringify(request), ...(request.source ? { source: request.source } : {}), ...(artifact ? { artifact, artifactFingerprint: JSON.stringify(artifact) } : {}) };
      this.#current(channel);
      this.#channels.set(channel.id, channel);
      channel.opened = this.#run(channel, "open", JSON.stringify(request), async signal => {
        const value = await readResource(connection, request.selection.resourceUri, { signal });
        if (value.contents.length !== 1) throw new Error("MCP app must provide exactly one UI resource.");
        const content = value.contents[0]!, raw = content as unknown as Record<string, unknown>, ui = asRecord(asRecord(raw._meta)?.ui);
        if (typeof content.text !== "string" && typeof content.blob !== "string") throw new Error("Invalid MCP app HTML payload.");
        if (ui?.permissions !== undefined && (!asRecord(ui.permissions) || Object.keys(asRecord(ui.permissions)!).length)) throw new Error("This app requests browser permissions that are not available in this sandbox.");
        const resource = parseNativeMcpAppResource({ uri: content.uri, mimeType: content.mimeType,
          html: "text" in content ? content.text : new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(typeof content.blob === "string" ? content.blob : "", "base64")),
          ...(ui?.csp === undefined ? {} : { csp: ui.csp }) });
        if (resource.uri !== request.selection.resourceUri) throw new Error("MCP app resource owner changed.");
        return { type: "opened", channelId: channel.id, resource,
          ...(request.source?.type === "file" ? { initialArguments: { file: { name: request.source.path.split("/").at(-1)!, resourceUri: request.source.resourceUri } } } : {}), ...(artifact ? { initialResult: artifact.result,
          ...(artifact.arguments ? { initialArguments: artifact.arguments } : {}) } : {}) };
      });
      return channel.opened;
    }
    const channel = this.#channels.get(request.channelId);
    if (!channel) return Promise.reject(new Error("The original MCP app channel is unavailable."));
    return this.#run(channel, request.requestId, JSON.stringify(request), async signal => {
      await channel.opened;
      this.#current(channel);
      let value: unknown;
      const hostResource = typeof request.params.uri === "string" && request.params.uri.startsWith("codex-resource://");
      if (hostResource || request.method === "openai/resources/write") {
        const source = channel.source;
        if (source?.type !== "file" || !this.options.fileResource || typeof request.params.uri !== "string"
          || !(request.params.uri === source.resourceUri || request.params.uri.startsWith(`${source.resourceUri}/`))
          || !["resources/read", "openai/resources/write"].includes(request.method)) throw new Error("This resource does not belong to the original file viewer.");
        value = await this.options.fileResource(source, request.method as "resources/read" | "openai/resources/write", request.params, signal, () => this.#current(channel));
        if (request.method === "resources/read") {
          const viewer = mcpFileViewers(channel.connection).find(viewer => viewer.toolName === channel.selection.toolName && viewer.resourceUri === channel.selection.resourceUri);
          value = { ...asRecord(value), extension: viewer ? mcpViewerExtension(source.path, viewer.extensions) : undefined };
        }
      } else if (request.method === "tools/call") {
        const name = request.params.name;
        const tool = channel.connection.tools?.find(tool => tool.name === name);
        const visibility = asRecord(tool?._meta?.ui)?.visibility;
        if (!tool || Array.isArray(visibility) && !visibility.includes("app")) throw new Error("This tool is not available to the MCP app.");
        if (request.params.arguments !== undefined && !asRecord(request.params.arguments)) throw new Error("Invalid MCP app tool arguments.");
        value = await this.options.executeTool(channel.connection, tool, asRecord(request.params.arguments) ?? {}, signal, () => {
          this.#current(channel);
          const current = channel.connection.tools?.find(value => value.name === tool.name);
          const currentVisibility = asRecord(current?._meta?.ui)?.visibility;
          if (current !== tool || Array.isArray(currentVisibility) && !currentVisibility.includes("app")) throw new Error("The original MCP tool changed before dispatch.");
        }, channel.source?.type === "file" ? { "openai/resource": { path: this.options.filePath!(channel.source) } } : undefined);
      } else if (request.method === "resources/read") {
        if (typeof request.params.uri !== "string" || request.params.uri.length > 16_384) throw new Error("Invalid MCP app resource request.");
        value = await readResource(channel.connection, request.params.uri, { signal });
      } else if (request.method === "resources/list") value = { resources: await listResources(channel.connection, { signal }) };
      else value = { resourceTemplates: await listResourceTemplates(channel.connection, { signal }) };
      // Parse dispatched results before retirement checks so cleanup retains malformed failures.
      const result = cloneMcpJson(value);
      if (!asRecord(result)) throw new Error("Invalid MCP app result.");
      return { type: "result", channelId: channel.id, requestId: request.requestId, value: result as Record<string, McpJson> };
    });
  }
  #close(channel: Channel): Promise<NativeMcpAppResponse> {
    if (channel.closed) return channel.closed;
    const pending = [...channel.operations.values()].filter(operation => !settledOperations.has(operation));
    channel.retired = true;
    channel.closed = Promise.resolve().then(async () => {
      await Promise.allSettled(pending.map(operation => operation.promise));
      const errors = pending.flatMap(operation => operation.failure === undefined ? [] : [operation.failure]);
      channel.cleanupFailures = errors;
      // Retirement is confirmed independently of the outcome of dispatched work.
      // Never retry that work or hide its failure behind a successful close.
      return { type: "closed" as const, channelId: channel.id, ...(errors.length ? { operationErrors: errors.length } : {}) };
    });
    channel.abort.abort();
    void channel.closed.catch(() => {});
    return channel.closed;
  }
  get pending(): boolean { return [...this.#channels.values()].some(channel => [...channel.operations.values()].some(operation => !settledOperations.has(operation))); }
  async dispose(): Promise<void> {
    this.#disposed = true; this.#unsubscribe?.(); this.#unsubscribe = undefined;
    const results = await Promise.allSettled([...this.#channels.values()].map(channel => this.#close(channel)));
    const errors = [...results.flatMap(result => result.status === "rejected" ? [result.reason] : []), ...[...this.#channels.values()].flatMap(channel => channel.cleanupFailures ?? [])];
    if (errors.length) throw new AggregateError(errors, "MCP app session cleanup failed.");
  }
}
const settledOperations = new WeakSet<Operation>();
