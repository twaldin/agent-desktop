import { parseAutomationMutation, type AutomationMutation } from '../../../packages/shared/src/automations';

export interface AutomationWindowRequest { hostId: string; mutation: AutomationMutation }

export function parseAutomationWindowRequests(value: unknown): AutomationWindowRequest[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Too many unresolved scheduled task requests.');
  const result = Array.from(value, entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.hostId !== 'string' || !entry.hostId || entry.hostId.length > 256) throw new Error('Invalid scheduled task request owner.');
    return { hostId: entry.hostId, mutation: parseAutomationMutation(entry.mutation) };
  });
  if (new Set(result.map(entry => entry.hostId)).size !== result.length) throw new Error('Duplicate unresolved scheduled task host.');
  return result;
}
