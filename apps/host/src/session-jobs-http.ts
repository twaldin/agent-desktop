import { SESSION_ACTIVITY_OWNER_HEADER } from "../../../packages/shared/src/session-activity";
import { assertSessionJobsResultMatches, parseSessionJobsRequest, parseSessionJobsResult, SESSION_JOBS_PROTOCOL_VERSION,
  type SessionJobsEnvelope, type SessionJobsRequest, type SessionJobsResult } from "../../../packages/shared/src/session-jobs";
import { nativeJobsErrorCode } from "./omp/session-jobs";

export interface SessionJobsHandle {
  workerFailure?: { message: string } | undefined;
  nativeJobs(request: SessionJobsRequest): Promise<SessionJobsResult>;
}

class SessionJobsHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing native jobs body.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel(); }, 5_000);
  try {
    for (;;) {
      const part = await reader.read();
      if (expired) throw new Error("Native jobs body timed out.");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32 * 1024) throw new Error("Native jobs body exceeds its limit.");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer); reader.releaseLock();
  }
}

/** Mounted after host authentication. Uses only an already-loaded original
 * worker: a jobs read or cancellation never starts or revives one. A cancel whose
 * owner is lost after dispatch stays unknown; it is never reported as done or undone. */
export class SessionJobsHttp {
  constructor(private readonly options: { hostId: string; sessionExists(id: string): boolean; getExistingHandle(id: string): Promise<SessionJobsHandle | undefined> }) {}

  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/jobs$/.exec(url.pathname);
    if (!match) return undefined;
    const headers = { "Cache-Control": "no-store", [SESSION_ACTIVITY_OWNER_HEADER]: this.options.hostId };
    try {
      if (request.headers.get(SESSION_ACTIVITY_OWNER_HEADER) !== this.options.hostId)
        throw new SessionJobsHttpError("The selected session owner no longer matches this endpoint.", 409, "OWNER_MISMATCH");
      if (request.method !== "POST") throw new SessionJobsHttpError("Use POST for native jobs.", 405, "INVALID_JOBS_REQUEST");
      let sessionId: string, input: SessionJobsRequest;
      try {
        if (match[1]!.length > 600) throw new Error("Invalid target");
        sessionId = decodeURIComponent(match[1]!);
        if (!sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error("Invalid target");
        input = parseSessionJobsRequest(await readBody(request));
        if (input.owner && input.owner.nativeSessionId !== sessionId) throw new Error("Owner names another session");
      } catch { throw new SessionJobsHttpError("Invalid native jobs request.", 400, "INVALID_JOBS_REQUEST"); }
      const mutation = input.action === "cancel";
      if (!this.options.sessionExists(sessionId)) throw new SessionJobsHttpError("The selected session no longer exists on this host.", 409, "STALE_TARGET");
      const handle = await this.options.getExistingHandle(sessionId).catch(() => undefined);
      if (!this.options.sessionExists(sessionId)) throw new SessionJobsHttpError("The selected session no longer exists on this host.", 409, "STALE_TARGET");
      if (!handle || handle.workerFailure)
        throw new SessionJobsHttpError("This session has no loaded native worker. Open the original session to inspect its jobs.", 409, "OWNER_UNAVAILABLE");
      let result: SessionJobsResult;
      try { result = parseSessionJobsResult(await handle.nativeJobs(input)); }
      catch (error) {
        const code = nativeJobsErrorCode(error);
        if (code === "JOBS_REJECTED") throw new SessionJobsHttpError(error instanceof Error ? error.message : "Invalid native jobs request.", 400, "INVALID_JOBS_REQUEST");
        if (code) throw new SessionJobsHttpError(error instanceof Error ? error.message : "The native jobs owner changed.", 409, code);
        if (mutation) throw new SessionJobsHttpError("The cancellation outcome could not be confirmed. Refresh the job list before acting again.", 500, "OUTCOME_UNKNOWN");
        throw new SessionJobsHttpError(error instanceof Error ? error.message : "Native jobs could not be read.", 500, "JOBS_FAILED");
      }
      // The original loaded worker must still own the session after the awaited dispatch.
      const current = this.options.sessionExists(sessionId) && !handle.workerFailure ? await this.options.getExistingHandle(sessionId).catch(() => undefined) : undefined;
      const intact = current === handle && !handle.workerFailure && this.options.sessionExists(sessionId) && result.snapshot.owner.nativeSessionId === sessionId;
      let matches = intact;
      if (intact) { try { assertSessionJobsResultMatches(input, result); } catch { matches = false; } }
      if (!matches) {
        if (mutation) throw new SessionJobsHttpError("The native session changed during the cancellation; its outcome is unknown. Refresh the job list before acting again.", 500, "OUTCOME_UNKNOWN");
        throw new SessionJobsHttpError(intact ? "The native jobs result did not answer this request." : "The selected session changed while its jobs were loading.", intact ? 500 : 409, intact ? "JOBS_FAILED" : "STALE_TARGET");
      }
      const envelope: SessionJobsEnvelope = { protocolVersion: SESSION_JOBS_PROTOCOL_VERSION, hostId: this.options.hostId, sessionId, result };
      return Response.json(envelope, { headers });
    } catch (error) {
      return Response.json({ error: { code: error instanceof SessionJobsHttpError ? error.code : "JOBS_FAILED",
        message: error instanceof Error ? error.message.slice(0, 4096) : "Native jobs failed." } },
      { status: error instanceof SessionJobsHttpError ? error.status : 500, headers });
    }
  }
}
