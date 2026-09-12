import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
/** Persisted deterministic GitHub boundary for the actual gh child, not a production API. */
export function discussionGithub(directory: string, parent: any, viewer: string, now: string) {
  const path = join(directory, "discussion-state.json");
  if (!existsSync(path)) return undefined;
  const state = JSON.parse(readFileSync(path, "utf8"));
  const comment = (id: string, body: string, kind: string, login = "reviewer") => ({ id, kind, body, createdAt: now, submittedAt: now, state: "COMMENTED", url: parent.url + `#${kind === "review" ? "pullrequestreview" : "discussion_r"}${id}`, author: { login, avatarUrl: null }, viewerCanUpdate: true, viewerCanDelete: kind !== "review", pullRequest: parent });
  if (!state.comments) {
    state.comments = [comment("C_NATIVE", "Native review comment", "comment"), comment("R_NATIVE", "Original review body", "review"), comment("RC_NATIVE", "Original inline conversation", "review_comment")];
    state.thread = { id: "T_NATIVE", isResolved: false, path: "src/native.ts", line: 1, originalLine: 1, startLine: null, originalStartLine: null, diffSide: "RIGHT", startDiffSide: null, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true, pullRequest: parent };
    writeFileSync(path, JSON.stringify(state));
  }
  const controls = existsSync(join(directory, "gh-write-control.json")) ? JSON.parse(readFileSync(join(directory, "gh-write-control.json"), "utf8")) : {};
  return {
    comments: state.comments.filter((c: any) => c.kind === "comment"), reviews: state.comments.filter((c: any) => c.kind === "review"),
    thread: { ...state.thread, comments: { nodes: state.comments.filter((c: any) => c.kind === "review_comment"), pageInfo: { hasNextPage: false, endCursor: null } } },
    node(id: string) {
      const node = id === state.thread.id ? { ...state.thread, __typename: "PullRequestReviewThread" } : state.comments.find((c: any) => c.id === id);
      if (!node || controls.missingNode) return null;
      return { ...node, __typename: node.__typename ?? ({ comment: "IssueComment", review: "PullRequestReview", review_comment: "PullRequestReviewComment" } as any)[node.kind],
        ...(controls.deny ? { viewerCanReply: false, viewerCanResolve: false, viewerCanUnresolve: false, viewerCanUpdate: false, viewerCanDelete: false } : {}),
        ...(controls.foreignNode ? { pullRequest: { ...parent, number: 99 } } : {}) };
    },
    async mutation(method: string, input: any) {
      if (controls.hold) {
        const started = Date.now();
        while (!existsSync(join(directory, "release-discussion")) && Date.now() - started < 10_000) await Bun.sleep(20);
        if (!existsSync(join(directory, "release-discussion"))) throw new Error("Fixture release gate timed out");
      }
      const result: any = { clientMutationId: input.clientMutationId };
      const id = input.id ?? input.pullRequestReviewId ?? input.pullRequestReviewCommentId;
      if (method === "addPullRequestReviewThreadReply") { const item = comment(`REPLY_${state.comments.length}`, input.body, "review_comment", viewer); state.comments.push(item); result.comment = item; }
      else if (method === "resolveReviewThread" || method === "unresolveReviewThread") { state.thread.isResolved = method === "resolveReviewThread"; result.thread = { id: state.thread.id, isResolved: state.thread.isResolved }; }
      else if (method.startsWith("delete")) { state.comments = state.comments.filter((c: any) => c.id !== id); }
      else if (method.startsWith("update")) { const item = state.comments.find((c: any) => c.id === id); if (!item) throw new Error("Fixture original node missing"); item.body = input.body; result[method === "updateIssueComment" ? "issueComment" : method === "updatePullRequestReview" ? "pullRequestReview" : "pullRequestReviewComment"] = item; }
      else throw new Error("Unsupported fixture discussion mutation");
      writeFileSync(path, JSON.stringify(state)); appendFileSync(join(directory, "discussion-written.jsonl"), JSON.stringify({ method, input }) + "\n");
      return controls.malformed ? { clientMutationId: "foreign-confirmation" } : result;
    },
    inline(input: any) {
      const id = 900 + state.comments.length, item = comment(`INLINE_${id}`, input.body, "review_comment", viewer); state.comments.push(item); state.thread = { ...state.thread, path: input.path, line: input.line, diffSide: input.side, startLine: input.start_line ?? null, startDiffSide: input.start_side ?? null };
      writeFileSync(path, JSON.stringify(state)); appendFileSync(join(directory, "discussion-written.jsonl"), JSON.stringify({ method: "inline", input }) + "\n");
      return { id, ...input, html_url: parent.url + `#discussion_r${id}`, user: { login: viewer } };
    },
  };
}
