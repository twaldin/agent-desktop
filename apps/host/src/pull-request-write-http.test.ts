import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostStore } from "./store";
import { PullRequests } from "./pull-requests";
import { PullRequestsHttp } from "./pull-requests-http";
import { PULL_REQUESTS_HOST_HEADER } from "../../../packages/shared/src/pull-requests";
test("actual HTTP status cannot reserve; authenticated owner parsing precedes submit and unknown history never posts", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-write-http-")), store = new HostStore(root); let runs = 0;
  const service = new PullRequests({ hostId: store.host.id, writes: store.pullRequestWrites, ghPath: process.execPath, runner: async () => { runs++; throw new Error("Unexpected runner"); } });
  const http = new PullRequestsHttp(store.host.id, service);
  const input = { requestId: "original-request-0001", accountId: "original-account", pullRequest: { hostname: "github.com", owner: "owner", repository: "repo", number: 42 }, action: "comment" as const, body: "My comment", expectedHeadOid: "a".repeat(40) };
  const call = (path: string, body: unknown = input, host = store.host.id, method = "POST") => http.route(new Request(`http://host/v1/pull-requests/${path}`, { method, headers: { [PULL_REQUESTS_HOST_HEADER]: host, "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) }));
  try {
    const absent = await call("submission-status"); expect(absent?.status).toBe(200); expect(await absent?.json()).toBeNull();
    expect(store.pullRequestWrites.get(input)).toBeUndefined(); expect(runs).toBe(0);
    expect((await call("submit", input, "foreign"))?.status).toBe(409);
    expect((await call("submit", { ...input, action: "merge" }))?.status).toBe(400);
    expect((await call("submit", input, store.host.id, "GET"))?.status).toBe(405); expect(runs).toBe(0);
    store.pullRequestWrites.claim(input);
    const response = await call("submit"); expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response?.json()).toMatchObject({ outcome: "unknown", request: input }); expect(runs).toBe(0);
  } finally { await service.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
