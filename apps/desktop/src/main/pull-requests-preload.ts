import {
  parsePullRequestReadRequest,
  parsePullRequestReadResult,
  type PullRequestsBridge,
} from "../../../../packages/shared/src/pull-requests";

export function createPullRequestsBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): PullRequestsBridge {
  return {
    read: async (hostId, value) => {
      const input = parsePullRequestReadRequest(value);
      return parsePullRequestReadResult(
        await invoke("host:pull-requests", hostId, input),
        input,
      );
    },
  };
}
