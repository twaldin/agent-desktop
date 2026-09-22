import { SESSION_ACTIVITY_OWNER_HEADER } from "../../../../packages/shared/src/session-activity";
import { assertSessionProcessesResultMatches, parseSessionProcessesEnvelope, parseSessionProcessesRequest, type SessionProcessesEnvelope, type SessionProcessesRequest } from "../../../../packages/shared/src/session-processes";
import { readBrowserJSON } from "./browser-frame-transport";
import { HostRequestError, type HostEndpoint } from "./host-transport";

/** Rows are small; inspect bodies are bounded per field on the host. */
const MAX_RESPONSE_BYTES = 512 * 1024;
const encoder = new TextEncoder();
function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || encoder.encode(value).byteLength > 200 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`Select the processes request's owning ${label}.`);
  return value;
}

/** One submission against the original host/session owner. Endpoint fields are
 * detached before the first await so connection-cache mutation cannot retarget
 * a read or a operation. A failed operation is never retried here. */
export async function requestSessionProcesses(endpoint: HostEndpoint, sessionValue: unknown, rawRequest: unknown): Promise<SessionProcessesEnvelope> {
  const captured = { origin: endpoint.origin, hostId: identity(endpoint.hostId, "host"), token: endpoint.token };
  const sessionId = identity(sessionValue, "conversation");
  const request: SessionProcessesRequest = parseSessionProcessesRequest(rawRequest);
  const isMutation = request.action === "stop" || request.action === "restart" || request.action === "input";
  if (request.action !== "receipt" && request.owner && request.owner.nativeSessionId !== sessionId) throw new Error("The processes owner belongs to another conversation.");
  if (typeof captured.origin !== "string" || !captured.origin || /[\u0000-\u001f\u007f]/.test(captured.origin))
    throw new Error("The processes request host endpoint is invalid.");
  const response = await fetch(`${captured.origin}/v1/sessions/${encodeURIComponent(sessionId)}/processes`, {
    method: "POST", body: JSON.stringify(request), redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json", [SESSION_ACTIVITY_OWNER_HEADER]: captured.hostId,
      ...(captured.token ? { Authorization: `Bearer ${captured.token}` } : {}) },
  });
  if (response.headers.get(SESSION_ACTIVITY_OWNER_HEADER) !== captured.hostId) {
    await response.body?.cancel();
    throw new HostRequestError(isMutation ? "The processes response belongs to another host; the operation outcome is unknown." : "The processes state belongs to another host.", 409, "OWNER_MISMATCH");
  }
  let value: unknown;
  try { value = await readBrowserJSON(response, MAX_RESPONSE_BYTES); }
  catch { throw new Error(isMutation ? "Invalid or oversized native processes response; the operation outcome is unknown." : "Invalid or oversized native processes response."); }
  if (!response.ok) {
    const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const detail = object.error && typeof object.error === "object" && !Array.isArray(object.error) ? object.error as Record<string, unknown> : {};
    const message = typeof detail.message === "string" && detail.message.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(detail.message)
      ? detail.message : `Native processes request failed (${response.status}).`;
    const code = typeof detail.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(detail.code) ? detail.code : undefined;
    throw new HostRequestError(message, response.status, code);
  }
  const envelope = parseSessionProcessesEnvelope(value, captured.hostId, sessionId);
  assertSessionProcessesResultMatches(request, envelope.result);
  return envelope;
}
