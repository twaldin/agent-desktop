import { afterAll, expect, test } from "bun:test";
import { SESSION_MCP_OWNER_HEADER } from "@agent-desktop/shared";
import { HostRequestError } from "./host-transport";
import {
  cancelSessionMcpAuthorization,
  requestSessionMcpAuthorization,
  respondSessionMcpAuthorization,
} from "./session-mcp-authorization-transport";

const requests: Array<{ path: string; search: string; method: string; owner: string | null; authorization: string | null; body?: unknown }> = [];
const snapshot = (authorizationId = "authorization-1", commandId?: string) => ({
  authorizationId, ...(commandId ? { commandId } : {}), serverName: "fixture", status: "running", phase: "authorizing",
  credentialsStored: false, credentialWrite: "not-started", configuration: "untouched", reconnected: false,
  login: { loginId: authorizationId, providerId: "mcp:fixture", status: "running", startedAt: 1, updatedAt: 2,
    cancellationRequested: false, prompts: [], auth: { url: "https://issuer.invalid/authorize?state=exact", callbackOnOwningHost: true } },
});
const response = (authorizationId = "authorization-1", hostId = "owner", sessionId = "native/id") => ({ protocolVersion: 1, hostId, sessionId, value: snapshot(authorizationId) });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url), prefix = url.pathname.split("/")[1];
  const row: (typeof requests)[number] = { path: url.pathname, search: url.search, method: request.method,
    owner: request.headers.get(SESSION_MCP_OWNER_HEADER), authorization: request.headers.get("authorization") };
  if (request.method === "POST") row.body = await request.json();
  requests.push(row);
  const headers = { [SESSION_MCP_OWNER_HEADER]: prefix === "wrong-header" ? "other" : "owner" };
  if (prefix === "rejected" || prefix === "unowned-409") return Response.json({ error: { code: "MCP_RESPONSE_REJECTED", message: "No longer pending." } }, { status: 409, headers: prefix === "unowned-409" ? { [SESSION_MCP_OWNER_HEADER]: "other" } : headers });
  if (prefix === "malformed" || prefix === "malformed-503") return new Response("not json", { status: prefix === "malformed-503" ? 503 : 200, headers });
  const body = row.body as { authorizationId?: string } | undefined;
  const authorizationId = prefix === "wrong-id" ? "authorization-2" : body?.authorizationId ?? "authorization-1";
  const value = response(authorizationId, prefix === "wrong-body" ? "other" : "owner");
  if (url.searchParams.has("commandId")) value.value = snapshot("authorization-1", url.searchParams.get("commandId")!);
  return Response.json({ ...value, ...(url.searchParams.has("commandId") ? { receipt: { commandId: url.searchParams.get("commandId"), state: "succeeded", authorizationId: "authorization-1" } } : {}) }, { headers });
} });
afterAll(() => server.stop(true));
const endpoint = (prefix: string) => ({ origin: `http://127.0.0.1:${server.port}/${prefix}`, hostId: "owner", token: "private-token" });

test("authorization inspection uses its exact authenticated owner route and receipt identity", async () => {
  requests.length = 0;
  const result = await requestSessionMcpAuthorization(endpoint("ok"), "native/id", "command-1");
  expect(result.receipt).toEqual({ commandId: "command-1", state: "succeeded", authorizationId: "authorization-1" });
  expect(requests).toEqual([{ path: "/ok/v1/sessions/native%2Fid/mcp/authorization", search: "?commandId=command-1", method: "GET", owner: "owner", authorization: "Bearer private-token" }]);
});

test("private response and cancellation POST only their strict write payload and validate returned identity", async () => {
  requests.length = 0;
  await respondSessionMcpAuthorization(endpoint("ok"), "native/id", { authorizationId: "authorization-1", requestId: "request-1", response: { value: "private callback value" } });
  await cancelSessionMcpAuthorization(endpoint("ok"), "native/id", "authorization-1");
  expect(requests.map(row => ({ path: row.path, method: row.method, body: row.body }))).toEqual([
    { path: "/ok/v1/sessions/native%2Fid/mcp/authorization/respond", method: "POST", body: { authorizationId: "authorization-1", requestId: "request-1", response: { value: "private callback value" } } },
    { path: "/ok/v1/sessions/native%2Fid/mcp/authorization/cancel", method: "POST", body: { authorizationId: "authorization-1" } },
  ]);
  await expect(cancelSessionMcpAuthorization(endpoint("wrong-id"), "native/id", "authorization-1"))
    .rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", status: 503 } satisfies Partial<HostRequestError>);
});

test("owner and malformed post-dispatch responses fail closed while a definite host rejection remains definite", async () => {
  await expect(requestSessionMcpAuthorization(endpoint("wrong-header"), "native/id")).rejects.toMatchObject({ code: "OWNER_MISMATCH" } satisfies Partial<HostRequestError>);
  await expect(requestSessionMcpAuthorization(endpoint("wrong-body"), "native/id")).rejects.toThrow("owner");
  await expect(cancelSessionMcpAuthorization(endpoint("wrong-header"), "native/id", "authorization-1"))
    .rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", status: 503 } satisfies Partial<HostRequestError>);
  await expect(cancelSessionMcpAuthorization(endpoint("malformed"), "native/id", "authorization-1"))
    .rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", status: 503 } satisfies Partial<HostRequestError>);
  await expect(cancelSessionMcpAuthorization(endpoint("rejected"), "native/id", "authorization-1"))
    .rejects.toMatchObject({ code: "MCP_RESPONSE_REJECTED", status: 409 } satisfies Partial<HostRequestError>);
  requests.length = 0;
  await expect(cancelSessionMcpAuthorization(endpoint("unowned-409"), "native/id", "authorization-1"))
    .rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", status: 503 } satisfies Partial<HostRequestError>);
  expect(requests.filter(row => row.method === "POST")).toHaveLength(1);
  requests.length = 0;
  await expect(cancelSessionMcpAuthorization(endpoint("malformed-503"), "native/id", "authorization-1"))
    .rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", status: 503 } satisfies Partial<HostRequestError>);
  expect(requests.filter(row => row.method === "POST")).toHaveLength(1);
});

test("invalid local owner, command, and private reply are rejected before dispatch", async () => {
  requests.length = 0;
  await expect(requestSessionMcpAuthorization({ origin: endpoint("ok").origin, hostId: "" }, "native/id")).rejects.toThrow("owning session");
  await expect(requestSessionMcpAuthorization(endpoint("ok"), "native/id", "bad command")).rejects.toThrow("command identity");
  expect(() => respondSessionMcpAuthorization(endpoint("ok"), "native/id", { authorizationId: "authorization-1", requestId: "request-1", response: { value: "x".repeat(1024 * 1024 + 1) } })).toThrow("response");
  expect(requests).toEqual([]);
});
