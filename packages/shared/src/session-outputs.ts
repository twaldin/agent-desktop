import { IMAGE_ATTACHMENT_MIME_TYPES, MAX_IMAGE_ATTACHMENT_BYTES, type ImageAttachmentMimeType } from './attachments';
export const SESSION_OUTPUTS_OWNER_HEADER = 'X-Agent-Host-Id';
export const MAX_SESSION_OUTPUTS = 100;
interface OutputIdentity { entryId: string; turnId: string; revision: string; label: string }
export type SessionOutput = OutputIdentity & (
  | { kind: 'file'; path: string }
  | { kind: 'html-preview'; path: string; branch: string }
  | { kind: 'generated-image'; path: string; imageIndex: number; mimeType: ImageAttachmentMimeType; bytes: number; sha256: string }
  | { kind: 'mcp'; serverName: string; toolName: string; resourceUri: string }
  | { kind: 'website'; url: string }
);
export interface SessionOutputs { epoch: string; revision: string; outputs: SessionOutput[]; truncated: boolean; warnings: string[] }
export function sessionOutputKey(output: SessionOutput): string {
  return output.kind === 'file' || output.kind === 'html-preview' || output.kind === 'generated-image' ? `path:${output.path}`
    : output.kind === 'website' ? `url:${output.url}` : JSON.stringify(['mcp', output.serverName, output.toolName, output.resourceUri]);
}
function text(value: unknown, limit = 200): string {
  if (typeof value !== 'string' || !value || value.length > limit || /[\0-\x1f\x7f]/.test(value)) throw new Error('Invalid saved output identity.');
  return value;
}
function digest(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid saved output revision.'); return value; }
export function parseSessionOutputs(value: unknown): SessionOutputs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved outputs response.');
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.outputs) || v.outputs.length > MAX_SESSION_OUTPUTS || typeof v.truncated !== 'boolean'
    || !Array.isArray(v.warnings) || v.warnings.length > 10) throw new Error('Invalid saved outputs response.');
  const seen = new Set<string>();
  const outputs = Array.from(v.outputs, (raw): SessionOutput => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid saved output.');
    const r = raw as Record<string, unknown>, base = { entryId: text(r.entryId), turnId: text(r.turnId), revision: digest(r.revision), label: text(r.label, 1000) };
    let output: SessionOutput;
    if (r.kind === 'file' || r.kind === 'html-preview' || r.kind === 'generated-image') {
      const path = text(r.path, 16_384);
      if (!path.startsWith('/') || path.split('/').some(part => part === '.' || part === '..') || path.includes('//')) throw new Error('Invalid saved output path.');
      if (r.kind === 'file') output = { ...base, kind: r.kind, path };
      else if (r.kind === 'html-preview') output = { ...base, kind: r.kind, path, branch: digest(r.branch) };
      else {
        if (!Number.isSafeInteger(r.imageIndex) || (r.imageIndex as number) < 0 || (r.imageIndex as number) >= 100
          || !Number.isSafeInteger(r.bytes) || (r.bytes as number) < 1 || (r.bytes as number) > MAX_IMAGE_ATTACHMENT_BYTES
          || !IMAGE_ATTACHMENT_MIME_TYPES.includes(r.mimeType as ImageAttachmentMimeType)) throw new Error('Invalid generated image identity.');
        output = { ...base, kind: r.kind, path, imageIndex: r.imageIndex as number, bytes: r.bytes as number, mimeType: r.mimeType as ImageAttachmentMimeType, sha256: digest(r.sha256) };
      }
    } else if (r.kind === 'mcp') {
      const resourceUri = text(r.resourceUri, 4096); if (!resourceUri.startsWith('ui://')) throw new Error('Invalid saved app resource.');
      output = { ...base, kind: r.kind, serverName: text(r.serverName, 1024), toolName: text(r.toolName, 1024), resourceUri };
    } else if (r.kind === 'website') {
      const url = new URL(text(r.url, 8192));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid saved output website.');
      output = { ...base, kind: r.kind, url: url.href };
    } else throw new Error('Unknown saved output type.');
    const key = sessionOutputKey(output); if (seen.has(key)) throw new Error('Duplicate saved output identity.'); seen.add(key); return output;
  });
  return { epoch: text(v.epoch), revision: digest(v.revision), outputs, truncated: v.truncated, warnings: Array.from(v.warnings, value => text(value, 1000)) };
}
