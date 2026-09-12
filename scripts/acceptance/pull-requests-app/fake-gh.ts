import { discussionGithub } from "./discussion-gh";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendFile } from "node:fs/promises";

const log = process.env.AGENT_DESKTOP_FAKE_GH_LOG;
if (!log) throw new Error("Missing controlled GitHub CLI log path.");
const controlPath = join(dirname(log), "gh-write-control.json"), writtenPath = join(dirname(log), "gh-written.jsonl");
const control = existsSync(controlPath) ? JSON.parse(readFileSync(controlPath, "utf8")) : {};
const written = existsSync(writtenPath) ? readFileSync(writtenPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
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
const head = control.head ?? "b".repeat(40),
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
const discussion = discussionGithub(dirname(log), pullRequest, "octocat", now);
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
  if (discussion && query.startsWith("mutation")) {
    const method = /\)\{(\w+)\(input:/.exec(query)![1]!;
    value = { data: { [method]: await discussion.mutation(method, request.variables.input) } };
  } else if (discussion && query.includes("node(id:")) value = { data: { viewer: { login: "octocat" }, node: discussion.node(request.variables.id) } };
  else if (query.includes("search(type:ISSUE"))
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
            comments: connection(discussion ? discussion.comments : [
              {
                id: "C_NATIVE",
                body: "Native review comment",
                createdAt: now,
                url: null,
                author: { login: "reviewer", avatarUrl: null },
              },
              ...written.filter(item => !item.event).map(item => ({ id: `C_${item.id}`, body: item.body, createdAt: now, url: `https://github.com/example/parity/pull/17#issuecomment-${item.id}`, author: { login: "octocat", avatarUrl: null } })),
            ]),
            reviews: connection(discussion ? discussion.reviews : written.filter(item => item.event).map(item => ({ id: `R_${item.id}`, body: item.body, state: item.event === "APPROVE" ? "APPROVED" : item.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED", submittedAt: now, createdAt: now, url: `https://github.com/example/parity/pull/17#pullrequestreview-${item.id}`, author: { login: "octocat", avatarUrl: null } }))),
            reviewThreads: connection(discussion ? [discussion.thread] : []),
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
} else if (discussion && args[0] === "api" && args[1] === "repos/example/parity/pulls/17/comments") value = discussion.inline(JSON.parse(input));
else if (args[0] === "api" && ["repos/example/parity/issues/17/comments", "repos/example/parity/pulls/17/reviews"].includes(args[1] ?? "")) {
  const body = JSON.parse(input), id = 100 + written.length;
  await appendFile(writtenPath, JSON.stringify({ ...body, id }) + "\n");
  value = control.malformed ? { error: "Controlled ambiguous response" } : { id, user: { login: "octocat" }, body: body.body,
    html_url: `https://github.com/example/parity/pull/17#${body.event ? "pullrequestreview" : "issuecomment"}-${id}`,
    commit_id: body.commit_id, state: body.event === "APPROVE" ? "APPROVED" : body.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED" };
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
