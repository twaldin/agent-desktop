import { PULL_REQUESTS_HOST_HEADER } from "../../../../packages/shared/src/pull-requests";
import { parsePullRequestWriteRequest, parsePullRequestWriteReceipt, type PullRequestWriteRequest } from "../../../../packages/shared/src/pull-request-write";
import { readBrowserJSON } from "./browser-frame-transport";
import type { HostEndpoint } from "./host-transport";

export async function requestPullRequestWrite(endpoint: HostEndpoint, operation: "submit" | "status", value: PullRequestWriteRequest) {
  if (!endpoint.hostId) throw new Error("Choose the pull request’s execution host.");
  if (operation !== "submit" && operation !== "status") throw new Error("Invalid pull request submission operation.");
  const input = parsePullRequestWriteRequest(value);
  const response = await fetch(`${endpoint.origin}/v1/pull-requests/${operation === "submit" ? "submit" : "submission-status"}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000),
    headers: { "content-type": "application/json", [PULL_REQUESTS_HOST_HEADER]: endpoint.hostId,
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) }, body: JSON.stringify(input),
  });
  if (response.headers.get(PULL_REQUESTS_HOST_HEADER) !== endpoint.hostId) {
    await response.body?.cancel(); throw new Error("The submission response belongs to another host. The saved request is preserved.");
  }
  const result = await readBrowserJSON(response, 140_000);
  if (!response.ok) throw new Error("The submission could not be confirmed. Your saved request is preserved; check its status before trying again.");
  if (result === null && operation === "status") return null;
  return parsePullRequestWriteReceipt(result, endpoint.hostId, input);
}
