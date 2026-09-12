import { parsePullRequestReadRequest, type PullRequestIdentity } from "../../../packages/shared/src/pull-requests";
import { parsePullRequestWriteRequest, parsePullRequestWriteReceipt, type PullRequestWriteRequest, type PullRequestWriteReceipt, type PullRequestWriteAction, type PullRequestInlineSelection, type PullRequestDiscussionTarget } from "../../../packages/shared/src/pull-request-write";

export interface PullRequestComposer {
  hostId: string;
  accountId: string;
  pullRequest: PullRequestIdentity;
  mode: "comment" | "review" | "inline" | "discussion";
  inline?: PullRequestInlineSelection;
  target?: PullRequestDiscussionTarget;
  expectedHeadOid?: string;
  body: string;
  action: PullRequestWriteAction;
  request?: PullRequestWriteRequest;
  receipt?: PullRequestWriteReceipt;
}
export function pullRequestComposerKey(input: Pick<PullRequestComposer, "hostId" | "accountId" | "pullRequest" | "mode" | "inline" | "target" | "expectedHeadOid" | "action">): string {
  return JSON.stringify([input.hostId, input.accountId, input.pullRequest.hostname.toLowerCase(), input.pullRequest.owner.toLowerCase(), input.pullRequest.repository.toLowerCase(), input.pullRequest.number, input.mode, ...(["inline", "discussion"].includes(input.mode) ? [input.action, input.target ?? null, input.inline ?? null, input.mode === "inline" ? input.expectedHeadOid : null] : [])]);
}
export function parsePullRequestComposers(value: unknown): PullRequestComposer[] {
  if (!Array.isArray(value) || value.length > 30 || new TextEncoder().encode(JSON.stringify(value)).byteLength > 256_000)
    throw new Error("Resolve or clear another saved pull request draft before adding more text.");
  const entries = Array.from(value, raw => {
    if (!raw || typeof raw !== "object" || typeof raw.hostId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(raw.hostId) ||
      !["comment", "review", "inline", "discussion"].includes(raw.mode) || typeof raw.body !== "string" || raw.body.includes("\0") || new TextEncoder().encode(raw.body).byteLength > 60_000)
      throw new Error("Invalid saved pull request draft.");
    const owner = parsePullRequestReadRequest({ type: "detail", accountId: raw.accountId, pullRequest: raw.pullRequest, pageSize: 50 });
    if (owner.type !== "detail") throw new Error("Invalid pull request draft owner.");
    if (!(raw.mode === "comment" ? raw.action === "comment" : raw.mode === "review" ? ["review_comment", "approve", "request_changes"].includes(raw.action) : raw.mode === "inline" ? raw.action === "inline_comment" : ["reply", "update", "delete", "resolve", "unresolve"].includes(raw.action)))
      throw new Error("Invalid pull request draft decision.");
    const entry: PullRequestComposer = { hostId: raw.hostId, accountId: owner.accountId, pullRequest: owner.pullRequest, mode: raw.mode, body: raw.body, action: raw.action };
    if (raw.mode === "inline" || raw.mode === "discussion") {
      const shape = parsePullRequestWriteRequest({ requestId: "saved-draft-validation", accountId: entry.accountId, pullRequest: entry.pullRequest, action: entry.action,
        expectedHeadOid: raw.mode === "inline" ? raw.expectedHeadOid : "0".repeat(40), body: ["delete", "resolve", "unresolve"].includes(entry.action) ? "" : "draft", inline: raw.inline, target: raw.target });
      if (shape.inline) { entry.inline = shape.inline; entry.expectedHeadOid = shape.expectedHeadOid; }
      if (shape.target) entry.target = shape.target;
    } else if (raw.inline !== undefined || raw.target !== undefined || raw.expectedHeadOid !== undefined) throw new Error("Unexpected discussion draft fields.");
    if (raw.request !== undefined) {
      entry.request = parsePullRequestWriteRequest(raw.request);
      if (entry.request.accountId !== entry.accountId || JSON.stringify(entry.request.pullRequest) !== JSON.stringify(entry.pullRequest) || entry.request.action !== entry.action || JSON.stringify(entry.request.inline) !== JSON.stringify(entry.inline) || JSON.stringify(entry.request.target) !== JSON.stringify(entry.target) || entry.mode === "inline" && entry.request.expectedHeadOid !== entry.expectedHeadOid)
        throw new Error("Saved submission belongs to another draft.");
      if (raw.receipt !== undefined) entry.receipt = parsePullRequestWriteReceipt(raw.receipt, entry.hostId, entry.request);
      if (entry.receipt?.outcome !== "succeeded" && entry.body.trim() !== entry.request.body) throw new Error("Saved submission text changed.");
    } else if (raw.receipt !== undefined) throw new Error("Saved submission has no original request.");
    return entry;
  });
  if (new Set(entries.map(pullRequestComposerKey)).size !== entries.length) throw new Error("Duplicate pull request drafts.");
  return entries;
}
