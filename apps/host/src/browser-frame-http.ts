import { BROWSER_FRAME_PROTOCOL_VERSION, BROWSER_METADATA_OWNER_HEADER, parseNativeBrowserFrame, validBrowserFrameTarget,
  type BrowserFrameTarget, type NativeBrowserFrame } from "@agent-desktop/shared";

interface FrameHandle {
  workerPid: number;
  workerFailure?: { message: string };
  getBrowserFrame(target: BrowserFrameTarget): Promise<NativeBrowserFrame>;
}
class FrameError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

/** Ephemeral viewport reads. Coalesce simultaneous viewers; never journal frames
 * or start a session worker simply because a desktop opens the panel. */
export class BrowserFrameHttp {
  private pending = new Map<string, Promise<NativeBrowserFrame>>();
  constructor(private options: { hostId: string; controlEpoch?: string; sessionExists(id: string): boolean; getExistingHandle(id: string): Promise<FrameHandle | undefined> }) {}

  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/browser-frame$/.exec(url.pathname);
    if (!match) return undefined;
    const headers = { "Cache-Control": "no-store", [BROWSER_METADATA_OWNER_HEADER]: this.options.hostId };
    try {
      if (request.headers.get(BROWSER_METADATA_OWNER_HEADER) !== this.options.hostId) throw new FrameError("The browser owner does not match this host.", 409, "OWNER_MISMATCH");
      if (request.method !== "GET") throw new FrameError("Use GET for browser viewport reads.", 405, "INVALID_BROWSER_FRAME_REQUEST");
      let sessionId: string;
      try { sessionId = decodeURIComponent(match[1]!); } catch { throw new FrameError("Invalid session identity.", 400, "INVALID_BROWSER_FRAME_REQUEST"); }
      const target = { workerPid: Number(url.searchParams.get("workerPid")), name: url.searchParams.get("name"), targetId: url.searchParams.get("targetId") };
      if (!sessionId || sessionId.length > 200 || sessionId.includes("\0") || !validBrowserFrameTarget(target)) throw new FrameError("Invalid browser target identity.", 400, "INVALID_BROWSER_FRAME_REQUEST");
      if (!this.options.sessionExists(sessionId)) throw new FrameError("The browser session no longer exists.", 409, "STALE_TARGET");
      const handle = await this.options.getExistingHandle(sessionId);
      if (!handle || handle.workerFailure || handle.workerPid !== target.workerPid) throw new FrameError("The browser worker changed or is unavailable. Refresh its tab list.", 409, "STALE_TARGET");
      const key = JSON.stringify([sessionId, target.workerPid, target.name, target.targetId]);
      let frame = this.pending.get(key);
      if (!frame) {
        if (this.pending.size >= 8) throw new FrameError("This host is capturing other browser views. Try again shortly.", 429, "BROWSER_FRAME_BUSY");
        frame = Promise.resolve().then(() => handle.getBrowserFrame(target));
        this.pending.set(key, frame);
        void frame.finally(() => { if (this.pending.get(key) === frame) this.pending.delete(key); }).catch(() => {});
      }
      const value = parseNativeBrowserFrame(await frame, target);
      if (!this.options.sessionExists(sessionId) || handle.workerFailure || await this.options.getExistingHandle(sessionId) !== handle) {
        throw new FrameError("The browser session changed while its viewport was loading.", 409, "STALE_TARGET");
      }
      return Response.json({ protocolVersion: BROWSER_FRAME_PROTOCOL_VERSION, hostId: this.options.hostId, sessionId, workerPid: target.workerPid, ...(this.options.controlEpoch ? { controlEpoch: this.options.controlEpoch } : {}), ...value }, { headers });
    } catch (error) {
      return Response.json({ error: { code: error instanceof FrameError ? error.code : "BROWSER_FRAME_FAILED",
        message: error instanceof FrameError ? error.message : "The native browser viewport could not be captured. Refresh its tab list and try again." } },
      { status: error instanceof FrameError ? error.status : 503, headers });
    }
  }
}
