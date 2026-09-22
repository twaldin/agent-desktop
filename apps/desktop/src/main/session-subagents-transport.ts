import { SESSION_ACTIVITY_OWNER_HEADER } from "../../../../packages/shared/src/session-activity";
import { assertSessionSubagentsResultMatches, parseSessionSubagentsEnvelope, parseSessionSubagentsRequest, SESSION_SUBAGENTS_MAX_RESPONSE_BYTES, type SessionSubagentsEnvelope } from "../../../../packages/shared/src/session-subagents";
import { readBrowserJSON } from "./browser-frame-transport";
import { HostRequestError, type HostEndpoint } from "./host-transport";

const encoder = new TextEncoder();

function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || encoder.encode(value).byteLength > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Select the original Subagents ${label}.`);
  return value;
}
/** Capture connection fields before awaits; no implicit active-host fallback or retry. */
export async function requestSessionSubagents(endpoint: HostEndpoint, sessionValue: unknown, rawRequest: unknown): Promise<SessionSubagentsEnvelope> {
  const captured = { origin: endpoint.origin, hostId: identity(endpoint.hostId, "host"), token: endpoint.token };
  const sessionId = identity(sessionValue, "conversation"), request = parseSessionSubagentsRequest(rawRequest);
  if (request.owner && request.owner.nativeSessionId !== sessionId) throw new Error("The Subagents owner belongs to another conversation.");
  if (typeof captured.origin !== "string" || !captured.origin || /[\u0000-\u001f\u007f]/.test(captured.origin)) throw new Error("The original host endpoint is invalid.");
  const response = await fetch(`${captured.origin}/v1/sessions/${encodeURIComponent(sessionId)}/subagents`, {
    method: "POST", body: JSON.stringify(request), redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json", [SESSION_ACTIVITY_OWNER_HEADER]: captured.hostId, ...(captured.token ? { Authorization: `Bearer ${captured.token}` } : {}) },
  });
  if (response.headers.get(SESSION_ACTIVITY_OWNER_HEADER) !== captured.hostId) {
    await response.body?.cancel();
    throw new HostRequestError("The Subagents response belongs to another host.", 409, "OWNER_MISMATCH");
  }
  let value: unknown;
  try { value = await readBrowserJSON(response, SESSION_SUBAGENTS_MAX_RESPONSE_BYTES); }
  catch { throw new Error("Invalid or oversized Subagents response."); }
  if (!response.ok) {
    const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const detail = object.error && typeof object.error === "object" && !Array.isArray(object.error) ? object.error as Record<string, unknown> : {};
    const message = typeof detail.message === "string" && detail.message.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(detail.message) ? detail.message : `Subagents read failed (${response.status}).`;
    const code = typeof detail.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(detail.code) ? detail.code : undefined;
    // Electron preserves Error.message, not custom fields, across invoke.
    throw new HostRequestError(code === "STALE_OWNER" ? `[STALE_OWNER] ${message}` : message, response.status, code);
  }
  const envelope = parseSessionSubagentsEnvelope(value, captured.hostId, sessionId);
  assertSessionSubagentsResultMatches(request, envelope.result);
  return envelope;
}
