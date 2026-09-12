import { WORKSPACE_OWNER_HEADER, parseTerminalCreationCapabilities, parseTerminalCreationRequest, parseTerminalCreationResponse,
  type TerminalCreationRequest, type TerminalCreationCapabilities, type TerminalCreationResponse } from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";

async function readJSON(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Terminal creation response is empty.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65536) throw new Error("Terminal creation response exceeds its bound.");
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
async function request(endpoint: HostEndpoint, operation: "creation-capabilities" | "create" | "creation-status", input?: TerminalCreationRequest): Promise<unknown> {
  if (typeof endpoint.hostId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(endpoint.hostId))
    throw new Error("Select the exact owning host for terminal creation.");
  const response = await fetch(`${endpoint.origin}/v2/terminals/${operation}`, {
    method: input ? "POST" : "GET", ...(input ? { body: JSON.stringify(input) } : {}), redirect: "error",
    signal: AbortSignal.timeout(operation === "create" ? 60000 : 20000),
    headers: { "Content-Type": "application/json", [WORKSPACE_OWNER_HEADER]: endpoint.hostId,
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) },
  });
  if (response.headers.get(WORKSPACE_OWNER_HEADER) !== endpoint.hostId) {
    await response.body?.cancel();
    throw new Error("Terminal creation response belongs to another host. Do not replay creation.");
  }
  const value = await readJSON(response);
  if (!response.ok) {
    const error = value && typeof value === "object" ? (value as { error?: unknown }).error : undefined;
    const detail = error && typeof error === "object" && !Array.isArray(error) ? error as Record<string, unknown> : {};
    const code = typeof detail.code === "string" && detail.code.length <= 128 ? detail.code : undefined;
    const message = typeof detail.message === "string" && detail.message.trim() && detail.message.length <= 4096 ? detail.message
      : `Terminal creation request failed (${response.status}); do not replay creation.`;
    throw new HostRequestError(message, response.status, code);
  }
  return value;
}

/** Capability absence is an update error, never permission to use /action. */
export async function requestTerminalCreationCapabilities(endpoint: HostEndpoint): Promise<TerminalCreationCapabilities> {
  return parseTerminalCreationCapabilities(await request(endpoint, "creation-capabilities"), endpoint.hostId);
}
/** Exactly one keyed POST. The caller must persist its intent before invoking. */
export async function requestTerminalCreate(endpoint: HostEndpoint, value: TerminalCreationRequest): Promise<TerminalCreationResponse> {
  const input = parseTerminalCreationRequest(value);
  const result = parseTerminalCreationResponse(await request(endpoint, "create", input), endpoint.hostId, input);
  if (result.status === "unavailable" || result.terminal !== undefined) throw new Error("Terminal creation acknowledgement is invalid. Inspect the request; do not replay creation.");
  return result;
}
/** Observation never invokes create, including unavailable or unknown results. */
export async function requestTerminalCreationStatus(endpoint: HostEndpoint, value: TerminalCreationRequest): Promise<TerminalCreationResponse> {
  const input = parseTerminalCreationRequest(value);
  return parseTerminalCreationResponse(await request(endpoint, "creation-status", input), endpoint.hostId, input);
}
