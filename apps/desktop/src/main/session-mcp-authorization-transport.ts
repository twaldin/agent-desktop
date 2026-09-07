import {
  SESSION_MCP_OWNER_HEADER,
  parseNativeMcpAuthorizationId,
  parseNativeMcpAuthorizationReply,
  parseNativeMcpAuthorizationResponse,
  type NativeMcpAuthorizationReply,
  type NativeMcpAuthorizationResponse,
} from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";
import { readSessionMcpResponse } from "./session-mcp-transport";

function target(endpoint: HostEndpoint, sessionId: string): void {
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || /[\0-\x1f\x7f]/.test(sessionId)) throw new Error("Select the MCP authorization owning session.");
}

function headers(endpoint: HostEndpoint): Record<string, string> {
  return {
    "Content-Type": "application/json",
    [SESSION_MCP_OWNER_HEADER]: endpoint.hostId,
    ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
  };
}

export async function requestSessionMcpAuthorization(endpoint: HostEndpoint, sessionId: string, commandId?: string): Promise<NativeMcpAuthorizationResponse> {
  target(endpoint, sessionId);
  if (commandId !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(commandId)) throw new Error("Invalid MCP authorization command identity.");
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/mcp/authorization${commandId ? `?commandId=${encodeURIComponent(commandId)}` : ""}`, {
    headers: headers(endpoint), signal: AbortSignal.timeout(20_000), redirect: "error",
  });
  return parseNativeMcpAuthorizationResponse(await readSessionMcpResponse(response, endpoint.hostId), endpoint.hostId, sessionId, commandId);
}

async function mutate(endpoint: HostEndpoint, sessionId: string, action: "respond" | "cancel", body: NativeMcpAuthorizationReply | { authorizationId: string }): Promise<NativeMcpAuthorizationResponse> {
  target(endpoint, sessionId);
  const authorizationId = parseNativeMcpAuthorizationId(body.authorizationId);
  let response: Response;
  try {
    response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/mcp/authorization/${action}`, {
      method: "POST", headers: headers(endpoint), body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: "error",
    });
  } catch {
    throw new HostRequestError("The authorization response outcome is unknown. Inspect its current state before trying again.", 503, "OUTCOME_UNKNOWN");
  }
  if (!response.ok) {
    // Only a correctly owned, structured host rejection is definitive after
    // dispatch. An unowned or malformed error cannot prove what took effect.
    if (response.headers.get(SESSION_MCP_OWNER_HEADER) === endpoint.hostId) {
      try { await readSessionMcpResponse(response, endpoint.hostId); }
      catch (error) { if (error instanceof HostRequestError && error.code) throw error; }
    } else await response.body?.cancel().catch(() => undefined);
    throw new HostRequestError("The authorization response outcome is unknown. Inspect its current state before trying again.", 503, "OUTCOME_UNKNOWN");
  }
  try {
    const parsed = parseNativeMcpAuthorizationResponse(await readSessionMcpResponse(response, endpoint.hostId), endpoint.hostId, sessionId);
    if (!parsed.value || parsed.value.authorizationId !== authorizationId) throw new Error("Authorization identity changed after dispatch.");
    return parsed;
  } catch (error) {
    throw new HostRequestError("The authorization response outcome is unknown. Inspect its current state before trying again.", 503, "OUTCOME_UNKNOWN");
  }
}

export function respondSessionMcpAuthorization(endpoint: HostEndpoint, sessionId: string, reply: NativeMcpAuthorizationReply): Promise<NativeMcpAuthorizationResponse> {
  return mutate(endpoint, sessionId, "respond", parseNativeMcpAuthorizationReply(reply));
}

export function cancelSessionMcpAuthorization(endpoint: HostEndpoint, sessionId: string, authorizationId: string): Promise<NativeMcpAuthorizationResponse> {
  return mutate(endpoint, sessionId, "cancel", { authorizationId: parseNativeMcpAuthorizationId(authorizationId) });
}
