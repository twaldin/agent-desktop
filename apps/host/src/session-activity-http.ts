import { SESSION_ACTIVITY_OWNER_HEADER, SESSION_ACTIVITY_PROTOCOL_VERSION, type NativeSessionActivity } from "@agent-desktop/shared";

class SessionActivityError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

export class SessionActivityHttp {
  constructor(private options: { hostId: string; getActivity(sessionId: string): Promise<NativeSessionActivity>; sessionExists(sessionId: string): boolean }) {}

  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/activity$/.exec(url.pathname);
    if (!match) return undefined;
    const headers = { "Cache-Control": "no-store", [SESSION_ACTIVITY_OWNER_HEADER]: this.options.hostId };
    try {
      if (request.headers.get(SESSION_ACTIVITY_OWNER_HEADER) !== this.options.hostId) throw new SessionActivityError("The selected session owner no longer matches this endpoint.", 409, "OWNER_MISMATCH");
      if (request.method !== "GET") throw new SessionActivityError("Use GET for session activity.", 405, "INVALID_ACTIVITY_REQUEST");
      const sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || sessionId.length > 200 || !this.options.sessionExists(sessionId)) throw new SessionActivityError("The selected session no longer exists on this host.", 409, "STALE_TARGET");
      const activity = await this.options.getActivity(sessionId);
      if (!this.options.sessionExists(sessionId)) throw new SessionActivityError("The selected session changed while activity was loading.", 409, "STALE_TARGET");
      return Response.json({ protocolVersion: SESSION_ACTIVITY_PROTOCOL_VERSION, hostId: this.options.hostId, sessionId, ...activity }, { headers });
    } catch (error) {
      return Response.json({ error: { code: error instanceof SessionActivityError ? error.code : "SESSION_ACTIVITY_FAILED",
        message: error instanceof Error ? error.message.slice(0, 4096) : "Native session activity failed." } },
      { status: error instanceof SessionActivityError ? error.status : 500, headers });
    }
  }
}
