import { parsePullRequestWriteRequest, parsePullRequestWriteReceipt, type PullRequestWritesBridge } from "../../../../packages/shared/src/pull-request-write";
export function createPullRequestWritesBridge(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): PullRequestWritesBridge {
  return {
    async submit(hostId, value) {
      const input = parsePullRequestWriteRequest(value);
      return parsePullRequestWriteReceipt(await invoke("host:pull-request-write", hostId, "submit", input), hostId, input);
    },
    async status(hostId, value) {
      const input = parsePullRequestWriteRequest(value);
      const result = await invoke("host:pull-request-write", hostId, "status", input);
      return result === null ? null : parsePullRequestWriteReceipt(result, hostId, input);
    },
  };
}
