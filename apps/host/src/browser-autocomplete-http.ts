import { BROWSER_AUTOCOMPLETE_OWNER_HEADER, parseBrowserAutocompleteRequest, type BrowserAutocompleteRequest } from "@agent-desktop/shared";
import { readBrowserControlBody } from "./browser-control-http";
import { BrowserAutocompleteService, type BrowserAutocompleteHandle } from "./browser-autocomplete-service";

export class BrowserAutocompleteHttp {
  private active = new Set<Promise<Response>>(); private closing?: Promise<void>;
  constructor(private readonly options: { hostId: string; service: BrowserAutocompleteService; sessionExists(id: string): boolean;
    getExistingHandle(id: string): Promise<BrowserAutocompleteHandle | undefined> }) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/browser-autocomplete$/.exec(url.pathname); if (!match) return;
    const headers = { "Cache-Control": "no-store", [BROWSER_AUTOCOMPLETE_OWNER_HEADER]: this.options.hostId };
    const failure = (message: string, status = 400) => Response.json({ error: { code: "BROWSER_AUTOCOMPLETE_FAILED", message } }, { status, headers });
    if (request.headers.get(BROWSER_AUTOCOMPLETE_OWNER_HEADER) !== this.options.hostId) return failure("The browser autocomplete owner does not match this host.", 409);
    if (request.method !== "POST") return failure("Use POST for browser autocomplete.", 405);
    let sessionId: string, input: BrowserAutocompleteRequest;
    try { sessionId = decodeURIComponent(match[1]!); if (!sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error(); input = parseBrowserAutocompleteRequest(await readBrowserControlBody(request)); }
    catch { return failure("Invalid browser autocomplete request."); }
    if (this.closing) return failure("Browser autocomplete is stopping.", 503);
    const operation = (async () => {
      if (!this.options.sessionExists(sessionId)) return failure("The browser session changed.", 409);
      const handle = await this.options.getExistingHandle(sessionId).catch(() => undefined);
      if (!handle || handle.workerFailure || handle.workerPid !== input.target.workerPid) return failure("The browser worker changed.", 409);
      try {
        const value = await this.options.service.execute({ kind: "session", id: sessionId }, input, handle, async () =>
          !this.closing && this.options.sessionExists(sessionId) && await this.options.getExistingHandle(sessionId).catch(() => undefined) === handle);
        return Response.json(value, { headers });
      } catch (cause) { return failure(cause instanceof Error ? cause.message : "Browser autocomplete is unavailable.", 409); }
    })();
    this.active.add(operation); try { return await operation; } finally { this.active.delete(operation); }
  }
  dispose(): Promise<void> { if (this.closing) return this.closing; this.closing = Promise.allSettled([...this.active]).then(results => {
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []); if (errors.length) throw new AggregateError(errors, "Browser autocomplete cleanup failed");
  }); return this.closing; }
}
