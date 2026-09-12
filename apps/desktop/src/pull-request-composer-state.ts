import { parsePullRequestReadRequest, type PullRequestIdentity } from "../../../packages/shared/src/pull-requests";
import { parsePullRequestWriteRequest, parsePullRequestWriteReceipt, type PullRequestWriteRequest, type PullRequestWriteReceipt, type PullRequestWriteAction } from "../../../packages/shared/src/pull-request-write";

export interface PullRequestComposer {
  hostId: string;
  accountId: string;
  pullRequest: PullRequestIdentity;
  mode: "comment" | "review";
  body: string;
  action: PullRequestWriteAction;
  request?: PullRequestWriteRequest;
  receipt?: PullRequestWriteReceipt;
}
export function pullRequestComposerKey(input: Pick<PullRequestComposer, "hostId" | "accountId" | "pullRequest" | "mode">): string {
  return JSON.stringify([input.hostId, input.accountId, input.pullRequest.hostname.toLowerCase(), input.pullRequest.owner.toLowerCase(), input.pullRequest.repository.toLowerCase(), input.pullRequest.number, input.mode]);
}
export function parsePullRequestComposers(value: unknown): PullRequestComposer[] {
  if (!Array.isArray(value) || value.length > 30 || new TextEncoder().encode(JSON.stringify(value)).byteLength > 256_000)
    throw new Error("Resolve or clear another saved pull request draft before adding more text.");
  const entries = Array.from(value, raw => {
    if (!raw || typeof raw !== "object" || typeof raw.hostId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(raw.hostId) ||
      !["comment", "review"].includes(raw.mode) || typeof raw.body !== "string" || raw.body.includes("\0") || new TextEncoder().encode(raw.body).byteLength > 60_000)
      throw new Error("Invalid saved pull request draft.");
    const owner = parsePullRequestReadRequest({ type: "detail", accountId: raw.accountId, pullRequest: raw.pullRequest, pageSize: 50 });
    if (owner.type !== "detail") throw new Error("Invalid pull request draft owner.");
    if (!(raw.mode === "comment" ? raw.action === "comment" : ["review_comment", "approve", "request_changes"].includes(raw.action)))
      throw new Error("Invalid pull request draft decision.");
    const entry: PullRequestComposer = { hostId: raw.hostId, accountId: owner.accountId, pullRequest: owner.pullRequest, mode: raw.mode, body: raw.body, action: raw.action };
    if (raw.request !== undefined) {
      entry.request = parsePullRequestWriteRequest(raw.request);
      if (entry.request.accountId !== entry.accountId || JSON.stringify(entry.request.pullRequest) !== JSON.stringify(entry.pullRequest) || entry.request.action !== entry.action)
        throw new Error("Saved submission belongs to another draft.");
      if (raw.receipt !== undefined) entry.receipt = parsePullRequestWriteReceipt(raw.receipt, entry.hostId, entry.request);
      if (entry.receipt?.outcome !== "succeeded" && entry.body.trim() !== entry.request.body) throw new Error("Saved submission text changed.");
    } else if (raw.receipt !== undefined) throw new Error("Saved submission has no original request.");
    return entry;
  });
  if (new Set(entries.map(pullRequestComposerKey)).size !== entries.length) throw new Error("Duplicate pull request drafts.");
  return entries;
}
