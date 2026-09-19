import { describe, expect, test } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
  planCodexResetRedemptions,
  planCodexResetRedemptionsWithReportRevision,
  type CodexResetPlanInput,
} from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";

const NOW = 1_800_000_000_000;
const report = (): UsageReport => ({
  provider: "openai-codex",
  fetchedAt: NOW,
  metadata: {
    accountId: "Account-A",
    account_id: "account-a",
    email: "A@example.com",
    projectId: "Project-A",
    orgId: "Org-A",
    limitReached: true,
  },
  limits: [
    {
      id: "openai-codex:primary",
      label: "5h",
      scope: { provider: "openai-codex", accountId: "account-a" },
      amount: { unit: "percent", usedFraction: 1 },
      window: { id: "5h", label: "5h", durationMs: 5 * 3_600_000, resetsAt: NOW + 4 * 3_600_000 },
      notes: ["display only"],
    },
    {
      id: "display-only",
      label: "Display",
      scope: { provider: "openai-codex", projectId: "project-a" },
      amount: { unit: "tokens", used: 1, limit: 10 },
    },
  ],
  resetCredits: {
    availableCount: 1,
    credits: [{ status: "available", grantedAt: new Date(NOW - 1_000).toISOString(), expiresAt: new Date(NOW + 3_600_000).toISOString() }],
  },
  notes: ["display only"],
  raw: { secretProviderPayload: "excluded" },
});

function input(reports: UsageReport[] | null = [report()]): CodexResetPlanInput {
  return {
    nowMs: NOW,
    trigger: "blocked",
    provider: "openai-codex",
    modelId: "gpt-5.4-mini",
    settings: { enabled: true, minBlockedMinutes: 60, keepCredits: 0, salvageHorizonMs: 12 * 3_600_000 },
    identity: { accountId: "account-a", email: "a@example.com", projectId: "project-a", orgId: "org-a" },
    reports,
    attemptedKeys: new Set(),
    deferredUntilByKey: new Map(),
    lastAttemptAtByAccount: new Map(),
    activeBlockUnblockAtMs: NOW + 4 * 3_600_000,
  };
}

const revision = (reports: UsageReport[] | null) => planCodexResetRedemptionsWithReportRevision(input(reports)).reportRevision;

describe("native reset report binding", () => {
  test("the bound wrapper returns the unchanged planner result and a stable lowercase SHA-256", () => {
    const plain = planCodexResetRedemptions(input());
    const first = planCodexResetRedemptionsWithReportRevision(input());
    const second = planCodexResetRedemptionsWithReportRevision(input());
    expect(first.plan).toEqual(plain);
    expect(first.reportRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(second.reportRevision).toBe(first.reportRevision);
  });

  test("raw, display notes, grants, and unused display-limit amounts do not change the semantic revision", () => {
    const baseline = report();
    const changed = structuredClone(baseline);
    changed.raw = { secretProviderPayload: "different" };
    changed.notes = ["different display note"];
    changed.limits[0]!.label = "different label";
    changed.limits[0]!.notes = ["different limit note"];
    changed.limits[1]!.amount.used = 9;
    changed.limits[1]!.amount.limit = 99;
    changed.resetCredits!.credits![0]!.grantedAt = new Date(NOW - 99_000).toISOString();
    expect(revision([changed])).toBe(revision([baseline]));
  });

  test.each([
    ["provider", (value: UsageReport) => { value.provider = "anthropic"; }],
    ["fetchedAt", (value: UsageReport) => { value.fetchedAt++; }],
    ["report label", (value: UsageReport) => { value.metadata!.email = "Other@example.com"; }],
    ["matching org", (value: UsageReport) => { value.metadata!.orgId = "org-b"; }],
    ["limit reached", (value: UsageReport) => { value.metadata!.limitReached = false; }],
    ["matching scope", (value: UsageReport) => { value.limits[0]!.scope.accountId = "account-b"; }],
    ["used fraction", (value: UsageReport) => { value.limits[0]!.amount.usedFraction = 0.5; }],
    ["reset time", (value: UsageReport) => { value.limits[0]!.window!.resetsAt!++; }],
    ["available count", (value: UsageReport) => { value.resetCredits!.availableCount = 2; }],
    ["credit status", (value: UsageReport) => { value.resetCredits!.credits![0]!.status = "redeemed"; }],
    ["credit expiry", (value: UsageReport) => { value.resetCredits!.credits![0]!.expiresAt = new Date(NOW + 4_000_000).toISOString(); }],
  ] as const)("planner-read %s changes the report revision", (_label, mutate) => {
    const baseline = report();
    const changed = structuredClone(baseline);
    mutate(changed);
    expect(revision([changed])).not.toBe(revision([baseline]));
  });

  test("null, empty, effective overlay changes, and report order have distinct revisions", () => {
    const first = report();
    const second = structuredClone(first);
    second.metadata!.accountId = "account-b";
    second.metadata!.email = "b@example.com";
    expect(revision(null)).not.toBe(revision([]));
    expect(revision([first, second])).not.toBe(revision([second, first]));
    const overlaid = structuredClone(first);
    overlaid.resetCredits!.availableCount = 0;
    expect(revision([overlaid])).not.toBe(revision([first]));
  });
});
