import { afterEach, expect, test } from "bun:test";
import { requestPullRequestWrite } from "./pull-request-write-transport";
import { createPullRequestWritesBridge } from "./pull-request-write-preload";
import { PULL_REQUESTS_HOST_HEADER } from "../../../../packages/shared/src/pull-requests";
import type { PullRequestWriteRequest, PullRequestWriteReceipt } from "../../../../packages/shared/src/pull-request-write";
const request: PullRequestWriteRequest = { requestId: "original-request-0001", accountId: "account-one", pullRequest: { hostname: "github.com", owner: "owner", repository: "repo", number: 42 }, action: "comment", body: "Original body", expectedHeadOid: "a".repeat(40) };
const receipt: PullRequestWriteReceipt = { hostId: "host-one", request, outcome: "succeeded", message: "Submitted", url: "https://github.com/owner/repo/pull/42#issuecomment-1" };
const endpoint = { hostId: "host-one", origin: "https://owner.invalid", token: "fixture-owner-token" };
const originalFetch = globalThis.fetch;
function installFetch(run: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>) {
  globalThis.fetch = Object.assign(run, { preconnect() {} });
}
afterEach(() => { globalThis.fetch = originalFetch; });
test("preload and transport preserve the captured original input, endpoint headers and structured body", async () => {
  const calls: { url: string; method?: string; body: unknown }[] = [];
  installFetch(async (url, init) => {
    const headers = new Headers(init?.headers); expect(headers.get(PULL_REQUESTS_HOST_HEADER)).toBe(endpoint.hostId); expect(headers.get("Authorization")).toBe("Bearer fixture-owner-token");
    calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
    return Response.json(receipt, { headers: { [PULL_REQUESTS_HOST_HEADER]: endpoint.hostId } });
  });
  const bridge = createPullRequestWritesBridge(async (channel, hostId, operation, input) => {
    expect(channel).toBe("host:pull-request-write"); expect(hostId).toBe(endpoint.hostId);
    return requestPullRequestWrite(endpoint, operation as "submit", input as PullRequestWriteRequest);
  });
  const mutable = structuredClone(request), promise = bridge.submit(endpoint.hostId, mutable); mutable.pullRequest.owner = "changed-after-call"; mutable.body = "changed";
  expect(await promise).toEqual(receipt);
  expect(calls).toEqual([{ url: "https://owner.invalid/v1/pull-requests/submit", method: "POST", body: request }]);
});
test("status is lookup-only and only status may return an absent reservation", async () => {
  let url = "";
  installFetch(async input => { url = String(input); return Response.json(null, { headers: { [PULL_REQUESTS_HOST_HEADER]: endpoint.hostId } }); });
  expect(await requestPullRequestWrite(endpoint, "status", request)).toBeNull(); expect(url).toEndWith("/submission-status");
  await expect(requestPullRequestWrite(endpoint, "submit", request)).rejects.toThrow();
});
test("foreign host, changed nested owner and oversized response cannot confirm success or leak a response body", async () => {
  let cancelled = false;
  installFetch(async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } }), { headers: { [PULL_REQUESTS_HOST_HEADER]: "foreign" } }));
  await expect(requestPullRequestWrite(endpoint, "submit", request)).rejects.toThrow("another host"); expect(cancelled).toBe(true);
  installFetch(async () => Response.json({ ...receipt, request: { ...request, pullRequest: { ...request.pullRequest, number: 43 } } }, { headers: { [PULL_REQUESTS_HOST_HEADER]: endpoint.hostId } }));
  await expect(requestPullRequestWrite(endpoint, "submit", request)).rejects.toThrow("owner changed");
  installFetch(async () => new Response('"' + "x".repeat(140_001) + '"', { headers: { [PULL_REQUESTS_HOST_HEADER]: endpoint.hostId } }));
  await expect(requestPullRequestWrite(endpoint, "submit", request)).rejects.toThrow();
});
