import { parsePullRequestReadRequest, type PullRequestIdentity } from "./pull-requests";

export const PULL_REQUEST_WRITES_CAPABILITY = { version: 1 } as const;
export type PullRequestWriteAction = "comment" | "review_comment" | "approve" | "request_changes";
export interface PullRequestWriteRequest {
  requestId: string;
  accountId: string;
  pullRequest: PullRequestIdentity;
  action: PullRequestWriteAction;
  expectedHeadOid: string;
  body: string;
}
export interface PullRequestWriteReceipt {
  hostId: string;
  request: PullRequestWriteRequest;
  outcome: "pending" | "succeeded" | "failed" | "unknown";
  message: string;
  url: string | null;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid pull request submission fields.");
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > limit || value.includes("\0"))
    throw new Error("Invalid pull request submission text.");
  return value;
}
export function parsePullRequestWriteRequest(value: unknown): PullRequestWriteRequest {
  const input = object(value, ["requestId", "accountId", "pullRequest", "action", "expectedHeadOid", "body"]);
  if (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(input.requestId))
    throw new Error("Invalid pull request submission ID.");
  if (typeof input.action !== "string" || !["comment", "review_comment", "approve", "request_changes"].includes(input.action))
    throw new Error("Invalid pull request submission action.");
  const detail = parsePullRequestReadRequest({ type: "detail", accountId: input.accountId,
    pullRequest: input.pullRequest, pageSize: 50 });
  if (detail.type !== "detail") throw new Error("Invalid pull request submission owner.");
  const expectedHeadOid = text(input.expectedHeadOid, 64);
  if (!/^[a-f0-9]{40,64}$/i.test(expectedHeadOid)) throw new Error("Refresh the pull request before submitting.");
  const body = text(input.body, 60_000).trim();
  if (!body && input.action !== "approve") throw new Error("A comment or review body is required.");
  return { requestId: input.requestId, accountId: detail.accountId, pullRequest: detail.pullRequest,
    action: input.action as PullRequestWriteAction, expectedHeadOid, body };
}
export function pullRequestWriteIdentity(value: PullRequestWriteRequest): string {
  return JSON.stringify(parsePullRequestWriteRequest(value));
}
export function parsePullRequestWriteReceipt(value: unknown, hostId: string, request: PullRequestWriteRequest): PullRequestWriteReceipt {
  const input = object(value, ["hostId", "request", "outcome", "message", "url"]);
  const saved = parsePullRequestWriteRequest(input.request);
  if (input.hostId !== hostId || pullRequestWriteIdentity(saved) !== pullRequestWriteIdentity(request))
    throw new Error("The pull request submission owner changed.");
  if (typeof input.outcome !== "string" || !["pending", "succeeded", "failed", "unknown"].includes(input.outcome))
    throw new Error("Invalid pull request submission outcome.");
  const message = text(input.message, 4096);
  let url: string | null = null;
  if (input.url !== null) {
    url = text(input.url, 4096);
    const parsed = new URL(url), target = saved.pullRequest;
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
      parsed.hostname.toLowerCase() !== target.hostname.toLowerCase() ||
      parsed.pathname.toLowerCase() !== `/${target.owner}/${target.repository}/pull/${target.number}`.toLowerCase())
      throw new Error("GitHub returned a foreign submission URL.");
  }
  if (input.outcome === "succeeded" && !url) throw new Error("GitHub did not confirm the submitted item.");
  return { hostId, request: saved, outcome: input.outcome as PullRequestWriteReceipt["outcome"], message, url };
}

export interface PullRequestWritesBridge {
  submit(hostId: string, request: PullRequestWriteRequest): Promise<PullRequestWriteReceipt>;
  status(hostId: string, request: PullRequestWriteRequest): Promise<PullRequestWriteReceipt | null>;
}
