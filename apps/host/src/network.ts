import type { HostIdentity, DiscoveredHost, NetworkState } from "@agent-desktop/shared";
import { TailscaleClient, type TailscaleDiscovery, type TailscaleAuthorization } from "./tailscale";

export const TAILNET_PORT = 47827;
export type { DiscoveredHost, NetworkState } from "@agent-desktop/shared";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const originFor = (address: string) => `http://${address.includes(":") ? `[${address}]` : address}:${TAILNET_PORT}`;

/** Existing Tailscale supplies device identity and transport encryption. No provider credentials leave their host. */
export class TailnetNetwork {
  readonly client = new TailscaleClient();
  state: NetworkState = { status: "connecting", hosts: [], checkedAt: 0 };
  #checks = new Map<string, { expires: number; pending: Promise<TailscaleAuthorization> }>();
  #refresh?: Promise<NetworkState>;
  async verify(address: string): Promise<boolean> {
    let check = this.#checks.get(address);
    if (!check || check.expires < Date.now()) {
      const pending = this.client.authorizePeer(address);
      check = { expires: Date.now() + 5000, pending };
      this.#checks.set(address, check);
      if (this.#checks.size > 1000) this.#checks.delete(this.#checks.keys().next().value!);
    }
    return (await check.pending).authorized;
  }
  refresh(): Promise<NetworkState> {
    if (!this.#refresh) this.#refresh = this.#discover().finally(() => { this.#refresh = undefined; });
    return this.#refresh;
  }
  async #discover(): Promise<NetworkState> {
    let discovery: TailscaleDiscovery;
    try { discovery = await this.client.discover(); }
    catch (error) { return this.state = { ...this.state, status: "unavailable", listenAddress: undefined, error: message(error), checkedAt: Date.now() }; }
    const self = discovery.self;
    const listenAddress = self?.addresses.find(address => !address.includes(":")) ?? self?.addresses[0];
    if (discovery.backendState !== "Running" || !self || !self.online || self.expired || self.tags.length || !listenAddress) {
      return this.state = { status: "unavailable", hosts: [], error: "Tailscale is not connected as a personal device.", checkedAt: Date.now() };
    }
    const hosts = await Promise.all(discovery.peers.filter(peer => peer.sameUser && !peer.tags.length && !peer.expired).map(async peer => {
      const base: DiscoveredHost = { nodeId: peer.nodeId, name: peer.hostname, platform: peer.os, online: peer.online,
        availability: peer.online ? "unavailable" : "offline" };
      if (!peer.online) return base;
      const address = peer.addresses.find(address => !address.includes(":")) ?? peer.addresses[0];
      if (!address) return base;
      const origin = originFor(address);
      try {
        const response = await fetch(`${origin}/v1/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
        if (!response.ok) return { ...base, error: `Host service returned ${response.status}.` };
        const value = await response.json() as { host?: HostIdentity; protocolVersion?: number };
        const host = value.host;
        if (value.protocolVersion !== 1 || !host || typeof host.id !== "string" || typeof host.name !== "string"
          || typeof host.platform !== "string" || typeof host.architecture !== "string") {
          return { ...base, error: "Host service has an incompatible protocol." };
        }
        return { ...base, availability: "available" as const, host, origin };
      } catch { return { ...base, error: "App host service is not reachable." }; }
    }));
    return this.state = { status: "connected", ownNodeId: self.nodeId, ownName: self.hostname, listenAddress, hosts, checkedAt: Date.now() };
  }
}
