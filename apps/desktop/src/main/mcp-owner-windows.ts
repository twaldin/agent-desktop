import { parseMcpOwnerRequest, type McpOwnerRequest, type McpOwnerResult } from "@agent-desktop/shared";
import type { HostEndpoint } from "./host-transport";
type Acquisition = Extract<McpOwnerRequest, { target: unknown }>;
interface Owner {
  hostId: string;
  acquisition: Acquisition;
  endpoint?: HostEndpoint;
  sent: boolean;
  retired: boolean;
  ready: Promise<McpOwnerResult>;
  closing?: Promise<McpOwnerResult>;
}
/** The original main document owns both acquisition and its exact endpoint.
 * Closing a sent but unconfirmed acquisition installs a host-side tombstone. */
export class McpOwnerWindow {
  readonly #owners = new Map<string, Owner>();
  readonly #retiredIds = new Map<string, string>();
  #retired = false;
  #drain?: Promise<void>;
  constructor(private readonly options: { current(): boolean; connect(hostId: string): Promise<HostEndpoint>; request(endpoint: HostEndpoint, request: McpOwnerRequest): Promise<McpOwnerResult> }) {}
  #assertCurrent(): void { if (this.#retired || !this.options.current()) throw new Error("The original MCP document is no longer available."); }
  dispatch(hostId: string, raw: McpOwnerRequest): Promise<McpOwnerResult> {
    const request = parseMcpOwnerRequest(raw); this.#assertCurrent();
    if (!hostId || hostId.length > 200 || /[\0-\x1f\x7f]/.test(hostId)) throw new Error("Invalid MCP host.");
    const existing = this.#owners.get(request.ownerId);
    if (existing && existing.hostId !== hostId) throw new Error("MCP owner belongs to another host.");
    if (request.type === "acquire") {
      if (this.#retiredIds.has(request.ownerId)) throw new Error("This MCP acquisition was already retired.");
      if (existing) {
        if (existing.retired || JSON.stringify(request) !== JSON.stringify(existing.acquisition)) throw new Error("This MCP acquisition was retired or reused.");
        return existing.ready;
      }
      if (this.#owners.size + this.#retiredIds.size >= 4096) throw new Error("This document has reached its MCP owner limit.");
      const owner = { hostId, acquisition: request, sent: false, retired: false } as Owner;
      this.#owners.set(request.ownerId, owner);
      owner.ready = Promise.resolve().then(async () => {
        this.#assertCurrent();
        const endpoint = await this.options.connect(hostId); this.#assertCurrent();
        if (owner.retired || endpoint.hostId !== hostId) throw new Error("The original MCP acquisition was cancelled.");
        owner.endpoint = { ...endpoint }; owner.sent = true;
        const result = await this.options.request(owner.endpoint, request); this.#assertCurrent();
        if (owner.retired) throw new Error("The original MCP acquisition was cancelled.");
        return result;
      });
      void owner.ready.catch(() => {}); return owner.ready;
    }
    if (!existing) {
      if (request.type === "retire") {
        const fingerprint = JSON.stringify(request.target), previous = this.#retiredIds.get(request.ownerId);
        if (previous !== undefined && previous !== fingerprint) throw new Error("MCP retirement target changed.");
        if (previous === undefined && this.#owners.size + this.#retiredIds.size >= 4096) throw new Error("MCP retirement limit exceeded.");
        this.#retiredIds.set(request.ownerId, fingerprint);
        return Promise.resolve({ closed: true });
      }
      throw new Error("This document has no original MCP owner.");
    }
    if (request.type === "close" || request.type === "retire") {
      if (request.type === "retire" && JSON.stringify(request.target) !== JSON.stringify(existing.acquisition.target)) throw new Error("MCP retirement target changed.");
      if (request.type === "close") return existing.ready.then(snapshot => {
        if (!("epoch" in snapshot) || snapshot.epoch !== request.epoch) throw new Error("MCP retirement generation changed.");
        return this.#close(existing);
      });
      return this.#close(existing);
    }
    return (async () => {
      const snapshot = await existing.ready; this.#assertCurrent();
      if (existing.retired || !existing.endpoint || !("epoch" in snapshot) || snapshot.epoch !== request.epoch) throw new Error("The original MCP owner has retired.");
      const value = await this.options.request(existing.endpoint, request); this.#assertCurrent();
      if (existing.retired) throw new Error("The original MCP owner has retired.");
      return value;
    })();
  }
  #close(owner: Owner): Promise<McpOwnerResult> {
    if (owner.closing) return owner.closing;
    owner.retired = true;
    owner.closing = Promise.resolve().then(async () => {
      await owner.ready.catch(() => {});
      if (!owner.sent || !owner.endpoint) return { closed: true };
      return this.options.request(owner.endpoint, { ...owner.acquisition, type: "retire" });
    });
    void owner.closing.catch(() => { owner.closing = undefined; });
    return owner.closing;
  }
  retire(): Promise<void> {
    this.#retired = true;
    return this.#drain ??= Promise.allSettled([...this.#owners.values()].map(owner => this.#close(owner))).then(results => {
      const errors = results.flatMap(value => value.status === "rejected" ? [value.reason] : []);
      if (errors.length) { this.#drain = undefined; throw new AggregateError(errors, "MCP document owner cleanup failed."); }
    });
  }
}
