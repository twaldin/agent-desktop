import { afterAll, expect, test } from "bun:test";
import { SESSION_ACTIVITY_OWNER_HEADER } from "@agent-desktop/shared";
import { HostRequestError } from "./host-transport";
import { requestDetachedQuestions } from "./detached-questions-transport";

const requests: Array<{ method: string; pathname: string; owner: string | null; authorization: string | null }> = [];
const snapshot = (hostId = "owner", sessionId = "native/id") => ({
  protocolVersion: 1 as const,
  hostId,
  sessionId,
  questions: [],
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const prefix = url.pathname.split("/")[1];
    requests.push({
      method: request.method,
      pathname: url.pathname,
      owner: request.headers.get(SESSION_ACTIVITY_OWNER_HEADER),
      authorization: request.headers.get("Authorization"),
    });
    if (prefix === "old-host") return Response.json({ error: "Not found" }, { status: 404 });
    if (prefix === "coded-missing") return Response.json({ error: { code: "STALE_TARGET", message: "Gone" } }, { status: 404 });
    if (prefix === "unauthorized") return Response.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
    if (prefix === "header-owner") return Response.json(snapshot(), { headers: { [SESSION_ACTIVITY_OWNER_HEADER]: "other" } });
    if (prefix === "body-owner") return Response.json(snapshot("other"), { headers: { [SESSION_ACTIVITY_OWNER_HEADER]: "owner" } });
    if (prefix === "body-session") return Response.json(snapshot("owner", "other"), { headers: { [SESSION_ACTIVITY_OWNER_HEADER]: "owner" } });
    if (prefix === "malformed") return Response.json({ protocolVersion: 1, hostId: "owner", sessionId: "native/id", questions: "invalid" }, { headers: { [SESSION_ACTIVITY_OWNER_HEADER]: "owner" } });
    return Response.json(snapshot(), { headers: { [SESSION_ACTIVITY_OWNER_HEADER]: "owner" } });
  },
});
const endpoint = (prefix: string, token?: string) => ({
  origin: `http://127.0.0.1:${server.port}/${prefix}`,
  hostId: "owner",
  ...(token ? { token } : {}),
});
afterAll(() => server.stop(true));

test("detached-question transport uses the owning authenticated route and accepts its exact identity", async () => {
  requests.length = 0;
  await expect(requestDetachedQuestions(endpoint("ok", "secret"), "native/id")).resolves.toEqual(snapshot());
  expect(requests).toEqual([{
    method: "GET",
    pathname: "/ok/v1/sessions/native%2Fid/questions",
    owner: "owner",
    authorization: "Bearer secret",
  }]);
});

test("detached-question transport rejects response-header, body-owner, and session identity changes", async () => {
  await expect(requestDetachedQuestions(endpoint("header-owner"), "native/id")).rejects.toMatchObject({ status: 409, code: "OWNER_MISMATCH" } satisfies Partial<HostRequestError>);
  await expect(requestDetachedQuestions(endpoint("body-owner"), "native/id")).rejects.toMatchObject({ status: 409, code: "OWNER_MISMATCH" } satisfies Partial<HostRequestError>);
  await expect(requestDetachedQuestions(endpoint("body-session"), "native/id")).rejects.toMatchObject({ status: 409, code: "OWNER_MISMATCH" } satisfies Partial<HostRequestError>);
});

test("detached-question transport rejects malformed successful payloads", async () => {
  await expect(requestDetachedQuestions(endpoint("malformed"), "native/id")).rejects.toThrow("Invalid detached question snapshot protocol or size");
});

test("detached-question transport treats only an uncoded old-host route miss as unavailable", async () => {
  await expect(requestDetachedQuestions(endpoint("old-host"), "native/id")).resolves.toBeNull();
  await expect(requestDetachedQuestions(endpoint("coded-missing"), "native/id")).rejects.toMatchObject({ status: 404, code: "STALE_TARGET" } satisfies Partial<HostRequestError>);
  await expect(requestDetachedQuestions(endpoint("unauthorized"), "native/id")).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" } satisfies Partial<HostRequestError>);
});
