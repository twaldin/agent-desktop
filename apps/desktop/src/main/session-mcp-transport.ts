import { SESSION_MCP_OWNER_HEADER, parseNativeSessionMcpResponse, type NativeSessionMcpResponse } from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";

export async function requestSessionMcp(endpoint: HostEndpoint, sessionId: string, commandId?: string): Promise<NativeSessionMcpResponse> {
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error("Select the MCP owning session.");
  if (commandId !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(commandId)) throw new Error("Invalid MCP command identity.");
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/mcp${commandId ? `?commandId=${encodeURIComponent(commandId)}` : ""}`, { headers: {
    [SESSION_MCP_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
  }, signal: AbortSignal.timeout(20_000), redirect: "error" });
  const value = await readSessionMcpResponse(response, endpoint.hostId);
  return parseNativeSessionMcpResponse(value, endpoint.hostId, sessionId, commandId);
}

export async function readSessionMcpResponse(response: Response, hostId: string): Promise<unknown> {
  if (response.headers.get(SESSION_MCP_OWNER_HEADER) !== hostId) { await response.body?.cancel(); throw new HostRequestError("The MCP response belongs to another host.", 409, "OWNER_MISMATCH"); }
  let value: unknown;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing MCP response.");
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      // Bound metadata before decoding untrusted host JSON.
      if (size > 8 * 1024 * 1024) throw new Error("MCP response exceeds 8 MiB.");
      chunks.push(part.value);
    }
    value = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch { await reader.cancel().catch(() => {}); throw new Error("Invalid or oversized MCP response."); }
  finally { reader.releaseLock(); }
  if (!response.ok) {
    const detail = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {};
    throw new HostRequestError(typeof detail.message === "string" ? detail.message : `MCP state failed (${response.status}).`, response.status, typeof detail.code === "string" ? detail.code : undefined);
  }
  return value;
}
