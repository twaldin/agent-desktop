import { SESSION_MCP_OWNER_HEADER, parseNativeSessionMcpResourceRequest, parseNativeSessionMcpResourceResult, type NativeSessionMcpResourceRequest, type NativeSessionMcpResourceResult } from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";
import { readSessionMcpResponse } from "./session-mcp-transport";

export async function requestSessionMcpResource(endpoint: HostEndpoint, sessionId: string, input: NativeSessionMcpResourceRequest): Promise<NativeSessionMcpResourceResult> {
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error("Select the MCP owning session.");
  const request = parseNativeSessionMcpResourceRequest(input);
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/mcp/resource`, {
    method: "POST", headers: { "Content-Type": "application/json", [SESSION_MCP_OWNER_HEADER]: endpoint.hostId,
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) },
    body: JSON.stringify(request), signal: AbortSignal.timeout(40_000), redirect: "error",
  });
  const body = await readSessionMcpResponse(response, endpoint.hostId);
  if (!body || typeof body !== "object" || !("protocolVersion" in body) || body.protocolVersion !== 1
    || !("hostId" in body) || body.hostId !== endpoint.hostId || !("sessionId" in body) || body.sessionId !== sessionId || !("value" in body))
    throw new HostRequestError("The resource response belongs to another session or protocol.", 409, "OWNER_MISMATCH");
  return parseNativeSessionMcpResourceResult(body.value);
}
