import {
  SESSION_MCP_OWNER_HEADER, parseNativeMcpAuthorizationId, parseNativeMcpAuthorizationReply,
  parseNativeMcpAuthorizationSnapshot,
  type NativeMcpAuthorizationReply, type NativeMcpAuthorizationResponse, type NativeMcpAuthorizationSnapshot,
} from "@agent-desktop/shared";

async function privateBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing authorization response.");
  const chunks: Uint8Array[] = [];
  let bytes = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 5000);
  try {
    for (;;) {
      const part = await reader.read();
      if (expired) throw new Error("Authorization response timed out.");
      if (part.done) break;
      bytes += part.value.byteLength;
      // Native callback values permit 1 Mi characters, including UTF-8 input.
      if (bytes > 4 * 1024 * 1024 + 4096) throw new Error("Authorization response is too large.");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Runs behind host authentication. Reads never load workers; answers bypass
 * the durable command journal entirely and are never logged or echoed. */
export class SessionMcpAuthorizationHttp {
  constructor(private readonly options: {
    hostId: string;
    sessionExists(id: string): boolean;
    receipt(sessionId: string, commandId: string): NonNullable<NativeMcpAuthorizationResponse["receipt"]>;
    existing(id: string): Promise<{
      getSessionMcpAuthorization(): Promise<NativeMcpAuthorizationSnapshot | null>;
      respondSessionMcpAuthorization(request: NativeMcpAuthorizationReply): Promise<NativeMcpAuthorizationSnapshot>;
      cancelSessionMcpAuthorization(authorizationId: string): Promise<NativeMcpAuthorizationSnapshot>;
    } | undefined>;
  }) {}

  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/mcp\/authorization(?:\/(respond|cancel))?$/.exec(url.pathname);
    if (!match) return;
    const headers = { "Cache-Control": "no-store", [SESSION_MCP_OWNER_HEADER]: this.options.hostId };
    const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(SESSION_MCP_OWNER_HEADER) !== this.options.hostId) return fail(409, "OWNER_MISMATCH", "The authorization endpoint belongs to another host.");
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || sessionId.length > 200 || /[\0-\x1f\x7f]/.test(sessionId) || !this.options.sessionExists(sessionId)) throw new Error();
    } catch { return fail(409, "STALE_TARGET", "The selected session no longer exists on this host."); }
    const response = (value: NativeMcpAuthorizationSnapshot | null, extra: Partial<NativeMcpAuthorizationResponse> = {}) => Response.json({
      ...extra, protocolVersion: 1, hostId: this.options.hostId, sessionId,
      value: value === null ? null : parseNativeMcpAuthorizationSnapshot(value),
    } satisfies NativeMcpAuthorizationResponse, { headers });

    if (!match[2]) {
      if (request.method !== "GET") return fail(405, "INVALID_MCP_REQUEST", "Use GET to inspect the existing authorization.");
      const commandId = url.searchParams.get("commandId");
      if (commandId !== null && !/^[a-zA-Z0-9_-]{1,200}$/.test(commandId)) return fail(400, "INVALID_MCP_REQUEST", "Invalid authorization receipt identity.");
      const receipt = commandId ? this.options.receipt(sessionId, commandId) : undefined;
      try {
        const handle = await this.options.existing(sessionId);
        return response(handle ? await handle.getSessionMcpAuthorization() : null, {
          ...(receipt ? { receipt } : {}), ...(!handle ? { unavailable: "This session has no loaded native runtime. No authorization was started." } : {}),
        });
      } catch {
        // Preserve the durable start receipt even if its worker has retired.
        return response(null, { ...(receipt ? { receipt } : {}), unavailable: "The native authorization state is unavailable. Inspect the original attempt before starting another." });
      }
    }
    if (request.method !== "POST") return fail(405, "INVALID_MCP_REQUEST", "Use POST for an explicit authorization response or cancellation.");
    let answer: NativeMcpAuthorizationReply | undefined, authorizationId: string | undefined;
    try {
      const body = await privateBody(request);
      if (match[2] === "respond") answer = parseNativeMcpAuthorizationReply(body);
      else {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "authorizationId")) throw new Error();
        authorizationId = parseNativeMcpAuthorizationId((body as Record<string, unknown>).authorizationId);
      }
    } catch { return fail(400, "INVALID_MCP_REQUEST", "Invalid authorization response."); }
    try {
      const handle = await this.options.existing(sessionId);
      if (!handle) return fail(409, "MCP_NOT_LOADED", "The original authorization worker is not loaded. No response was replayed.");
      let value: NativeMcpAuthorizationSnapshot;
      try {
        value = answer ? await handle.respondSessionMcpAuthorization(answer) : await handle.cancelSessionMcpAuthorization(authorizationId!);
      } catch (error) {
        const unknown = error instanceof Error && "code" in error && error.code === "OUTCOME_UNKNOWN";
        return fail(unknown ? 503 : 409, unknown ? "OUTCOME_UNKNOWN" : "MCP_RESPONSE_REJECTED",
          unknown ? "The response may have reached the native login. Inspect its current state before answering again."
            : "The authorization or prompt is no longer pending. Inspect its current state before answering again.");
      }
      try { return response(value); }
      catch { return fail(503, "OUTCOME_UNKNOWN", "The response reached the native login, but its receipt could not be projected. Inspect its current state before answering again."); }
    } catch (error) {
      const unknown = error instanceof Error && "code" in error && error.code === "OUTCOME_UNKNOWN";
      return fail(unknown ? 503 : 409, unknown ? "OUTCOME_UNKNOWN" : "MCP_RESPONSE_REJECTED",
        unknown ? "The response may have reached the native login. Inspect its current state before answering again."
          : "The authorization or prompt is no longer pending. Inspect its current state before answering again.");
    }
  }
}
