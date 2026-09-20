import {
  SESSION_USAGE_HEADER,
  SESSION_USAGE_MAX_BYTES,
  SESSION_USAGE_VERSION,
  type ProviderUsageLimit,
  type ProviderUsageReport,
  type SessionUsage,
  type SessionUsageResponse,
  type UsageCommandReceipt,
  type UsageCredit,
  type UsageCreditAccount,
  type UsageRefresh,
  type UsageResetConfirmation,
  type UsageResetCommandAccount,
  type UsageResetReceipt,
} from "./session-usage";
const MAX_IDENTITY_LENGTH = 200;
const MAX_TEXT_LENGTH = 4_096;
const MAX_ARRAY_ITEMS = 2_000;
const RESET_OUTCOMES = new Set(["reset", "already_redeemed", "no_credit", "nothing_to_reset", "no_account", "account_unavailable", "credit_list_failed", "admission_rejected"]);
const RESET_STATES = new Set(["prepared", "cancelled", "dispatching", "settled", "rejected", "unknown"]);

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function string(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
  return typeof value === "string" && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : undefined;
}

function requiredString(value: unknown, name: string, max = MAX_TEXT_LENGTH): string {
  const result = string(value, max);
  if (result === undefined) throw new Error(`Invalid session usage ${name}.`);
  return result;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredNumber(value: unknown, name: string): number {
  const result = number(value);
  if (result === undefined) throw new Error(`Invalid session usage ${name}.`);
  return result;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredNumber(value, name);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid session usage ${name}.`);
  return value;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid session usage ${name}.`);
  return value;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) throw new Error(`Invalid session usage ${name}.`);
  return value;
}

function credit(value: unknown): UsageCredit {
  const input = record(value);
  if (!input) throw new Error("Invalid session usage credit.");
  return {
    ...(input.title !== undefined ? { title: requiredString(input.title, "credit title") } : {}),
    ...(input.description !== undefined ? { description: requiredString(input.description, "credit description") } : {}),
    ...(input.status !== undefined ? { status: requiredString(input.status, "credit status") } : {}),
    ...(input.resetType !== undefined ? { resetType: requiredString(input.resetType, "credit reset type") } : {}),
    ...(input.grantedAt !== undefined ? { grantedAt: requiredString(input.grantedAt, "credit grantedAt") } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: requiredString(input.expiresAt, "credit expiresAt") } : {}),
  };
}

function stringList(value: unknown, name: string): string[] {
  return array(value, name).map((item, index) => requiredString(item, `${name}[${index}]`));
}

function providerLimit(value: unknown): ProviderUsageLimit {
  const input = record(value);
  const scope = record(input?.scope);
  const amount = record(input?.amount);
  if (!input || !scope || !amount) throw new Error("Invalid session usage limit.");
  const cleanScope = {
    provider: requiredString(scope.provider, "limit provider"),
    ...(scope.accountId !== undefined ? { accountId: requiredString(scope.accountId, "limit accountId") } : {}),
    ...(scope.projectId !== undefined ? { projectId: requiredString(scope.projectId, "limit projectId") } : {}),
    ...(scope.orgId !== undefined ? { orgId: requiredString(scope.orgId, "limit orgId") } : {}),
    ...(scope.modelId !== undefined ? { modelId: requiredString(scope.modelId, "limit modelId") } : {}),
    ...(scope.tier !== undefined ? { tier: requiredString(scope.tier, "limit tier") } : {}),
    ...(scope.windowId !== undefined ? { windowId: requiredString(scope.windowId, "limit windowId") } : {}),
    ...(scope.shared !== undefined ? { shared: optionalBoolean(scope.shared, "limit shared")! } : {}),
  };
  const cleanAmount = {
    unit: requiredString(amount.unit, "limit amount unit"),
    ...(amount.used !== undefined ? { used: requiredNumber(amount.used, "limit used") } : {}),
    ...(amount.limit !== undefined ? { limit: requiredNumber(amount.limit, "limit limit") } : {}),
    ...(amount.remaining !== undefined ? { remaining: requiredNumber(amount.remaining, "limit remaining") } : {}),
    ...(amount.usedFraction !== undefined ? { usedFraction: requiredNumber(amount.usedFraction, "limit usedFraction") } : {}),
    ...(amount.remainingFraction !== undefined ? { remainingFraction: requiredNumber(amount.remainingFraction, "limit remainingFraction") } : {}),
  };
  const window = input.window === undefined ? undefined : record(input.window);
  if (input.window !== undefined && !window) throw new Error("Invalid session usage limit window.");
  return {
    id: requiredString(input.id, "limit id"), label: requiredString(input.label, "limit label"), active: requiredBoolean(input.active, "limit active"),
    scope: cleanScope, amount: cleanAmount,
    ...(window ? { window: {
      id: requiredString(window.id, "limit window id"), label: requiredString(window.label, "limit window label"),
      ...(window.durationMs !== undefined ? { durationMs: requiredNumber(window.durationMs, "limit durationMs") } : {}),
      ...(window.resetsAt !== undefined ? { resetsAt: requiredNumber(window.resetsAt, "limit resetsAt") } : {}),
      ...(window.resetLabel !== undefined ? { resetLabel: requiredString(window.resetLabel, "limit resetLabel") } : {}),
    } } : {}),
    ...(input.status !== undefined ? { status: requiredString(input.status, "limit status") } : {}),
    notes: stringList(input.notes, "limit notes"),
  };
}

function usageReport(value: unknown): ProviderUsageReport {
  const input = record(value);
  if (!input) throw new Error("Invalid session usage report.");
  const identity = record(input.identity);
  if (!identity) throw new Error("Invalid session usage report identity.");
  const cleanIdentity: Record<string, string> = {};
  for (const [key, item] of Object.entries(identity)) cleanIdentity[requiredString(key, "report identity key")] = requiredString(item, "report identity value");
  const resetCredits = input.resetCredits === undefined ? undefined : record(input.resetCredits);
  if (input.resetCredits !== undefined && !resetCredits) throw new Error("Invalid session usage report credits.");
  return {
    provider: requiredString(input.provider, "report provider"), fetchedAt: requiredNumber(input.fetchedAt, "report fetchedAt"), active: requiredBoolean(input.active, "report active"),
    identity: cleanIdentity, limits: array(input.limits, "report limits").map(providerLimit), notes: stringList(input.notes, "report notes"),
    ...(resetCredits ? { resetCredits: {
      availableCount: requiredNumber(resetCredits.availableCount, "report availableCount"),
      credits: array(resetCredits.credits, "report credits").map(credit),
    } } : {}),
  };
}

function usageAccount(value: unknown): UsageCreditAccount {
  const input = record(value);
  if (!input) throw new Error("Invalid session usage credit account.");
  return {
    accountRef: requiredString(input.accountRef, "accountRef"),
    ...(input.accountId !== undefined ? { accountId: requiredString(input.accountId, "accountId") } : {}),
    ...(input.email !== undefined ? { email: requiredString(input.email, "email") } : {}),
    ...(input.orgId !== undefined ? { orgId: requiredString(input.orgId, "orgId") } : {}),
    ...(input.projectId !== undefined ? { projectId: requiredString(input.projectId, "projectId") } : {}),
    active: requiredBoolean(input.active, "account active"),
    ...(input.availableCount !== undefined ? { availableCount: requiredNumber(input.availableCount, "availableCount") } : {}),
    ...(input.unavailable !== undefined ? { unavailable: requiredString(input.unavailable, "unavailable") } : {}),
    credits: array(input.credits, "account credits").map(credit),
    canPrepare: requiredBoolean(input.canPrepare, "canPrepare"),
  };
}

function resetCommandAccount(value: unknown): UsageResetCommandAccount {
  const input = record(value);
  if (!input) throw new Error("Invalid session usage reset command account.");
  const availableCount = requiredNumber(input.availableCount, "reset command availableCount");
  if (!Number.isSafeInteger(availableCount) || availableCount < 0) throw new Error("Invalid session usage reset command availableCount.");
  return {
    accountRef: requiredString(input.accountRef, "reset command accountRef", MAX_IDENTITY_LENGTH),
    label: requiredString(input.label, "reset command label"),
    active: requiredBoolean(input.active, "reset command active"),
    availableCount,
    ...(input.email === undefined ? {} : { email: requiredString(input.email, "reset command email") }),
    ...(input.accountId === undefined ? {} : { accountId: requiredString(input.accountId, "reset command accountId") }),
    ...(input.unavailable === undefined ? {} : { unavailable: requiredString(input.unavailable, "reset command unavailable") }),
  };
}

function confirmation(value: unknown): UsageResetConfirmation {
  const input = record(value);
  const account = record(input?.account);
  if (!input || !account) throw new Error("Invalid session usage reset confirmation.");
  return {
    account: {
      accountRef: requiredString(account.accountRef, "confirmation accountRef"), active: requiredBoolean(account.active, "confirmation active"),
      ...(account.accountId !== undefined ? { accountId: requiredString(account.accountId, "confirmation accountId") } : {}),
      ...(account.email !== undefined ? { email: requiredString(account.email, "confirmation email") } : {}),
      ...(account.orgId !== undefined ? { orgId: requiredString(account.orgId, "confirmation orgId") } : {}),
      ...(account.projectId !== undefined ? { projectId: requiredString(account.projectId, "confirmation projectId") } : {}),
    }, ...(input.creditReference !== undefined ? { creditReference: requiredString(input.creditReference, "credit reference", 64) } : {}), credit: credit(input.credit), expiresAt: requiredNumber(input.expiresAt, "confirmation expiresAt"),
  };
}

function resetReceipt(value: unknown): UsageResetReceipt {
  const input = record(value);
  if (!input || typeof input.state !== "string" || !RESET_STATES.has(input.state)) throw new Error("Invalid session usage reset receipt.");
  if (input.outcome !== undefined && (typeof input.outcome !== "string" || !RESET_OUTCOMES.has(input.outcome))) throw new Error("Invalid session usage reset outcome.");
  return {
    operationId: requiredString(input.operationId, "reset operationId"), hostId: requiredString(input.hostId, "reset hostId"), sessionId: requiredString(input.sessionId, "reset sessionId"),
    ...(input.dispatchedAt !== undefined ? { dispatchedAt: requiredNumber(input.dispatchedAt, "reset dispatchedAt") } : {}),
    createdAt: requiredNumber(input.createdAt, "reset createdAt"), state: input.state as UsageResetReceipt["state"], confirmation: confirmation(input.confirmation),
    ...(input.outcome !== undefined ? { outcome: input.outcome as UsageResetReceipt["outcome"] } : {}),
    ...(input.message !== undefined ? { message: requiredString(input.message, "reset message") } : {}),
  };
}

function snapshot(value: unknown, sessionId: string): SessionUsage | null {
  if (value === null) return null;
  const input = record(value);
  const model = input?.model === undefined ? undefined : record(input.model);
  const policy = record(input?.policy);
  if (!input || !policy || (input.model !== undefined && !model)) throw new Error("Invalid session usage snapshot.");
  if (input.version !== SESSION_USAGE_VERSION || input.sessionId !== sessionId) throw new Error("Session usage snapshot identity mismatch.");
  if (input.reportStatus !== "not-loaded" && input.reportStatus !== "available" && input.reportStatus !== "unsupported") throw new Error("Invalid session usage report status.");
  const autoRedeem = policy.autoRedeem;
  if (autoRedeem !== "unset" && autoRedeem !== "yes" && autoRedeem !== "no") throw new Error("Invalid session usage policy.");
  return {
    version: SESSION_USAGE_VERSION, sessionId, epoch: requiredString(input.epoch, "snapshot epoch"), revision: requiredString(input.revision, "snapshot revision"),
    ...(model ? { model: { provider: requiredString(model.provider, "model provider"), id: requiredString(model.id, "model id") } } : {}),
    reports: array(input.reports, "snapshot reports").map(usageReport), reportStatus: input.reportStatus,
    ...(input.reportsCheckedAt !== undefined ? { reportsCheckedAt: requiredNumber(input.reportsCheckedAt, "reportsCheckedAt") } : {}),
    ...(input.creditsCheckedAt !== undefined ? { creditsCheckedAt: requiredNumber(input.creditsCheckedAt, "creditsCheckedAt") } : {}),
    credits: array(input.credits, "snapshot credits").map(usageAccount), modelSelectors: stringList(input.modelSelectors, "modelSelectors"),
    ...(input.resetCommandAccounts === undefined ? {} : { resetCommandAccounts: array(input.resetCommandAccounts, "resetCommandAccounts").map(resetCommandAccount) }),
    policy: { autoRedeem, minBlockedMinutes: requiredNumber(policy.minBlockedMinutes, "minBlockedMinutes"), keepCredits: requiredNumber(policy.keepCredits, "keepCredits"), salvageHorizonHours: requiredNumber(policy.salvageHorizonHours, "salvageHorizonHours") },
  };
}

/** Validates and sanitizes the host envelope before it can cross into renderer-owned state. */
export function validateSessionUsageResponse(value: unknown, endpoint: { hostId: string }, sessionId: string, commandId?: string): SessionUsageResponse {
  const input = record(value);
  if (!input || input.version !== SESSION_USAGE_VERSION || input.hostId !== endpoint.hostId || input.sessionId !== sessionId) throw new Error("Session usage response identity mismatch.");
  const reset = input.reset === null ? null : resetReceipt(input.reset);
  if (reset && (reset.hostId !== endpoint.hostId || reset.sessionId !== sessionId)) throw new Error("Session usage reset identity mismatch.");
  const command = input.command === undefined ? undefined : (() => {
    const candidate = record(input.command);
    if (!candidate || candidate.id !== undefined && string(candidate.id, MAX_IDENTITY_LENGTH) === undefined || candidate.state !== "absent" && candidate.state !== "pending" && candidate.state !== "done" && candidate.state !== "unknown") throw new Error("Invalid session usage command receipt.");
    if (candidate.failed !== undefined && typeof candidate.failed !== "boolean") throw new Error("Invalid session usage command receipt.");
    return { id: requiredString(candidate.id, "command id", MAX_IDENTITY_LENGTH), state: candidate.state as UsageCommandReceipt["state"], ...(candidate.failed === undefined ? {} : { failed: candidate.failed }) };
  })();
  if (commandId !== undefined && command?.id !== commandId || commandId === undefined && command !== undefined) throw new Error("Session usage command identity mismatch.");
  return { ...(command ? { command } : {}), version: SESSION_USAGE_VERSION, hostId: endpoint.hostId, sessionId, snapshot: snapshot(input.snapshot, sessionId), reset };
}
