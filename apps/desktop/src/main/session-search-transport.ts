import { parseSessionSearchRequest, parseSessionSearchResult, SESSION_SEARCH_OWNER_HEADER, type SessionSearchRequest, type SessionSearchResult } from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";

export async function requestSessionSearch(endpoint: HostEndpoint, input: SessionSearchRequest, signal?: AbortSignal): Promise<SessionSearchResult> {
  if (!endpoint.hostId) throw new Error("Choose the chat search owning host.");
  const request = parseSessionSearchRequest(input);
  const params = new URLSearchParams({ query: request.query, content: String(request.includeContent), limit: String(request.limit) });
  const response = await fetch(`${endpoint.origin}/v1/sessions/search?${params}`, { headers: {
    [SESSION_SEARCH_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
  }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), redirect: "error" });
  const responseOwner = response.headers.get(SESSION_SEARCH_OWNER_HEADER);
  // Old hosts/auth middleware may omit this header on errors. An explicit
  // foreign owner is never accepted or parsed, including on error responses.
  if ((response.ok && responseOwner !== endpoint.hostId) || (responseOwner !== null && responseOwner !== endpoint.hostId)) {
    await response.body?.cancel(); throw new HostRequestError("Chat search belongs to a different host.", 409, "OWNER_MISMATCH");
  }
  let value: unknown;
  try { value = await readSearchJSON(response); } catch { throw new Error("Invalid or oversized chat search response."); }
  if (!response.ok) {
    const outer = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const error = outer.error && typeof outer.error === "object" ? outer.error as Record<string, unknown> : {};
    const code = typeof error.code === "string" ? error.code : undefined;
    if (response.status === 404 && !code) throw new HostRequestError("Update this host to search its stored chats.", 404, "SESSION_SEARCH_UNSUPPORTED");
    throw new HostRequestError(typeof error.message === "string" ? error.message : `Chat search failed (${response.status}).`, response.status, code);
  }
  return parseSessionSearchResult(value, endpoint.hostId, request);
}

async function readSearchJSON(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing chat search body.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) { await reader.cancel(); throw new Error("Chat search body exceeds its limit."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}
