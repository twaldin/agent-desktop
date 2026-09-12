import { BROWSER_METADATA_OWNER_HEADER } from "@agent-desktop/shared";
import { parseBrowserCloseOwner, parseBrowserCloseRequest } from "../../../packages/shared/src/browser-close";
import { readBrowserCreateBody } from "./browser-create-http";
import { BrowserCloseInputMismatch } from "./browser-close-records";
import { BrowserCloseRequests, type BrowserCloseHandle } from "./browser-close-requests";

/** Called behind the server's existing authenticated local/tailnet admission. */
export class BrowserCloseHttp {
  constructor(private readonly closes: BrowserCloseRequests, private readonly hostId: string,
    private readonly sessionExists: (id: string) => boolean,
    private readonly getExistingHandle: (id: string) => Promise<BrowserCloseHandle | undefined>) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/browser-(close|close-status)$/.exec(url.pathname);
    if (!match) return;
    const headers = { "Cache-Control": "no-store", [BROWSER_METADATA_OWNER_HEADER]: this.hostId };
    const error = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(BROWSER_METADATA_OWNER_HEADER) !== this.hostId) return error("OWNER_MISMATCH", "The browser belongs to another host.", 409);
    if (request.method !== "POST") return error("INVALID_REQUEST", "Use POST for browser close.", 405);
    let owner, input;
    try {
      owner = parseBrowserCloseOwner({ kind: "session", sessionId: decodeURIComponent(match[1]!) });
      input = parseBrowserCloseRequest(await readBrowserCreateBody(request));
    } catch { return error("INVALID_REQUEST", "Invalid browser close request.", 400); }
    // The session variant was selected above, independent of client fields.
    if (owner.kind !== "session") throw new Error("Invalid close route owner.");
    const sessionId = owner.sessionId;
    try {
      const value = match[2] === "close-status" ? this.closes.observe(owner, input) : await this.closes.execute(owner, input, {
        isCurrent: () => this.sessionExists(sessionId), getExistingHandle: () => this.getExistingHandle(sessionId),
      });
      return Response.json(value, { headers });
    } catch (cause) {
      return cause instanceof BrowserCloseInputMismatch ? error("BROWSER_CLOSE_INPUT_MISMATCH", "The close request has different input.", 409)
        : error("BROWSER_CLOSE_UNAVAILABLE", "Close history is unavailable. Do not replay this request.", 503);
    }
  }
}
