import { SESSION_OUTPUTS_OWNER_HEADER, parseSessionOutputs, type SessionOutputs } from '@agent-desktop/shared';
interface OutputOwner { getSessionOutputs(): Promise<SessionOutputs> }
/** Saved output inspection never starts a worker, executes a tool, or scans a directory. */
export class SessionOutputsHttp {
  #reads = 0;
  constructor(private readonly options: {
    hostId: string;
    sessionExists(id: string): boolean;
    existing(id: string): Promise<OutputOwner | undefined>;
  }) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/outputs$/.exec(url.pathname);
    if (!match) return;
    const headers = { 'Cache-Control': 'no-store', [SESSION_OUTPUTS_OWNER_HEADER]: this.options.hostId };
    const fail = (status: number, message: string) => Response.json({ error: message }, { status, headers });
    if (request.method !== 'GET') return fail(405, 'Use GET for saved outputs.');
    if (request.headers.get(SESSION_OUTPUTS_OWNER_HEADER) !== this.options.hostId) return fail(409, 'The selected output owner changed.');
    let id: string;
    try { id = decodeURIComponent(match[1]!); } catch { return fail(400, 'Invalid task identity.'); }
    if (!id || id.length > 200 || /[\0-\x1f\x7f]/.test(id)) return fail(400, 'Invalid task identity.');
    if (this.#reads >= 2) return fail(429, 'Saved output inspections are busy. Retry when they finish.');
    this.#reads++;
    try {
      if (!this.options.sessionExists(id)) return fail(409, 'The original task is unavailable.');
      const owner = await this.options.existing(id);
      if (!owner) return fail(503, 'Open the task to load its saved outputs.');
      const value = parseSessionOutputs(await owner.getSessionOutputs());
      if (!this.options.sessionExists(id) || await this.options.existing(id) !== owner) return fail(409, 'The original output owner retired.');
      return Response.json({ hostId: this.options.hostId, sessionId: id, value }, { headers });
    } catch { return fail(503, 'Saved outputs could not be inspected. Refresh after the original task reconnects.'); }
    finally { this.#reads--; }
  }
}
