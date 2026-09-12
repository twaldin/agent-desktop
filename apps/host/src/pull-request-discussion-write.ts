import type { PullRequestWriteRequest, PullRequestInlineSelection } from "../../../packages/shared/src/pull-request-write";

type Json = Record<string, unknown>;
export class PullRequestDiscussionError extends Error {}
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const parentFields = `number url repository{name owner{login}}`;
export const DISCUSSION_NODE_QUERY = `query($id:ID!){viewer{login}node(id:$id){__typename ... on IssueComment{id url viewerCanUpdate viewerCanDelete pullRequest{${parentFields}}} ... on PullRequestReview{id url viewerCanUpdate pullRequest{${parentFields}}} ... on PullRequestReviewComment{id url viewerCanUpdate viewerCanDelete pullRequest{${parentFields}}} ... on PullRequestReviewThread{id isResolved viewerCanReply viewerCanResolve viewerCanUnresolve pullRequest{${parentFields}}}}}`;

/** Read-time permission is presentation only; this preflight binds the original node and current viewer. */
export function discussionMutation(request: PullRequestWriteRequest, response: Json, login: string) {
  const data = object(response.data), node = object(data.node), target = request.target, pr = request.pullRequest;
  if (!target || String(object(data.viewer).login).toLowerCase() !== login.toLowerCase()) throw new PullRequestDiscussionError("The GitHub discussion viewer changed.");
  const expectedType = { comment: "IssueComment", review: "PullRequestReview", review_comment: "PullRequestReviewComment", thread: "PullRequestReviewThread" }[target.kind];
  const parent = object(node.pullRequest), repository = object(parent.repository);
  const parentUrl = `https://${pr.hostname}/${pr.owner}/${pr.repository}/pull/${pr.number}`;
  if (node.__typename !== expectedType || node.id !== target.id || parent.number !== pr.number ||
      String(repository.name).toLowerCase() !== pr.repository.toLowerCase() || String(object(repository.owner).login).toLowerCase() !== pr.owner.toLowerCase() ||
      String(parent.url).toLowerCase() !== parentUrl.toLowerCase()) throw new PullRequestDiscussionError("The original GitHub discussion is no longer available.");
  const permission = request.action === "reply" ? "viewerCanReply" : request.action === "update" ? "viewerCanUpdate" : request.action === "delete" ? "viewerCanDelete" : request.action === "resolve" ? "viewerCanResolve" : "viewerCanUnresolve";
  if (node[permission] !== true) throw new PullRequestDiscussionError("GitHub does not permit this action on the original discussion.");
  const input: Json = { clientMutationId: request.requestId };
  let method: string, output: string;
  if (request.action === "reply") {
    method = "addPullRequestReviewThreadReply"; input.pullRequestReviewThreadId = target.id; input.body = request.body;
    output = "comment{id url body author{login} pullRequest{number url repository{name owner{login}}}}";
  } else if (request.action === "resolve" || request.action === "unresolve") {
    method = request.action === "resolve" ? "resolveReviewThread" : "unresolveReviewThread"; input.threadId = target.id; output = "thread{id isResolved}";
  } else {
    const suffix = target.kind === "comment" ? "IssueComment" : target.kind === "review" ? "PullRequestReview" : "PullRequestReviewComment";
    method = `${request.action === "update" ? "update" : "delete"}${suffix}`;
    input[request.action === "delete" || target.kind === "comment" ? "id" : target.kind === "review" ? "pullRequestReviewId" : "pullRequestReviewCommentId"] = target.id;
    if (request.action === "update") input.body = request.body;
    output = request.action === "delete" ? "" : `${target.kind === "comment" ? "issueComment" : target.kind === "review" ? "pullRequestReview" : "pullRequestReviewComment"}{id url body}`;
  }
  const type = method[0]!.toUpperCase() + method.slice(1) + "Input";
  return { method, payload: { query: `mutation($input:${type}!){${method}(input:$input){clientMutationId ${output}}}`, input },
    confirm(raw: Json): string {
      const result = object(object(raw.data)[method]);
      if (result.clientMutationId !== request.requestId) throw new PullRequestDiscussionError("GitHub did not confirm the original discussion mutation.");
      if (request.action === "delete") return parentUrl;
      if (request.action === "resolve" || request.action === "unresolve") {
        const thread = object(result.thread);
        if (thread.id !== target.id || thread.isResolved !== (request.action === "resolve")) throw new PullRequestDiscussionError("GitHub did not confirm the original thread state.");
        return parentUrl;
      }
      const item = object(result[request.action === "reply" ? "comment" : target.kind === "comment" ? "issueComment" : target.kind === "review" ? "pullRequestReview" : "pullRequestReviewComment"]);
      if (typeof item.id !== "string" || !item.id || item.body !== request.body || (request.action === "update" && item.id !== target.id)) throw new PullRequestDiscussionError("GitHub did not confirm the original comment.");
      if (request.action === "reply" && (String(object(item.author).login).toLowerCase() !== login.toLowerCase() || object(item.pullRequest).url !== parent.url)) throw new PullRequestDiscussionError("GitHub returned a foreign reply.");
      if (typeof item.url !== "string") throw new PullRequestDiscussionError("GitHub did not return the comment URL.");
      return item.url;
    } };
}

/** Only complete returned hunks may authorize a selection; no blob or line-number guesses. */
export function validateInlinePatch(selection: PullRequestInlineSelection, files: unknown[]): void {
  const matches = files.map(object).filter(file => file.filename === selection.path);
  if (matches.length !== 1 || typeof matches[0]!.patch !== "string") throw new PullRequestDiscussionError("Refresh an available text diff before commenting.");
  const file = matches[0]!, patch = file.patch as string;
  const positions: { side: "LEFT" | "RIGHT"; line: number; hunk: number }[] = [];
  let left = 0, right = 0, leftRemaining = 0, rightRemaining = 0, hunk = 0, complete = true;
  let additions = 0, deletions = 0;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (leftRemaining || rightRemaining) complete = false;
      left = Number(header[1]); right = Number(header[3]); leftRemaining = Number(header[2] ?? 1); rightRemaining = Number(header[4] ?? 1); hunk++; continue;
    }
    if (!hunk || line.startsWith("\\")) continue;
    if (line.startsWith(" ")) { positions.push({ side: "LEFT", line: left++, hunk }, { side: "RIGHT", line: right++, hunk }); leftRemaining--; rightRemaining--; }
    else if (line.startsWith("-")) { positions.push({ side: "LEFT", line: left++, hunk }); leftRemaining--; deletions++; }
    else if (line.startsWith("+")) { positions.push({ side: "RIGHT", line: right++, hunk }); rightRemaining--; additions++; }
    else if (line !== "") complete = false;
    if (leftRemaining < 0 || rightRemaining < 0) complete = false;
  }
  if (!complete || !hunk || leftRemaining || rightRemaining || additions !== file.additions || deletions !== file.deletions) throw new PullRequestDiscussionError("The returned diff is incomplete. Refresh before commenting.");
  const end = positions.find(p => p.side === selection.side && p.line === selection.line);
  const start = positions.find(p => p.side === (selection.startSide ?? selection.side) && p.line === (selection.startLine ?? selection.line));
  if (!start || !end || start.hunk !== end.hunk || positions.indexOf(start) > positions.indexOf(end)) throw new PullRequestDiscussionError("Choose a range inside one original diff hunk.");
}
