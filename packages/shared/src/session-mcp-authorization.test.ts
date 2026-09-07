import { describe, expect, test } from "bun:test";
import {
  type NativeMcpAuthorizationResponse,
  type NativeMcpAuthorizationSnapshot,
  parseNativeMcpAuthorizationResponse,
  parseNativeMcpAuthorizationSnapshot,
  parseNativeMcpAuthorizationStart,
} from "./session-mcp-authorization";

const pending = (): NativeMcpAuthorizationSnapshot => ({
  authorizationId: "authorization-1",
  serverName: " exact server ",
  status: "running",
  phase: "authorizing",
  credentialsStored: false,
  credentialWrite: "not-started",
  configuration: "untouched",
  reconnected: false,
  login: {
    loginId: "authorization-1",
    providerId: "mcp: exact server ",
    status: "running",
    startedAt: 10,
    updatedAt: 20,
    cancellationRequested: false,
    auth: {
      url: "http://127.0.0.1/callback?state=exact%20state",
      launchUrl: "https://issuer.invalid/authorize?state=exact%20state",
      instructions: "Paste the exact callback URL",
      callbackOnOwningHost: true,
    },
    progress: "Waiting for authorization",
    prompts: [{
      requestId: "request-1",
      kind: "manual-code",
      message: "Paste redirect URL",
      placeholder: "http://127.0.0.1/callback",
      allowEmpty: false,
      sensitive: true,
    }],
  },
});

describe("native MCP authorization wire state", () => {
  test("round trips exact pending callback state and binds owner, command, and authorization identity", () => {
    const value = { ...pending(), commandId: "command-1" };
    expect(parseNativeMcpAuthorizationSnapshot(value)).toEqual(value);
    const response: NativeMcpAuthorizationResponse = {
      protocolVersion: 1,
      hostId: "host-1",
      sessionId: "session-1",
      value,
      receipt: { commandId: "command-1", state: "succeeded", authorizationId: "authorization-1" },
    };
    expect(parseNativeMcpAuthorizationResponse(response, "host-1", "session-1", "command-1")).toEqual(response);
  });

  test("parses a reconnect ticket with an optional strict command correlation identity", () => {
    expect(parseNativeMcpAuthorizationStart({ epoch: "epoch-1", expectedRevision: 3, serverName: "fixture", commandId: "command_1-A" }))
      .toEqual({ epoch: "epoch-1", expectedRevision: 3, serverName: "fixture", commandId: "command_1-A" });
    expect(parseNativeMcpAuthorizationStart({ epoch: "epoch-1", expectedRevision: 3, serverName: "fixture" }))
      .toEqual({ epoch: "epoch-1", expectedRevision: 3, serverName: "fixture" });
    expect(() => parseNativeMcpAuthorizationStart({ epoch: "epoch-1", expectedRevision: 3, serverName: "fixture", commandId: "bad command" })).toThrow("command identity");
    expect(() => parseNativeMcpAuthorizationStart({ epoch: "epoch-1", expectedRevision: 3, serverName: "fixture", extra: true })).toThrow("start field");
  });

  test("accepts a truthful partial terminal outcome and legacy absent optional receipt identity", () => {
    const value = {
      ...pending(), status: "failed", phase: "finished", credentialsStored: true,
      credentialWrite: "stored", configuration: "unknown", error: "Credentials were stored; configuration outcome is unknown.",
      login: {
        ...pending().login, status: "succeeded", prompts: [], auth: undefined, progress: undefined,
        identity: { type: "oauth", accountId: "account-1", orgName: "Example" },
      },
    };
    const parsed = parseNativeMcpAuthorizationResponse({
      protocolVersion: 1, hostId: "host-1", sessionId: "session-1", value,
      receipt: { commandId: "command-1", state: "unknown", message: "Inspect authorization status." },
    }, "host-1", "session-1", "command-1");
    expect(parsed.value).toMatchObject({ status: "failed", credentialsStored: true, configuration: "unknown" });
    expect(parsed.receipt).toEqual({ commandId: "command-1", state: "unknown", message: "Inspect authorization status." });
  });

  test("rejects wrong transport and receipt owners or mismatched authorization identities", () => {
    const response = { protocolVersion: 1, hostId: "host-1", sessionId: "session-1", value: pending() };
    expect(() => parseNativeMcpAuthorizationResponse(response, "other", "session-1")).toThrow("owner");
    expect(() => parseNativeMcpAuthorizationResponse({ ...response, receipt: { commandId: "other", state: "pending" } }, "host-1", "session-1", "command-1")).toThrow("receipt owner");
    expect(() => parseNativeMcpAuthorizationResponse({ ...response, value: { ...pending(), commandId: "command-1" }, receipt: { commandId: "command-1", state: "pending", authorizationId: "authorization-2" } }, "host-1", "session-1", "command-1")).toThrow("identity");
    expect(parseNativeMcpAuthorizationResponse({ ...response, value: { ...pending(), authorizationId: "authorization-2", commandId: "new-command", login: { ...pending().login, loginId: "authorization-2" } }, receipt: { commandId: "command-1", state: "succeeded", authorizationId: "authorization-1" } }, "host-1", "session-1", "command-1"))
      .toMatchObject({ value: { authorizationId: "authorization-2", commandId: "new-command" }, receipt: { commandId: "command-1", authorizationId: "authorization-1" } });
    expect(() => parseNativeMcpAuthorizationResponse(response, "host-1", "session-1", "command-1")).toThrow("Missing");
    expect(() => parseNativeMcpAuthorizationSnapshot({ ...pending(), login: { ...pending().login, loginId: "other" } })).toThrow("do not match");
  });

  test("rejects private response values, credentials, unknown fields, and malformed nested login state", () => {
    const promptWithValue = structuredClone(pending());
    (promptWithValue.login.prompts[0] as unknown as Record<string, unknown>).value = "private callback response";
    expect(() => parseNativeMcpAuthorizationSnapshot(promptWithValue)).toThrow("prompt field");
    expect(() => parseNativeMcpAuthorizationSnapshot({ ...pending(), credential: { access: "private-token" } })).toThrow("snapshot field");
    expect(() => parseNativeMcpAuthorizationSnapshot({ ...pending(), login: { ...pending().login, auth: { ...pending().login.auth, token: "private-token" } } })).toThrow("authorization field");
    expect(() => parseNativeMcpAuthorizationSnapshot({ ...pending(), login: { ...pending().login, prompts: [{ ...pending().login.prompts[0], sensitive: false }] } })).toThrow("sensitivity");
    expect(() => parseNativeMcpAuthorizationResponse({ protocolVersion: 1, hostId: "host-1", sessionId: "session-1", value: null, receipt: { commandId: "command-1", state: "succeeded", response: { value: "private" } } }, "host-1", "session-1", "command-1")).toThrow("receipt field");
  });

  test("enforces prompt counts, text bounds, identifiers, and total serialized size", () => {
    expect(() => parseNativeMcpAuthorizationSnapshot({ ...pending(), login: { ...pending().login, prompts: Array.from({ length: 257 }, () => pending().login.prompts[0]) } })).toThrow("prompts");
    expect(() => parseNativeMcpAuthorizationSnapshot({ ...pending(), serverName: "x".repeat(1025) })).toThrow("text");
    expect(() => parseNativeMcpAuthorizationSnapshot({ ...pending(), authorizationId: "bad\0id", login: { ...pending().login, loginId: "bad\0id" } })).toThrow("identity");
    expect(() => parseNativeMcpAuthorizationSnapshot({ ...pending(), login: { ...pending().login, prompts: [{ ...pending().login.prompts[0], message: "x".repeat(64 * 1024 + 1) }] }, error: "x".repeat(16 * 1024) })).toThrow();
  });
});
