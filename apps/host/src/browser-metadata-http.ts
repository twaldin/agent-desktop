import { BROWSER_METADATA_OWNER_HEADER, BROWSER_METADATA_PROTOCOL_VERSION, type BrowserCreationTicket, type BrowserMetadataAvailability } from "@agent-desktop/shared";

class BrowserMetadataError extends Error { constructor(message: string, readonly status: number, readonly code: string) { super(message); } }

/** Owner-bound polling endpoint. It never starts a native worker merely to look
 * for browser tabs, so an empty/stale worker cannot fabricate a target. */
export class BrowserMetadataHttp {
  constructor(private options: { hostId: string; sessionExists(sessionId: string): boolean; creationTicket?: () => BrowserCreationTicket; getExistingHandle(sessionId: string): Promise<{ workerFailure?: { message: string }; getBrowserMetadata(): Promise<BrowserMetadataAvailability> } | undefined> }) {}

  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/browser-metadata$/.exec(url.pathname);
    if (!match) return undefined;
    const headers = { "Cache-Control": "no-store", [BROWSER_METADATA_OWNER_HEADER]: this.options.hostId };
    try {
      if (request.headers.get(BROWSER_METADATA_OWNER_HEADER) !== this.options.hostId) throw new BrowserMetadataError("The selected browser owner no longer matches this endpoint.", 409, "OWNER_MISMATCH");
      if (request.method !== "GET") throw new BrowserMetadataError("Use GET for browser metadata.", 405, "INVALID_BROWSER_METADATA_REQUEST");
      const sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || sessionId.length > 200 || !this.options.sessionExists(sessionId)) throw new BrowserMetadataError("The selected session no longer exists on this host.", 409, "STALE_TARGET");
      const handle = await this.options.getExistingHandle(sessionId);
      const metadata = !handle ? { availability: "not-started" as const, reason: "The native session worker has not started, so it has no live browser tabs." }
        : handle.workerFailure ? { availability: "unavailable" as const, reason: `The native session worker stopped: ${handle.workerFailure.message}` }
        : await handle.getBrowserMetadata();
      if (!this.options.sessionExists(sessionId)) throw new BrowserMetadataError("The selected session changed while browser metadata was loading.", 409, "STALE_TARGET");
      return Response.json({ protocolVersion: BROWSER_METADATA_PROTOCOL_VERSION, hostId: this.options.hostId, sessionId, ...metadata,
        ...(this.options.creationTicket ? { creationTicket: this.options.creationTicket() } : {}) }, { headers });
    } catch (error) {
      return Response.json({ error: { code: error instanceof BrowserMetadataError ? error.code : "BROWSER_METADATA_FAILED", message: error instanceof Error ? error.message.slice(0, 4096) : "Native browser metadata failed." } }, { status: error instanceof BrowserMetadataError ? error.status : 500, headers });
    }
  }
}
