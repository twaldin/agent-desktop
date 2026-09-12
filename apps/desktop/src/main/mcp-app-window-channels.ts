import { parseNativeMcpAppRequest, parseNativeMcpAppResponse, type NativeMcpAppRequest, type NativeMcpAppResponse } from "@agent-desktop/shared";
import type { HostEndpoint } from "./host-transport";

interface Channel {
  sessionId: string;
  hostId: string;
  request: Extract<NativeMcpAppRequest, { type: "open" }>;
  endpoint?: HostEndpoint;
  dispatched: boolean;
  retired: boolean;
  opening: Promise<NativeMcpAppResponse>;
  closing?: Promise<NativeMcpAppResponse>;
  closeFailed?: boolean;
}

/** One original main-frame document owns these channels. Navigation retires the
 * whole object; a replacement document gets another owner, never this map. */
export class McpAppWindowChannels {
  #channels = new Map<string, Channel>();
  #retired = false;
  #drain?: Promise<void>;
  constructor(private readonly options: {
    current(): boolean;
    reportOperationErrors?(count: number): void;
    connect(hostId: string): Promise<HostEndpoint>;
    request(endpoint: HostEndpoint, sessionId: string, request: NativeMcpAppRequest): Promise<NativeMcpAppResponse>;
  }) {}
  #current(): void {
    if (this.#retired || !this.options.current()) throw new Error("The original MCP app document has retired.");
  }
  dispatch(sessionId: string, hostId: string, raw: NativeMcpAppRequest): Promise<NativeMcpAppResponse> {
    const request = parseNativeMcpAppRequest(raw);
    if (!sessionId || sessionId.length > 200 || sessionId.includes("\0") || !hostId) throw new Error("Invalid MCP app owner.");
    this.#current();
    let channel = this.#channels.get(request.channelId);
    if (channel && (channel.hostId !== hostId || channel.sessionId !== sessionId)) throw new Error("MCP app channel belongs to another task.");
    if (request.type === "close") { if (channel?.closeFailed) channel.closing = undefined; return channel ? this.#close(channel) : Promise.resolve({ type: "closed", channelId: request.channelId }); }
    if (request.type === "open") {
      if (channel) {
        if (channel.retired || JSON.stringify(request) !== JSON.stringify(channel.request)) throw new Error("MCP app channel was retired or reused.");
        return channel.opening;
      }
      if (this.#channels.size >= 4096) throw new Error("This document has reached its MCP app channel limit.");
      const original = { sessionId, hostId, request, dispatched: false, retired: false } as Channel;
      this.#channels.set(request.channelId, original);
      original.opening = Promise.resolve().then(async () => {
        this.#current();
        const endpoint = await this.options.connect(hostId);
        this.#current();
        if (original.retired) throw new Error("The original MCP app opening was cancelled.");
        if (endpoint.hostId !== hostId) throw new Error("The MCP app host changed during lookup.");
        original.endpoint = { ...endpoint };
        original.dispatched = true;
        const response = parseNativeMcpAppResponse(await this.options.request(original.endpoint, sessionId, request), request);
        this.#current();
        if (original.retired) throw new Error("The original MCP app opening was cancelled.");
        return response;
      });
      void original.opening.catch(() => {});
      return original.opening;
    }
    if (!channel || channel.retired) throw new Error("The original MCP app channel is unavailable.");
    const original = channel;
    return (async () => {
      await original.opening;
      this.#current();
      if (original.retired || !original.endpoint) throw new Error("The original MCP app channel is unavailable.");
      const response = parseNativeMcpAppResponse(await this.options.request(original.endpoint, sessionId, request), request);
      this.#current();
      if (original.retired) throw new Error("The original MCP app channel has closed.");
      return response;
    })();
  }
  #close(channel: Channel): Promise<NativeMcpAppResponse> {
    if (channel.closing) return channel.closing;
    channel.retired = true; channel.closeFailed = false;
    channel.closing = Promise.resolve().then(async () => {
      await channel.opening.catch(() => {});
      const request = { type: "close" as const, channelId: channel.request.channelId };
      if (!channel.dispatched || !channel.endpoint) return { type: "closed" as const, channelId: request.channelId };
      const response = parseNativeMcpAppResponse(await this.options.request(channel.endpoint, channel.sessionId, request), request);
      if (response.type === "closed" && response.operationErrors) this.options.reportOperationErrors?.(response.operationErrors);
      return response;
    });
    void channel.closing.catch(() => { channel.closeFailed = true; });
    return channel.closing;
  }
  retire(): Promise<void> {
    this.#retired = true;
    if (this.#drain) return this.#drain;
    for (const channel of this.#channels.values()) if (channel.closeFailed) { channel.closing = undefined; channel.closeFailed = false; }
    this.#drain = Promise.allSettled([...this.#channels.values()].map(channel => this.#close(channel))).then(results => {
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "MCP app document cleanup could not be confirmed.");
    });
    void this.#drain.catch(() => { this.#drain = undefined; });
    return this.#drain;
  }
}
