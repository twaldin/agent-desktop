import { parseMcpOwnerRequest, parseMcpOwnerResult, SESSION_MCP_OWNER_HEADER, type McpOwnerRequest, type McpOwnerResult } from "@agent-desktop/shared";
import type { HostEndpoint } from "./host-transport";
import { readSessionMcpResponse } from "./session-mcp-transport";
export async function requestMcpOwner(endpoint: HostEndpoint, input: McpOwnerRequest): Promise<McpOwnerResult> {
  const request = parseMcpOwnerRequest(input);
  const response = await fetch(`${endpoint.origin}/v1/mcp-owners`, {
    method: "POST", headers: { "Content-Type": "application/json", [SESSION_MCP_OWNER_HEADER]: endpoint.hostId,
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) }, body: JSON.stringify(request),
    signal: AbortSignal.timeout(60_000), redirect: "error",
  });
  const body = await readSessionMcpResponse(response, endpoint.hostId);
  if (!body || typeof body !== "object" || !("protocolVersion" in body) || body.protocolVersion !== 1 || !("hostId" in body) || body.hostId !== endpoint.hostId || !("ownerId" in body) || body.ownerId !== request.ownerId || !("value" in body)) throw new Error("The MCP owner response belongs to another host or request.");
  return parseMcpOwnerResult(body.value, request);
}
