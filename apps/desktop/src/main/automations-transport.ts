import { AUTOMATIONS_OWNER_HEADER, parseAutomationsQuery, parseAutomationsSnapshot, parseAutomationMutation,
  parseAutomationMutationResult, type AutomationsQuery, type AutomationMutation } from '../../../../packages/shared/src/automations';
import type { HostEndpoint } from './host-transport';
import { readBrowserJSON } from './browser-frame-transport';

async function request(endpoint: HostEndpoint, query: AutomationsQuery, mutation?: AutomationMutation): Promise<unknown> {
  if (!endpoint.hostId) throw new Error('Choose the scheduled task’s owning host.');
  const search = new URLSearchParams(parseAutomationsQuery(query) as Record<string, string>);
  const response = await fetch(`${endpoint.origin}/v1/automations${search.size ? `?${search}` : ''}`, {
    method: mutation ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { [AUTOMATIONS_OWNER_HEADER]: endpoint.hostId, 'Content-Type': 'application/json',
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) },
    ...(mutation ? { body: JSON.stringify(mutation) } : {}),
  });
  if (response.headers.get(AUTOMATIONS_OWNER_HEADER) !== endpoint.hostId) {
    await response.body?.cancel();
    throw new Error('The scheduled task response belongs to another host. The request outcome is unknown.');
  }
  const value = await readBrowserJSON(response, response.ok ? 9 * 1024 * 1024 : 16_384);
  if (!response.ok) {
    const error = value && typeof value === 'object' && 'error' in value ? value.error : undefined;
    const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : undefined;
    throw new Error(message || `Scheduled task request failed (${response.status}). Inspect its saved state before submitting a different request.`);
  }
  return value;
}

export async function listAutomations(endpoint: HostEndpoint, query: AutomationsQuery = {}) {
  return parseAutomationsSnapshot(await request(endpoint, parseAutomationsQuery(query)), endpoint.hostId);
}

export async function mutateAutomation(endpoint: HostEndpoint, mutation: AutomationMutation) {
  const input = parseAutomationMutation(mutation);
  return parseAutomationMutationResult(await request(endpoint, {}, input), endpoint.hostId, input);
}
