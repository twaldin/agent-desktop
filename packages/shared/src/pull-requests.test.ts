import { describe, expect, test } from "bun:test";
import {
  hasRelationshipQualifier,
  parsePullRequestReadRequest,
  parsePullRequestReadResult,
  pullRequestQualifierNames,
  type PullRequestDetailResult,
  type PullRequestReadRequest,
  type PullRequestSummary,
} from "./pull-requests";

const identity = {
  hostname: "github.com",
  owner: "openai",
  repository: "codex",
  number: 42,
};
const account = {
  id: "a".repeat(64),
  hostname: "github.com",
  login: "octocat",
  name: null,
  avatarUrl: null,
};
const summary: PullRequestSummary = {
  nodeId: "PR_1",
  pullRequest: identity,
  url: "https://github.com/openai/codex/pull/42",
  title: "Read it",
  author: { login: "octocat", avatarUrl: null },
  state: "open",
  isDraft: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  baseBranch: "main",
  headBranch: "feature",
  headOid: "b".repeat(40),
  additions: 2,
  deletions: 1,
  reviewDecision: null,
};
const pageInfo = {
  hasNextPage: false,
  endCursor: null,
  totalCount: 1,
  truncated: false,
};

describe("pull request wire contract", () => {
  test("recognizes native relationship qualifiers outside quoted text", () => {
    expect(hasRelationshipQualifier('"author:inside phrase" label:bug')).toBe(
      false,
    );
    expect(hasRelationshipQualifier("assignee:octocat")).toBe(true);
    expect(hasRelationshipQualifier("review-involves:@me")).toBe(true);
    expect([
      ...pullRequestQualifierNames('"sort:old" archived:true sort:updated'),
    ]).toEqual(["archived", "sort"]);
  });
  test("accepts exact inbox filters and rejects sparse, oversized and extra input", () => {
    const request = parsePullRequestReadRequest({
      type: "inbox",
      accountId: account.id,
      filters: {
        view: "all",
        lifecycle: "open",
        repository: null,
        rawQuery: null,
        search: "native browser",
      },
      pageSize: 50,
    });
    expect(request.type).toBe("inbox");
    for (const value of [
      null,
      { type: "accounts", refresh: false, extra: true },
      {
        type: "inbox",
        accountId: account.id,
        filters: {
          view: "all",
          lifecycle: "open",
          repository: null,
          rawQuery: null,
          search: "x".repeat(257),
        },
        pageSize: 50,
      },
      {
        type: "detail",
        accountId: account.id,
        pullRequest: identity,
        pageSize: 50,
        after: { files: "cursor" },
      },
    ])
      expect(() => parsePullRequestReadRequest(value)).toThrow();
    const sparse = new Array(1);
    sparse[0] = summary;
    const result = {
      type: "inbox",
      account,
      filters: (request as Extract<PullRequestReadRequest, { type: "inbox" }>)
        .filters,
      sections: [
        { key: "user_review_requested", items: sparse, pageInfo, error: null },
        {
          key: "team_review_requested",
          items: [],
          pageInfo: { ...pageInfo, totalCount: 0 },
          error: null,
        },
        {
          key: "reviewed",
          items: [],
          pageInfo: { ...pageInfo, totalCount: 0 },
          error: null,
        },
        {
          key: "authored",
          items: [],
          pageInfo: { ...pageInfo, totalCount: 0 },
          error: null,
        },
      ],
    };
    expect(parsePullRequestReadResult(result, request).type).toBe("inbox");
    const hole = new Array(1);
    expect(() =>
      parsePullRequestReadResult({ ...result, sections: hole }, request),
    ).toThrow();
    expect(() =>
      parsePullRequestReadResult(
        {
          ...result,
          sections: [
            result.sections[0],
            result.sections[0],
            ...result.sections.slice(2),
          ],
        },
        request,
      ),
    ).toThrow("sections");
    expect(() =>
      parsePullRequestReadResult(
        {
          ...result,
          sections: [
            { ...result.sections[0], items: [summary, summary] },
            ...result.sections.slice(1),
          ],
        },
        request,
      ),
    ).toThrow("Duplicate");
  });

  test("correlates owner, filters, target and exact revision while allowing multiline review data", () => {
    const request = parsePullRequestReadRequest({
      type: "detail",
      accountId: account.id,
      pullRequest: identity,
      expectedRevision: "rev1",
      pageSize: 50,
    });
    const result = {
      type: "detail",
      account,
      revision: "rev1",
      summary,
      body: "Line one\nLine two",
      discussion: {
        items: [
          {
            id: "c1",
            kind: "comment",
            author: summary.author,
            body: "Review\nbody",
            createdAt: summary.createdAt,
            url: null,
            path: null,
            line: null,
            resolved: null,
          },
        ],
        pageInfo,
      },
      checks: { items: [], pageInfo: { ...pageInfo, totalCount: 0 } },
      files: {
        items: [
          {
            path: "src/a.ts",
            previousPath: null,
            status: "modified",
            additions: 1,
            deletions: 1,
            changes: 2,
            blobOid: "c".repeat(40),
            patch: { text: "@@ -1 +1 @@\n-old\n+new\n" },
          },
        ],
        pageInfo,
      },
    } satisfies PullRequestDetailResult;
    expect(parsePullRequestReadResult(result, request)).toEqual(result);
    expect(() =>
      parsePullRequestReadResult({ ...result, revision: "rev2" }, request),
    ).toThrow("head changed");
    expect(() =>
      parsePullRequestReadResult(
        { ...result, account: { ...account, id: "other" } },
        request,
      ),
    ).toThrow("account changed");
    expect(() =>
      parsePullRequestReadResult(
        {
          ...result,
          summary: { ...summary, pullRequest: { ...identity, number: 43 } },
        },
        request,
      ),
    ).toThrow("identity changed");
    expect(() =>
      parsePullRequestReadResult({ ...result, body: "x\0y" }, request),
    ).toThrow("body");
  });
});
