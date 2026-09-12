import { SESSION_OUTPUTS_OWNER_HEADER } from '@agent-desktop/shared';
import { parseHtmlPreviewRequest, parseHtmlPreviewLease, type HtmlPreviewRequest, type HtmlPreviewLease } from '../../../../packages/shared/src/html-preview';
import type { HostEndpoint } from './host-transport';
export async function requestHtmlPreview(endpoint: HostEndpoint, sessionId: string, input: HtmlPreviewRequest | { leaseId: string }): Promise<HtmlPreviewLease | undefined> {
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || /[\0-\x1f\x7f]/.test(sessionId)) throw new Error('Choose the original HTML preview owner.');
  const opening = 'output' in input, body = opening ? parseHtmlPreviewRequest(input) : input;
  if (!opening && !/^[a-f0-9-]{36}$/.test(input.leaseId)) throw new Error('Invalid HTML preview lease.');
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/html-preview/${opening ? 'open' : 'release'}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', [SESSION_OUTPUTS_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(35_000), redirect: 'error',
  });
  if (response.headers.get(SESSION_OUTPUTS_OWNER_HEADER) !== endpoint.hostId) { await response.body?.cancel(); throw new Error('The HTML preview host changed.'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Missing HTML preview response.');
  let value: any;
  try {
    const parts: Uint8Array[] = []; let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 32 * 1024) throw new Error('HTML preview response exceeds its bound.'); parts.push(part.value); }
    value = JSON.parse(Buffer.concat(parts, size).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!response.ok || value.hostId !== endpoint.hostId || value.sessionId !== sessionId) throw new Error(typeof value.error === 'string' ? value.error : 'The HTML preview owner changed.');
  if (opening) return parseHtmlPreviewLease(value.value, body as HtmlPreviewRequest);
  if (value.released !== true) throw new Error('HTML preview release was not confirmed.');
}
