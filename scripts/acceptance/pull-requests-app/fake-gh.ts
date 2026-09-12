import { appendFile } from "node:fs/promises";

const log = process.env.AGENT_DESKTOP_FAKE_GH_LOG;
if (!log) throw new Error("Missing controlled GitHub CLI log path.");
const args = process.argv.slice(2);
const input = await new Response(Bun.stdin.stream()).text();
await appendFile(
  log,
  JSON.stringify({
    args,
    inputKind: input
      ? JSON.parse(input).query?.includes("search(type:ISSUE")
        ? "inbox"
        : JSON.parse(input).query?.includes("comments(first:50")
          ? "detail"
          : "head"
      : null,
  }) + "\n",
);
const now = "2026-09-12T12:00:00Z";
const head = "b".repeat(40),
  base = "a".repeat(40);
const pullRequest = {
  id: "PR_NATIVE_17",
  number: 17,
  url: "https://github.com/example/parity/pull/17",
  title: "Native pull request",
  state: "OPEN",
  isDraft: false,
  createdAt: now,
  updatedAt: now,
  additions: 2,
  deletions: 1,
  changedFiles: 1,
  baseRefName: "main",
  baseRefOid: base,
  headRefName: "feature/native-pr",
  headRefOid: head,
  reviewDecision: "REVIEW_REQUIRED",
  body: "Actual host-backed pull request detail.",
  author: { login: "author", avatarUrl: null },
  repository: { name: "parity", owner: { login: "example" } },
  reviewRequests: {
    nodes: [
      {
        requestedReviewer: {
          __typename: "Team",
          name: "desktop",
          slug: "desktop",
        },
      },
    ],
  },
};
const connection = (nodes: unknown[]) => ({
  issueCount: nodes.length,
  totalCount: nodes.length,
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes,
});
let value: unknown;
if (args[0] === "auth" && args[1] === "status")
  value = {
    hosts: {
      "github.com": [{ login: "octocat", active: true, state: "success" }],
    },
  };
else if (args[0] === "auth" && args[1] === "token") value = "fixture-token";
else if (args[0] === "api" && args[1] === "user")
  value = { login: "octocat", name: "Octo Cat", avatar_url: null };
else if (args[0] === "api" && args[1] === "graphql") {
  const request = JSON.parse(input),
    query = String(request.query ?? "");
  if (query.includes("search(type:ISSUE"))
    value = {
      data: { viewer: { login: "octocat" }, search: connection([pullRequest]) },
    };
  else if (query.includes("comments(first:50"))
    value = {
      data: {
        viewer: { login: "octocat" },
        repository: {
          pullRequest: {
            ...pullRequest,
            comments: connection([
              {
                id: "C_NATIVE",
                body: "Native review comment",
                createdAt: now,
                url: null,
                author: { login: "reviewer", avatarUrl: null },
              },
            ]),
            reviews: connection([]),
            reviewThreads: connection([]),
            commits: {
              nodes: [
                {
                  commit: {
                    oid: head,
                    statusCheckRollup: {
                      contexts: connection([
                        {
                          __typename: "CheckRun",
                          id: "CHECK_NATIVE",
                          name: "build",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                          startedAt: now,
                          completedAt: now,
                          detailsUrl: null,
                          checkSuite: {
                            workflowRun: { workflow: { name: "CI" } },
                          },
                        },
                      ]),
                    },
                  },
                },
              ],
            },
          },
        },
      },
    };
  else
    value = {
      data: {
        viewer: { login: "octocat" },
        repository: {
          pullRequest: { headRefOid: head, baseRefOid: base, updatedAt: now },
        },
      },
    };
} else if (args[0] === "api" && args[1]?.includes("/pulls/17/files"))
  value = [
    {
      filename: "src/native.ts",
      previous_filename: null,
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      sha: "d".repeat(40),
      patch: "@@ -1 +1 @@\n-old value\n+new value\n",
    },
  ];
else {
  console.error("Unsupported controlled gh invocation");
  process.exit(2);
}
process.stdout.write(
  typeof value === "string" ? `${value}\n` : JSON.stringify(value),
);
