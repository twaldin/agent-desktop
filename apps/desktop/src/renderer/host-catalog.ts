import type { DesktopBridge, DesktopEvent, HostState, NetworkState } from "../../../../packages/shared/src/protocol";
import type { OfflineCache } from "./offline-cache";
export type HostCatalogBridge = Pick<DesktopBridge, "getState" | "getHosts" | "subscribe">;

export interface HostRecord { state?: HostState; connected: boolean; loading: boolean; error?: string }
export interface HostOption { key: string; hostId?: string; name: string; local: boolean; availability: "available" | "unavailable" | "offline"; cached: boolean; error?: string }
const cacheKey = "agent-desktop:host-catalog:v2";
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Owns cached host identity and event routing; a session ID is never a host identity. */
export class HostCatalog {
  readonly records = new Map<string, HostRecord>();
  localHostId?: string;
  network?: NetworkState;
  networkError?: string;
  cacheWarning?: string;
  localError?: string;
  revision = 0;
  private nodes = new Map<string, string>();
  private listeners = new Set<() => void>();
  private pending = new Map<string, Promise<void>>();
  private unsubscribe?: () => void;
  private refreshing?: Promise<void>;
  private restoring?: Promise<void>;
  private cacheLoaded = false;
  private needsPersist = false;
  private observation = 0;
  private observed = new Map<string, number>();
  constructor(private bridge: HostCatalogBridge | undefined, private cache?: OfflineCache) {}
  restore(): Promise<void> {
    if (this.cacheLoaded) return Promise.resolve();
    return this.restoring ??= this.loadCache().finally(() => { this.restoring = undefined; });
  }
  private async loadCache() {
    try {
      let saved = JSON.parse(await this.cache?.read(cacheKey) ?? "null");
      if (!saved) {
        const legacy = JSON.parse(await this.cache?.read("agent-desktop:host-cache:v1") ?? "null");
        if (validState(legacy)) { saved = { localHostId: legacy.host.id, states: [legacy], nodes: [] }; this.needsPersist = true; }
      }
      if (saved) {
        this.localHostId ??= typeof saved.localHostId === "string" ? saved.localHostId : undefined;
        for (const state of saved.states ?? []) if (validState(state) && !this.records.get(state.host.id)?.state) this.records.set(state.host.id, { state, connected: false, loading: false });
        for (const [node, host] of saved.nodes ?? []) if (typeof node === "string" && typeof host === "string" && !this.nodes.has(node)) this.nodes.set(node, host);
      }
    } catch {
      this.cacheWarning = "The cached host catalog could not be read. Reconnect to retry; existing cached history has been preserved.";
      this.changed(); return;
    }
    this.cacheWarning = undefined;
    this.cacheLoaded = true;
    if (this.needsPersist) this.persist();
    this.changed();
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { this.revision++; for (const listener of this.listeners) listener(); }
  private persist() {
    if (!this.cacheLoaded) { this.needsPersist = true; return; }
    this.needsPersist = false;
    void this.cache?.write(cacheKey, JSON.stringify({ localHostId: this.localHostId, states: [...this.records.values()].flatMap(record => record.state ? [record.state] : []), nodes: [...this.nodes] })).catch(() => { this.cacheWarning = "Offline host catalog storage is unavailable on this device."; this.changed(); });
  }
  start() { this.unsubscribe ??= this.bridge?.subscribe(event => this.ingest(event)); }
  stop() { this.unsubscribe?.(); this.unsubscribe = undefined; }
  ingest(event: DesktopEvent) {
    const hostId = event.hostId ?? (event.type === "state" ? event.state.host.id : this.localHostId);
    if (!hostId) return;
    if (event.type === "state") {
      // Reject a malformed envelope rather than attaching a remote catalog to another owner.
      if (!validState(event.state) || hostId !== event.state.host.id) return;
      this.apply(event.state); return;
    }
    if (event.type === "connection") {
      this.observed.set(hostId, ++this.observation);
      const previous = this.records.get(hostId);
      this.records.set(hostId, { ...previous, connected: event.connected, loading: false, error: event.error ?? (event.connected ? undefined : "This host is disconnected. Your draft stays on this device.") });
      this.changed();
      if (event.connected) void this.refreshHost(hostId);
    }
  }
  private apply(state: HostState) {
    const previous = this.records.get(state.host.id)?.state;
    if (previous && previous.lastEventSequence > state.lastEventSequence) return;
    this.observed.set(state.host.id, ++this.observation);
    this.records.set(state.host.id, { state, connected: true, loading: false });
    this.persist(); this.changed();
  }
  async refreshHost(hostId?: string): Promise<void> {
    const key = hostId ?? "local";
    const pending = this.pending.get(key); if (pending) return pending;
    const request = this.loadHost(hostId).finally(() => this.pending.delete(key));
    this.pending.set(key, request); return request;
  }
  private async loadHost(hostId?: string) {
    const started = this.observation;
    const knownId = hostId ?? this.localHostId;
    if (knownId) this.records.set(knownId, { ...this.records.get(knownId), connected: this.records.get(knownId)?.connected ?? false, loading: true });
    this.changed();
    try {
      if (!this.bridge) throw new Error("The desktop bridge is unavailable. Open this app in its Electron window.");
      const state = await this.bridge.getState(hostId);
      if (!validState(state)) throw new Error("The connected machine returned an invalid host catalog.");
      if (hostId && state.host.id !== hostId) throw new Error("The connected machine returned a different host identity.");
      if (!hostId) { this.localHostId = state.host.id; this.localError = undefined; }
      // The result belongs to the observation at request admission. A later
      // stream event (including disconnect) has already superseded it.
      if ((this.observed.get(state.host.id) ?? 0) <= started) this.apply(state);
    } catch (cause) {
      if (knownId && (this.observed.get(knownId) ?? 0) > started) return;
      if (!hostId) this.localError = message(cause);
      if (knownId) {
        this.observed.set(knownId, ++this.observation);
        this.records.set(knownId, { ...this.records.get(knownId), connected: false, loading: false, error: message(cause) });
      }
      this.changed();
    } finally {
      const owner = knownId ?? this.localHostId;
      const record = owner ? this.records.get(owner) : undefined;
      if (record?.loading) { this.records.set(owner!, { ...record, loading: false }); this.changed(); }
    }
  }
  refresh(activeHostId?: string): Promise<void> {
    this.refreshing ??= this.loadNetwork().finally(() => { this.refreshing = undefined; });
    // The selected owner's authenticated request is independent of a discovery
    // health probe. A failed probe must not suppress every recovery attempt.
    return activeHostId && activeHostId !== this.localHostId
      ? Promise.all([this.refreshing, this.refreshHost(activeHostId)]).then(() => {}) : this.refreshing;
  }
  private async loadNetwork() {
    if (!this.cacheLoaded) void this.restore();
    await Promise.allSettled([this.refreshHost(), (async () => {
      const started = this.observation;
      try {
        if (!this.bridge?.getHosts) throw new Error("Host discovery requires the current desktop bridge. Restart the app after updating.");
        this.network = await this.bridge.getHosts(); this.networkError = undefined;
        for (const node of this.network.hosts) {
          if (node.host) this.nodes.set(node.nodeId, node.host.id);
          const hostId = node.host?.id ?? this.nodes.get(node.nodeId);
          if (hostId && node.availability !== "available" && hostId !== this.localHostId && (this.observed.get(hostId) ?? 0) <= started) this.records.set(hostId, { ...this.records.get(hostId), connected: false, loading: false, error: node.error ?? (node.availability === "offline" ? "This machine is offline." : "The app service is unavailable on this machine.") });
        }
        this.persist(); this.changed();
        await Promise.allSettled(this.network.hosts.filter(node => node.availability === "available" && node.host && node.host.id !== this.localHostId).map(node => this.refreshHost(node.host!.id)));
      } catch (cause) { this.networkError = message(cause); this.changed(); }
    })()]);
  }
  options(): HostOption[] {
    const result: HostOption[] = []; const included = new Set<string>();
    if (this.localHostId) {
      const record = this.records.get(this.localHostId);
      result.push({ key: this.localHostId, hostId: this.localHostId, name: record?.state?.host.name ?? "This machine", local: true, availability: record?.connected ? "available" : "unavailable", cached: Boolean(record?.state), error: record?.error ?? this.localError });
      included.add(this.localHostId);
    }
    for (const node of this.network?.hosts ?? []) {
      const hostId = node.host?.id ?? this.nodes.get(node.nodeId);
      if ((hostId && included.has(hostId)) || node.nodeId === this.network?.ownNodeId) continue;
      const record = hostId ? this.records.get(hostId) : undefined;
      // Discovery is a periodically sampled probe. A later authenticated state
      // or connection event is the same live evidence used by the active footer.
      // Keep discovery diagnostics in network; don't attach an old probe failure
      // to a now-connected owner. Disconnects and failed fetches clear connected.
      const availability = record?.connected ? "available" : node.availability === "available" && record?.error ? "unavailable" : node.availability;
      const error = record?.connected ? record.error : record?.error ?? node.error;
      result.push({ key: hostId ?? `node:${node.nodeId}`, hostId, name: node.host?.name ?? record?.state?.host.name ?? node.name, local: false, availability, cached: Boolean(record?.state), error });
      if (hostId) included.add(hostId);
    }
    for (const [hostId, record] of this.records) if (!included.has(hostId)) result.push({ key: hostId, hostId, name: record.state?.host.name ?? hostId, local: false, availability: record.connected ? "available" : "offline", cached: Boolean(record.state), error: record.error });
    return result;
  }
}
function validState(value: any): value is HostState { return value?.protocolVersion === 1 && typeof value.host?.id === "string" && Array.isArray(value.projects) && Array.isArray(value.sessions) && Array.isArray(value.drafts) && Array.isArray(value.models); }
