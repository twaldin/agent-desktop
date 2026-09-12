import { BROWSER_METADATA_OWNER_HEADER, BROWSER_HISTORY_PROTOCOL_VERSION, parseBrowserHistoryRequest, type BrowserHistoryEntry, type BrowserHistoryRequest } from "@agent-desktop/shared";
import { readBrowserControlBody } from "./browser-control-http";
import { browserHistoryRevision } from "./browser-history-revision";

export interface BrowserHistoryHandle { workerPid: number; workerFailure?: { message: string }; getBrowserHistory(target: BrowserHistoryRequest["target"]): Promise<BrowserHistoryEntry[]> }

export class BrowserHistoryHttp {
  private active = new Set<Promise<Response>>(); private closing?: Promise<void>;
  constructor(private options: { hostId: string; sessionExists(id: string): boolean; getExistingHandle(id: string): Promise<BrowserHistoryHandle | undefined> }) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/browser-history$/.exec(url.pathname); if (!match) return;
    const headers = { "Cache-Control": "no-store", [BROWSER_METADATA_OWNER_HEADER]: this.options.hostId };
    const failure = (message: string, status = 400) => Response.json({ error: { code: "BROWSER_HISTORY_FAILED", message } }, { status, headers });
    if (request.headers.get(BROWSER_METADATA_OWNER_HEADER) !== this.options.hostId) return failure("The browser owner does not match this host.", 409);
    if (request.method !== "POST") return failure("Use POST for browser history.", 405);
    let sessionId: string, input: BrowserHistoryRequest;
    try { sessionId = decodeURIComponent(match[1]!); if (!sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error(); input = parseBrowserHistoryRequest(await readBrowserControlBody(request)); }
    catch { return failure("Invalid browser history request."); }
    if (this.closing) return failure("Browser history is stopping.", 503);
    const operation = (async () => {
      if (!this.options.sessionExists(sessionId)) return failure("The browser session changed.", 409);
      const handle = await this.options.getExistingHandle(sessionId).catch(() => undefined);
      if (!handle || handle.workerFailure || handle.workerPid !== input.target.workerPid) return failure("The browser worker changed.", 409);
      try {
        const entries = await handle.getBrowserHistory(input.target), current = await this.options.getExistingHandle(sessionId).catch(() => undefined);
        if (this.closing || !this.options.sessionExists(sessionId) || current !== handle || handle.workerFailure) return failure("The browser owner changed during the history read.", 409);
        return Response.json({ protocolVersion: BROWSER_HISTORY_PROTOCOL_VERSION, hostId: this.options.hostId, owner: { kind: "session", id: sessionId }, requestId: input.requestId, target: input.target, query: input.query, revision: browserHistoryRevision(entries), entries }, { headers });
      } catch { return failure("The native browser history is unavailable.", 503); }
    })();
    this.active.add(operation); try { return await operation; } finally { this.active.delete(operation); }
  }
  dispose(): Promise<void> { if (this.closing) return this.closing; this.closing = Promise.allSettled([...this.active]).then(results => { const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []); if (errors.length) throw new AggregateError(errors, "Browser history cleanup failed"); }); return this.closing; }
}
