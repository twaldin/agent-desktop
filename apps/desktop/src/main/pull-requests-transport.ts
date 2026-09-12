import {
  PULL_REQUESTS_HOST_HEADER,
  parsePullRequestReadRequest,
  parsePullRequestReadResult,
  type PullRequestReadRequest,
} from "../../../../packages/shared/src/pull-requests";
import { readBrowserJSON } from "./browser-frame-transport";
import type { HostEndpoint } from "./host-transport";

export async function readPullRequests(
  endpoint: HostEndpoint,
  value: PullRequestReadRequest,
) {
  if (!endpoint.hostId)
    throw new Error("Choose the pull request’s execution host.");
  const input = parsePullRequestReadRequest(value);
  const response = await fetch(`${endpoint.origin}/v1/pull-requests`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(90_000),
    headers: {
      "content-type": "application/json",
      [PULL_REQUESTS_HOST_HEADER]: endpoint.hostId,
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
    },
    body: JSON.stringify(input),
  });
  if (response.headers.get(PULL_REQUESTS_HOST_HEADER) !== endpoint.hostId) {
    await response.body?.cancel();
    throw new Error("The pull request response belongs to another host.");
  }
  const result = await readBrowserJSON(
    response,
    response.ok ? 12 * 1024 * 1024 : 16_384,
  );
  if (!response.ok) {
    const error =
      result && typeof result === "object" && "error" in result
        ? result.error
        : undefined;
    const message =
      typeof error === "string"
        ? error
        : error &&
            typeof error === "object" &&
            "message" in error &&
            typeof error.message === "string"
          ? error.message
          : undefined;
    throw new Error(
      message ?? `Pull request read failed (${response.status}).`,
    );
  }
  return parsePullRequestReadResult(result, input);
}
