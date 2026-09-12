import { SESSION_OUTPUTS_OWNER_HEADER, parseSessionOutputs, type SessionOutputs } from '@agent-desktop/shared';
import type { HostEndpoint } from './host-transport';
export async function requestSessionOutputs(endpoint: HostEndpoint, sessionId: string): Promise<SessionOutputs> {
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || /[\0-\x1f\x7f]/.test(sessionId)) throw new Error('Select the original output task.');
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/outputs`, {
    headers: { [SESSION_OUTPUTS_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) },
    signal: AbortSignal.timeout(35_000), redirect: 'error',
  });
  if (response.headers.get(SESSION_OUTPUTS_OWNER_HEADER) !== endpoint.hostId) { await response.body?.cancel(); throw new Error('The outputs belong to another host.'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Missing saved outputs.');
  let value: any;
  try {
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 2 * 1024 * 1024) throw new Error('Saved outputs exceed the 2 MiB response limit.'); chunks.push(part.value); }
    value = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : 'Saved output inspection failed.');
  if (value?.hostId !== endpoint.hostId || value?.sessionId !== sessionId) throw new Error('The saved output owner changed.');
  return parseSessionOutputs(value.value);
}
