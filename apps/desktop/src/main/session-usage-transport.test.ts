import { afterEach, expect, test } from "bun:test";
import { SESSION_USAGE_HEADER, SESSION_USAGE_MAX_BYTES, type SessionUsageResponse } from "../../../../packages/shared/src/session-usage";
import { requestSessionUsage, requestSessionUsageCommand, validateSessionUsageResponse } from "./session-usage-transport";

const originalFetch = globalThis.fetch;
const endpoint = { origin: "http://unused.invalid", hostId: "owner", token: "test-token" };
const sessionId = "session/one";
const responseBody: SessionUsageResponse = {
  version: 1, hostId: "owner", sessionId,
  snapshot: {
    version: 1, sessionId, epoch: "epoch", revision: "revision", reportStatus: "available", reportsCheckedAt: 10,
    reports: [{ provider: "openai", fetchedAt: 11, active: true, identity: { accountId: "acct" }, limits: [{ id: "five-hour", label: "Five hour", active: true, scope: { provider: "openai" }, amount: { unit: "tokens", remaining: 2 }, notes: [] }], notes: [] }],
    credits: [{ accountRef: "acct", active: true, credits: [], canPrepare: false }], modelSelectors: [],
    policy: { autoRedeem: "unset", minBlockedMinutes: 30, keepCredits: 1, salvageHorizonHours: 24 },
  }, reset: null,
};

afterEach(() => { globalThis.fetch = originalFetch; });

test("cached usage uses GET and authenticated owner headers", async () => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("http://unused.invalid/v1/sessions/session%2Fone/usage");
    expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined(); expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get(SESSION_USAGE_HEADER)).toBe("owner"); expect(headers.get("Authorization")).toBe("Bearer test-token");
    return Response.json(responseBody, { headers: { [SESSION_USAGE_HEADER]: "owner" } });
  }) as unknown as typeof fetch;
  expect(await requestSessionUsage(endpoint, sessionId)).toEqual(responseBody);
});

test("reports and credits refreshes use POST with only the requested mode", async () => {
  for (const mode of ["reports", "credits"] as const) {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST"); expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({ mode });
      return Response.json(responseBody, { headers: { [SESSION_USAGE_HEADER]: "owner" } });
    }) as unknown as typeof fetch;
    await expect(requestSessionUsage(endpoint, sessionId, mode)).resolves.toEqual(responseBody);
  }
});

test("rejects mismatched ownership, version, and session identity", async () => {
  globalThis.fetch = (async () => Response.json({ ...responseBody, hostId: "foreign" }, { headers: { [SESSION_USAGE_HEADER]: "owner" } })) as unknown as typeof fetch;
  await expect(requestSessionUsage(endpoint, sessionId)).rejects.toThrow("Invalid session usage response.");
  globalThis.fetch = (async () => Response.json({ ...responseBody, version: 2 }, { headers: { [SESSION_USAGE_HEADER]: "owner" } })) as unknown as typeof fetch;
  await expect(requestSessionUsage(endpoint, sessionId)).rejects.toThrow("Invalid session usage response.");
  globalThis.fetch = (async () => Response.json({ ...responseBody, sessionId: "other" }, { headers: { [SESSION_USAGE_HEADER]: "owner" } })) as unknown as typeof fetch;
  await expect(requestSessionUsage(endpoint, sessionId)).rejects.toThrow("Invalid session usage response.");
  globalThis.fetch = (async () => Response.json(responseBody, { headers: { [SESSION_USAGE_HEADER]: "foreign" } })) as unknown as typeof fetch;
  await expect(requestSessionUsage(endpoint, sessionId)).rejects.toThrow("Session usage response owner mismatch.");
});

test("rejects oversized streamed responses and all remote error details are sanitized", async () => {
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(SESSION_USAGE_MAX_BYTES)); controller.enqueue(new Uint8Array(1));
  }, cancel() { cancelled = true; } }), { status: 200, headers: { [SESSION_USAGE_HEADER]: "owner" } })) as unknown as typeof fetch;
  await expect(requestSessionUsage(endpoint, sessionId)).rejects.toThrow("oversized"); expect(cancelled).toBe(true);
  globalThis.fetch = (async () => Response.json({ error: { message: "secret provider detail", code: "SECRET" } }, { status: 503 })) as unknown as typeof fetch;
  await expect(requestSessionUsage(endpoint, sessionId)).rejects.toThrow("Session usage request failed.");
  await expect(requestSessionUsage(endpoint, sessionId)).rejects.not.toThrow("secret provider detail");
});

test("sanitizes unknown fields from the renderer-facing envelope", () => {
  const snapshot = responseBody.snapshot!;
  const value = validateSessionUsageResponse({ ...responseBody, injected: "drop", snapshot: { ...snapshot, injected: "drop", reports: [{ ...snapshot.reports[0], injected: "drop" }] } }, endpoint, sessionId);
  expect(value).not.toHaveProperty("injected"); expect(value.snapshot).not.toHaveProperty("injected"); expect(value.snapshot?.reports[0]).not.toHaveProperty("injected");
});

test("cached command inspection uses an exact encoded ID and rejects unsolicited or mismatched receipts", async () => {
  globalThis.fetch = (async (url: string | URL) => {
    expect(String(url)).toContain("/usage?commandId=cmd%2F1");
    return Response.json({ ...responseBody, command: { id: "cmd/1", state: "absent" } }, { headers: { [SESSION_USAGE_HEADER]: "owner" } });
  }) as unknown as typeof fetch;
  await expect(requestSessionUsage(endpoint, sessionId, "cached", "cmd/1")).resolves.toMatchObject({ command: { id: "cmd/1", state: "absent" } });
  globalThis.fetch = (async () => Response.json({ ...responseBody, command: { id: "other", state: "pending" } }, { headers: { [SESSION_USAGE_HEADER]: "owner" } })) as unknown as typeof fetch;
  await expect(requestSessionUsage(endpoint, sessionId, "cached", "cmd/1")).rejects.toThrow("Invalid session usage response.");
  globalThis.fetch = (async () => Response.json({ ...responseBody, command: { id: "cmd/1", state: "done" } }, { headers: { [SESSION_USAGE_HEADER]: "owner" } })) as unknown as typeof fetch;
  await expect(requestSessionUsage(endpoint, sessionId)).rejects.toThrow("Invalid session usage response.");
});

test("reset dispatch binds original host before admission and validates exact sanitized receipt", async () => {
  const envelope = { id: "prepare-1", commandVersion: 20 as const, command: { type: "session.usage.reset.prepare" as const, sessionId, epoch: "e", revision: "r", accountRef: "a" } };
  const receipt = { operationId: envelope.id, hostId: endpoint.hostId, sessionId, state: "prepared", createdAt: 1,
    confirmation: { expiresAt: 2, account: { accountRef: "a", active: true }, credit: { title: "Saved credit" } } };
  let next = receipt;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`${endpoint.origin}/v20/commands`); expect(init?.method).toBe("POST"); expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get(SESSION_USAGE_HEADER)).toBe(endpoint.hostId);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token"); expect(JSON.parse(String(init?.body))).toEqual(envelope);
    return Response.json({ ok: true, commandId: envelope.id, value: { type: "session.usage.reset", receipt: { ...next, secret: "drop" } } }, { headers: { [SESSION_USAGE_HEADER]: endpoint.hostId } });
  }) as unknown as typeof fetch;
  const result = await requestSessionUsageCommand(endpoint, envelope); expect(result.ok).toBe(true); expect(result).not.toHaveProperty("value.receipt.secret");
  next = { ...receipt, operationId: "different" }; await expect(requestSessionUsageCommand(endpoint, envelope)).rejects.toThrow("operation identity");
  next = { ...receipt, hostId: "different" }; await expect(requestSessionUsageCommand(endpoint, envelope)).rejects.toThrow("identity mismatch");
  globalThis.fetch = (async () => Response.json({ error: "private provider error" }, { status: 409 })) as unknown as typeof fetch;
  await expect(requestSessionUsageCommand(endpoint, envelope)).rejects.toThrow("outcome could not be confirmed");
});
