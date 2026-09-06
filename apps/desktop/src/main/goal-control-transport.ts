import { parseGoalMutationRequest, parseGoalMutationReceipt, SESSION_ACTIVITY_OWNER_HEADER, type GoalMutationRequest, type GoalMutationReceipt } from '@agent-desktop/shared';
import type { HostEndpoint } from './host-transport';
import { readBrowserJSON } from './browser-frame-transport';

/** Exactly one submission; ambiguous outcomes require an authoritative activity read. */
export async function requestGoalMutation(endpoint: HostEndpoint, sessionId: string, request: GoalMutationRequest): Promise<GoalMutationReceipt> {
  const input = parseGoalMutationRequest(request);
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || sessionId.includes('\0')) throw new Error('Select the goal owning session.');
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/goal-control`, {
    method: 'POST', body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { 'Content-Type': 'application/json', [SESSION_ACTIVITY_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) },
  });
  if (response.headers.get(SESSION_ACTIVITY_OWNER_HEADER) !== endpoint.hostId) {
    await response.body?.cancel(); throw new Error('The goal response belongs to another host; its outcome is unknown.');
  }
  const value = await readBrowserJSON(response, 32_768) as Record<string, unknown>;
  if (!response.ok) {
    const detail = value && typeof value.error === 'object' && value.error !== null ? value.error as Record<string, unknown> : undefined;
    if (detail && typeof detail.message === 'string' && detail.message.trim() && detail.message.length <= 4096
      && ((detail.code === 'INVALID_GOAL_CONTROL_REQUEST' && [400,405].includes(response.status)) || detail.code === 'OWNER_MISMATCH' && response.status === 409)) {
      return { protocolVersion: 1, hostId: endpoint.hostId, sessionId, requestId: input.requestId, outcome: 'rejected', message: detail.message };
    }
    throw new Error(`The goal action could not be confirmed (${response.status}); its outcome is unknown.`);
  }
  return parseGoalMutationReceipt(value, { hostId: endpoint.hostId, sessionId, requestId: input.requestId });
}
