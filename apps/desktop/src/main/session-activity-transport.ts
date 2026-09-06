import { parseGoalControlTicket, parseNativeGoalActivity, SESSION_ACTIVITY_OWNER_HEADER, SESSION_ACTIVITY_PROTOCOL_VERSION, type SessionActivitySnapshot } from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";

export async function requestSessionActivity(endpoint: HostEndpoint, sessionId: string): Promise<SessionActivitySnapshot | null> {
  if (!endpoint.hostId) throw new Error("Select the owning host before reading session activity.");
  if (!sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error("Invalid session identity.");
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/activity`, { headers: {
    [SESSION_ACTIVITY_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
  }, signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (response.ok && response.headers.get(SESSION_ACTIVITY_OWNER_HEADER) !== endpoint.hostId) { await response.body?.cancel(); throw new HostRequestError("Session activity belongs to a different host.", 409, "OWNER_MISMATCH"); }
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error("Invalid session activity response."); }
  if (!response.ok) {
    const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const detail = object.error && typeof object.error === "object" ? object.error as Record<string, unknown> : {};
    const code = typeof detail.code === "string" ? detail.code : undefined;
    if (response.status === 404 && !code) return null;
    throw new HostRequestError(typeof detail.message === "string" ? detail.message : `Session activity failed (${response.status}).`, response.status, code);
  }
  const result = value as Partial<SessionActivitySnapshot>;
  if (result.protocolVersion !== SESSION_ACTIVITY_PROTOCOL_VERSION || result.hostId !== endpoint.hostId || result.sessionId !== sessionId) throw new Error("Session activity does not match the selected owner or protocol.");
  if (!result.goal || typeof result.goal !== "object") throw new Error("Session activity has an invalid goal capability.");
  const goalCapability = result.goal as Record<string, unknown>;
  if (goalCapability.availability === "available") {
    if (goalCapability.value !== null && goalCapability.value !== undefined) goalCapability.value = parseNativeGoalActivity(goalCapability.value);
    else if (goalCapability.value === undefined) throw new Error("Session activity has an invalid available goal.");
  } else if ((goalCapability.availability !== "unavailable" && goalCapability.availability !== "unsupported")
    || typeof goalCapability.reason !== "string" || !goalCapability.reason.trim() || goalCapability.reason.length > 4_096) {
    throw new Error("Session activity has an invalid goal capability.");
  }
  if (result.goalControlTicket !== undefined) result.goalControlTicket = parseGoalControlTicket(result.goalControlTicket);
  return result as SessionActivitySnapshot;
}
