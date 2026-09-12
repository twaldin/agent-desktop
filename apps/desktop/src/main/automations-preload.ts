import { parseAutomationsQuery, parseAutomationsSnapshot, parseAutomationMutation, parseAutomationMutationResult,
  type AutomationsBridge } from '../../../../packages/shared/src/automations';

export function createAutomationsBridge(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): AutomationsBridge {
  return {
    list: async (hostId, query = {}) => parseAutomationsSnapshot(await invoke('host:automations', hostId, parseAutomationsQuery(query)), hostId),
    mutate: async (hostId, value) => {
      const mutation = parseAutomationMutation(value);
      return parseAutomationMutationResult(await invoke('host:automation-mutate', hostId, mutation), hostId, mutation);
    },
  };
}
