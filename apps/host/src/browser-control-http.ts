import { createHash } from 'node:crypto';
import { BROWSER_CONTROL_MAX_AGE_MS, BROWSER_METADATA_OWNER_HEADER, parseBrowserControlRequest, parseBrowserDocumentContext,
  type BrowserControlRequest, type BrowserControlReceipt } from '@agent-desktop/shared';

export interface BrowserControlHandle {
  workerPid: number; workerFailure?: { message: string };
  controlBrowser(request: BrowserControlRequest): Promise<{ name: string; targetId: string; context: unknown; url: string; title: string }>;
}
async function readBody(request: Request): Promise<unknown> {
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
  readonly epoch = crypto.randomUUID();
  private receipts = new Map<string, { hash: string; createdAt: number; settled: boolean; result: Promise<BrowserControlReceipt> }>();
  constructor(private options: { hostId: string; sessionExists(id: string): boolean; getExistingHandle(id: string): Promise<BrowserControlHandle | undefined>; now?: () => number }) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/browser-control$/.exec(url.pathname); if (!match) return;
    const headers = { 'Cache-Control': 'no-store', [BROWSER_METADATA_OWNER_HEADER]: this.options.hostId };
    const failure = (message: string, status = 400) => Response.json({ error: { code: 'BROWSER_CONTROL_REJECTED', message } }, { status, headers });
    if (request.headers.get(BROWSER_METADATA_OWNER_HEADER) !== this.options.hostId) return failure('The browser owner does not match this host.', 409);
    if (request.method !== 'POST') return failure('Use POST for browser actions.', 405);
    let sessionId: string, input: BrowserControlRequest;
    try { sessionId = decodeURIComponent(match[1]!); if (!sessionId || sessionId.length > 200 || sessionId.includes('\0')) throw new Error('Invalid session identity.'); input = parseBrowserControlRequest(await readBody(request)); }
    catch { return failure('Invalid browser action request.'); }
    const receipt = (outcome: BrowserControlReceipt['outcome'], message?: string): BrowserControlReceipt => ({ protocolVersion: 1, hostId: this.options.hostId, sessionId, requestId: input.requestId,
      workerPid: input.target.workerPid, name: input.target.name, targetId: input.target.targetId, outcome, ...(message ? { message } : {}) });
    const rejected = (message: string) => Response.json(receipt('rejected', message), { headers });
    if (input.controlEpoch !== this.epoch) return rejected('The browser host restarted. Refresh before sending another action.');
    const now = (this.options.now ?? Date.now)();
    for (const [key, value] of this.receipts) if (value.settled && now - value.createdAt > BROWSER_CONTROL_MAX_AGE_MS * 2) this.receipts.delete(key);
    const key = `${sessionId}:${input.requestId}`, hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior = this.receipts.get(key);
    if (prior) return prior.hash === hash ? Response.json(await prior.result, { headers }) : rejected('This browser action identity was already used for different input.');
    if (input.capturedAt > now + 5000 || now - input.capturedAt > BROWSER_CONTROL_MAX_AGE_MS) return rejected('The browser preview is too old. Refresh before interacting.');
    if (this.receipts.size >= 4096) return rejected('This host is handling too many browser actions. Wait before trying a new action.');
    // Reserve the identity before the first asynchronous lookup; concurrent retry
    // requests must observe the same promise even while resolving the worker.
    const result = Promise.resolve().then(async (): Promise<BrowserControlReceipt> => {
      if (!this.options.sessionExists(sessionId)) return receipt('rejected', 'The browser session is no longer available.');
      let handle: BrowserControlHandle | undefined;
      try { handle = await this.options.getExistingHandle(sessionId); } catch { return receipt('rejected', 'The browser worker is unavailable.'); }
      if (!handle || handle.workerFailure || handle.workerPid !== input.target.workerPid) return receipt('rejected', 'The browser worker changed. Refresh before interacting.');
      try {
        const value = await handle.controlBrowser(input);
        if (!this.options.sessionExists(sessionId) || handle.workerFailure || await this.options.getExistingHandle(sessionId) !== handle) return receipt('unknown', 'The browser worker changed during the action. Inspect the page before acting again.');
        if (value.name !== input.target.name || value.targetId !== input.target.targetId) throw new Error('Browser result identity changed.');
        // Returned text remains untrusted page data and is bounded before IPC.
        if (typeof value.url !== 'string' || value.url.length > 8192 || typeof value.title !== 'string' || value.title.length > 1024) throw new Error('Invalid browser action result.');
        return { ...receipt('completed'), context: parseBrowserDocumentContext(value.context), url: value.url, title: value.title };
      } catch (error) {
        return error instanceof Error && error.name === 'BrowserActionRejected'
          ? receipt('rejected', 'The page changed or its native browser is busy. Refresh and try again.')
          : receipt('unknown', 'The action may have reached the page. Refresh and inspect it before acting again.');
      }
    });
    const record = { hash, createdAt: now, settled: false, result }; this.receipts.set(key, record);
    void result.finally(() => { record.settled = true; }).catch(() => {});
    return Response.json(await result, { headers });
  }
}
