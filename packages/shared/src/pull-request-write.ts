import { parsePullRequestReadRequest, type PullRequestIdentity } from "./pull-requests";

export interface PullRequestWritesCapability { version: 1; reviewThreads?: 1 }
export const PULL_REQUEST_WRITES_CAPABILITY: PullRequestWritesCapability = { version: 1, reviewThreads: 1 };
export type PullRequestWriteAction = "comment" | "review_comment" | "approve" | "request_changes" | "inline_comment" | "reply" | "update" | "delete" | "resolve" | "unresolve";
export interface PullRequestInlineSelection { path: string; side: "LEFT" | "RIGHT"; line: number; startSide?: "LEFT" | "RIGHT"; startLine?: number }
export interface PullRequestDiscussionTarget { id: string; kind: "comment" | "review" | "review_comment" | "thread" }
export interface PullRequestWriteRequest {
  requestId: string;
  accountId: string;
  pullRequest: PullRequestIdentity;
  action: PullRequestWriteAction;
  expectedHeadOid: string;
  body: string;
  inline?: PullRequestInlineSelection;
  target?: PullRequestDiscussionTarget;
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
export function parsePullRequestInlineSelection(value: unknown): PullRequestInlineSelection {
  const input = object(value, ["path", "side", "line", "startSide", "startLine"]);
  const path = text(input.path, 4096);
  if (!path || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..") || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Choose an original changed-file path.");
  const side = input.side;
  if (side !== "LEFT" && side !== "RIGHT") throw new Error("Choose the original diff side.");
  if (!Number.isSafeInteger(input.line) || Number(input.line) < 1) throw new Error("Choose an actual changed-file line.");
  const line = Number(input.line);
  if (input.startLine === undefined && input.startSide === undefined) return { path, side, line };
  if (!Number.isSafeInteger(input.startLine) || Number(input.startLine) < 1 || (input.startSide !== "LEFT" && input.startSide !== "RIGHT")) throw new Error("Choose the complete original diff range.");
  const startLine = Number(input.startLine), startSide = input.startSide;
  if (startSide === side && startLine > line) throw new Error("The diff range is reversed.");
  return { path, side, line, startSide, startLine };
}
export function parsePullRequestWriteRequest(value: unknown): PullRequestWriteRequest {
  const input = object(value, ["requestId", "accountId", "pullRequest", "action", "expectedHeadOid", "body", "inline", "target"]);
  if (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(input.requestId))
    throw new Error("Invalid pull request submission ID.");
  if (typeof input.action !== "string" || !["comment", "review_comment", "approve", "request_changes", "inline_comment", "reply", "update", "delete", "resolve", "unresolve"].includes(input.action))
    throw new Error("Invalid pull request submission action.");
  const detail = parsePullRequestReadRequest({ type: "detail", accountId: input.accountId,
    pullRequest: input.pullRequest, pageSize: 50 });
  if (detail.type !== "detail") throw new Error("Invalid pull request submission owner.");
  const expectedHeadOid = text(input.expectedHeadOid, 64);
  if (!/^[a-f0-9]{40,64}$/i.test(expectedHeadOid)) throw new Error("Refresh the pull request before submitting.");
  const body = text(input.body, 60_000).trim();
  const bodyless = ["delete", "resolve", "unresolve"].includes(input.action);
  if (!body && input.action !== "approve" && !bodyless) throw new Error("A comment or review body is required.");
  if (bodyless && body) throw new Error("This discussion action does not accept a comment body.");
  const inline = input.action === "inline_comment" ? parsePullRequestInlineSelection(input.inline) : undefined;
  if (!inline && input.inline !== undefined) throw new Error("Only inline comments accept a diff selection.");
  let target: PullRequestDiscussionTarget | undefined;
  if (["reply", "update", "delete", "resolve", "unresolve"].includes(input.action)) {
    const node = object(input.target, ["id", "kind"]);
    const id = text(node.id, 256);
    if (!id || /[\x00-\x20\x7f]/.test(id)) throw new Error("Choose the original GitHub discussion node.");
    const kinds = ["reply", "resolve", "unresolve"].includes(input.action) ? ["thread"] : input.action === "delete" ? ["comment", "review_comment"] : ["comment", "review", "review_comment"];
    if (typeof node.kind !== "string" || !kinds.includes(node.kind)) throw new Error("This action does not apply to the selected discussion node.");
    target = { id, kind: node.kind as PullRequestDiscussionTarget["kind"] };
  } else if (input.target !== undefined) throw new Error("This submission does not accept a discussion target.");
  return { requestId: input.requestId, accountId: detail.accountId, pullRequest: detail.pullRequest,
    action: input.action as PullRequestWriteAction, expectedHeadOid, body, ...(inline ? { inline } : {}), ...(target ? { target } : {}) };
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
