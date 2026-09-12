import { describe, expect, test } from "bun:test";
import {
  PullRequests,
  PullRequestReadError,
  runGh,
  type GhRunner,
} from "./pull-requests";

const node = {
  id: "PR_1",
  number: 42,
  url: "https://github.com/openai/codex/pull/42",
  title: "Native browser",
  state: "OPEN",
  isDraft: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  additions: 3,
  deletions: 1,
  baseRefName: "main",
  baseRefOid: "a".repeat(40),
  headRefName: "feature",
  headRefOid: "b".repeat(40),
  changedFiles: 51,
  reviewDecision: "REVIEW_REQUIRED",
  body: "Body\ntext",
  author: { login: "author", avatarUrl: null },
  repository: { name: "codex", owner: { login: "openai" } },
  reviewRequests: {
    nodes: [
      {
        requestedReviewer: {
          __typename: "Team",
          name: "runtime",
          slug: "runtime",
        },
      },
    ],
  },
};
const connection = (
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
) => ({
  issueCount: nodes.length,
  totalCount: nodes.length,
  pageInfo: { hasNextPage, endCursor },
  nodes,
});

function fixture(
  options: {
    failReviewed?: boolean;
    failReviewedStderr?: string;
    changeHeadAtEnd?: boolean;
    hold?: boolean;
    nestedThreadComments?: boolean;
    throwOnStatus?: boolean;
    graphqlError?: boolean;
    noTeamMetadata?: boolean;
  } = {},
) {
  const calls: { args: string[]; input?: string; token?: string }[] = [];
  let headReads = 0;
  const runner: GhRunner = async (_executable, args, run) => {
    const call = {
      args: [...args],
      input: run.input,
      token: run.env?.GH_TOKEN,
    };
    if (options.hold && args.includes("graphql")) {
      if (run.signal?.aborted) throw run.signal.reason;
      const gate = new Promise<void>((_resolve, reject) =>
        run.signal?.addEventListener(
          "abort",
          () => reject(run.signal?.reason),
          { once: true },
        ),
      );
      calls.push(call);
      await gate;
    } else calls.push(call);
    if (args[0] === "auth" && args[1] === "status") {
      if (options.throwOnStatus)
        throw new Error("spawn exposed /private/path and token");
      return ok({
        hosts: {
          "github.com": [
            { login: "octocat", active: true, state: "success" },
            { login: "other", active: false, state: "failure" },
          ],
        },
      });
    }
    if (args[0] === "auth" && args[1] === "token")
      return { ...ok("secret-token"), stdout: "secret-token\n" };
    if (args[1] === "user")
      return ok({
        login: "octocat",
        name: "Octo Cat",
        avatar_url: "https://avatars.invalid/octo",
      });
    if (args[1] === "graphql") {
      const input = JSON.parse(run.input!),
        variables = input.variables ?? {};
      if (String(input.query).includes("search(type:ISSUE")) {
        if (options.graphqlError)
          return ok({
            data: { viewer: { login: "octocat" }, search: null },
            errors: [{ message: "private credential detail" }],
          });
        if (
          options.failReviewed &&
          String(variables.searchQuery).includes("reviewed-by:@me")
        )
          return fail(options.failReviewedStderr);
        expect(variables.first).toBe(50);
        return ok({
          data: {
            viewer: { login: "octocat" },
            search: connection(
              [
                {
                  ...node,
                  ...(options.noTeamMetadata
                    ? { reviewRequests: { nodes: [] } }
                    : {}),
                },
              ],
              true,
              "cursor-next",
            ),
          },
        });
      }
      if (String(input.query).includes("comments(first:50")) {
        const contexts = connection([
          {
            __typename: "CheckRun",
            id: "CHECK_1",
            name: "test",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            startedAt: node.createdAt,
            completedAt: node.updatedAt,
            detailsUrl: null,
            checkSuite: { workflowRun: { workflow: { name: "CI" } } },
          },
        ]);
        const pullRequest = {
          ...node,
          comments: connection([
            {
              id: "C1",
              body: "Comment\nbody",
              createdAt: node.createdAt,
              url: null,
              author: { login: "reviewer", avatarUrl: null },
            },
          ]),
          reviews: connection([]),
          reviewThreads: connection(
            options.nestedThreadComments
              ? [
                  {
                    id: "T1",
                    isResolved: false,
                    path: "src/a.ts",
                    line: 2,
                    comments: {
                      nodes: [
                        {
                          id: "RC1",
                          body: "Thread body",
                          createdAt: node.createdAt,
                          url: null,
                          author: { login: "reviewer", avatarUrl: null },
                        },
                      ],
                      pageInfo: { hasNextPage: true },
                    },
                  },
                ]
              : [],
          ),
          commits: {
            nodes: [
              {
                commit: {
                  oid: node.headRefOid,
                  statusCheckRollup: { contexts },
                },
              },
            ],
          },
        };
        return ok({
          data: { viewer: { login: "octocat" }, repository: { pullRequest } },
        });
      }
      headReads++;
      return ok({
        data: {
          viewer: { login: "octocat" },
          repository: {
            pullRequest: {
              headRefOid:
                options.changeHeadAtEnd && headReads > 0
                  ? "c".repeat(40)
                  : node.headRefOid,
              baseRefOid: node.baseRefOid,
              updatedAt: node.updatedAt,
            },
          },
        },
      });
    }
    if (args[1]?.startsWith("repos/"))
      return {
        ...ok([]),
        stdout: JSON.stringify([
          {
            filename: "src/a.ts",
            previous_filename: null,
            status: "modified",
            additions: 1,
            deletions: 1,
            changes: 2,
            sha: "d".repeat(40),
            patch: "@@ -1 +1 @@\n-old\n+new\n",
          },
        ]),
      };
    throw new Error(`unexpected gh call ${args.join(" ")}`);
  };
  return {
    service: new PullRequests({
      hostId: "host-1",
      ghPath: "/bin/sh",
      runner,
      env: { PATH: "/bin" },
    }),
    calls,
  };
}
const ok = (value: unknown) => ({
  exitCode: 0,
  stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: "",
  timedOut: false,
  overflow: false,
});
const fail = (stderr = "credential URL and token must stay private") => ({
  exitCode: 1,
  stdout: "",
  stderr,
  timedOut: false,
  overflow: false,
});

describe("native GitHub pull request reads", () => {
  test("discovers only authenticated accounts without capturing a token", async () => {
    const f = fixture(),
      result = await f.service.read({ type: "accounts", refresh: true });
    expect(result.type).toBe("accounts");
    if (result.type !== "accounts") return;
    expect(result.availability.status).toBe("ready");
    expect(result.availability.accounts.map((item) => item.login)).toEqual([
      "octocat",
    ]);
    expect(f.calls.some((call) => call.args.includes("token"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("pins the selected account in memory and returns all inbox lanes with bounded cursors", async () => {
    const f = fixture(),
      accounts = await f.service.read({ type: "accounts", refresh: true });
    if (accounts.type !== "accounts") throw new Error();
    const accountId = accounts.availability.activeAccountId!;
    const result = await f.service.read({
      type: "inbox",
      accountId,
      filters: {
        view: "all",
        lifecycle: "open",
        repository: { owner: "openai", repository: "codex" },
        rawQuery: null,
        search: "browser owner",
      },
      pageSize: 50,
    });
    expect(result.type).toBe("inbox");
    if (result.type !== "inbox") return;
    expect(result.sections.map((item) => item.key)).toEqual([
      "user_review_requested",
      "team_review_requested",
      "reviewed",
      "authored",
    ]);
    expect(result.sections[1].items).toHaveLength(1);
    expect(
      result.sections.every(
        (item) => item.pageInfo.endCursor !== "cursor-next",
      ),
    ).toBe(true);
    const apiCalls = f.calls.filter((call) => call.args[0] === "api");
    expect(
      apiCalls.every((call) => !call.args.join(" ").includes("secret-token")),
    ).toBe(true);
    expect(
      apiCalls.slice(1).every((call) => call.token === "secret-token"),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  test("keeps a failed relationship explicit while other inbox sections succeed", async () => {
    const f = fixture({ failReviewed: true }),
      accounts = await f.service.read({ type: "accounts", refresh: true });
    if (accounts.type !== "accounts") throw 0;
    const result = await f.service.read({
      type: "inbox",
      accountId: accounts.availability.activeAccountId!,
      filters: {
        view: "reviewing",
        lifecycle: "all",
        repository: null,
        rawQuery: null,
        search: "",
      },
      pageSize: 50,
    });
    if (result.type !== "inbox") throw 0;
    expect(result.sections.find((item) => item.key === "reviewed")?.error).toBe(
      "GitHub could not complete this read request.",
    );
    expect(
      result.sections.find((item) => item.key === "user_review_requested")
        ?.items,
    ).toHaveLength(1);
    const queries = f.calls
      .filter((call) => call.args.includes("graphql"))
      .map((call) => JSON.parse(call.input!).variables.searchQuery);
    expect(queries.every((query) => String(query).includes("is:open"))).toBe(
      true,
    );
  });

  test("classifies offline section failures without exposing native stderr", async () => {
    const f = fixture({
        failReviewed: true,
        failReviewedStderr:
          "failed to connect to github.com using secret-token",
      }),
      accounts = await f.service.read({ type: "accounts", refresh: true });
    if (accounts.type !== "accounts") throw 0;
    const result = await f.service.read({
      type: "inbox",
      accountId: accounts.availability.activeAccountId!,
      filters: {
        view: "reviewing",
        lifecycle: "all",
        repository: null,
        rawQuery: null,
        search: "",
      },
      pageSize: 50,
    });
    if (result.type !== "inbox") throw 0;
    expect(result.sections.find((item) => item.key === "reviewed")?.error).toBe(
      "GitHub is unreachable from this host.",
    );
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  test("uses pinned raw qualifier rules and paginates only requested lanes", async () => {
    const f = fixture(),
      accounts = await f.service.read({ type: "accounts", refresh: true });
    if (accounts.type !== "accounts") throw 0;
    const accountId = accounts.availability.activeAccountId!;
    const raw = await f.service.read({
      type: "inbox",
      accountId,
      filters: {
        view: "reviewing",
        lifecycle: "all",
        repository: null,
        search: "ignored",
        rawQuery: "author:hubot archived:true sort:created-asc",
      },
      pageSize: 50,
    });
    if (raw.type !== "inbox") throw 0;
    expect(raw.sections.map((item) => item.key)).toEqual(["results"]);
    const rawQuery = JSON.parse(
      f.calls.findLast((call) => call.args.includes("graphql"))!.input!,
    ).variables.searchQuery as string;
    expect(rawQuery).toContain("author:hubot archived:true sort:created-asc");
    expect(rawQuery).not.toContain("archived:false");
    expect(rawQuery).not.toContain("sort:updated-desc");
    expect(rawQuery).not.toContain("review-requested:@me");
    const initial = await f.service.read({
      type: "inbox",
      accountId,
      filters: {
        view: "all",
        lifecycle: "open",
        repository: null,
        search: "",
        rawQuery: null,
      },
      pageSize: 50,
    });
    if (initial.type !== "inbox") throw 0;
    const authored = initial.sections.find((item) => item.key === "authored")!;
    const next = await f.service.read({
      type: "inbox",
      accountId,
      filters: initial.filters,
      after: { authored: authored.pageInfo.endCursor! },
      pageSize: 50,
    });
    if (next.type !== "inbox") throw 0;
    expect(next.sections.map((item) => item.key)).toEqual(["authored"]);
  });

  test("returns body, discussion, checks and bounded file patch under an exact head fence", async () => {
    const f = fixture(),
      accounts = await f.service.read({ type: "accounts", refresh: true });
    if (accounts.type !== "accounts") throw 0;
    const result = await f.service.read({
      type: "detail",
      accountId: accounts.availability.activeAccountId!,
      pullRequest: {
        hostname: "github.com",
        owner: "openai",
        repository: "codex",
        number: 42,
      },
      pageSize: 50,
    });
    if (result.type !== "detail") throw 0;
    expect(result.body).toBe("Body\ntext");
    expect(result.discussion.items[0]?.body).toBe("Comment\nbody");
    expect(result.checks.items[0]?.bucket).toBe("pass");
    expect(result.files.items[0]?.patch).toEqual({
      text: "@@ -1 +1 @@\n-old\n+new\n",
    });
    expect(result.revision).toHaveLength(64);
  });

  test("marks nested review-thread comments partial instead of claiming a complete discussion", async () => {
    const f = fixture({ nestedThreadComments: true }),
      accounts = await f.service.read({ type: "accounts", refresh: true });
    if (accounts.type !== "accounts") throw 0;
    const pullRequest = {
      hostname: "github.com",
      owner: "openai",
      repository: "codex",
      number: 42,
    } as const;
    const comments = await f.service.read({
      type: "detail",
      accountId: accounts.availability.activeAccountId!,
      pullRequest,
      pageSize: 50,
    });
    if (comments.type !== "detail") throw 0;
    const reviews = await f.service.read({
      type: "detail",
      accountId: accounts.availability.activeAccountId!,
      pullRequest,
      expectedRevision: comments.revision,
      after: { discussion: comments.discussion.pageInfo.endCursor! },
      pageSize: 50,
    });
    if (reviews.type !== "detail") throw 0;
    const threads = await f.service.read({
      type: "detail",
      accountId: accounts.availability.activeAccountId!,
      pullRequest,
      expectedRevision: reviews.revision,
      after: { discussion: reviews.discussion.pageInfo.endCursor! },
      pageSize: 50,
    });
    if (threads.type !== "detail") throw 0;
    expect(threads.discussion.items[0]?.kind).toBe("review_comment");
    expect(threads.discussion.pageInfo.truncated).toBe(true);
  });

  test("sanitizes an operational runner failure", async () => {
    const f = fixture({ throwOnStatus: true });
    await expect(
      f.service.read({ type: "accounts", refresh: true }),
    ).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: "GitHub CLI could not start or complete this read.",
    });
  });

  test("rejects a head change observed after file reads", async () => {
    const f = fixture({ changeHeadAtEnd: true }),
      accounts = await f.service.read({ type: "accounts", refresh: true });
    if (accounts.type !== "accounts") throw 0;
    await expect(
      f.service.read({
        type: "detail",
        accountId: accounts.availability.activeAccountId!,
        pullRequest: {
          hostname: "github.com",
          owner: "openai",
          repository: "codex",
          number: 42,
        },
        pageSize: 50,
      }),
    ).rejects.toMatchObject({ code: "HEAD_CHANGED" });
  });

  test("shutdown aborts and drains an admitted read", async () => {
    const f = fixture({ hold: true }),
      accounts = await f.service.read({ type: "accounts", refresh: true });
    if (accounts.type !== "accounts") throw 0;
    const read = f.service.read({
      type: "inbox",
      accountId: accounts.availability.activeAccountId!,
      filters: {
        view: "authored",
        lifecycle: "all",
        repository: null,
        rawQuery: null,
        search: "",
      },
      pageSize: 50,
    });
    read.catch(() => {});
    while (!f.calls.some((call) => call.args.includes("graphql")))
      await Bun.sleep(1);
    const disposed = f.service.dispose();
    await expect(read).rejects.toBeDefined();
    await disposed;
    await expect(
      f.service.read({ type: "accounts", refresh: false }),
    ).rejects.toBeInstanceOf(PullRequestReadError);
  });
  test("explicit state qualifiers do not acquire an extra open filter", async () => {
    const f = fixture(),
      a = await f.service.read({ type: "accounts", refresh: true });
    if (a.type !== "accounts") throw 0;
    for (const rawQuery of ["state:closed", "draft:true", "is:draft"]) {
      await f.service.read({
        type: "inbox",
        accountId: a.availability.activeAccountId!,
        filters: {
          view: "reviewing",
          lifecycle: "all",
          repository: null,
          search: rawQuery,
          rawQuery,
        },
        pageSize: 50,
      });
      const query = JSON.parse(
        f.calls.findLast((call) => call.args.includes("graphql"))!.input!,
      ).variables.searchQuery;
      expect(query).toContain(rawQuery);
      expect(query).not.toContain("is:open");
    }
  });
  test("GraphQL failures stay explicit and direct-query rows do not require truncated team metadata", async () => {
    for (const graphqlError of [true, false]) {
      const f = fixture({ graphqlError, noTeamMetadata: true }),
        a = await f.service.read({ type: "accounts", refresh: true });
      if (a.type !== "accounts") throw 0;
      const result = await f.service.read({
        type: "inbox",
        accountId: a.availability.activeAccountId!,
        filters: {
          view: "all",
          lifecycle: "open",
          repository: null,
          search: "",
          rawQuery: null,
        },
        pageSize: 50,
      });
      if (result.type !== "inbox") throw 0;
      if (graphqlError) {
        expect(result.sections.every((section) => section.error !== null)).toBe(
          true,
        );
        expect(JSON.stringify(result)).not.toContain("private credential");
      } else
        expect(
          result.sections
            .find((section) => section.key === "team_review_requested")!
            .items.map((item) => item.nodeId),
        ).toEqual(["PR_1"]);
    }
  });
});

test("native command runner drains bounded output and rejects an already-retired request before spawning", async () => {
  const output = await runGh(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000)"],
    { stdoutLimit: 64, timeoutMs: 5000 },
  );
  expect(output.overflow).toBe(true);
  expect(output.timedOut).toBe(false);
  expect(output.stdout).toBe("");
  const input = await runGh(
    process.execPath,
    ["-e", "process.stdout.write(await Bun.stdin.text())"],
    { input: "ordinary owned input", timeoutMs: 5000 },
  );
  expect(input.exitCode).toBe(0);
  expect(input.stdout).toBe("ordinary owned input");
  const retired = new AbortController();
  retired.abort(new Error("Retired before spawn"));
  await expect(
    runGh("/nonexistent/executable", [], { signal: retired.signal }),
  ).rejects.toThrow("Retired before spawn");
  await expect(runGh("/nonexistent/executable", [], {})).rejects.toThrow();
});
