import { expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { nativeResetAccountKey, projectUsageReports } from "./session-usage";
import { parseUsageCommand } from "../../../../packages/shared/src/session-usage";
import { validateSessionUsageResponse } from "../../../../packages/shared/src/session-usage-validation";

test("native report projection preserves quantitative scopes, windows, notes and org-gated active identity", () => {
  const session = { sessionId: "original", modelRegistry: { authStorage: { getOAuthAccountIdentity: (_provider: string, id: string) => {
    expect(id).toBe("original"); return { accountId: "account", email: "same@fixture.invalid", orgId: "org-a" };
  } } } } as unknown as AgentSession;
  const report: UsageReport = { provider: "openai-codex", fetchedAt: 100, metadata: { accountId: "account", email: "same@fixture.invalid", orgId: "org-a", accessToken: "private-token" }, raw: { secret: "private-raw" }, notes: ["Native disclaimer"],
    resetCredits: { availableCount: 1, credits: [{ status: "available", expiresAt: "2099-01-01" }] },
    limits: [{ id: "window", label: "Shared tier", scope: { provider: "openai-codex", accountId: "account", orgId: "org-a", projectId: "project", modelId: "model", tier: "tier", windowId: "day", shared: true },
      amount: { unit: "tokens", usedFraction: 1.2 }, window: { id: "day", label: "Day", durationMs: 86400000, resetsAt: 12345, resetLabel: "regenerates" }, notes: ["Limit note"] }] };
  const values = projectUsageReports([report, { ...report, metadata: { ...report.metadata, orgId: "org-b" }, limits: report.limits.map(limit => ({ ...limit, scope: { ...limit.scope, orgId: "org-b" } })) }], session);
  expect(values[0]?.active).toBe(true); expect(values[1]?.active).toBe(false); expect(values[1]?.limits[0]?.active).toBe(false);
  expect(values[0]?.limits[0]?.amount).toEqual({ unit: "tokens", usedFraction: 1.2 });
  expect(values[0]?.limits[0]?.window?.resetLabel).toBe("regenerates"); expect(values[0]?.notes).toEqual(["Native disclaimer"]);
  expect(values[0]?.resetCredits?.credits[0]?.expiresAt).toBe("2099-01-01");
  expect(JSON.stringify(values)).not.toContain("private-"); expect(values[0]?.fetchedAt).toBe(100);
  expect(() => projectUsageReports(Array(129).fill(report), session)).toThrow();
});
test("one native endpoint/account/scope fence survives email aliases but separates organizations", () => {
  const identity = { provider: "openai-codex", accountId: "proven", orgId: "org", projectId: "project", email: "old@fixture.invalid" };
  expect(nativeResetAccountKey(identity)).toBe(nativeResetAccountKey({ ...identity, email: "new@fixture.invalid" }));
  expect(nativeResetAccountKey(identity)).not.toBe(nativeResetAccountKey({ ...identity, orgId: "other" }));
  expect(nativeResetAccountKey(identity, "https://chatgpt.com/backend-api/codex/responses")).toBe(nativeResetAccountKey(identity));
  expect(nativeResetAccountKey(identity, "https://streaming-proxy.fixture.invalid/v1")).toBe(nativeResetAccountKey(identity));
  expect(() => nativeResetAccountKey({ provider: "openai-codex" })).toThrow();
});
test("usage commands accept only original opaque references and an explicit boolean answer", () => {
  const command = { type: "session.usage.reset.prepare" as const, sessionId: "session", epoch: "epoch", revision: "revision", accountRef: "opaque" };
  expect(parseUsageCommand(command)).toEqual(command);
  for (const extra of [{ credentialId: 2 }, { creditId: "credit" }, { cwd: "/elsewhere" }, { sessionFile: "/elsewhere/native.jsonl" }, { baseUrl: "https://other.invalid" }]) expect(() => parseUsageCommand({ ...command, ...extra })).toThrow();
  expect(() => parseUsageCommand({ type: "session.usage.reset.respond", sessionId: "session", operationId: "op", confirm: "yes" })).toThrow();
});

test("usage validation retains exact reset-command matching fields and rejects malformed metadata", () => {
  const base = { version: 1, hostId: "host", sessionId: "session", reset: null, snapshot: { version: 1, sessionId: "session", epoch: "epoch", revision: "revision",
    reports: [], reportStatus: "not-loaded", credits: [], modelSelectors: [], policy: { autoRedeem: "unset", minBlockedMinutes: 1, keepCredits: 1, salvageHorizonHours: 1 },
    resetCommandAccounts: [{ accountRef: "opaque", label: "Exact Label", active: true, availableCount: 2, email: "Case@Example.invalid", accountId: "Account-A" }] } };
  expect(validateSessionUsageResponse(base, { hostId: "host" }, "session").snapshot?.resetCommandAccounts).toEqual(base.snapshot.resetCommandAccounts);
  expect(() => validateSessionUsageResponse({ ...base, snapshot: { ...base.snapshot, resetCommandAccounts: [{ ...base.snapshot.resetCommandAccounts[0], label: "bad\nlabel" }] } }, { hostId: "host" }, "session")).toThrow("reset command label");
});
