import { SESSION_USAGE_HEADER, SESSION_USAGE_MAX_BYTES, usageIdentity, type UsageRefresh, type SessionUsageResponse } from "../../../packages/shared/src/session-usage";

/** Mounted behind the owning host's existing authenticated boundary. */
export class SessionUsageHttp {
  #bodies = 0;
  constructor(private options: { hostId: string; sessionExists(id: string): boolean; read(id: string, mode: UsageRefresh, commandId?: string): Promise<SessionUsageResponse> }) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/usage$/.exec(url.pathname); if (!match) return;
    const headers = { "Cache-Control": "no-store", [SESSION_USAGE_HEADER]: this.options.hostId };
    const fail = (status: number, message: string) => Response.json({ error: { code: "USAGE_UNAVAILABLE", message } }, { status, headers });
    if (request.headers.get(SESSION_USAGE_HEADER) !== this.options.hostId) return fail(409, "Provider usage belongs to a different host.");
    try {
      const sessionId = usageIdentity(decodeURIComponent(match[1]!));
      const commandId = url.searchParams.has("commandId") ? usageIdentity(url.searchParams.get("commandId")) : undefined;
      if ([...url.searchParams.keys()].some(key => key !== "commandId") || url.searchParams.getAll("commandId").length > 1 || commandId && request.method !== "GET" || !this.options.sessionExists(sessionId)) return fail(404, "Original session is unavailable.");
      let mode: UsageRefresh = "cached";
      if (request.method === "POST") {
        if (this.#bodies >= 16) return fail(429, "Too many pending provider usage requests.");
        const reader = request.body?.getReader(); if (!reader) return fail(400, "Choose a provider usage refresh.");
        this.#bodies++;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Usage request deadline exceeded.")), 5_000); });
        let body = "", bytes = 0; const decoder = new TextDecoder();
        try { while (true) { const part = await Promise.race([reader.read(), deadline]); if (part.done) break; bytes += part.value.byteLength; if (bytes > 128) { await reader.cancel(); return fail(413, "Provider usage request exceeds the limit."); } body += decoder.decode(part.value, { stream: true }); } }
        finally { clearTimeout(timeout); this.#bodies--; void reader.cancel().catch(() => {}); reader.releaseLock(); }
        const input = JSON.parse(body + decoder.decode());
        if (!input || Object.keys(input).length !== 1 || !["reports", "credits"].includes(input.mode)) return fail(400, "Choose reports or saved credits.");
        mode = input.mode;
      } else if (request.method !== "GET") return fail(405, "Use GET to inspect or POST to refresh provider usage.");
      const value = await this.options.read(sessionId, mode, commandId);
      if (Buffer.byteLength(JSON.stringify(value)) > SESSION_USAGE_MAX_BYTES) return fail(413, "Provider usage response exceeds the display limit.");
      return Response.json(value, { headers });
    } catch { return fail(409, "Provider usage could not be confirmed. Inspect cached state or explicitly refresh the original session."); }
  }
}

/** Reject ownership/protocol mismatches before generic journal claim or dispatch. */
export function usageCommandHeaders(request: Request, pathname: string, value: unknown, hostId: string): Record<string, string> | Response | undefined {
  const envelope = value as { commandVersion?: unknown; command?: { type?: unknown } } | null;
  if (envelope?.command?.type !== "session.usage.reset.prepare" && envelope?.command?.type !== "session.usage.reset.respond") return;
  const headers = { "Cache-Control": "no-store", [SESSION_USAGE_HEADER]: hostId };
  if (request.headers.get(SESSION_USAGE_HEADER) !== hostId || pathname !== "/v20/commands" || envelope.commandVersion !== 20)
    return Response.json({ error: { code: "USAGE_OWNER_PROTOCOL_REQUIRED", message: "Provider usage requires its original host and command version 20." } }, { status: 409, headers });
  return headers;
}
