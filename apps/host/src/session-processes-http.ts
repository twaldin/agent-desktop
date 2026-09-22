import { SESSION_ACTIVITY_OWNER_HEADER } from "../../../packages/shared/src/session-activity";
import { parseSessionProcessesRequest, SESSION_PROCESSES_PROTOCOL_VERSION, type SessionProcessesEnvelope } from "../../../packages/shared/src/session-processes";
import { NativeProcessesAdmissionError } from "./omp/session-processes";
import { ProcessInputMismatch } from "./session-process-records";
import { SessionProcessRequests } from "./session-process-requests";

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing process request body.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 5_000);
  try {
    for (;;) {
      const part = await reader.read();
      if (expired) throw new Error("Process request body timed out.");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32 * 1024) throw new Error("Process request body exceeds its limit.");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(timer); reader.releaseLock(); }
}

/** Mount only after the existing host authentication gate. Retains complete
 * admitted routes through body parsing and durable settlement so shutdown can
 * wait before closing SQLite. Closing a client connection never replays or
 * cancels an already-dispatched native mutation. */
export class SessionProcessesHttp {
  readonly #pending = new Set<Promise<Response>>();
  #stopping = false;
  #disposal: Promise<void> | undefined;
  constructor(private readonly hostId: string, private readonly requests: SessionProcessRequests) {}
  #failure(code: string, message: string, status: number): Response {
    return Response.json({ error: { code, message } }, { status, headers: this.#headers() });
  }
  #headers(): Record<string, string> {
    return { "Cache-Control": "no-store", [SESSION_ACTIVITY_OWNER_HEADER]: this.hostId };
  }
  route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/processes$/.exec(url.pathname);
    if (!match) return Promise.resolve(undefined);
    if (request.headers.get(SESSION_ACTIVITY_OWNER_HEADER) !== this.hostId)
      return Promise.resolve(this.#failure("OWNER_MISMATCH", "The selected process owner no longer matches this host.", 409));
    if (request.method !== "POST") return Promise.resolve(this.#failure("INVALID_PROCESSES_REQUEST", "Use POST for native processes.", 405));
    if (this.#stopping) return Promise.resolve(this.#failure("STOPPING", "The native process host is stopping.", 409));
    if (this.#pending.size >= 32) return Promise.resolve(this.#failure("PROCESSES_BUSY", "Too many process requests are pending.", 429));
    const pending = Promise.resolve().then(() => this.#run(request, match[1]!)).finally(() => this.#pending.delete(pending));
    this.#pending.add(pending);
    return pending;
  }
  async #run(request: Request, encodedSession: string): Promise<Response> {
    let sessionId: string, input: ReturnType<typeof parseSessionProcessesRequest>;
    try {
      if (encodedSession.length > 600) throw new Error("Invalid session");
      sessionId = decodeURIComponent(encodedSession);
      if (!sessionId || sessionId.length > 200 || /[\u0000-\u001f\u007f]/.test(sessionId)) throw new Error("Invalid session");
      input = parseSessionProcessesRequest(await readBody(request));
      if (input.action !== "receipt" && input.owner && input.owner.nativeSessionId !== sessionId) throw new Error("Foreign process owner");
    } catch { return this.#failure("INVALID_PROCESSES_REQUEST", "Invalid native process request.", 400); }
    try {
      const result = await this.requests.request(sessionId, input);
      const envelope: SessionProcessesEnvelope = { protocolVersion: SESSION_PROCESSES_PROTOCOL_VERSION, hostId: this.hostId, sessionId, result };
      return Response.json(envelope, { headers: this.#headers() });
    } catch (error) {
      if (error instanceof ProcessInputMismatch) return this.#failure("OPERATION_MISMATCH", "This operation ID already has different input.", 409);
      if (error instanceof NativeProcessesAdmissionError) return this.#failure("OWNER_UNAVAILABLE", error.message, 409);
      // Do not leak private native paths or SQLite messages. This failure does
      // not authorize retry; a client keeps its original operation ID and reads
      // the durable receipt, which may correctly remain unknown.
      return this.#failure("PROCESSES_FAILED", "The process result could not be confirmed. Inspect the original receipt before acting again.", 500);
    }
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#stopping = true;
    const routes = [...this.#pending];
    const requests = this.requests.dispose();
    this.#disposal = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...routes, requests]);
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Native process routes could not drain cleanly.");
    });
    return this.#disposal;
  }
}
