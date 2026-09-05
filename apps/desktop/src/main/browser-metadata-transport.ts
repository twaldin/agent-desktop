import { BROWSER_METADATA_OWNER_HEADER, BROWSER_METADATA_PROTOCOL_VERSION, type BrowserMetadataSnapshot, type NativeBrowserTabMetadata } from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";

const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 && value.length <= limit;
const number = (value: unknown, minimum: number, maximum: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;

function tab(value: unknown): NativeBrowserTabMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>, viewport = source.viewport;
  if (!text(source.name, 200) || !text(source.targetId, 200) || !text(source.url, 8_192)
    || (source.backend !== "worker" && source.backend !== "cmux")
    || !["headless", "spawned", "connected", "relay", "cmux"].includes(String(source.kindTag))
    || (source.state !== "alive" && source.state !== "dead")
    || (source.title !== undefined && (typeof source.title !== "string" || source.title.length > 1_024))
    || !viewport || typeof viewport !== "object") return undefined;
  const size = viewport as Record<string, unknown>;
  if (!number(size.width, 1, 100_000) || !number(size.height, 1, 100_000)
    || (size.deviceScaleFactor !== undefined && !number(size.deviceScaleFactor, Number.MIN_VALUE, 100))) return undefined;
  return { name: source.name, targetId: source.targetId, backend: source.backend, kindTag: source.kindTag as NativeBrowserTabMetadata["kindTag"], state: source.state,
    url: source.url, ...(source.title === undefined ? {} : { title: source.title }), viewport: { width: size.width as number, height: size.height as number, ...(size.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: size.deviceScaleFactor as number }) } };
}

function snapshot(value: unknown, hostId: string, sessionId: string): BrowserMetadataSnapshot {
  if (!value || typeof value !== "object") throw new Error("Invalid browser metadata response.");
  const source = value as Record<string, unknown>;
  if (source.protocolVersion !== BROWSER_METADATA_PROTOCOL_VERSION || source.hostId !== hostId || source.sessionId !== sessionId) throw new Error("Browser metadata does not match the selected owner or protocol.");
  if (source.availability === "not-started") {
    if (!text(source.reason, 4_096)) throw new Error("Browser metadata has an invalid availability reason.");
    return { protocolVersion: BROWSER_METADATA_PROTOCOL_VERSION, hostId, sessionId, availability: "not-started", reason: source.reason };
  }
  if (source.availability === "unavailable") {
    if (!text(source.reason, 4_096)) throw new Error("Browser metadata has an invalid availability reason.");
    return { protocolVersion: BROWSER_METADATA_PROTOCOL_VERSION, hostId, sessionId, availability: "unavailable", reason: source.reason };
  }
  if (source.availability !== "running" || !Number.isSafeInteger(source.workerPid) || !number(source.workerPid, 1, Number.MAX_SAFE_INTEGER) || !Array.isArray(source.tabs) || source.tabs.length > 1_000) throw new Error("Browser metadata has invalid running fields.");
  const tabs = source.tabs.map(tab);
  if (tabs.some(value => value === undefined) || new Set(tabs.map(value => value!.name)).size !== tabs.length) throw new Error("Browser metadata has invalid tab fields.");
  return { protocolVersion: BROWSER_METADATA_PROTOCOL_VERSION, hostId, sessionId, availability: "running", workerPid: source.workerPid, tabs: tabs as NativeBrowserTabMetadata[] };
}

export async function requestBrowserMetadata(endpoint: HostEndpoint, sessionId: string): Promise<BrowserMetadataSnapshot | null> {
  if (!endpoint.hostId) throw new Error("Select the owning host before reading browser metadata.");
  if (!sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error("Invalid session identity.");
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/browser-metadata`, { headers: { [BROWSER_METADATA_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) }, signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (response.ok && response.headers.get(BROWSER_METADATA_OWNER_HEADER) !== endpoint.hostId) { await response.body?.cancel(); throw new HostRequestError("Browser metadata belongs to a different host.", 409, "OWNER_MISMATCH"); }
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error("Invalid browser metadata response."); }
  if (!response.ok) {
    const object = value && typeof value === "object" ? value as Record<string, unknown> : {}, detail = object.error && typeof object.error === "object" ? object.error as Record<string, unknown> : {};
    const code = typeof detail.code === "string" ? detail.code : undefined;
    if (response.status === 404 && !code) return null;
    throw new HostRequestError(typeof detail.message === "string" ? detail.message : `Browser metadata failed (${response.status}).`, response.status, code);
  }
  return snapshot(value, endpoint.hostId, sessionId);
}
