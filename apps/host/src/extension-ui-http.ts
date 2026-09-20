import { EXTENSION_UI_OWNER_HEADER, parseNativeExtensionUiSnapshot, type NativeExtensionUiSnapshot, type ExtensionUiResult } from "../../../packages/shared/src/extension-ui";
interface ExtensionUiOwner { getExtensionUi(): Promise<NativeExtensionUiSnapshot> }
/** Reading presentation never starts or replaces a native worker. */
export class ExtensionUiHttp {
  constructor(private options: { hostId: string; sessionExists(id: string): boolean; existing(id: string): Promise<ExtensionUiOwner | undefined> }) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/extension-ui$/.exec(url.pathname);
    if (!match) return undefined;
    const headers = { "Cache-Control": "no-store", [EXTENSION_UI_OWNER_HEADER]: this.options.hostId };
    if (request.headers.get(EXTENSION_UI_OWNER_HEADER) !== this.options.hostId) return Response.json({ error: "Extension display owner mismatch." }, { status: 409, headers });
    if (request.method !== "GET") return Response.json({ error: "Use GET for extension display." }, { status: 405, headers });
    let sessionId: string;
    try { sessionId = decodeURIComponent(match[1]!); } catch { return Response.json({ error: "Invalid session identity." }, { status: 400, headers }); }
    if (!sessionId || sessionId.length > 200 || sessionId.includes("\0") || !this.options.sessionExists(sessionId)) return Response.json({ error: "The session is unavailable on this host." }, { status: 409, headers });
    const base = { protocolVersion: 1 as const, hostId: this.options.hostId, sessionId };
    let result: ExtensionUiResult = { ...base, availability: "unavailable", reason: "The original native extension UI owner is not active." };
    try {
      const owner = await this.options.existing(sessionId);
      if (owner) {
        const value = parseNativeExtensionUiSnapshot(await owner.getExtensionUi());
        if (this.options.sessionExists(sessionId) && await this.options.existing(sessionId) === owner && value.sessionId === sessionId)
          result = { ...base, availability: "available", value };
      }
    } catch { /* No live owner or lost original worker; do not start a replacement. */ }
    return Response.json(result, { headers });
  }
}
