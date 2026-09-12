import { SESSION_OUTPUTS_OWNER_HEADER } from '@agent-desktop/shared';
import { parseHtmlPreviewRequest, parseHtmlPreviewLease, type HtmlPreviewRequest, type HtmlPreviewLease } from '../../../packages/shared/src/html-preview';
import { readMcpAppBody } from './session-mcp-app-http';
interface Owner { openHtmlPreview(request: HtmlPreviewRequest): Promise<HtmlPreviewLease>; releaseHtmlPreview(id: string): Promise<void> }
export class HtmlPreviewHttp {
  #pending = 0;
  constructor(private readonly options: { hostId: string; sessionExists(id: string): boolean; existing(id: string): Promise<Owner | undefined> }) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/html-preview\/(open|release)$/.exec(url.pathname); if (!match) return;
    const headers = { 'Cache-Control': 'no-store', [SESSION_OUTPUTS_OWNER_HEADER]: this.options.hostId };
    const fail = (status: number, message: string) => Response.json({ error: message }, { status, headers });
    if (request.method !== 'POST') return fail(405, 'Use POST for HTML preview leases.');
    if (request.headers.get(SESSION_OUTPUTS_OWNER_HEADER) !== this.options.hostId) return fail(409, 'The original preview host changed.');
    if (this.#pending >= 4) return fail(429, 'HTML preview operations are busy.');
    this.#pending++;
    try {
      const sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || sessionId.length > 200 || /[\0-\x1f\x7f]/.test(sessionId) || !this.options.sessionExists(sessionId)) return fail(409, 'The original task is unavailable.');
      const body = await readMcpAppBody(request);
      const input = match[2] === 'open' ? parseHtmlPreviewRequest(body) : undefined;
      const leaseId = (body as { leaseId?: unknown })?.leaseId;
      if (!input && (typeof leaseId !== 'string' || !/^[a-f0-9-]{36}$/.test(leaseId))) return fail(400, 'Invalid HTML preview lease.');
      const owner = await this.options.existing(sessionId);
      if (!owner || !this.options.sessionExists(sessionId)) return fail(409, 'The original task worker is not loaded.');
      if (!input) { await owner.releaseHtmlPreview(leaseId as string); return Response.json({ hostId: this.options.hostId, sessionId, released: true }, { headers }); }
      const value = parseHtmlPreviewLease(await owner.openHtmlPreview(input), input);
      if (request.signal.aborted || !this.options.sessionExists(sessionId) || await this.options.existing(sessionId) !== owner) {
        await owner.releaseHtmlPreview(value.leaseId); return fail(409, 'The original HTML owner retired during preparation.');
      }
      return Response.json({ hostId: this.options.hostId, sessionId, value }, { headers });
    } catch { return fail(503, 'The saved HTML preview is unavailable. Refresh the original output before retrying.'); }
    finally { this.#pending--; }
  }
}
