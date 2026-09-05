import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface TailscaleNode {
  nodeId: string;
  userId: string;
  hostname: string;
  dnsName: string;
  os: string;
  addresses: string[];
  online: boolean;
  expired: boolean;
  tags: string[];
}

export interface TailscalePeer extends TailscaleNode {
  sameUser: boolean;
  /** Online Tailscale presence does not establish that our host service exists. */
  appAvailability: "unknown";
}

export interface TailscaleDiscovery {
  backendState: string;
  self: TailscaleNode | null;
  peers: TailscalePeer[];
  magicDnsSuffix: string | null;
  checkedAt: number;
}

export interface TailscalePeerPolicy {
  /** Optional pairing restriction, in addition to same-user ownership. Empty denies everyone. */
  allowedNodeIds?: readonly string[];
}

export type TailscaleAuthorization =
  | { authorized: true; peer: TailscalePeer; checkedAt: number }
  | { authorized: false; code: "INVALID_ADDRESS" | "TAILSCALE_UNAVAILABLE" | "LOCAL_IDENTITY_UNAVAILABLE" | "UNKNOWN_PEER" | "PEER_UNAVAILABLE" | "WRONG_USER" | "NOT_PAIRED" | "IDENTITY_MISMATCH"; message: string };

export class TailscaleError extends Error {
  constructor(readonly code: "CLI_NOT_FOUND" | "CLI_FAILED" | "INVALID_RESPONSE", message: string) {
    super(message);
    this.name = "TailscaleError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TailscaleError("INVALID_RESPONSE", "Tailscale returned invalid identity metadata.");
  return value as Record<string, unknown>;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new TailscaleError("INVALID_RESPONSE", "Tailscale omitted required identity metadata.");
  return value;
}

function userId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  throw new TailscaleError("INVALID_RESPONSE", "Tailscale returned an invalid or unsafe numeric user identity.");
}

function strings(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new TailscaleError("INVALID_RESPONSE", "Tailscale returned invalid address or tag metadata.");
  return value as string[];
}

/** Takes a socket's bare IP address, never a hostname, URL, forwarded header, or IP:port. */
function normalizeAddress(value: string): string | undefined {
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6 || value.includes("%")) return undefined;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(normalized);
  if (!mapped) return normalized;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isExpired(record: Record<string, unknown>, now: number): boolean {
  if (record.Expired === true) return true;
  if (record.KeyExpiry === undefined || record.KeyExpiry === null || record.KeyExpiry === "0001-01-01T00:00:00Z") return false;
  if (typeof record.KeyExpiry !== "string" || !Number.isFinite(Date.parse(record.KeyExpiry))) {
    throw new TailscaleError("INVALID_RESPONSE", "Tailscale returned invalid identity expiry metadata.");
  }
  return Date.parse(record.KeyExpiry) <= now;
}

function node(value: unknown, now: number): TailscaleNode {
  const raw = object(value);
  const addresses = strings(raw.TailscaleIPs).map(address => normalizeAddress(address));
  if (addresses.some(address => !address)) throw new TailscaleError("INVALID_RESPONSE", "Tailscale returned an invalid node address.");
  return {
    nodeId: requiredText(raw.ID), userId: userId(raw.UserID),
    hostname: typeof raw.HostName === "string" ? raw.HostName : "",
    dnsName: typeof raw.DNSName === "string" ? raw.DNSName.replace(/\.$/, "") : "",
    os: typeof raw.OS === "string" ? raw.OS : "", addresses: addresses as string[],
    online: raw.Online === true, expired: isExpired(raw, now), tags: strings(raw.Tags),
  };
}

function discovery(value: unknown): TailscaleDiscovery {
  const raw = object(value);
  const now = Date.now();
  const self = raw.Self === null || raw.Self === undefined ? null : node(raw.Self, now);
  const peers = raw.Peer === null || raw.Peer === undefined ? [] : Object.values(object(raw.Peer)).map(value => node(value, now));
  const tailnet = raw.CurrentTailnet === null || raw.CurrentTailnet === undefined ? null : object(raw.CurrentTailnet);
  return {
    backendState: requiredText(raw.BackendState), self,
    peers: peers.map(peer => ({
      ...peer, sameUser: !!self && self.userId !== "0" && peer.userId === self.userId && !self.tags.length && !peer.tags.length,
      appAvailability: "unknown" as const,
    })).sort((a, b) => a.hostname.localeCompare(b.hostname) || a.nodeId.localeCompare(b.nodeId)),
    magicDnsSuffix: typeof tailnet?.MagicDNSSuffix === "string" ? tailnet.MagicDNSSuffix : null,
    checkedAt: now,
  };
}

export class TailscaleClient {
  private binary?: Promise<string>;
  private readonly timeoutMs: number;

  constructor(private readonly options: { binaryPath?: string; timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new Error("Tailscale timeout must be between 1 and 30000 milliseconds.");
    if (options.binaryPath && !isAbsolute(options.binaryPath)) throw new Error("Tailscale binary path must be absolute.");
  }

  private async findBinary(): Promise<string> {
    const candidates = this.options.binaryPath ? [this.options.binaryPath] : [
      Bun.which("tailscale"), "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/usr/bin/tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ];
    for (const candidate of new Set(candidates)) {
      if (!candidate) continue;
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch { /* Try the next known installation path. */ }
    }
    throw new TailscaleError("CLI_NOT_FOUND", "The existing Tailscale CLI was not found. Configure its executable path or install Tailscale.");
  }

  private async json(args: string[]): Promise<unknown> {
    this.binary ??= this.findBinary();
    let binary: string;
    try { binary = await this.binary; }
    catch (error) { this.binary = undefined; throw error; }
    let stdout: string;
    try {
      ({ stdout } = await execute(binary, args, { timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }));
    } catch {
      // Do not return raw CLI output: status/errors may contain login URLs or key material.
      throw new TailscaleError("CLI_FAILED", `Tailscale ${args[0]} failed or timed out. Check that Tailscale is running and accessible to this user.`);
    }
    try { return JSON.parse(stdout) as unknown; }
    catch { throw new TailscaleError("INVALID_RESPONSE", "Tailscale returned invalid JSON."); }
  }

  /** Read-only presence discovery; it performs no probing, pairing, or service configuration. */
  async discover(): Promise<TailscaleDiscovery> {
    return discovery(await this.json(["status", "--json"]));
  }

  /** Resolve an actual accepted socket IP via the local Tailscale daemon; fail closed on any mismatch. */
  async authorizePeer(remoteAddress: string, policy: TailscalePeerPolicy = {}): Promise<TailscaleAuthorization> {
    const denied = (code: Extract<TailscaleAuthorization, { authorized: false }>["code"], message: string): TailscaleAuthorization => ({ authorized: false, code, message });
    const address = normalizeAddress(remoteAddress);
    if (!address) return denied("INVALID_ADDRESS", "A direct socket IP address is required.");
    try {
      const state = await this.discover();
      const self = state.self;
      if (state.backendState !== "Running") return denied("TAILSCALE_UNAVAILABLE", "Tailscale is not running.");
      if (!self || !self.online || self.expired || self.userId === "0" || self.tags.length) {
        return denied("LOCAL_IDENTITY_UNAVAILABLE", "The local Tailscale node has no active user-owned identity.");
      }
      const matching = state.peers.filter(peer => peer.addresses.includes(address));
      if (matching.length !== 1) return denied("UNKNOWN_PEER", "The socket is not a unique direct Tailscale peer.");
      const peer = matching[0]!;
      if (!peer.online || peer.expired) return denied("PEER_UNAVAILABLE", "The Tailscale peer is offline or expired.");
      if (!peer.sameUser) return denied("WRONG_USER", "Only untagged devices owned by the same Tailscale user may attach.");
      if (policy.allowedNodeIds && !policy.allowedNodeIds.includes(peer.nodeId)) return denied("NOT_PAIRED", "This Tailscale node has not been paired with the host.");
      const identity = object(await this.json(["whois", "--json", address]));
      const remote = object(identity.Node);
      const profile = object(identity.UserProfile);
      const directAddresses = strings(remote.Addresses).flatMap(prefix => {
        const [ip, bits, extra] = prefix.split("/");
        if (!ip || extra !== undefined || bits !== (isIP(ip) === 4 ? "32" : "128")) return [];
        const normalized = normalizeAddress(ip);
        return normalized ? [normalized] : [];
      });
      if (remote.StableID !== peer.nodeId || userId(remote.User) !== self.userId || userId(profile.ID) !== self.userId
        || remote.Online !== true || strings(remote.Tags).length || isExpired(remote, Date.now()) || !directAddresses.includes(address)) {
        return denied("IDENTITY_MISMATCH", "Tailscale's socket identity does not match the online same-user peer.");
      }
      return { authorized: true, peer, checkedAt: Date.now() };
    } catch (error) {
      return denied("TAILSCALE_UNAVAILABLE", error instanceof TailscaleError ? error.message : "Tailscale identity verification failed.");
    }
  }
}
