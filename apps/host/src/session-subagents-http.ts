import { SESSION_ACTIVITY_OWNER_HEADER } from "../../../packages/shared/src/session-activity";
import { assertSessionSubagentsResultMatches, parseSessionSubagentsRequest, parseSessionSubagentsResult, SESSION_SUBAGENTS_MAX_RESPONSE_BYTES, SESSION_SUBAGENTS_PROTOCOL_VERSION,
  type SessionSubagentsRequest, type SessionSubagentsResult } from "../../../packages/shared/src/session-subagents";
import { nativeSubagentsErrorCode } from "./omp/session-subagents";

export interface SessionSubagentsHandle {
  workerFailure?: { message: string } | undefined;
  nativeSubagents(request: SessionSubagentsRequest): Promise<SessionSubagentsResult>;
}
class SubagentsHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing Subagents body.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel(); }, 5_000);
  try {
    for (;;) {
      const part = await reader.read();
      if (expired) throw new Error("Subagents body timed out.");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32 * 1024) throw new Error("Subagents body exceeds its limit.");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(timer); reader.releaseLock(); }
}

/** Authentication is supplied by server.ts. Browsing never creates a worker or
 * imports a child into the catalog; every request stays on the captured root. */
export class SessionSubagentsHttp {
  constructor(private readonly options: { hostId: string; sessionExists(id: string): boolean; getExistingHandle(id: string): Promise<SessionSubagentsHandle | undefined> }) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/subagents$/.exec(url.pathname);
    if (!match) return;
    const headers = { "Cache-Control": "no-store", [SESSION_ACTIVITY_OWNER_HEADER]: this.options.hostId };
    try {
      if (request.headers.get(SESSION_ACTIVITY_OWNER_HEADER) !== this.options.hostId)
        throw new SubagentsHttpError("The original Subagents host no longer matches this endpoint.", 409, "OWNER_MISMATCH");
      if (request.method !== "POST") throw new SubagentsHttpError("Use POST for read-only Subagents requests.", 405, "INVALID_SUBAGENTS_REQUEST");
      let sessionId: string, input: SessionSubagentsRequest;
      try {
        if (match[1]!.length > 600) throw new Error("Invalid target");
        sessionId = decodeURIComponent(match[1]!);
        if (!sessionId || sessionId.length > 200 || /[\u0000-\u001f\u007f]/.test(sessionId)) throw new Error("Invalid target");
        input = parseSessionSubagentsRequest(await readBody(request));
        if (input.owner && input.owner.nativeSessionId !== sessionId) throw new Error("Different root");
      } catch { throw new SubagentsHttpError("Invalid read-only Subagents request.", 400, "INVALID_SUBAGENTS_REQUEST"); }
      if (!this.options.sessionExists(sessionId)) throw new SubagentsHttpError("The original conversation no longer exists on this host.", 409, "STALE_OWNER");
      const handle = await this.options.getExistingHandle(sessionId);
      if (!this.options.sessionExists(sessionId)) throw new SubagentsHttpError("The original conversation was retired.", 409, "STALE_OWNER");
      if (!handle || handle.workerFailure) throw new SubagentsHttpError("This conversation has no loaded native worker. Open the original conversation before browsing its subagents.", 409, "OWNER_UNAVAILABLE");
      let result: SessionSubagentsResult;
      try { result = parseSessionSubagentsResult(await handle.nativeSubagents(input)); }
      catch (error) {
        const code = nativeSubagentsErrorCode(error);
        throw new SubagentsHttpError(error instanceof Error ? error.message : "The native Subagents read failed.", code === "SUBAGENTS_REJECTED" ? 400 : code ? 409 : 500, code ?? "SUBAGENTS_FAILED");
      }
      const current = await this.options.getExistingHandle(sessionId);
      if (!this.options.sessionExists(sessionId) || current !== handle || handle.workerFailure || result.owner.nativeSessionId !== sessionId)
        throw new SubagentsHttpError("The original conversation changed while its subagents were loading.", 409, "STALE_OWNER");
      assertSessionSubagentsResultMatches(input, result);
      const body = JSON.stringify({ protocolVersion: SESSION_SUBAGENTS_PROTOCOL_VERSION, hostId: this.options.hostId, sessionId, result });
      if (Buffer.byteLength(body) > SESSION_SUBAGENTS_MAX_RESPONSE_BYTES) throw new SubagentsHttpError("The native Subagents response exceeds its read limit.", 413, "SUBAGENTS_TOO_LARGE");
      return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
    } catch (error) {
      return Response.json({ error: { code: error instanceof SubagentsHttpError ? error.code : "SUBAGENTS_FAILED", message: error instanceof Error ? error.message.slice(0, 4096) : "Subagents could not be read." } },
        { status: error instanceof SubagentsHttpError ? error.status : 500, headers });
    }
  }
}
