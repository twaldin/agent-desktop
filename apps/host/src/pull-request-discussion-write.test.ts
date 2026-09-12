import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PullRequests, type GhRunner, type GhRunResult } from "./pull-requests";
import { HostStore } from "./store";
import { validateInlinePatch } from "./pull-request-discussion-write";
import { parsePullRequestWriteRequest, type PullRequestWriteRequest } from "../../../packages/shared/src/pull-request-write";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const ok = (data: unknown): GhRunResult => ({ stdout: JSON.stringify(data), stderr: "", exitCode: 0, overflow: false, timedOut: false });
const parent = { number: 42, url: "https://github.com/owner/repo/pull/42", repository: { name: "repo", owner: { login: "owner" } } };
const patch = { filename: "src/a.ts", patch: "@@ -1,3 +1,3 @@\n keep\n-old\n+new\n tail", additions: 1, deletions: 1 };
const head = "a".repeat(40);
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pr-thread-")), store = new HostStore(directory);
  const calls: { endpoint: string; input: any }[] = [];
  let node: any = {}, changedHead = head, mutation: ((input: any, method: string) => Promise<any>) | undefined;
  const runner: GhRunner = async (_, args, config) => {
    if (args[0] === "auth" && args[1] === "status") return ok({ hosts: { "github.com": [{ login: "octocat", active: true, state: "success" }] } });
    if (args[0] === "auth" && args[1] === "token") return { ...ok(null), stdout: "controlled-token\n" };
    if (args[1] === "user") return ok({ login: "octocat" });
    const body = config.input ? JSON.parse(config.input) : undefined;
    calls.push({ endpoint: args[1]!, input: body });
    if (args[1]?.includes("/files?")) return ok([patch]);
    if (args[1] === "graphql") {
      if (body.query.startsWith("mutation")) {
        const method = /\)\{(\w+)\(input:/.exec(body.query)![1]!, input = body.variables.input;
        expect(store.pullRequestWrites.get(currentRequest)?.receipt).toBeUndefined();
        expect(store.pullRequestWrites.get(currentRequest)).toBeDefined();
        const data = mutation ? await mutation(input, method) : { clientMutationId: input.clientMutationId,
          comment: { id: "new-reply", url: parent.url + "#discussion_r2", body: input.body, author: { login: "octocat" }, pullRequest: parent },
          issueComment: { id: node.id, body: input.body, url: parent.url + "#issuecomment-1" },
          pullRequestReview: { id: node.id, body: input.body, url: parent.url + "#pullrequestreview-1" },
          pullRequestReviewComment: { id: node.id, body: input.body, url: parent.url + "#discussion_r1" },
          thread: { id: node.id, isResolved: method === "resolveReviewThread" } };
        return ok({ data: { [method]: data } });
      }
      if (body.query.includes("node(id:")) return ok({ data: { viewer: { login: "octocat" }, node } });
      return ok({ data: { viewer: { login: "octocat" }, repository: { pullRequest: { headRefOid: changedHead } } } });
    }
    return ok({ id: 12, user: { login: "octocat" }, html_url: parent.url + "#discussion_r12", ...body });
  };
  const service = new PullRequests({ hostId: store.host.id, writes: store.pullRequestWrites, ghPath: process.execPath, runner, env: {} });
  cleanup.push(async () => { await service.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const accounts = await service.read({ type: "accounts", refresh: true }); if (accounts.type !== "accounts") throw new Error("fixture");
  let currentRequest: PullRequestWriteRequest;
  const request = (action: PullRequestWriteRequest["action"], kind: "comment" | "review" | "review_comment" | "thread" = "thread") => {
    node = { id: "original-node", __typename: { comment: "IssueComment", review: "PullRequestReview", review_comment: "PullRequestReviewComment", thread: "PullRequestReviewThread" }[kind], pullRequest: parent, viewerCanReply: true, viewerCanUpdate: true, viewerCanDelete: true, viewerCanResolve: true, viewerCanUnresolve: true, isResolved: false };
    currentRequest = parsePullRequestWriteRequest({ requestId: crypto.randomUUID(), accountId: accounts.availability.accounts[0]!.id, pullRequest: { hostname: "github.com", owner: "owner", repository: "repo", number: 42 }, action, expectedHeadOid: head, body: ["delete", "resolve", "unresolve"].includes(action) ? "" : "Original body", ...(action === "inline_comment" ? { inline: { path: "src/a.ts", side: "RIGHT", line: 3, startSide: "RIGHT", startLine: 2 } } : { target: { id: "original-node", kind } }) }); return currentRequest;
  };
  return { service, store, calls, request, node: () => node, head: (value: string) => { changedHead = value; }, mutate: (value: typeof mutation) => { mutation = value; } };
}
test("all original node operations use current permissions and exact correlated mutation after durable reservation", async () => {
  const f = await fixture();
  for (const [action, kind, expected] of [["reply", "thread", "addPullRequestReviewThreadReply"], ["update", "comment", "updateIssueComment"], ["update", "review", "updatePullRequestReview"], ["update", "review_comment", "updatePullRequestReviewComment"], ["delete", "comment", "deleteIssueComment"], ["delete", "review_comment", "deletePullRequestReviewComment"], ["resolve", "thread", "resolveReviewThread"], ["unresolve", "thread", "unresolveReviewThread"]] as const) {
    const request = f.request(action, kind); f.head("b".repeat(40));
    const result = await f.service.submit(request);
    expect(result.outcome).toBe("succeeded"); expect(f.store.pullRequestWrites.get(request)?.receipt).toEqual(result);
    const call = f.calls.at(-1)!.input;
    expect(call.query).toContain(expected + "(input:$input)"); expect(call.variables.input.clientMutationId).toBe(request.requestId);
    expect(f.calls.some(c => c.input?.query?.includes("headRefOid"))).toBe(false);
  }
});
test("permission, node type and parent identity changes refuse every mutation before dispatch", async () => {
  for (const change of [(n: any) => { n.viewerCanReply = false; }, (n: any) => { n.__typename = "IssueComment"; }, (n: any) => { n.id = "replaced"; }, (n: any) => { n.pullRequest = { ...parent, number: 99 }; }, (n: any) => { n.pullRequest = { ...parent, url: "https://foreign.invalid/owner/repo/pull/42" }; }]) {
    const f = await fixture(), request = f.request("reply"); change(f.node());
    expect((await f.service.submit(request)).outcome).toBe("failed");
    expect(f.calls.some(call => call.input?.query?.startsWith("mutation"))).toBe(false);
  }
});
test("inline comments bind exact head, returned hunk and snake-case native REST range", async () => {
  const f = await fixture(), request = f.request("inline_comment");
  expect((await f.service.submit(request)).outcome).toBe("succeeded");
  expect(f.calls.at(-1)).toEqual({ endpoint: "repos/owner/repo/pulls/42/comments", input: { body: request.body, commit_id: head, path: "src/a.ts", side: "RIGHT", line: 3, start_line: 2, start_side: "RIGHT" } });
  const stale = f.request("inline_comment"); f.head("b".repeat(40));
  expect((await f.service.submit(stale)).outcome).toBe("failed"); expect(f.calls.filter(c => c.endpoint.endsWith("/comments"))).toHaveLength(1);
});
test("missing, truncated, wrong-side and cross-hunk ranges never infer a valid inline line", () => {
  const selection = { path: "src/a.ts", side: "RIGHT" as const, line: 2 };
  expect(() => validateInlinePatch(selection, [patch])).not.toThrow();
  for (const files of [[], [{ ...patch, patch: undefined }], [{ ...patch, patch: "@@ -1,3 +1,3 @@\n keep\n-old\n+new" }], [{ ...patch, additions: 50 }]]) expect(() => validateInlinePatch(selection, files)).toThrow();
  expect(() => validateInlinePatch({ ...selection, line: 9 }, [patch])).toThrow();
  expect(() => validateInlinePatch({ ...selection, startLine: 3, startSide: "RIGHT" }, [patch])).toThrow();
});
test("malformed mutation confirmation is durable unknown, and reentry never repeats its mutation", async () => {
  const f = await fixture(), request = f.request("resolve"); f.mutate(async input => ({ clientMutationId: input.clientMutationId, thread: { id: "foreign", isResolved: true } }));
  expect((await f.service.submit(request)).outcome).toBe("unknown"); expect((await f.service.submit(request)).outcome).toBe("unknown");
  expect(f.calls.filter(call => call.input?.query?.startsWith("mutation"))).toHaveLength(1);
});

test("queued node revalidation observes permission changes after the prior original mutation settles", async () => {
  const f = await fixture(), first = f.request("reply");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  f.mutate(async input => { entered(); await held; return { clientMutationId: input.clientMutationId, comment: { id: "first-reply", body: input.body, url: parent.url + "#discussion_r1", author: { login: "octocat" }, pullRequest: parent } }; });
  const operation = f.service.submit(first); await started;
  const second = f.request("reply"), queued = f.service.submit(second); f.node().viewerCanReply = false;
  release(); const [a, b] = await Promise.all([operation, queued]);
  expect(a.outcome).toBe("succeeded"); expect(b.outcome).toBe("failed");
  expect(f.calls.filter(call => call.input?.query?.startsWith("mutation"))).toHaveLength(1);
});
