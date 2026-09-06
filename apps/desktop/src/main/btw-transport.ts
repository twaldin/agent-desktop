import { BTW_OWNER_HEADER, parseNativeBtwResponse, type NativeBtwResponse } from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";

export async function requestBtw(endpoint: HostEndpoint, sessionId: string): Promise<NativeBtwResponse> {
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error("Select the btw owning session.");
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/btw`, { headers: {
    [BTW_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
  }, signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (response.headers.get(BTW_OWNER_HEADER) !== endpoint.hostId) { await response.body?.cancel(); throw new HostRequestError("The btw response belongs to another host.", 409, "OWNER_MISMATCH"); }
  let value: unknown;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing side-chat response.");
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      // A valid 1 MiB answer can expand sixfold when JSON escapes controls.
      if (size > 8 * 1024 * 1024) throw new Error("Side-chat response exceeds 8 MiB.");
      chunks.push(part.value);
    }
    value = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch { await reader.cancel().catch(() => {}); throw new Error("Invalid or oversized side-chat response."); }
  finally { reader.releaseLock(); }
  if (!response.ok) {
    const detail = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {};
    throw new HostRequestError(typeof detail.message === "string" ? detail.message : `btw state failed (${response.status}).`, response.status, typeof detail.code === "string" ? detail.code : undefined);
  }
  return parseNativeBtwResponse(value, { hostId: endpoint.hostId, sessionId });
}
