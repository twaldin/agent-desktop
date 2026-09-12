import { expect, test } from "bun:test";
import { parsePullRequestWriteRequest, pullRequestWriteIdentity } from "./pull-request-write";
const base = { requestId: "original-request-id", accountId: "account", pullRequest: { hostname: "github.com", owner: "owner", repository: "repo", number: 1 }, expectedHeadOid: "a".repeat(40), body: "hello" };
test("discussion requests copy original nodes and line ranges without conflating existing review actions", () => {
  const raw = { ...base, action: "inline_comment", inline: { path: "a.ts", side: "RIGHT", line: 5, startLine: 2, startSide: "RIGHT" } };
  const parsed = parsePullRequestWriteRequest(raw); raw.inline.path = "changed.ts";
  expect(parsed.inline?.path).toBe("a.ts"); parsed.inline!.line = 8; expect(raw.inline.line).toBe(5);
  const node = { ...base, action: "reply", target: { id: "thread", kind: "thread" } }, first = parsePullRequestWriteRequest(node);
  node.target.id = "changed"; expect(first.target?.id).toBe("thread"); first.target!.kind = "comment"; expect(node.target.kind).toBe("thread");
  const old = { ...base, action: "comment" };
  expect(pullRequestWriteIdentity(parsePullRequestWriteRequest(old))).toBe(JSON.stringify({ requestId: base.requestId, accountId: base.accountId, pullRequest: base.pullRequest, action: "comment", expectedHeadOid: base.expectedHeadOid, body: base.body }));
});
test("malformed or inapplicable discussion selection cannot be reserved as another action", () => {
  for (const value of [
    { action: "delete", body: "", target: { id: "review", kind: "review" } },
    { action: "resolve", body: "", target: { id: "comment", kind: "comment" } },
    { action: "reply", target: { id: "thread", kind: "thread", permission: true } },
    { action: "inline_comment", inline: { path: "../private", side: "RIGHT", line: 1 } },
    { action: "inline_comment", inline: { path: "a.ts", side: "RIGHT", line: 1, startLine: 2 } },
    { action: "inline_comment", inline: { path: "a.ts", side: "RIGHT", line: 1, startLine: 2, startSide: "RIGHT" } },
    { action: "delete", body: "must be empty", target: { id: "comment", kind: "comment" } },
    { action: "comment", target: { id: "thread", kind: "thread" } },
  ]) expect(() => parsePullRequestWriteRequest({ ...base, ...value })).toThrow();
});
