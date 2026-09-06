import { BROWSER_METADATA_OWNER_HEADER, BROWSER_METADATA_PROTOCOL_VERSION, parseBrowserCreationTicket, parseNativeBrowserTabMetadata, type BrowserCreationTicket, type BrowserMetadataSnapshot, type NativeBrowserTabMetadata } from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";

const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 && value.length <= limit;
const number = (value: unknown, minimum: number, maximum: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;

function snapshot(value: unknown, hostId: string, sessionId: string): BrowserMetadataSnapshot {
  if (!value || typeof value !== "object") throw new Error("Invalid browser metadata response.");
  const source = value as Record<string, unknown>;
  let creationTicket: BrowserCreationTicket | undefined;
  if (source.creationTicket !== undefined) creationTicket = parseBrowserCreationTicket(source.creationTicket);
  const ticket = creationTicket ? { creationTicket } : {};
  if (source.protocolVersion !== BROWSER_METADATA_PROTOCOL_VERSION || source.hostId !== hostId || source.sessionId !== sessionId) throw new Error("Browser metadata does not match the selected owner or protocol.");
  if (source.availability === "not-started") {
    if (!text(source.reason, 4_096)) throw new Error("Browser metadata has an invalid availability reason.");
    return { protocolVersion: BROWSER_METADATA_PROTOCOL_VERSION, hostId, sessionId, availability: "not-started", reason: source.reason, ...ticket };
  }
  if (source.availability === "unavailable") {
    if (!text(source.reason, 4_096)) throw new Error("Browser metadata has an invalid availability reason.");
    return { protocolVersion: BROWSER_METADATA_PROTOCOL_VERSION, hostId, sessionId, availability: "unavailable", reason: source.reason, ...ticket };
  }
  if (source.availability !== "running" || !Number.isSafeInteger(source.workerPid) || !number(source.workerPid, 1, Number.MAX_SAFE_INTEGER) || !Array.isArray(source.tabs) || source.tabs.length > 1_000) throw new Error("Browser metadata has invalid running fields.");
  const tabs = source.tabs.map(value => { try { return parseNativeBrowserTabMetadata(value); } catch { return undefined; } });
  if (tabs.some(value => value === undefined) || new Set(tabs.map(value => value!.name)).size !== tabs.length) throw new Error("Browser metadata has invalid tab fields.");
  return { protocolVersion: BROWSER_METADATA_PROTOCOL_VERSION, hostId, sessionId, availability: "running", workerPid: source.workerPid, tabs: tabs as NativeBrowserTabMetadata[], ...ticket };
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
