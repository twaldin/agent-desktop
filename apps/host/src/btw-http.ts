import { BTW_OWNER_HEADER, BTW_PROTOCOL_VERSION, type NativeBtwResponse } from "@agent-desktop/shared";
import { BtwService } from "./btw";

export class BtwHttp {
  constructor(private readonly options: { hostId: string; sessionExists: (id: string) => boolean; service: BtwService }) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/btw$/.exec(url.pathname);
    if (!match) return undefined;
    const headers = { "Cache-Control": "no-store", [BTW_OWNER_HEADER]: this.options.hostId };
    try {
      if (request.headers.get(BTW_OWNER_HEADER) !== this.options.hostId) return Response.json({ error: { code: "OWNER_MISMATCH", message: "The selected session owner no longer matches this endpoint." } }, { status: 409, headers });
      const sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || sessionId.length > 200 || !this.options.sessionExists(sessionId)) return Response.json({ error: { code: "STALE_TARGET", message: "The selected session no longer exists on this host." } }, { status: 409, headers });
      if (request.method !== "GET") return Response.json({ error: { code: "INVALID_BTW_REQUEST", message: "Use GET for btw state." } }, { status: 405, headers });
      const value = await this.options.service.snapshot(sessionId);
      return Response.json({ protocolVersion: BTW_PROTOCOL_VERSION, hostId: this.options.hostId, sessionId, value, draftConsumption: true } satisfies NativeBtwResponse, { headers });
    } catch (error) { return Response.json({ error: { code: "BTW_FAILED", message: error instanceof Error ? error.message.slice(0, 4096) : "btw state failed." } }, { status: 500, headers }); }
  }
}
