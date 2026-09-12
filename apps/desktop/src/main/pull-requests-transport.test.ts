import { afterEach, expect, test } from "bun:test";
import {
  PULL_REQUESTS_HOST_HEADER,
  parsePullRequestReadResult,
} from "../../../../packages/shared/src/pull-requests";
import {
  detail,
  inbox,
  account,
} from "../../../../scripts/acceptance/pull-requests/data";
import { readPullRequests } from "./pull-requests-transport";
import { createPullRequestsBridge } from "./pull-requests-preload";
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});
const endpoint = (
  fetch: (request: Request) => Response | Promise<Response>,
) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);
  return {
    origin: `http://127.0.0.1:${server.port}`,
    hostId: "host-a",
    token: "fixture-only",
  };
};
test("desktop transport captures authenticated host, parses correlated detail and preserves operational error text", async () => {
  const value = detail();
  let request: unknown;
  const owner = endpoint(async (input) => {
    expect(input.headers.get("Authorization")).toBe("Bearer fixture-only");
    expect(input.headers.get(PULL_REQUESTS_HOST_HEADER)).toBe("host-a");
    request = await input.json();
    return Response.json(value, {
      headers: { [PULL_REQUESTS_HOST_HEADER]: "host-a" },
    });
  });
  const result = await readPullRequests(owner, {
    type: "detail",
    accountId: account.id,
    pullRequest: value.summary.pullRequest,
    pageSize: 50,
  });
  expect(result).toEqual(value);
  expect(request).toMatchObject({
    type: "detail",
    accountId: account.id,
    pageSize: 50,
  });
  const refused = endpoint(() =>
    Response.json(
      {
        code: "HEAD_CHANGED",
        error: "The pull request head changed. Refresh.",
      },
      { status: 409, headers: { [PULL_REQUESTS_HOST_HEADER]: "host-a" } },
    ),
  );
  await expect(
    readPullRequests(refused, { type: "accounts", refresh: true }),
  ).rejects.toThrow("head changed");
});
test("foreign host, wrong account and wrong revision are refused through the actual preload parser", async () => {
  const request = {
    type: "inbox" as const,
    accountId: account.id,
    filters: inbox().filters,
    pageSize: 50 as const,
  };
  const foreign = endpoint(() =>
    Response.json(inbox(), {
      headers: { [PULL_REQUESTS_HOST_HEADER]: "host-b" },
    }),
  );
  await expect(readPullRequests(foreign, request)).rejects.toThrow(
    "another host",
  );
  const bridge = createPullRequestsBridge(async (channel, host, input) => {
    expect(channel).toBe("host:pull-requests");
    expect(host).toBe("host-a");
    expect(input).toEqual(request);
    return { ...inbox(), account: { ...account, id: "other" } };
  });
  await expect(bridge.read("host-a", request)).rejects.toThrow(
    "account changed",
  );
  const value = detail();
  expect(() =>
    parsePullRequestReadResult(value, {
      type: "detail",
      accountId: account.id,
      pullRequest: value.summary.pullRequest,
      expectedRevision: "b".repeat(40),
      pageSize: 50,
    }),
  ).toThrow("head changed");
});
test("invalid requests never enter the desktop IPC bridge", async () => {
  let calls = 0;
  const bridge = createPullRequestsBridge(async () => {
    calls++;
    throw new Error("Unexpected dispatch");
  });
  await expect(
    bridge.read("host-a", {
      type: "detail",
      accountId: account.id,
      pullRequest: detail().summary.pullRequest,
      after: { files: "next" },
      pageSize: 50,
    } as never),
  ).rejects.toThrow("reviewed revision");
  expect(calls).toBe(0);
});
