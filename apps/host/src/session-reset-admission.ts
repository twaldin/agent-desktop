import { createHash, randomUUID } from "node:crypto";
import type { HostStore } from "./store";
import type { UsageResetOutcome } from "../../../packages/shared/src/session-usage";

export type ResetAdmissionState = "dispatching" | "settled" | "unknown";
export type ResetAdmissionKind = "manual" | "automatic";
export type ResetUnknownReason = "worker-lost" | "settlement-failed" | "restarted";
export type ResetOutcomeCode = UsageResetOutcome | "unknown";

/** Bounded, JSON-safe native provenance captured by the first executor. The authority
 * validates its structure and integrity; semantic compatibility remains the owner's. */
export interface ResetAutomaticEvidence {
  provenance: { hostId: string; sessionId: string; sessionFile: string; cwd: string; workerEpoch: string; nativeSessionId: string; passId: string;
    trigger: "blocked" | "sweep"; source: "manual" | "background" | "blocked"; startedAtMs: number; provider: string; modelId: string;
    reportRevision: string; selectionRevision: string; policyRevision: string };
  policy: { autoRedeem: "unset" | "yes" | "no"; minBlockedMinutes: number; keepCredits: number; salvageHorizonHours: number };
  action: { index: number; reason: "blocked-account" | "expiring-credit"; nativeAttemptKey: string; plannedAtMs: number; blockedUntilMs?: number; creditExpiresAtMs?: number };
  account: { provider: "openai-codex"; baseUrl?: string; accountId?: string; email?: string; orgId?: string; projectId?: string;
    credentialId: number; credentialFingerprint: string; authAuthority: string; emailUnambiguous?: boolean };
  credit: { id: string; status: "available"; expiresAt?: string; fingerprint: string };
  compatibilityHash: string;
  redeemRequestId: string;
}
/** The only observed-result shape that is persisted: raw errors and unknown provider strings are stripped first. */
export interface ResetAttemptObservation {
  consumeBoundary: "not-reached" | "refused" | "passed";
  result: { kind: "outcome"; code: ResetOutcomeCode; ok: boolean } | { kind: "error" };
}
export interface ResetAttemptBase {
  version: 1; hostId: string; id: string; key: string; generation: string; operationId: string; state: ResetAdmissionState;
  createdAt: number; updatedAt: number; commandId?: string; observation?: ResetAttemptObservation; unknownReason?: ResetUnknownReason;
}
export type ResetAdmissionAttempt =
  | (ResetAttemptBase & { kind: "manual"; evidence?: undefined; evidenceHash?: undefined })
  | (ResetAttemptBase & { kind: "automatic"; evidence: ResetAutomaticEvidence; evidenceHash: string });

export interface ResetAccountAdmission {
  generation: string; operationId: string; state: ResetAdmissionState;
  /** Manual transactions settle through the existing command journal. */
  commandId?: string;
  /** Absent only for legacy rows written before canonical attempts existed. */
  kind?: ResetAdmissionKind; attemptId?: string; fence?: undefined;
}
export type ResetAutomaticAdmission = ResetAccountAdmission & { kind: "automatic"; attemptId: string };
/** A damaged or orphan-fenced account row: its identity is unavailable rather than fabricated, and it never authorizes a spend. */
export interface ResetAccountFence { state: "unknown"; fence: "malformed" | "orphan"; generation?: undefined; operationId?: undefined; commandId?: undefined; kind?: undefined; attemptId?: undefined }
export type ResetAccountInspection = ResetAccountAdmission | ResetAccountFence;

const GLOBAL = "reset-admission.v1:revision";
const ACCOUNT_PREFIX = "reset-admission.v1:account:";
const ATTEMPT_PREFIX = "reset-admission.v1:attempt:";
const ACCOUNT_BYTES = 4_096, EVIDENCE_BYTES = 16_384, ATTEMPT_BYTES = 32_768, LIST_LIMIT = 16_384;
const STATES = ["dispatching", "settled", "unknown"] as const;
const KINDS = ["manual", "automatic"] as const;
const REASONS = ["worker-lost", "settlement-failed", "restarted"] as const;
const BOUNDARIES = ["not-reached", "refused", "passed"] as const;
const OUTCOMES: readonly ResetOutcomeCode[] = ["reset", "already_redeemed", "no_credit", "nothing_to_reset", "no_account", "account_unavailable", "credit_list_failed", "admission_rejected", "unknown"];
const HEX64 = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9-]{36}$/;
const keyFor = (key: string) => { if (typeof key !== "string" || !HEX64.test(key)) throw new Error("Invalid native reset account key."); return `${ACCOUNT_PREFIX}${key}`; };
const attemptKeyFor = (id: string) => { if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid reset attempt id."); return `${ATTEMPT_PREFIX}${id}`; };
const canonical = (value: unknown): string => JSON.stringify(value, (_, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item as object).sort().map(name => [name, (item as Record<string, unknown>)[name]])) : item);
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");


const invalid = (label: string): never => { throw new Error(`Invalid ${label}.`); };
const record = (value: unknown, label: string, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label);
  const source = value as Record<string, unknown>;
  for (const name of Object.keys(source)) if (!keys.includes(name)) invalid(`${label} field ${name}`);
  for (const name of required) if (source[name] === undefined) invalid(`${label} field ${name}`);
  return source;
};
const text = (value: unknown, label: string, max = 1_024): string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : invalid(label);
const optionalText = (value: unknown, label: string, max = 1_024): string | undefined => value === undefined ? undefined : text(value, label, max);
const hex = (value: unknown, label: string): string => typeof value === "string" && HEX64.test(value) ? value : invalid(label);
const uuid = (value: unknown, label: string): string => typeof value === "string" && UUID.test(value) ? value : invalid(label);
const whole = (value: unknown, label: string): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : invalid(label);
const optionalWhole = (value: unknown, label: string): number | undefined => value === undefined ? undefined : whole(value, label);
const amount = (value: unknown, label: string): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : invalid(label);
const oneOf = <T extends string>(value: unknown, label: string, options: readonly T[]): T => options.includes(value as T) ? value as T : invalid(label);
const defined = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

export function parseResetAutomaticEvidence(value: unknown): ResetAutomaticEvidence {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > EVIDENCE_BYTES) invalid("reset evidence size");
  const input = record(value, "reset evidence", ["provenance", "policy", "action", "account", "credit", "compatibilityHash", "redeemRequestId"]);
  const p = record(input.provenance, "reset evidence provenance", ["hostId", "sessionId", "sessionFile", "cwd", "workerEpoch", "nativeSessionId", "passId", "trigger", "source", "startedAtMs", "provider", "modelId", "reportRevision", "selectionRevision", "policyRevision"]);
  const y = record(input.policy, "reset evidence policy", ["autoRedeem", "minBlockedMinutes", "keepCredits", "salvageHorizonHours"]);
  const a = record(input.action, "reset evidence action", ["index", "reason", "nativeAttemptKey", "plannedAtMs", "blockedUntilMs", "creditExpiresAtMs"], ["index", "reason", "nativeAttemptKey", "plannedAtMs"]);
  const c = record(input.account, "reset evidence account", ["provider", "baseUrl", "accountId", "email", "orgId", "projectId", "credentialId", "credentialFingerprint", "authAuthority", "emailUnambiguous"], ["provider", "credentialId", "credentialFingerprint", "authAuthority"]);
  const r = record(input.credit, "reset evidence credit", ["id", "status", "expiresAt", "fingerprint"], ["id", "status", "fingerprint"]);
  const account = defined({ provider: oneOf(c.provider, "reset evidence account provider", ["openai-codex"] as const), baseUrl: optionalText(c.baseUrl, "reset evidence base URL", 2_048),
    accountId: optionalText(c.accountId, "reset evidence account id", 200), email: optionalText(c.email, "reset evidence email", 320), orgId: optionalText(c.orgId, "reset evidence org id", 200),
    projectId: optionalText(c.projectId, "reset evidence project id", 200), credentialId: whole(c.credentialId, "reset evidence credential id"),
    credentialFingerprint: hex(c.credentialFingerprint, "reset evidence credential fingerprint"), authAuthority: text(c.authAuthority, "reset evidence auth authority", 2_048),
    emailUnambiguous: c.emailUnambiguous === undefined || typeof c.emailUnambiguous === "boolean" ? c.emailUnambiguous : invalid("reset evidence email ambiguity") });
  // Email-only identity is a collision key only when the native account list proved it unambiguous.
  if (!account.accountId && !(account.email && account.emailUnambiguous === true)) invalid("reset evidence account identity");
  return {
    provenance: { hostId: text(p.hostId, "reset evidence host id", 200), sessionId: text(p.sessionId, "reset evidence session id", 200), sessionFile: text(p.sessionFile, "reset evidence session file", 4_096),
      cwd: text(p.cwd, "reset evidence cwd", 4_096), workerEpoch: text(p.workerEpoch, "reset evidence worker epoch", 200), nativeSessionId: text(p.nativeSessionId, "reset evidence native session id", 200),
      passId: text(p.passId, "reset evidence pass id", 200), trigger: oneOf(p.trigger, "reset evidence trigger", ["blocked", "sweep"] as const),
      source: oneOf(p.source, "reset evidence source", ["manual", "background", "blocked"] as const), startedAtMs: whole(p.startedAtMs, "reset evidence start time"),
      provider: text(p.provider, "reset evidence provider", 200), modelId: text(p.modelId, "reset evidence model id", 200), reportRevision: text(p.reportRevision, "reset evidence report revision", 200),
      selectionRevision: text(p.selectionRevision, "reset evidence selection revision", 200), policyRevision: text(p.policyRevision, "reset evidence policy revision", 200) },
    policy: { autoRedeem: oneOf(y.autoRedeem, "reset evidence auto-redeem", ["unset", "yes", "no"] as const), minBlockedMinutes: amount(y.minBlockedMinutes, "reset evidence blocked minutes"),
      keepCredits: amount(y.keepCredits, "reset evidence kept credits"), salvageHorizonHours: amount(y.salvageHorizonHours, "reset evidence salvage horizon") },
    action: defined({ index: whole(a.index, "reset evidence action index"), reason: oneOf(a.reason, "reset evidence action reason", ["blocked-account", "expiring-credit"] as const),
      nativeAttemptKey: text(a.nativeAttemptKey, "reset evidence native attempt key", 512), plannedAtMs: whole(a.plannedAtMs, "reset evidence planned time"),
      blockedUntilMs: optionalWhole(a.blockedUntilMs, "reset evidence blocked-until time"), creditExpiresAtMs: optionalWhole(a.creditExpiresAtMs, "reset evidence credit expiry time") }),
    account,
    credit: defined({ id: text(r.id, "reset evidence credit id", 200), status: oneOf(r.status, "reset evidence credit status", ["available"] as const),
      expiresAt: optionalText(r.expiresAt, "reset evidence credit expiry", 200), fingerprint: hex(r.fingerprint, "reset evidence credit fingerprint") }),
    compatibilityHash: hex(input.compatibilityHash, "reset evidence compatibility hash"),
    redeemRequestId: uuid(input.redeemRequestId, "reset evidence redeem request id"),
  };
}

/** Retain only the boundary and a known outcome enum; raw errors and unknown provider strings are dropped. */
export function sanitizeResetObservation(value: unknown): ResetAttemptObservation {
  if (!value || typeof value !== "object") invalid("reset observation");
  const input = value as Record<string, unknown>;
  const consumeBoundary = oneOf(input.consumeBoundary, "reset observation boundary", BOUNDARIES);
  if (!input.result || typeof input.result !== "object") invalid("reset observation result");
  const result = input.result as Record<string, unknown>;
  if (result.kind === "error") return { consumeBoundary, result: { kind: "error" } };
  if (result.kind !== "outcome" || typeof result.ok !== "boolean" || typeof result.code !== "string") invalid("reset observation result");
  return { consumeBoundary, result: { kind: "outcome", code: OUTCOMES.includes(result.code as ResetOutcomeCode) ? result.code as ResetOutcomeCode : "unknown", ok: result.ok as boolean } };
}
/** A proved not-dispatched or refused boundary settles with no effect; a reset claimed without a passed guard,
 * an error or unknown outcome after the guard, or an ok/code mismatch all fence the account as unknown. */
export function classifyResetObservation(observation: ResetAttemptObservation): { state: "settled" | "unknown"; effect: "reset" | "no-effect" | "unknown" } {
  const { consumeBoundary, result } = observation;
  const claimsReset = result.kind === "outcome" && (result.code === "reset" || result.ok);
  if (consumeBoundary !== "passed") return claimsReset ? { state: "unknown", effect: "unknown" } : { state: "settled", effect: "no-effect" };
  if (result.kind !== "outcome" || result.code === "unknown" || result.ok !== (result.code === "reset")) return { state: "unknown", effect: "unknown" };
  return { state: "settled", effect: result.code === "reset" ? "reset" : "no-effect" };
}

interface LegacyAccount { generation: string; operationId: string; state: ResetAdmissionState; commandId?: string }
interface LinkedAccount extends LegacyAccount { version: 1; hostId: string; kind: ResetAdmissionKind; attemptId: string }
interface FenceAccount { version: 1; hostId: string; kind: "fence"; state: "unknown"; reason: "orphan-attempt"; attemptId?: string }
type StoredAccount = { shape: "legacy"; row: LegacyAccount } | { shape: "linked"; row: LinkedAccount } | { shape: "fence"; row: FenceAccount } | { shape: "malformed" };
function parseAccount(value: unknown, hostId: string): StoredAccount {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { shape: "malformed" };
    const source = value as Record<string, unknown>;
    if (source.version === undefined) {
      const row = record(value, "account", ["generation", "operationId", "state", "commandId"], ["generation", "operationId", "state"]);
      return { shape: "legacy", row: defined({ generation: text(row.generation, "generation", 200), operationId: text(row.operationId, "operation id", 200), state: oneOf(row.state, "state", STATES), commandId: optionalText(row.commandId, "command id", 200) }) };
    }
    if (source.kind === "fence") {
      const row = record(value, "fence", ["version", "hostId", "kind", "state", "reason", "attemptId"], ["version", "hostId", "kind", "state", "reason"]);
      if (row.version !== 1 || row.hostId !== hostId || row.state !== "unknown" || row.reason !== "orphan-attempt") return { shape: "malformed" };
      return { shape: "fence", row: defined({ version: 1, hostId, kind: "fence", state: "unknown", reason: "orphan-attempt", attemptId: optionalText(row.attemptId, "attempt id", 200) }) };
    }
    const row = record(value, "account", ["version", "hostId", "kind", "attemptId", "generation", "operationId", "state", "commandId"], ["version", "hostId", "kind", "attemptId", "generation", "operationId", "state"]);
    if (row.version !== 1 || row.hostId !== hostId) return { shape: "malformed" };
    const kind = oneOf(row.kind, "kind", KINDS), commandId = optionalText(row.commandId, "command id", 200);
    if (kind === "automatic" && commandId !== undefined) return { shape: "malformed" };
    return { shape: "linked", row: defined({ version: 1, hostId, kind, attemptId: uuid(row.attemptId, "attempt id"), generation: text(row.generation, "generation", 200),
      operationId: text(row.operationId, "operation id", 200), state: oneOf(row.state, "state", STATES), commandId }) };
  } catch { return { shape: "malformed" }; }
}
function parseAttempt(value: unknown, hostId: string, id: string): ResetAdmissionAttempt {
  const row = record(value, "reset attempt", ["version", "hostId", "id", "key", "generation", "operationId", "kind", "state", "createdAt", "updatedAt", "commandId", "observation", "unknownReason", "evidence", "evidenceHash"],
    ["version", "hostId", "id", "key", "generation", "operationId", "kind", "state", "createdAt", "updatedAt"]);
  if (row.version !== 1 || row.hostId !== hostId || row.id !== id) invalid("reset attempt identity");
  const state = oneOf(row.state, "reset attempt state", STATES);
  const observation = row.observation === undefined ? undefined : sanitizeResetObservation(row.observation);
  if (observation && canonical(observation) !== canonical(row.observation)) invalid("retained reset observation");
  const base: ResetAttemptBase = defined({ version: 1, hostId, id, key: hex(row.key, "reset attempt account key"), generation: text(row.generation, "reset attempt generation", 200),
    operationId: text(row.operationId, "reset attempt operation id", 200), state, createdAt: whole(row.createdAt, "reset attempt creation time"), updatedAt: whole(row.updatedAt, "reset attempt update time"),
    commandId: optionalText(row.commandId, "reset attempt command id", 200), observation,
    unknownReason: row.unknownReason === undefined ? undefined : oneOf(row.unknownReason, "reset attempt unknown reason", REASONS) });
  if (base.unknownReason !== undefined && state !== "unknown" || base.observation !== undefined && state === "dispatching") invalid("reset attempt resolution");
  const kind = oneOf(row.kind, "reset attempt kind", KINDS);
  if (kind === "manual") { if (row.evidence !== undefined || row.evidenceHash !== undefined) invalid("manual reset attempt evidence"); return { ...base, kind }; }
  if (base.commandId !== undefined) invalid("automatic reset attempt command");
  if (state === "settled" && (!observation || classifyResetObservation(observation).state !== "settled")) invalid("automatic reset settlement observation");
  const evidence = parseResetAutomaticEvidence(row.evidence);
  if (evidence.provenance.hostId !== hostId || evidence.provenance.passId !== base.operationId || digest(evidence) !== row.evidenceHash) invalid("reset attempt evidence integrity");
  return { ...base, kind, evidence, evidenceHash: row.evidenceHash as string };
}

/** One host-local collision authority for manual and native policy owners. It owns account claims and
 * canonical attempt history; it does not coordinate another host, TUI or independently running broker client. */
export class ResetAccountAdmissions {
  readonly #store: HostStore;
  readonly #maxAccounts: number;
  readonly #maxAttempts: number;
  /** Set when retained rows cannot be assigned to any account; admissions then fail closed until repaired. */
  #closed: string | undefined;
  constructor(store: HostStore, options: { maxAccounts?: number; maxAttempts?: number } = {}) {
    const bound = (value: number | undefined, fallback: number) => value === undefined ? fallback : Number.isSafeInteger(value) && value >= 1 && value <= LIST_LIMIT ? value : invalid("reset admission capacity");
    this.#store = store; this.#maxAccounts = bound(options.maxAccounts, 256); this.#maxAttempts = bound(options.maxAttempts, 1_024);
    this.#audit();
  }
  get #hostId() { return this.#store.host.id; }
  assertStore(store: HostStore): void { if (store !== this.#store) throw new Error("Reset admissions belong to a different host store."); }
  revision(): string { return this.#store.readMetadata<string>(GLOBAL, ACCOUNT_BYTES) ?? "initial"; }
  /** Capture revision before asynchronous preparation, then assert it afterward. */
  assertRevision(revision: string): void { if (revision !== this.revision()) throw new Error("A native reset was admitted during preparation. Prepare fresh evidence."); }

  inspect(key: string): ResetAccountInspection | undefined {
    const stored = this.#account(key);
    if (stored === undefined) return undefined;
    if (stored.shape === "malformed") return { state: "unknown", fence: "malformed" };
    if (stored.shape === "fence") return { state: "unknown", fence: "orphan" };
    if (stored.shape === "linked") {
      const { row } = stored, attempt = this.#attemptOf(row);
      if (!attempt || attempt.key !== key) return { state: "unknown", fence: "malformed" };
      return defined({ generation: row.generation, operationId: row.operationId, state: this.#journalState(row), commandId: row.commandId, kind: row.kind, attemptId: row.attemptId });
    }
    const { row } = stored;
    return defined({ generation: row.generation, operationId: row.operationId, state: this.#journalState(row), commandId: row.commandId });
  }
  admit(input: { key: string; expectedGeneration?: string; operationId: string; commandId?: string }): ResetAccountAdmission {
    const operationId = text(input.operationId, "reset operation id", 200), commandId = optionalText(input.commandId, "reset command id", 200);
    return this.#store.transactionMetadata(() => {
      const attempt = this.#claim(input.key, input.expectedGeneration, "manual", operationId, commandId);
      return defined({ generation: attempt.generation, operationId, state: attempt.state, commandId, kind: "manual" as const, attemptId: attempt.id });
    });
  }
  admitAutomatic(input: { key: string; expectedGeneration?: string; operationId: string; evidence: ResetAutomaticEvidence }): ResetAutomaticAdmission {
    const operationId = text(input.operationId, "reset operation id", 200), evidence = parseResetAutomaticEvidence(input.evidence);
    if (evidence.provenance.hostId !== this.#hostId) throw new Error("Reset evidence belongs to another host.");
    if (evidence.provenance.passId !== operationId) throw new Error("Automatic reset operation id must be the original native pass id.");
    return this.#store.transactionMetadata(() => {
      const attempt = this.#claim(input.key, input.expectedGeneration, "automatic", operationId, undefined, evidence);
      return { generation: attempt.generation, operationId, state: attempt.state, kind: "automatic", attemptId: attempt.id };
    });
  }
  settle(key: string, operationId: string, state: "settled" | "unknown"): void {
    if (state !== "settled" && state !== "unknown") throw new Error("Invalid reset settlement state.");
    this.#store.transactionMetadata(() => {
      const stored = this.#account(key);
      if (!stored || stored.shape !== "legacy" && stored.shape !== "linked" || stored.row.operationId !== operationId) throw new Error("Reset admission does not belong to this operation.");
      if (stored.shape === "linked" && stored.row.kind === "automatic") throw new Error("Automatic reset attempts settle only through their observed native result.");
      if (stored.row.state === "unknown" && state !== "unknown") throw new Error("Unknown reset admission cannot be upgraded or replayed.");
      if (stored.shape === "linked") {
        const attempt = this.#attemptOf(stored.row);
        if (!attempt || attempt.key !== key) throw new Error("Reset admission lost its canonical attempt.");
        this.#store.writeMetadata(attemptKeyFor(attempt.id), { ...attempt, state, updatedAt: Date.now() });
      }
      this.#store.writeMetadata(keyFor(key), { ...stored.row, state });
    });
  }
  getAttempt(attemptId: string): ResetAdmissionAttempt | undefined {
    const attempt = this.#attempt(attemptId);
    return attempt && this.#journalState(attempt) !== attempt.state ? { ...attempt, state: "unknown" } : attempt;
  }
  listAttempts(): ResetAdmissionAttempt[] {
    const attempts: ResetAdmissionAttempt[] = [];
    for (const key of this.#store.metadataKeys(ATTEMPT_PREFIX, LIST_LIMIT)) { const attempt = this.getAttempt(key.slice(ATTEMPT_PREFIX.length)); if (attempt) attempts.push(attempt); }
    return attempts;
  }
  completeAutomatic(attemptId: string, observation: ResetAttemptObservation): ResetAdmissionAttempt {
    const safe = sanitizeResetObservation(observation), { state } = classifyResetObservation(safe);
    return this.#store.transactionMetadata(() => {
      const attempt = this.#automatic(attemptId);
      if (attempt.observation) {
        if (canonical(attempt.observation) === canonical(safe)) return attempt;
        throw new Error(attempt.state === "unknown" ? "Unknown reset attempt cannot be upgraded or replayed." : "Reset attempt already settled with a different observation.");
      }
      if (attempt.state === "settled") throw new Error("Reset attempt already settled without an observation.");
      const account = this.#current(attempt);
      // A late result for an already-fenced attempt is retained as evidence; the fence and its reason stay.
      const next: ResetAdmissionAttempt = attempt.state === "unknown" ? { ...attempt, observation: safe, updatedAt: Date.now() }
        : { ...attempt, state, observation: safe, updatedAt: Date.now(), ...(state === "unknown" ? { unknownReason: "settlement-failed" as const } : {}) };
      this.#store.writeMetadata(attemptKeyFor(attempt.id), next);
      if (next.state !== account.state) this.#store.writeMetadata(keyFor(attempt.key), { ...account, state: next.state });
      return next;
    });
  }
  markAutomaticUnknown(attemptId: string, reason: ResetUnknownReason, observation?: ResetAttemptObservation): ResetAdmissionAttempt {
    const unknownReason = oneOf(reason, "reset unknown reason", REASONS), safe = observation === undefined ? undefined : sanitizeResetObservation(observation);
    return this.#store.transactionMetadata(() => {
      const attempt = this.#automatic(attemptId);
      if (attempt.state === "unknown") return attempt;
      const account = this.#current(attempt);
      const next: ResetAdmissionAttempt = defined({ ...attempt, state: "unknown", unknownReason, observation: attempt.observation ?? safe, updatedAt: Date.now() });
      this.#store.writeMetadata(attemptKeyFor(attempt.id), next);
      this.#store.writeMetadata(keyFor(attempt.key), { ...account, state: "unknown" });
      return next;
    });
  }
  /** Reclaim only settled attempts that a later admission superseded; fences, pointers, unresolved and damaged rows remain. */
  pruneSettledAttempts(): void {
    this.#store.transactionMetadata(() => {
      for (const key of this.#store.metadataKeys(ATTEMPT_PREFIX, LIST_LIMIT)) {
        let attempt: ResetAdmissionAttempt | undefined;
        try { attempt = this.getAttempt(key.slice(ATTEMPT_PREFIX.length)); } catch { continue; }
        if (!attempt || attempt.state !== "settled") continue;
        const account = this.#account(attempt.key);
        if (!account || account.shape === "malformed" || account.shape === "fence" || account.row.generation === attempt.generation
          || account.shape === "linked" && account.row.attemptId === attempt.id) continue;
        this.#store.deleteMetadata(key);
      }
    });
  }

  #account(key: string): StoredAccount | undefined {
    const storeKey = keyFor(key);
    let raw: unknown;
    try { raw = this.#store.readMetadata<unknown>(storeKey, ACCOUNT_BYTES); } catch { return { shape: "malformed" }; }
    return raw === undefined ? undefined : parseAccount(raw, this.#hostId);
  }
  /** Stored attempt as written; journal conservatism is layered on by getAttempt. */
  #attempt(id: string): ResetAdmissionAttempt | undefined {
    const raw = this.#store.readMetadata<unknown>(attemptKeyFor(id), ATTEMPT_BYTES);
    return raw === undefined ? undefined : parseAttempt(raw, this.#hostId, id);
  }
  /** The attempt an account row points at, or undefined when it is missing, damaged or disagrees with the row. */
  #attemptOf(row: LinkedAccount): ResetAdmissionAttempt | undefined {
    let attempt: ResetAdmissionAttempt | undefined;
    try { attempt = this.#attempt(row.attemptId); } catch { return undefined; }
    return attempt && attempt.kind === row.kind && attempt.generation === row.generation && attempt.operationId === row.operationId
      && attempt.commandId === row.commandId && attempt.state === row.state ? attempt : undefined;
  }
  #automatic(attemptId: string): ResetAdmissionAttempt & { kind: "automatic" } {
    const attempt = this.#attempt(attemptId);
    if (!attempt) throw new Error("Unknown reset attempt.");
    if (attempt.kind !== "automatic") throw new Error("Manual reset attempts settle through their command journal.");
    return attempt;
  }
  #current(attempt: ResetAdmissionAttempt): LinkedAccount {
    const account = this.#account(attempt.key);
    if (!account || account.shape !== "linked" || account.row.attemptId !== attempt.id || account.row.generation !== attempt.generation || account.row.operationId !== attempt.operationId || account.row.kind !== attempt.kind)
      throw new Error("Reset attempt is no longer the account's current admission.");
    return account.row;
  }
  /** Manual settlements are authoritative only once their journal receipt succeeded. */
  #journalState(row: { state: ResetAdmissionState; commandId?: string }): ResetAdmissionState {
    if (row.state !== "settled" || !row.commandId) return row.state;
    const command = this.#store.getCommand(row.commandId);
    return command?.state === "done" && command.result?.ok ? "settled" : "unknown";
  }
  #claim(key: string, expectedGeneration: string | undefined, kind: ResetAdmissionKind, operationId: string, commandId: string | undefined, evidence?: ResetAutomaticEvidence): ResetAdmissionAttempt {
    if (this.#closed) throw new Error(`Reset admissions are closed: ${this.#closed}`);
    const existing = this.inspect(key);
    if (existing?.generation !== expectedGeneration || existing && existing.state !== "settled") throw new Error("The account has changed or has an unresolved reset admission.");
    if (existing === undefined && this.#store.metadataKeys(ACCOUNT_PREFIX, LIST_LIMIT).length >= this.#maxAccounts) throw new Error("Too many native reset accounts are retained.");
    if (this.#store.metadataKeys(ATTEMPT_PREFIX, LIST_LIMIT).length >= this.#maxAttempts) {
      this.pruneSettledAttempts();
      // The settled attempt this claim replaces is superseded at commit; it is the only current pointer prune may not touch.
      if (existing?.attemptId && this.#store.metadataKeys(ATTEMPT_PREFIX, LIST_LIMIT).length >= this.#maxAttempts) this.#store.deleteMetadata(attemptKeyFor(existing.attemptId));
      if (this.#store.metadataKeys(ATTEMPT_PREFIX, LIST_LIMIT).length >= this.#maxAttempts) throw new Error("Too many unresolved native reset attempts are retained.");
    }
    const now = Date.now(), generation = randomUUID(), id = randomUUID();
    const base: ResetAttemptBase = defined({ version: 1, hostId: this.#hostId, id, key, generation, operationId, state: "dispatching", createdAt: now, updatedAt: now, commandId });
    const attempt: ResetAdmissionAttempt = evidence ? { ...base, kind: "automatic", evidence, evidenceHash: digest(evidence) } : { ...base, kind: "manual" };
    // Invalidation first: a failure here rolls back the whole claim and sends nothing.
    this.#store.writeMetadata(GLOBAL, randomUUID());
    const row: LinkedAccount = defined({ version: 1, hostId: this.#hostId, kind, attemptId: id, generation, operationId, state: "dispatching", commandId });
    this.#store.writeMetadata(keyFor(key), row);
    this.#store.writeMetadata(attemptKeyFor(id), attempt);
    return attempt;
  }
  /** Orphan attempts fence their account key durably; rows that cannot name an account close admissions. */
  #audit(): void {
    this.#store.transactionMetadata(() => {
      for (const storeKey of this.#store.metadataKeys(ATTEMPT_PREFIX, LIST_LIMIT)) {
        const id = storeKey.slice(ATTEMPT_PREFIX.length);
        let raw: unknown, key: string | undefined;
        try { raw = this.#store.readMetadata<unknown>(storeKey, ATTEMPT_BYTES); } catch { raw = undefined; }
        try { key = UUID.test(id) ? parseAttempt(raw, this.#hostId, id).key : undefined; }
        catch { const claimed = (raw as { key?: unknown } | null)?.key; key = typeof claimed === "string" && HEX64.test(claimed) ? claimed : undefined; }
        if (!key) { this.#closed = `retained reset attempt ${id} cannot be assigned to an account`; continue; }
        let present: boolean;
        try { present = this.#store.readMetadata<unknown>(keyFor(key), ACCOUNT_BYTES) !== undefined; } catch { present = true; }
        if (present) continue;
        const fence: FenceAccount = { version: 1, hostId: this.#hostId, kind: "fence", state: "unknown", reason: "orphan-attempt", attemptId: id };
        this.#store.writeMetadata(keyFor(key), fence);
      }
    });
  }
}
