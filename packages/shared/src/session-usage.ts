/** Provider reports and explicit manual saved resets. Native /usage policy is separate. */
export const SESSION_USAGE_VERSION = 1;
export const SESSION_USAGE_HEADER = "X-Agent-Host-Id";
export const SESSION_USAGE_MAX_BYTES = 1_048_576;
export type UsageRefresh = "cached" | "reports" | "credits";
export interface UsageCredit {
  title?: string; description?: string; status?: string; resetType?: string;
  grantedAt?: string; expiresAt?: string;
}
export interface ProviderUsageLimit {
  id: string; label: string; active: boolean;
  scope: { provider: string; accountId?: string; projectId?: string; orgId?: string; modelId?: string; tier?: string; windowId?: string; shared?: boolean };
  amount: { unit: string; used?: number; limit?: number; remaining?: number; usedFraction?: number; remainingFraction?: number };
  window?: { id: string; label: string; durationMs?: number; resetsAt?: number; resetLabel?: string };
  status?: string; notes: string[];
}
export interface ProviderUsageReport {
  provider: string; fetchedAt: number; active: boolean; identity: Record<string, string>;
  limits: ProviderUsageLimit[]; notes: string[];
  resetCredits?: { availableCount: number; credits: UsageCredit[] };
}
export interface UsageCreditAccount {
  accountRef: string; accountId?: string; email?: string; orgId?: string; projectId?: string;
  active: boolean; availableCount?: number; unavailable?: string; credits: UsageCredit[]; canPrepare: boolean;
}
export interface SessionUsage {
  version: 1; sessionId: string; epoch: string; revision: string;
  model?: { provider: string; id: string };
  reports: ProviderUsageReport[]; reportStatus: "not-loaded" | "available" | "unsupported";
  reportsCheckedAt?: number; creditsCheckedAt?: number;
  credits: UsageCreditAccount[]; modelSelectors: string[];
  policy: { autoRedeem: "unset" | "yes" | "no"; minBlockedMinutes: number; keepCredits: number; salvageHorizonHours: number };
}
export interface UsageResetPrepare { sessionId: string; epoch: string; revision: string; accountRef: string }
export interface UsageResetAnswer { sessionId: string; operationId: string; confirm: boolean }
export interface UsageResetConfirmation {
  account: Omit<UsageCreditAccount, "credits" | "canPrepare" | "availableCount" | "unavailable">;
  credit: UsageCredit; creditReference?: string; expiresAt: number;
}
export type UsageResetOutcome = "reset" | "already_redeemed" | "no_credit" | "nothing_to_reset" | "no_account" | "account_unavailable" | "credit_list_failed" | "admission_rejected";
export interface UsageResetReceipt {
  operationId: string; hostId: string; sessionId: string; createdAt: number; dispatchedAt?: number;
  state: "prepared" | "cancelled" | "dispatching" | "settled" | "rejected" | "unknown";
  confirmation: UsageResetConfirmation; outcome?: UsageResetOutcome; message?: string;
}
export interface UsageCommandReceipt { id: string; state: "absent" | "pending" | "done" | "unknown"; failed?: boolean }
export interface SessionUsageResponse { command?: UsageCommandReceipt; version: 1; hostId: string; sessionId: string; snapshot: SessionUsage | null; reset: UsageResetReceipt | null }
export type SessionUsageCommand = ({ type: "session.usage.reset.prepare" } & UsageResetPrepare) | ({ type: "session.usage.reset.respond" } & UsageResetAnswer);
export type SessionUsageResult = { type: "session.usage.reset"; receipt: UsageResetReceipt };

export function usageIdentity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw new Error("Invalid usage identity.");
  return value;
}
export function parseUsageCommand(value: Record<string, unknown>): SessionUsageCommand {
  const sessionId = usageIdentity(value.sessionId);
  const prepare = value.type === "session.usage.reset.prepare";
  const fields = prepare ? ["type", "sessionId", "epoch", "revision", "accountRef"] : ["type", "sessionId", "operationId", "confirm"];
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error("Unexpected usage command field.");
  if (prepare) return { type: "session.usage.reset.prepare", sessionId, epoch: usageIdentity(value.epoch), revision: usageIdentity(value.revision), accountRef: usageIdentity(value.accountRef) };
  if (value.type !== "session.usage.reset.respond" || typeof value.confirm !== "boolean") throw new Error("An explicit reset answer is required.");
  return { type: "session.usage.reset.respond", sessionId, operationId: usageIdentity(value.operationId), confirm: value.confirm };
}
