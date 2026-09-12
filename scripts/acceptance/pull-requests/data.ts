import type {
  PullRequestAccount,
  PullRequestDetailResult,
  PullRequestInboxResult,
  PullRequestSummary,
} from "../../../packages/shared/src/pull-requests";
import { defaultPullRequestFilters } from "../../../apps/desktop/src/pull-request-window-state";
export const account: PullRequestAccount = {
  id: "account-a",
  hostname: "github.com",
  login: "reviewer",
  name: "Reviewer",
  avatarUrl: null,
};
export const page = {
  hasNextPage: false,
  endCursor: null,
  totalCount: 1,
  truncated: false,
};
export function summary(number = 7): PullRequestSummary {
  return {
    nodeId: `PR_${number}`,
    pullRequest: {
      hostname: "github.com",
      owner: "example",
      repository: "desktop",
      number,
    },
    url: `https://github.com/example/desktop/pull/${number}`,
    title: `Preserve original file ${number}`,
    author: { login: "author", avatarUrl: null },
    state: "open",
    isDraft: false,
    createdAt: "2026-09-11T12:00:00Z",
    updatedAt: "2026-09-12T12:00:00Z",
    baseBranch: "main",
    headBranch: "feature",
    headOid: "a".repeat(40),
    additions: 1,
    deletions: 1,
    reviewDecision: "review_required",
  };
}
export function inbox(): PullRequestInboxResult {
  return {
    type: "inbox",
    account,
    filters: defaultPullRequestFilters(),
    sections: [
      {
        key: "user_review_requested",
        items: [summary()],
        pageInfo: {
          ...page,
          hasNextPage: true,
          endCursor: "next",
          totalCount: 2,
        },
        error: null,
      },
      {
        key: "team_review_requested",
        items: [summary(), summary(8)],
        pageInfo: page,
        error: null,
      },
      {
        key: "reviewed",
        items: [],
        pageInfo: { ...page, totalCount: 0 },
        error: null,
      },
      { key: "authored", items: [summary(9)], pageInfo: page, error: null },
    ],
  };
}
export function detail(): PullRequestDetailResult {
  return {
    type: "detail",
    account,
    revision: "a".repeat(40),
    summary: summary(),
    body: "# Original ownership\n\nPreserve **the selected file** and report errors.",
    discussion: {
      items: [
        {
          id: "comment1",
          kind: "comment",
          author: { login: account.login, avatarUrl: null },
          body: "Please keep the original revision.",
          createdAt: "2026-09-12T12:00:00Z",
          url: null,
          path: null,
          line: null,
          resolved: null,
        },
      ],
      pageInfo: page,
    },
    checks: {
      items: [
        {
          id: "check1",
          name: "Tests",
          workflow: "CI",
          state: "SUCCESS",
          bucket: "pass",
          startedAt: null,
          completedAt: null,
          url: null,
        },
      ],
      pageInfo: page,
    },
    files: {
      items: [
        {
          path: "src/hello world.ts",
          previousPath: null,
          status: "modified",
          additions: 1,
          deletions: 1,
          changes: 2,
          blobOid: "b".repeat(40),
          patch: { text: "@@ -1 +1 @@\n-old\n+new" },
        },
      ],
      pageInfo: page,
    },
  };
}
