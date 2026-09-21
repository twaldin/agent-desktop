import { TURN_REVIEW_OWNER_HEADER, parseTurnReview, type TurnReview } from '@agent-desktop/shared';
import type { HostEndpoint } from './host-transport';
/** Session-owned recorded turn read; the owner header must match on request and reply. */
export async function requestTurnReview(endpoint: HostEndpoint, sessionId: string): Promise<TurnReview> {
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || /[\0-\x1f\x7f]/.test(sessionId)) throw new Error('Select the conversation whose turn to review.');
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/turn-review`, {
    headers: { [TURN_REVIEW_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) },
    signal: AbortSignal.timeout(35_000), redirect: 'error',
  });
  if (response.headers.get(TURN_REVIEW_OWNER_HEADER) !== endpoint.hostId) { await response.body?.cancel(); throw new Error('The recorded turn belongs to another host.'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Missing recorded turn review.');
  let value: unknown;
  try {
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 8 * 1024 * 1024) throw new Error('Recorded turn review exceeds the 8 MiB response limit.');
      chunks.push(part.value);
    }
    value = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const envelope = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (!response.ok) throw new Error(typeof envelope.error === 'string' ? envelope.error : 'Recorded turn review failed.');
  if (envelope.hostId !== endpoint.hostId || envelope.sessionId !== sessionId) throw new Error('The recorded turn owner changed.');
  const review = parseTurnReview(envelope.value);
  if (review.sessionId !== sessionId) throw new Error('The recorded turn owner changed.');
  return review;
}
