import { expect, test } from "bun:test";
import {
  SESSION_MCP_OWNER_HEADER,
  type NativeMcpAuthorizationReply,
  type NativeMcpAuthorizationSnapshot,
} from "@agent-desktop/shared";
import { SessionMcpAuthorizationHttp } from "./session-mcp-authorization-http";

const snapshot: NativeMcpAuthorizationSnapshot = {
  authorizationId: "auth-1",
  commandId: "start-1",
  serverName: "fixture",
  status: "running",
  phase: "authorizing",
  credentialsStored: false,
  credentialWrite: "not-started",
  configuration: "untouched",
  reconnected: false,
  login: {
    loginId: "auth-1",
    providerId: "mcp:fixture",
    status: "running",
    startedAt: 1,
    updatedAt: 2,
    cancellationRequested: false,
    prompts: [{ requestId: "request-1", kind: "prompt", message: "Paste code", allowEmpty: false, sensitive: true }],
  },
};

function harness(options: {
  loaded?: boolean;
  read?: () => Promise<NativeMcpAuthorizationSnapshot | null>;
  respond?: (value: NativeMcpAuthorizationReply) => Promise<NativeMcpAuthorizationSnapshot>;
  cancel?: (id: string) => Promise<NativeMcpAuthorizationSnapshot>;
  receipt?: (sessionId: string, commandId: string) => { commandId: string; state: "pending" | "succeeded" | "failed" | "unknown" | "absent"; message?: string; authorizationId?: string };
} = {}) {
  let reads = 0;
  const service = new SessionMcpAuthorizationHttp({
    hostId: "host-a",
    sessionExists: id => id === "session-a",
    receipt: options.receipt ?? ((_, commandId) => ({ commandId, state: "absent" })),
    existing: async id => {
      if (id !== "session-a" || options.loaded === false) return undefined;
      return {
        getSessionMcpAuthorization: async () => { reads++; return options.read ? options.read() : snapshot; },
        respondSessionMcpAuthorization: options.respond ?? (async () => snapshot),
        cancelSessionMcpAuthorization: options.cancel ?? (async () => snapshot),
      };
    },
  });
  const request = (path: string, init: RequestInit = {}) => service.route(new Request(`http://localhost${path}`, {
    ...init,
    headers: { [SESSION_MCP_OWNER_HEADER]: "host-a", ...(init.headers ?? {}) },
  }));
  return { request, get reads() { return reads; } };
}

test("authorization GET binds owner/session, never starts a worker, and preserves receipts on read failure", async () => {
  const unloaded = harness({ loaded: false });
  const response = await unloaded.request("/v1/sessions/session-a/mcp/authorization");
  expect(response?.status).toBe(200);
  expect(response?.headers.get("Cache-Control")).toBe("no-store");
  expect((await response!.json()).unavailable).toContain("No authorization was started");

  const wrongHost = harness();
  expect((await wrongHost.request("/v1/sessions/session-a/mcp/authorization", { headers: { [SESSION_MCP_OWNER_HEADER]: "other" } }))?.status).toBe(409);
  expect((await wrongHost.request("/v1/sessions/other/mcp/authorization"))?.status).toBe(409);
  expect((await wrongHost.request("/v1/sessions/session-a/mcp/authorization", { method: "POST" }))?.status).toBe(405);

  const receipt = { commandId: "start-1", state: "pending" as const, authorizationId: "auth-1" };
  const failedRead = harness({ read: async () => { throw new Error("private credential must not escape"); }, receipt: () => receipt });
  const failed = await failedRead.request("/v1/sessions/session-a/mcp/authorization?commandId=start-1");
  expect(failed?.status).toBe(200);
  const body = await failed!.json() as Record<string, unknown>;
  expect(body.receipt).toEqual(receipt);
  expect(JSON.stringify(body)).not.toContain("private credential");
  expect(failedRead.reads).toBe(1);
});

test("respond and cancel accept only their strict private bodies and never echo input", async () => {
  let received: NativeMcpAuthorizationReply | undefined;
  let cancelled: string | undefined;
  const service = harness({
    respond: async value => { received = value; return snapshot; },
    cancel: async id => { cancelled = id; return snapshot; },
  });
  const reply = { authorizationId: "auth-1", requestId: "request-1", response: { value: "secret-answer" } };
  const ok = await service.request("/v1/sessions/session-a/mcp/authorization/respond", { method: "POST", body: JSON.stringify(reply), headers: { "Content-Type": "application/json" } });
  expect(ok?.status).toBe(200);
  expect(received).toEqual(reply);
  expect(JSON.stringify(await ok!.json())).not.toContain("secret-answer");

  const cancelledResponse = await service.request("/v1/sessions/session-a/mcp/authorization/cancel", { method: "POST", body: JSON.stringify({ authorizationId: "auth-1" }) });
  expect(cancelledResponse?.status).toBe(200);
  expect(cancelled).toBe("auth-1");
  for (const [path, body] of [
    ["respond", { ...reply, extra: "nope" }],
    ["respond", { ...reply, response: { value: "x", extra: "nope" } }],
    ["cancel", { authorizationId: "auth-1", extra: "nope" }],
  ] as const) {
    expect((await service.request(`/v1/sessions/session-a/mcp/authorization/${path}`, { method: "POST", body: JSON.stringify(body) }))?.status).toBe(400);
  }
  expect((await service.request("/v1/sessions/session-a/mcp/authorization/respond", { method: "POST", body: JSON.stringify({ ...reply, response: { value: "x".repeat(1024 * 1024 + 1) } }) }))?.status).toBe(400);
});

test("unknown response outcome is reported without replaying the callback", async () => {
  let calls = 0;
  const service = harness({ respond: async () => { calls++; const error = Object.assign(new Error("native receipt uncertain"), { code: "OUTCOME_UNKNOWN" }); throw error; } });
  const response = await service.request("/v1/sessions/session-a/mcp/authorization/respond", { method: "POST", body: JSON.stringify({ authorizationId: "auth-1", requestId: "request-1", response: { value: "answer" } }) });
  expect(response?.status).toBe(503);
  expect((await response!.json()).error.code).toBe("OUTCOME_UNKNOWN");
  expect(calls).toBe(1);
});

test("a native mutation followed by an invalid snapshot is unknown, not retryable rejection", async () => {
  let calls = 0;
  const service = harness({
    respond: async () => {
      calls++;
      return { ...snapshot, login: { ...snapshot.login, loginId: "different-login" } };
    },
  });
  const response = await service.request("/v1/sessions/session-a/mcp/authorization/respond", {
    method: "POST",
    body: JSON.stringify({ authorizationId: "auth-1", requestId: "request-1", response: { value: "answer" } }),
  });
  expect(response?.status).toBe(503);
  const body = await response!.json() as { error: { code: string } };
  expect(body.error.code).toBe("OUTCOME_UNKNOWN");
  expect(calls).toBe(1);
});
