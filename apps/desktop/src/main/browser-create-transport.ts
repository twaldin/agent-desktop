import {
  BROWSER_CREATE_PROTOCOL_VERSION,
  BROWSER_METADATA_OWNER_HEADER,
  parseBrowserCreateRequest,
  parseNativeBrowserTabMetadata,
  type BrowserCreateReceipt,
  type BrowserCreateRequest,
} from "@agent-desktop/shared";
import type { HostEndpoint } from "./host-transport";
import { readBrowserJSON } from "./browser-frame-transport";

/** Submit exactly once. Network or identity failure after submission is unknown;
 * callers must refresh metadata and must not automatically retry creation. */
export async function requestBrowserCreate(
  endpoint: HostEndpoint,
  sessionId: string,
  request: BrowserCreateRequest,
): Promise<BrowserCreateReceipt> {
  const input = parseBrowserCreateRequest(request);
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || sessionId.includes("\0")) {
    throw new Error("Select the browser owning session.");
  }
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/browser-create`, {
    method: "POST",
    body: JSON.stringify(input),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: {
      "Content-Type": "application/json",
      [BROWSER_METADATA_OWNER_HEADER]: endpoint.hostId,
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
    },
  });
  if (response.headers.get(BROWSER_METADATA_OWNER_HEADER) !== endpoint.hostId) {
    await response.body?.cancel();
    throw new Error("Browser creation response belongs to another host; its outcome is unknown.");
  }
  const value = await readBrowserJSON(response, 32_768) as Record<string, unknown>;
  if (!response.ok) {
    const detail = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object"
      ? value.error as Record<string, unknown> : undefined;
    const definitePreAdmission = detail
      && typeof detail.message === "string" && !!detail.message.trim() && detail.message.length <= 4_096
      && ((detail.code === "INVALID_BROWSER_CREATE_REQUEST" && (response.status === 400 || response.status === 405))
        || (detail.code === "OWNER_MISMATCH" && response.status === 409));
    if (definitePreAdmission) {
      return { protocolVersion: BROWSER_CREATE_PROTOCOL_VERSION, hostId: endpoint.hostId, sessionId,
        requestId: input.requestId, outcome: "rejected", message: detail.message as string };
    }
    throw new Error(`Browser creation could not be confirmed (${response.status}); its outcome is unknown.`);
  }
  if (!value || value.protocolVersion !== BROWSER_CREATE_PROTOCOL_VERSION || value.hostId !== endpoint.hostId
    || value.sessionId !== sessionId || value.requestId !== input.requestId
    || !["completed", "rejected", "unknown"].includes(typeof value.outcome === "string" ? value.outcome : "")) {
    throw new Error("Browser creation receipt is invalid; its outcome is unknown.");
  }
  if (value.outcome === "rejected" || value.outcome === "unknown") {
    if (typeof value.message !== "string" || !value.message || value.message.length > 4_096
      || (value.workerPid !== undefined && (typeof value.workerPid !== "number" || !Number.isSafeInteger(value.workerPid) || value.workerPid <= 0))) {
      throw new Error("Browser creation receipt is invalid; its outcome is unknown.");
    }
    return { protocolVersion: BROWSER_CREATE_PROTOCOL_VERSION, hostId: endpoint.hostId, sessionId,
      requestId: input.requestId, outcome: value.outcome, message: value.message,
      ...(value.workerPid === undefined ? {} : { workerPid: value.workerPid as number }) };
  }
  if (typeof value.workerPid !== "number" || !Number.isSafeInteger(value.workerPid) || value.workerPid <= 0
    || !["created-page", "created-surface", "adopted-existing-target"].includes(typeof value.targetDisposition === "string" ? value.targetDisposition : "")) {
    throw new Error("Browser creation receipt is invalid; its outcome is unknown.");
  }
  const tab = parseNativeBrowserTabMetadata(value.tab);
  if (tab.name !== `desktop-${input.requestId}` || tab.state !== "alive") {
    throw new Error("Browser creation target identity is invalid; its outcome is unknown.");
  }
  const expected = tab.kindTag === "headless" ? "created-page" : tab.kindTag === "cmux" ? "created-surface" : "adopted-existing-target";
  if (value.targetDisposition !== expected) throw new Error("Browser creation disposition is invalid; its outcome is unknown.");
  return { protocolVersion: BROWSER_CREATE_PROTOCOL_VERSION, hostId: endpoint.hostId, sessionId,
    requestId: input.requestId, outcome: "completed", workerPid: value.workerPid, tab, targetDisposition: expected };
}
