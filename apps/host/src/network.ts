import { deviceAccessAllowed, type DeviceAccessPolicy } from "../../../packages/shared/src/device-access";
import type { HostIdentity, DiscoveredHost, NetworkState } from "@agent-desktop/shared";
import { TailscaleClient, type TailscaleDiscovery, type TailscaleAuthorization } from "./tailscale";

export const TAILNET_PORT = 47827;
export type { DiscoveredHost, NetworkState } from "@agent-desktop/shared";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const originFor = (address: string) => `http://${address.includes(":") ? `[${address}]` : address}:${TAILNET_PORT}`;

type AppHostProbe =
  | { availability: "available"; host: HostIdentity; origin: string; preferencesSyncVersion?: 2 | 3 }
  | { availability: "unavailable"; error: string };

// An uncached peer authorization can run two sequential Tailscale CLI calls,
// each bounded at 5 seconds. Allow that work plus transport within one probe.
export async function probeAppHost(origin: string, timeoutMs = 12_000): Promise<AppHostProbe> {
  try {
    const response = await fetch(`${origin}/v1/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    if (!response.ok) return { availability: "unavailable", error: `Host service returned ${response.status}.` };
    const value = await response.json() as { host?: HostIdentity; protocolVersion?: number; preferencesSyncVersion?: unknown };
    const host = value.host;
    if (value.protocolVersion !== 1 || !host || typeof host.id !== "string" || typeof host.name !== "string"
      || typeof host.platform !== "string" || typeof host.architecture !== "string") {
      return { availability: "unavailable", error: "Host service has an incompatible protocol." };
    }
    return { availability: "available", host, origin, ...(value.preferencesSyncVersion === 2 || value.preferencesSyncVersion === 3 ? { preferencesSyncVersion: value.preferencesSyncVersion } : {}) };
  } catch { return { availability: "unavailable", error: "App host service is not reachable." }; }
}

/** Existing Tailscale supplies device identity and transport encryption. No provider credentials leave their host. */
export class TailnetNetwork {
  constructor(private readonly policy: () => DeviceAccessPolicy, readonly client: Pick<TailscaleClient, "authorizePeer" | "discover"> = new TailscaleClient()) {}
  allows(nodeId: string): boolean { return deviceAccessAllowed(this.policy(), nodeId); }
  state: NetworkState = { status: "connecting", hosts: [], checkedAt: 0 };
  #checks = new Map<string, { expires: number; pending: Promise<TailscaleAuthorization> }>();
  #refresh?: Promise<NetworkState>;
  async authenticate(address: string): Promise<string | undefined> {
    if (!this.policy().enabled) return undefined;
    let check = this.#checks.get(address);
    if (!check || check.expires < Date.now()) {
      const pending = this.client.authorizePeer(address);
      check = { expires: Date.now() + 5000, pending };
      this.#checks.set(address, check);
      if (this.#checks.size > 1000) this.#checks.delete(this.#checks.keys().next().value!);
    }
    const result = await check.pending;
    // Authorization may finish after a local revoke, or reuse a cached identity. Never cache policy.
    return result.authorized && this.allows(result.peer.nodeId) ? result.peer.nodeId : undefined;
  }
  async verify(address: string): Promise<boolean> { return (await this.authenticate(address)) !== undefined; }
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
      return { ...base, ...await probeAppHost(origin) };
    }));
    return this.state = { status: "connected", ownNodeId: self.nodeId, ownName: self.hostname, listenAddress, hosts, checkedAt: Date.now() };
  }
}
