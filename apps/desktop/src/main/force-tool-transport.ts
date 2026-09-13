import { parseForceToolResponse, SESSION_FORCE_TOOL_OWNER_HEADER, type ForceToolResponse } from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";

export async function requestForceToolState(endpoint: HostEndpoint, sessionId: string,
  commandId?: string): Promise<ForceToolResponse> {
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error("Select the force request's owning conversation.");
  if (commandId !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(commandId)) throw new Error("Invalid force command identity.");
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/force-tool${commandId ? `?commandId=${encodeURIComponent(commandId)}` : ""}`, {
    headers: { [SESSION_FORCE_TOOL_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) },
    signal: AbortSignal.timeout(20_000), redirect: "error",
  });
  if (response.headers.get(SESSION_FORCE_TOOL_OWNER_HEADER) !== endpoint.hostId) {
    await response.body?.cancel(); throw new HostRequestError("The force state belongs to another host.", 409, "OWNER_MISMATCH");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing native force state response.");
  let value: unknown;
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("Native force state exceeds 8 MiB.");
      chunks.push(part.value);
    }
    value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw new Error("Invalid or oversized native force state response.", { cause: error });
  } finally { reader.releaseLock(); }
  if (!response.ok) {
    const detail = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {};
    throw new HostRequestError(typeof detail.message === "string" ? detail.message : `Native force state failed (${response.status}).`, response.status,
      typeof detail.code === "string" ? detail.code : undefined);
  }
  return parseForceToolResponse(value, endpoint.hostId, sessionId, commandId);
}
