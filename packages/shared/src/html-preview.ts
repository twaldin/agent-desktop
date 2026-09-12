import { parseSessionOutputs, type SessionOutput } from './session-outputs';
export type HtmlPreviewOutput = Extract<SessionOutput, { kind: 'html-preview' }>;
/** Local admission deadline; never the remote host expiry timestamp. */
export interface HtmlPreviewAdmission { workerPid: number; expiresAt: number }
export interface HtmlPreviewRequest { epoch: string; output: HtmlPreviewOutput }
export interface HtmlPreviewLease { leaseId: string; epoch: string; branch: string; entryId: string; revision: string; url: string; workerPid: number; expiresAt: number; validForMs: number }
const id = (v: unknown): string => { if (typeof v !== 'string' || !/^[a-f0-9-]{36}$/.test(v)) throw new Error('Invalid HTML preview lease.'); return v; };
export function parseHtmlPreviewRequest(value: unknown): HtmlPreviewRequest {
  const v = value as Partial<HtmlPreviewRequest> | null;
  const parsed = parseSessionOutputs({ epoch: v?.epoch, revision: '0'.repeat(64), outputs: [v?.output], truncated: false, warnings: [] });
  const output = parsed.outputs[0]!;
  if (output.kind !== 'html-preview' || !/\.html?$/i.test(output.path)) throw new Error('Only the original saved HTML output can be previewed.');
  return { epoch: parsed.epoch, output };
}
export function parseHtmlPreviewLease(value: unknown, request: HtmlPreviewRequest): HtmlPreviewLease {
  const v = value as Partial<HtmlPreviewLease> | null;
  if (!v || v.epoch !== request.epoch || v.branch !== request.output.branch || v.entryId !== request.output.entryId || v.revision !== request.output.revision
    || !Number.isSafeInteger(v.workerPid) || v.workerPid! <= 0 || !Number.isSafeInteger(v.expiresAt) || v.expiresAt! <= 0
    || !Number.isSafeInteger(v.validForMs) || v.validForMs! <= 0 || v.validForMs! > 300_000) throw new Error('The HTML preview belongs to a different saved output.');
  const leaseId = id(v.leaseId), url = new URL(String(v.url));
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith(`/${leaseId}/`)) throw new Error('Invalid owning-worker preview address.');
  return { leaseId, epoch: v.epoch, branch: v.branch, entryId: v.entryId, revision: v.revision, url: url.href, workerPid: v.workerPid!, expiresAt: v.expiresAt!, validForMs: v.validForMs! };
}
