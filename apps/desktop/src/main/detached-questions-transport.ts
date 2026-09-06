import { parseDetachedQuestionsSnapshot, SESSION_ACTIVITY_OWNER_HEADER, type DetachedQuestionsSnapshot } from '@agent-desktop/shared';
import { HostRequestError, type HostEndpoint } from './host-transport';

export async function requestDetachedQuestions(endpoint: HostEndpoint, sessionId: string): Promise<DetachedQuestionsSnapshot | null> {
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || sessionId.includes('\0')) throw new Error('Select a valid question owner.');
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/questions`, { headers: {
    [SESSION_ACTIVITY_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
  }, signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (response.ok && response.headers.get(SESSION_ACTIVITY_OWNER_HEADER) !== endpoint.hostId) { await response.body?.cancel(); throw new HostRequestError('Questions belong to a different host.', 409, 'OWNER_MISMATCH'); }
  const value = await response.json();
  if (!response.ok) {
    const detail = value && typeof value === 'object' && 'error' in value ? value.error : undefined;
    const code = detail && typeof detail === 'object' && 'code' in detail && typeof detail.code === 'string' ? detail.code : undefined;
    if (response.status === 404 && !code) return null;
    throw new HostRequestError('Questions could not be loaded from the owning host.', response.status, code);
  }
  const result = parseDetachedQuestionsSnapshot(value);
  if (result.hostId !== endpoint.hostId || result.sessionId !== sessionId) throw new HostRequestError('Questions do not match the selected conversation.', 409, 'OWNER_MISMATCH');
  return result;
}
