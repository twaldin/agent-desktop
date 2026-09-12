import { BROWSER_METADATA_OWNER_HEADER, parseBrowserControlRequest,
  type BrowserControlRequest } from '@agent-desktop/shared';

import { BrowserControlRequests, type BrowserControlHandle } from "./browser-control-requests";
export type { BrowserControlHandle } from "./browser-control-requests";
export async function readBrowserControlBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error('Missing browser action body.');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel(); }, 5000);
  try {
    for (;;) {
      const part = await reader.read(); if (expired) throw new Error('Browser action body timed out.'); if (part.done) break;
      size += part.value.byteLength; if (size > 128 * 1024) throw new Error('Browser action body exceeds its limit.'); chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(timer); reader.releaseLock(); }
}

/** Ephemeral action receipts never contain typed text or page contents. The
 * process epoch rejects requests from before a host restart. No action replay. */
export class BrowserControlHttp {
  private readonly controls: BrowserControlRequests;
  constructor(private options: { hostId: string; sessionExists(id: string): boolean; getExistingHandle(id: string): Promise<BrowserControlHandle | undefined>; now?: () => number }) {
    this.controls = new BrowserControlRequests(options.now);
  }
  get epoch(): string { return this.controls.epoch; }
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/browser-control$/.exec(url.pathname); if (!match) return;
    const headers = { 'Cache-Control': 'no-store', [BROWSER_METADATA_OWNER_HEADER]: this.options.hostId };
    const failure = (message: string, status = 400) => Response.json({ error: { code: 'BROWSER_CONTROL_REJECTED', message } }, { status, headers });
    if (request.headers.get(BROWSER_METADATA_OWNER_HEADER) !== this.options.hostId) return failure('The browser owner does not match this host.', 409);
    if (request.method !== 'POST') return failure('Use POST for browser actions.', 405);
    let sessionId: string, input: BrowserControlRequest;
    try { sessionId = decodeURIComponent(match[1]!); if (!sessionId || sessionId.length > 200 || sessionId.includes('\0')) throw new Error('Invalid session identity.'); input = parseBrowserControlRequest(await readBrowserControlBody(request)); }
    catch { return failure('Invalid browser action request.'); }
    const result = await this.controls.execute(sessionId, input, {
      isCurrent: () => this.options.sessionExists(sessionId), getExistingHandle: () => this.options.getExistingHandle(sessionId),
    });
    return Response.json({ ...result, hostId: this.options.hostId, sessionId }, { headers });
  }
}
