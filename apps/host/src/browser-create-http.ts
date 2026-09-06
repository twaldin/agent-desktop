import { createHash } from "node:crypto";
import {
  BROWSER_CREATE_MAX_AGE_MS,
  BROWSER_CREATE_PROTOCOL_VERSION,
  BROWSER_METADATA_OWNER_HEADER,
  parseBrowserCreateRequest,
  parseNativeBrowserTabMetadata,
  type BrowserCreateReceipt,
  type BrowserCreateRequest,
  type NativeBrowserTabMetadata,
} from "@agent-desktop/shared";

export interface BrowserCreateHandle {
  workerPid: number;
  workerFailure?: { message: string };
  createBrowserTab(name: string): Promise<{
    tab: NativeBrowserTabMetadata;
    targetDisposition: "created-page" | "created-surface" | "adopted-existing-target";
  }>;
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing browser creation body.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = setTimeout(() => void reader.cancel(), 5_000);
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32 * 1024) throw new Error("Browser creation body exceeds its limit.");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
}

/** Owner-bound, idempotent admission of one native browser tab. Request IDs are
 * reserved before worker lookup; an uncertain native outcome is never replayed. */
export class BrowserCreateHttp {
  private receipts = new Map<string, { hash: string; createdAt: number; settled: boolean; result: Promise<BrowserCreateReceipt> }>();
  private inFlight = 0;

  constructor(private options: {
    hostId: string;
    controlEpoch: string;
    sessionExists(id: string): boolean;
    getHandle(id: string): Promise<BrowserCreateHandle>;
    getExistingHandle(id: string): Promise<BrowserCreateHandle | undefined>;
    now?: () => number;
  }) {}

  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/browser-create$/.exec(url.pathname);
    if (!match) return undefined;
    const headers = { "Cache-Control": "no-store", [BROWSER_METADATA_OWNER_HEADER]: this.options.hostId };
    const errorResponse = (message: string, status: number, code: string) =>
      Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(BROWSER_METADATA_OWNER_HEADER) !== this.options.hostId) {
      return errorResponse("The browser owner does not match this host.", 409, "OWNER_MISMATCH");
    }
    if (request.method !== "POST") return errorResponse("Use POST to create a browser tab.", 405, "INVALID_BROWSER_CREATE_REQUEST");

    let sessionId: string;
    let input: BrowserCreateRequest;
    try {
      sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error("Invalid session identity.");
      input = parseBrowserCreateRequest(await readBody(request));
    } catch {
      return errorResponse("Invalid browser creation request.", 400, "INVALID_BROWSER_CREATE_REQUEST");
    }

    const base = { protocolVersion: BROWSER_CREATE_PROTOCOL_VERSION, hostId: this.options.hostId, sessionId, requestId: input.requestId } as const;
    const failure = (outcome: "rejected" | "unknown", message: string, workerPid?: number): BrowserCreateReceipt =>
      ({ ...base, outcome, message, ...(workerPid === undefined ? {} : { workerPid }) });
    const now = (this.options.now ?? Date.now)();
    for (const [key, record] of this.receipts) {
      if (record.settled && now - record.createdAt > BROWSER_CREATE_MAX_AGE_MS * 2) this.receipts.delete(key);
    }
    const key = `${sessionId}:${input.requestId}`;
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const prior = this.receipts.get(key);
    if (prior) {
      return Response.json(prior.hash === hash
        ? await prior.result
        : failure("rejected", "This browser creation identity was already used for different input."), { headers });
    }
    if (input.controlEpoch !== this.options.controlEpoch) {
      return Response.json(failure("rejected", "The browser host restarted. Refresh before creating a tab."), { headers });
    }
    if (input.observedAt > now + 5_000 || now - input.observedAt > BROWSER_CREATE_MAX_AGE_MS) {
      return Response.json(failure("rejected", "The browser creation ticket is too old. Refresh before creating a tab."), { headers });
    }
    if (this.receipts.size >= 4_096) {
      return Response.json(failure("rejected", "This host is handling too many browser creations. Wait before trying again."), { headers });
    }
    if (this.inFlight >= 8) {
      return Response.json(failure("rejected", "This host is creating other browser tabs. Wait before trying again."), { headers });
    }

    this.inFlight++;
    const result = Promise.resolve().then(async (): Promise<BrowserCreateReceipt> => {
      if (!this.options.sessionExists(sessionId)) return failure("rejected", "The browser session is no longer available.");
      let handle: BrowserCreateHandle;
      try { handle = await this.options.getHandle(sessionId); }
      catch { return failure("rejected", "The native session could not be opened for browser creation."); }
      if (handle.workerFailure) return failure("rejected", "The native session worker is unavailable.", handle.workerPid);
      try {
        const value = await handle.createBrowserTab(`desktop-${input.requestId}`);
        if (!this.options.sessionExists(sessionId) || handle.workerFailure || await this.options.getExistingHandle(sessionId) !== handle) {
          return failure("unknown", "The browser worker changed during creation. Refresh its tab list before creating again.", handle.workerPid);
        }
        const tab = parseNativeBrowserTabMetadata(value.tab);
        if (tab.name !== `desktop-${input.requestId}` || tab.state !== "alive") {
          return failure("unknown", "Native browser creation returned an invalid target. Refresh its tab list.", handle.workerPid);
        }
        if (!["created-page", "created-surface", "adopted-existing-target"].includes(value.targetDisposition)) {
          return failure("unknown", "Native browser creation returned an invalid disposition. Refresh its tab list.", handle.workerPid);
        }
        return { ...base, outcome: "completed", workerPid: handle.workerPid, tab, targetDisposition: value.targetDisposition };
      } catch (error) {
        return error instanceof Error && error.name === "BrowserTabCreateRejected"
          ? failure("rejected", "The native browser rejected tab creation. Refresh its settings and tab list.", handle.workerPid)
          : failure("unknown", "Browser creation may have reached the native worker. Refresh its tab list before creating again.", handle.workerPid);
      }
    }).finally(() => { this.inFlight--; });
    const record = { hash, createdAt: now, settled: false, result };
    this.receipts.set(key, record);
    void result.finally(() => { record.settled = true; }).catch(() => {});
    return Response.json(await result, { headers });
  }
}
