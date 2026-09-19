import { createHash, randomUUID } from "node:crypto";
import type { CodexResetAction } from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { classifyResetObservation, sanitizeResetObservation, type ResetAccountAdmissions, type ResetAccountInspection, type ResetAdmissionAttempt, type ResetAttemptObservation, type ResetAutomaticEvidence, type ResetUnknownReason } from "./session-reset-admission";
import { nativeResetAccountKey } from "./omp/session-usage";
import type { HostStore } from "./store";

export type NativeResetProvenance = ResetAutomaticEvidence["provenance"];
export type NativeResetPolicyValues = ResetAutomaticEvidence["policy"];
export type NativeResetAccountEvidence = ResetAutomaticEvidence["account"];
export type NativeResetCreditEvidence = ResetAutomaticEvidence["credit"];
export type NativeResetActionEvidence = ResetAutomaticEvidence["action"];
export type NativeResetObserved = "reset" | "no-effect" | "unknown";

export interface NativeResetPlannedAction extends NativeResetActionEvidence {
  /** Host collision key from {@link nativeResetAccountKey}. */
  key: string;
  account: NativeResetAccountEvidence;
  /** Account generation captured at plan time; admission holds once it moves. */
  expectedGeneration?: string;
  /** Planned while that generation was still dispatching: this evidence may join it but never spend after it settles. */
  joinOnly?: true;
  checkpoint?: NativeResetCheckpoint;
}
export type NativeResetCheckpointCompletion = { at: number; persistence: "durable" | "failed" } & (
  | { terminal: "native-completion"; observation: ResetAttemptObservation }
  | { terminal: "worker-exit"; observation?: undefined }
);
export interface NativeResetCheckpoint {
  attemptId: string;
  /** `origin` owns the canonical attempt; `join` shares the origin's settlement. */
  role: "origin" | "join";
  originPassId: string;
  redeemRequestId: string;
  admittedAt: number;
  /** Origin-only durable unknown marker (worker loss, restart, failed settlement); the account fence lives in the authority. */
  fence?: { at: number; reason: ResetUnknownReason };
  /** Origin-only terminal accounting; confirmed worker exit is not a native consume observation. */
  completion?: NativeResetCheckpointCompletion;
}
export type NativeResetDecision =
  | { state: "none" }
  | { state: "pending"; requestedAt: number }
  | { state: "answered"; answer: "Yes" | "No" | "dismissed"; requestedAt: number; answeredAt: number };
export interface NativeResetPersistenceProof {
  status: "verified" | "failed";
  globalMode?: "yes" | "no";
  effectivePolicy?: NativeResetPolicyValues;
  layersUnchanged?: boolean;
  /** Verified post-write revision; omitted only when the effective policy revision did not change. */
  policyRevision?: string;
}
/** Native finish projection. `applied`/`attemptIds` are the native settlement's own counters, retained for display only;
 * consume truth stays in the authority attempts and pass checkpoints. */
export interface NativeResetFinish { state: "settled" | "held" | "cancelled" | "failed"; refresh: "not-needed" | "complete" | "failed"; applied: number; attemptIds: readonly string[] }
export type NativeResetClosureReason = "invalidated" | "oversized" | "restarted" | "worker-lost";
export interface NativeResetPassRecord {
  version: 1;
  hostId: string;
  passId: string;
  provenance: NativeResetProvenance;
  policy: NativeResetPolicyValues;
  /** Shared authority revision captured at start; plan asserts it after native eligibility awaits. */
  startRevision: string;
  createdAt: number;
  updatedAt: number;
  plan?: { plannedAtMs: number; actions: NativeResetPlannedAction[] };
  /** Native same-session join: this pass emitted only joined→finished against the original running pass; it never plans, consents or admits. */
  joinedToPassId?: string;
  decision: NativeResetDecision;
  persistence?: NativeResetPersistenceProof & { recordedAt: number };
  finish?: NativeResetFinish & { recordedAt: number };
  closed?: { reason: NativeResetClosureReason; at: number };
}
export interface NativeResetCompletion {
  attemptId: string;
  passId: string;
  key: string;
  /** Whether the completion itself reached durable storage. A failed completion may still carry a durable unknown marker. */
  persistence: "durable" | "failed";
  /** Durable authority state after settlement. */
  authority: "settled" | "unknown";
  /** Worker exit ends host waiting, not uncertainty about the provider-side effect. */
  terminal: "native-completion" | "worker-exit";
  /** Physically observed effect per the shared classifier; never upgrades authority. */
  observed: NativeResetObserved;
  observation?: ResetAttemptObservation;
  reason?: ResetUnknownReason;
}
export type NativeResetHoldReason =
  | "disposing" | "unknown-pass" | "closed" | "finished" | "unplanned" | "unknown-action" | "already-admitted"
  | "stale" | "binding-changed" | "policy-no" | "no-consent" | "persistence-hold"
  | "fenced" | "manual-collision" | "incompatible" | "unjoinable" | "stale-generation";
export type NativeResetAdmission =
  | { kind: "execute"; attemptId: string; passId: string; key: string; generation: string; credentialId: number; creditId: string; redeemRequestId: string; settlement: Promise<NativeResetCompletion> }
  | { kind: "join"; attemptId: string; passId: string; originPassId: string; provenance: NativeResetProvenance; key: string; credentialId: number; creditId: string; redeemRequestId: string; settlement: Promise<NativeResetCompletion> }
  | { kind: "hold"; reason: NativeResetHoldReason };
export interface NativeResetAdmitInput {
  current: { workerEpoch: string; nativeSessionId: string; selectionRevision: string; policyRevision: string };
  account: NativeResetAccountEvidence;
  credit: NativeResetCreditEvidence;
}
/** Original executor identity required to complete an admitted attempt. */
export interface NativeResetCompletionProvenance { workerEpoch: string; nativeSessionId: string; passId: string; sessionId: string }
export type NativeResetAttemptState = "dispatching" | "settled" | "unknown" | "missing" | "malformed";
export interface NativeResetAttemptView {
  index: number;
  attemptId: string;
  role: "origin" | "join";
  state: NativeResetAttemptState;
  unknownReason?: ResetUnknownReason;
  observed: NativeResetObserved;
  live: boolean;
  fence?: NativeResetCheckpoint["fence"];
  completion?: NativeResetCheckpointCompletion;
}
export type NativeResetPassView =
  | { passId: string; status: "malformed" }
  | { passId: string; status: "started" | "joined" | "planned" | "finished" | "closed"; record: NativeResetPassRecord; attempts: NativeResetAttemptView[] };
export interface NativeResetAttemptInspection {
  attemptId: string;
  attempt?: ResetAdmissionAttempt;
  state: NativeResetAttemptState;
  passId?: string;
  provenance?: NativeResetProvenance;
  observed: NativeResetObserved;
  /** A settlement promise is still pending in this process (possibly already fenced unknown by loss notification). */
  live: boolean;
  fenced?: ResetUnknownReason;
  completion?: NativeResetCompletion;
}
export interface NativeResetPolicyOptions { store: HostStore; admissions: ResetAccountAdmissions; now?: () => number; maxPasses?: number }

const PREFIX = "native-reset-policy.v1:";
const PASS_PREFIX = `${PREFIX}pass:`;
const FLOOR_KEY = `${PREFIX}retired-floor`;
/** Complete native plans up to this many actions are retained whole; larger plans are durably rejected, never truncated. */
export const NATIVE_RESET_MAX_ACTIONS = 128;
// Worst case per action under the field bounds below: ~2.4 KiB account (baseUrl 1024, email 320, ids 200×3, authority 256, fingerprint 64)
// + ~0.5 KiB action/key/generation + ~0.5 KiB checkpoint with observation ≈ 3.5 KiB; 128 actions ≈ 448 KiB, plus ≤ 12 KiB provenance.
const PASS_MAX_BYTES = 1024 * 1024;
const MAX_ENUMERATION = 4096;
const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const fail = (message: string): never => { throw new Error(message); };
const str = (value: unknown, max: number, what: string): string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL.test(value) ? value : fail(`Invalid native reset ${what}.`);
const optStr = (value: unknown, max: number, what: string): string | undefined => value === undefined ? undefined : str(value, max, what);
const id = (value: unknown, what: string): string => typeof value === "string" && ID.test(value) ? value : fail(`Invalid native reset ${what}.`);
const hex = (value: unknown, what: string): string => typeof value === "string" && HEX64.test(value) ? value : fail(`Invalid native reset ${what}.`);
const num = (value: unknown, what: string): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail(`Invalid native reset ${what}.`);
const optNum = (value: unknown, what: string): number | undefined => value === undefined ? undefined : num(value, what);
const int = (value: unknown, what: string): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fail(`Invalid native reset ${what}.`);
const optInt = (value: unknown, what: string): number | undefined => value === undefined ? undefined : int(value, what);
const optBool = (value: unknown, what: string): boolean | undefined => value === undefined || typeof value === "boolean" ? value : fail(`Invalid native reset ${what}.`);
const oneOf = <T extends string>(value: unknown, options: readonly T[], what: string): T => options.includes(value as T) ? value as T : fail(`Invalid native reset ${what}.`);
const record = (value: unknown, what: string): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail(`Invalid native reset ${what}.`);
const defined = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const TRIGGERS = ["blocked", "sweep"] as const, SOURCES = ["manual", "background", "blocked"] as const, MODES = ["unset", "yes", "no"] as const;
const REASONS = ["blocked-account", "expiring-credit"] as const, UNKNOWN_REASONS = ["worker-lost", "settlement-failed", "restarted"] as const;
const FINISH_STATES = ["settled", "held", "cancelled", "failed"] as const, REFRESH_STATES = ["not-needed", "complete", "failed"] as const;

export function sanitizeNativeResetProvenance(value: unknown): NativeResetProvenance {
  const v = record(value, "provenance");
  return {
    hostId: str(v.hostId, 128, "provenance host"), sessionId: id(v.sessionId, "provenance session"), sessionFile: str(v.sessionFile, 4096, "provenance session file"),
    cwd: str(v.cwd, 4096, "provenance cwd"), workerEpoch: id(v.workerEpoch, "provenance worker epoch"), nativeSessionId: id(v.nativeSessionId, "provenance native session"),
    passId: id(v.passId, "pass id"), trigger: oneOf(v.trigger, TRIGGERS, "provenance trigger"), source: oneOf(v.source, SOURCES, "provenance source"),
    startedAtMs: int(v.startedAtMs, "provenance start time"), provider: str(v.provider, 64, "provenance provider"), modelId: str(v.modelId, 256, "provenance model"),
    reportRevision: str(v.reportRevision, 128, "provenance report revision"), selectionRevision: str(v.selectionRevision, 128, "provenance selection revision"),
    policyRevision: str(v.policyRevision, 128, "provenance policy revision"),
  };
}
export function sanitizeNativeResetPolicyValues(value: unknown): NativeResetPolicyValues {
  const v = record(value, "policy");
  return { autoRedeem: oneOf(v.autoRedeem, MODES, "policy mode"), minBlockedMinutes: num(v.minBlockedMinutes, "policy blocked minutes"),
    keepCredits: int(v.keepCredits, "policy credit reserve"), salvageHorizonHours: num(v.salvageHorizonHours, "policy salvage horizon") };
}
export function sanitizeNativeResetAccount(value: unknown): NativeResetAccountEvidence {
  const v = record(value, "account");
  const account = defined({
    provider: oneOf(v.provider, ["openai-codex"] as const, "account provider"), baseUrl: optStr(v.baseUrl, 1024, "account base URL"), accountId: optStr(v.accountId, 200, "account id"),
    email: optStr(v.email, 320, "account email"), orgId: optStr(v.orgId, 200, "account org"), projectId: optStr(v.projectId, 200, "account project"),
    credentialId: int(v.credentialId, "credential id"), credentialFingerprint: hex(v.credentialFingerprint, "credential fingerprint"),
    authAuthority: str(v.authAuthority, 256, "auth authority"), emailUnambiguous: optBool(v.emailUnambiguous, "email disambiguation"),
  });
  if (!account.accountId && !account.email?.trim()) fail("Invalid native reset account identity.");
  return account;
}
export function sanitizeNativeResetCredit(value: unknown): NativeResetCreditEvidence {
  const v = record(value, "credit");
  return defined({ id: str(v.id, 200, "credit id"), status: oneOf(v.status, ["available"] as const, "credit status"), expiresAt: optStr(v.expiresAt, 64, "credit expiry"), fingerprint: hex(v.fingerprint, "credit fingerprint") });
}
const sanitizePersistence = (value: unknown): NativeResetPersistenceProof => {
  const v = record(value, "persistence proof");
  return defined({ status: oneOf(v.status, ["verified", "failed"] as const, "persistence status"), globalMode: v.globalMode === undefined ? undefined : oneOf(v.globalMode, ["yes", "no"] as const, "persisted global mode"),
    effectivePolicy: v.effectivePolicy === undefined ? undefined : sanitizeNativeResetPolicyValues(v.effectivePolicy), layersUnchanged: optBool(v.layersUnchanged, "layer proof"),
    policyRevision: optStr(v.policyRevision, 128, "verified policy revision") });
};
/** Bounded projection of the native settlement; counters are display facts, never consume truth. */
const sanitizeFinish = (value: unknown): NativeResetFinish => {
  const v = record(value, "finish");
  if (!Array.isArray(v.attemptIds) || v.attemptIds.length > NATIVE_RESET_MAX_ACTIONS) return fail("Invalid native reset settlement attempt list.");
  return { state: oneOf(v.state, FINISH_STATES, "finish state"), refresh: oneOf(v.refresh, REFRESH_STATES, "refresh state"),
    applied: int(v.applied, "settlement applied count"), attemptIds: v.attemptIds.map(item => str(item, 256, "settlement attempt id")) };
};
const sanitizeCheckpoint = (value: unknown): NativeResetCheckpoint => {
  const v = record(value, "checkpoint");
  let completion: NativeResetCheckpointCompletion | undefined, fence: NativeResetCheckpoint["fence"];
  if (v.completion !== undefined) {
    const c = record(v.completion, "checkpoint completion");
    const base = { at: int(c.at, "completion time"), persistence: oneOf(c.persistence, ["durable", "failed"] as const, "completion persistence") };
    const terminal = oneOf(c.terminal, ["native-completion", "worker-exit"] as const, "completion terminal");
    if (terminal === "worker-exit") {
      if (c.observation !== undefined) fail("Worker exit cannot contain a native reset observation.");
      completion = { ...base, terminal };
    } else completion = { ...base, terminal, observation: sanitizeResetObservation(c.observation) };
  }
  if (v.fence !== undefined) { const f = record(v.fence, "checkpoint fence"); fence = { at: int(f.at, "fence time"), reason: oneOf(f.reason, UNKNOWN_REASONS, "fence reason") }; }
  return defined({ attemptId: id(v.attemptId, "attempt id"), role: oneOf(v.role, ["origin", "join"] as const, "checkpoint role"), originPassId: id(v.originPassId, "origin pass id"),
    redeemRequestId: str(v.redeemRequestId, 128, "redeem request id"), admittedAt: int(v.admittedAt, "admission time"), fence, completion });
};
const sanitizePlannedAction = (value: unknown, index: number): NativeResetPlannedAction => {
  const v = record(value, "planned action");
  if (v.index !== index) fail("Invalid native reset plan order.");
  const action = defined({ index, reason: oneOf(v.reason, REASONS, "action reason"), nativeAttemptKey: str(v.nativeAttemptKey, 256, "attempt key"), plannedAtMs: int(v.plannedAtMs, "plan time"),
    blockedUntilMs: optInt(v.blockedUntilMs, "blocked-until evidence"), creditExpiresAtMs: optInt(v.creditExpiresAtMs, "credit expiry evidence"), key: hex(v.key, "account key"),
    account: sanitizeNativeResetAccount(v.account), expectedGeneration: optStr(v.expectedGeneration, 128, "expected generation"),
    joinOnly: v.joinOnly === undefined ? undefined : v.joinOnly === true ? true as const : fail("Invalid native reset join marker."),
    checkpoint: v.checkpoint === undefined ? undefined : sanitizeCheckpoint(v.checkpoint) });
  if (action.key !== nativeResetAccountKey(action.account, action.account.baseUrl)) fail("Native reset plan account key disagrees with its identity.");
  return action;
};
const sanitizeDecision = (value: unknown): NativeResetDecision => {
  const v = record(value, "decision");
  switch (v.state) {
    case "none": return { state: "none" };
    case "pending": return { state: "pending", requestedAt: int(v.requestedAt, "decision request time") };
    case "answered": return { state: "answered", answer: oneOf(v.answer, ["Yes", "No", "dismissed"] as const, "decision answer"), requestedAt: int(v.requestedAt, "decision request time"), answeredAt: int(v.answeredAt, "decision answer time") };
    default: return fail("Invalid native reset decision.");
  }
};
function sanitizePassRecord(value: unknown, hostId: string): NativeResetPassRecord {
  const v = record(value, "pass record");
  if (v.version !== 1 || v.hostId !== hostId) fail("Foreign native reset pass record.");
  const provenance = sanitizeNativeResetProvenance(v.provenance), passId = id(v.passId, "pass id");
  if (provenance.passId !== passId || provenance.hostId !== hostId) fail("Native reset pass record identity mismatch.");
  let plan: NativeResetPassRecord["plan"];
  if (v.plan !== undefined) {
    const p = record(v.plan, "plan");
    if (!Array.isArray(p.actions) || p.actions.length > NATIVE_RESET_MAX_ACTIONS) return fail("Invalid native reset plan.");
    const actions = p.actions.map(sanitizePlannedAction);
    if (new Set(actions.map(action => action.key)).size !== actions.length) fail("Invalid native reset plan accounts.");
    plan = { plannedAtMs: int(p.plannedAtMs, "plan time"), actions };
  }
  let persistence: NativeResetPassRecord["persistence"], finish: NativeResetPassRecord["finish"], closed: NativeResetPassRecord["closed"];
  if (v.persistence !== undefined) persistence = { ...sanitizePersistence(v.persistence), recordedAt: int(record(v.persistence, "persistence").recordedAt, "persistence time") };
  if (v.finish !== undefined) { const f = record(v.finish, "finish"); finish = { ...sanitizeFinish(f), recordedAt: int(f.recordedAt, "finish time") }; }
  if (v.closed !== undefined) { const c = record(v.closed, "closure"); closed = { reason: oneOf(c.reason, ["invalidated", "oversized", "restarted", "worker-lost"] as const, "closure reason"), at: int(c.at, "closure time") }; }
  return defined({ version: 1 as const, hostId, passId, provenance, policy: sanitizeNativeResetPolicyValues(v.policy), startRevision: str(v.startRevision, 128, "start revision"),
    createdAt: int(v.createdAt, "creation time"), updatedAt: int(v.updatedAt, "update time"), plan, joinedToPassId: v.joinedToPassId === undefined ? undefined : id(v.joinedToPassId, "joined pass id"),
    decision: sanitizeDecision(v.decision), persistence, finish, closed });
}
/** Semantic identity of one automatic redemption; independent of host session, worker and pass ids. */
export function nativeResetCompatibilityHash(input: { key: string; account: NativeResetAccountEvidence; action: NativeResetActionEvidence; credit: NativeResetCreditEvidence; provider: string; modelId: string; policy: NativeResetPolicyValues; selectionRevision: string }): string {
  const { account, action, credit, policy } = input;
  return createHash("sha256").update(JSON.stringify({ key: input.key,
    // Identity is already normalized into `key` (cosmetic email aliases collapse); only credential proof is added here.
    account: { credentialId: account.credentialId, credentialFingerprint: account.credentialFingerprint, authAuthority: account.authAuthority },
    episode: { reason: action.reason, nativeAttemptKey: action.nativeAttemptKey, blockedUntilMs: action.blockedUntilMs ?? null, creditExpiresAtMs: action.creditExpiresAtMs ?? null },
    credit: { id: credit.id, fingerprint: credit.fingerprint, expiresAt: credit.expiresAt ?? null },
    model: { provider: input.provider, modelId: input.modelId },
    policy: { autoRedeem: policy.autoRedeem, minBlockedMinutes: policy.minBlockedMinutes, keepCredits: policy.keepCredits, salvageHorizonHours: policy.salvageHorizonHours },
    selectionRevision: input.selectionRevision })).digest("hex");
}

interface LiveAttempt {
  attemptId: string; passId: string; key: string; index: number; evidence: ResetAutomaticEvidence;
  promise: Promise<NativeResetCompletion>; resolve: (completion: NativeResetCompletion) => void;
  /** Durable unknown marker already written while the settlement stays pending. */
  fenced?: ResetUnknownReason;
  completion?: NativeResetCompletion;
}
interface LoadedPass { passId: string; record?: NativeResetPassRecord }
interface AttemptLookup { state: NativeResetAttemptState; attempt?: ResetAdmissionAttempt }

/** Durable owner of native automatic reset passes: consent checkpoints, plan evidence and live
 * settlement joins over the one shared {@link ResetAccountAdmissions} authority. It never selects,
 * consents, saves settings or consumes on its own; every step records a native or adapter fact. */
export class NativeResetPolicy {
  readonly #store: HostStore;
  readonly #admissions: ResetAccountAdmissions;
  readonly #now: () => number;
  readonly #maxPasses: number;
  readonly #live = new Map<string, LiveAttempt>();
  #disposing = false;

  constructor(options: NativeResetPolicyOptions) {
    options.admissions.assertStore(options.store);
    this.#store = options.store; this.#admissions = options.admissions; this.#now = options.now ?? Date.now;
    this.#maxPasses = options.maxPasses ?? 256;
    if (!Number.isSafeInteger(this.#maxPasses) || this.#maxPasses < 1 || this.#maxPasses > MAX_ENUMERATION) throw new Error("Invalid native reset pass bound.");
    this.#recover();
  }

  /** Reopen: no live promise survives, so admitted work is unknown and unadmitted passes are interrupted. */
  #recover(): void {
    this.#store.transactionMetadata(() => {
      for (const loaded of this.#loadAll()) {
        const pass = loaded.record; if (!pass) continue;
        let changed = false;
        for (const action of pass.plan?.actions ?? []) {
          const checkpoint = action.checkpoint;
          if (!checkpoint || checkpoint.role !== "origin" || checkpoint.fence || checkpoint.completion || this.#attempt(checkpoint.attemptId).state !== "dispatching") continue;
          // A marker that cannot be written leaves the dispatching claim itself as the fence.
          try { this.#admissions.markAutomaticUnknown(checkpoint.attemptId, "restarted"); } catch { continue; }
          checkpoint.fence = { at: this.#now(), reason: "restarted" }; changed = true;
        }
        if (!pass.closed && !pass.finish) { pass.closed = { reason: "restarted", at: this.#now() }; changed = true; }
        if (changed) this.#write(pass);
      }
    });
  }
  #attempt(attemptId: string): AttemptLookup {
    try { const attempt = this.#admissions.getAttempt(attemptId); return attempt ? { state: attempt.state, attempt } : { state: "missing" }; }
    catch { return { state: "malformed" }; }
  }
  #load(passId: string): LoadedPass {
    try {
      const raw = this.#store.readMetadata<unknown>(`${PASS_PREFIX}${passId}`, PASS_MAX_BYTES);
      if (raw === undefined) return { passId };
      const record = sanitizePassRecord(raw, this.#store.host.id);
      return record.passId === passId ? { passId, record } : { passId };
    } catch { return { passId }; }
  }
  /** Any retained row counts, including oversized or unparseable ones. */
  #exists(passId: string): boolean {
    try { return this.#store.readMetadata<unknown>(`${PASS_PREFIX}${passId}`, PASS_MAX_BYTES) !== undefined; } catch { return true; }
  }
  #loadAll(): LoadedPass[] { return this.#store.metadataKeys(PASS_PREFIX, MAX_ENUMERATION).map(key => this.#load(key.slice(PASS_PREFIX.length))); }
  #write(pass: NativeResetPassRecord): void {
    pass.updatedAt = this.#now();
    if (Buffer.byteLength(JSON.stringify(pass)) > PASS_MAX_BYTES) throw new Error("Native reset pass record exceeds its bound.");
    this.#store.writeMetadata(`${PASS_PREFIX}${pass.passId}`, pass);
  }
  #require(passId: string): NativeResetPassRecord {
    const loaded = this.#load(id(passId, "pass id"));
    if (!loaded.record) throw new Error(this.#exists(loaded.passId) ? "Native reset pass record is malformed." : "Unknown native reset pass.");
    return loaded.record;
  }
  #open(passId: string): NativeResetPassRecord {
    if (this.#disposing) throw new Error("Native reset policy is disposing.");
    const pass = this.#require(passId);
    if (pass.closed) throw new Error(`Native reset pass was closed (${pass.closed.reason}).`);
    if (pass.finish) throw new Error("Native reset pass has already finished.");
    return pass;
  }
  /** Closed or finished, with every admitted attempt durably resolved and no live settlement pending. */
  #reclaimable(pass: NativeResetPassRecord): boolean {
    if (!pass.closed && !pass.finish) return false;
    if (this.#unverifiedYes(pass)) return false;
    for (const action of pass.plan?.actions ?? []) {
      const checkpoint = action.checkpoint; if (!checkpoint) continue;
      const live = this.#live.get(checkpoint.attemptId);
      if (live && !live.completion) return false;
      const state = this.#attempt(checkpoint.attemptId).state;
      if (state !== "settled" && state !== "unknown") return false;
    }
    return true;
  }
  #floor(): number {
    const raw = this.#store.readMetadata<{ version?: unknown; hostId?: unknown; retiredStartedAtMs?: unknown }>(FLOOR_KEY, 1024);
    if (raw === undefined) return -1;
    return raw.version === 1 && raw.hostId === this.#store.host.id && Number.isSafeInteger(raw.retiredStartedAtMs) ? raw.retiredStartedAtMs as number : fail("retirement floor");
  }
  /** Reclaims closed, fully resolved passes oldest-first and raises the retired-start floor; never evicts unresolved work. */
  #makeRoom(): void {
    const loaded = this.#loadAll();
    if (loaded.length < this.#maxPasses) return;
    const candidates = loaded.filter((item): item is Required<LoadedPass> => !!item.record && this.#reclaimable(item.record))
      .sort((a, b) => a.record.provenance.startedAtMs - b.record.provenance.startedAtMs || a.record.createdAt - b.record.createdAt);
    let floor = this.#floor(), remaining = loaded.length;
    for (const item of candidates) {
      if (remaining < this.#maxPasses) break;
      this.#store.deleteMetadata(`${PASS_PREFIX}${item.passId}`); remaining -= 1;
      floor = Math.max(floor, item.record.provenance.startedAtMs);
      for (const action of item.record.plan?.actions ?? []) if (action.checkpoint?.role === "origin") this.#live.delete(action.checkpoint.attemptId);
    }
    if (remaining >= this.#maxPasses) throw new Error("Native reset pass history is full of unresolved work.");
    this.#store.writeMetadata(FLOOR_KEY, { version: 1, hostId: this.#store.host.id, retiredStartedAtMs: floor });
    this.#admissions.pruneSettledAttempts();
  }

  start(input: { provenance: NativeResetProvenance; policy: NativeResetPolicyValues }): NativeResetPassRecord {
    return this.#retain(input);
  }
  /** Retains a native same-session join against a running original pass. No claim, promise or consent is created: the
   * original pass owns them. Only finish() follows, mirroring the native joined→finished path. */
  joined(input: { provenance: NativeResetProvenance; policy: NativeResetPolicyValues }, originalPassId: string): NativeResetPassRecord {
    return this.#retain(input, id(originalPassId, "original pass id"));
  }
  #retain(input: { provenance: NativeResetProvenance; policy: NativeResetPolicyValues }, joinedToPassId?: string): NativeResetPassRecord {
    if (this.#disposing) throw new Error("Native reset policy is disposing.");
    const provenance = sanitizeNativeResetProvenance(input.provenance), policy = sanitizeNativeResetPolicyValues(input.policy);
    if (provenance.hostId !== this.#store.host.id) throw new Error("Native reset pass belongs to another host.");
    if (joinedToPassId === provenance.passId) throw new Error("Native reset pass cannot join itself.");
    return this.#store.transactionMetadata(() => {
      const existing = this.#load(provenance.passId);
      if (existing.record || this.#exists(provenance.passId)) {
        if (existing.record && same(existing.record.provenance, provenance) && same(existing.record.policy, policy) && existing.record.joinedToPassId === joinedToPassId) return existing.record;
        throw new Error("Native reset pass id is already retained with different provenance.");
      }
      if (joinedToPassId !== undefined) {
        const original = this.#load(joinedToPassId).record;
        if (!original || original.joinedToPassId !== undefined) throw new Error("Native reset join names no retained original pass.");
        const o = original.provenance;
        if (o.hostId !== provenance.hostId || o.sessionId !== provenance.sessionId || o.workerEpoch !== provenance.workerEpoch || o.nativeSessionId !== provenance.nativeSessionId)
          throw new Error("Native reset join does not share the original pass's session identity.");
      }
      if (provenance.startedAtMs <= this.#floor()) throw new Error("Native reset pass start time is at or below the retired floor.");
      this.#makeRoom();
      const at = this.#now();
      const pass: NativeResetPassRecord = defined({ version: 1 as const, hostId: this.#store.host.id, passId: provenance.passId, provenance, policy, startRevision: this.#admissions.revision(), createdAt: at, updatedAt: at, joinedToPassId, decision: { state: "none" as const } });
      this.#write(pass);
      return pass;
    });
  }

  plan(passId: string, input: { plannedAtMs: number; actions: readonly { native: CodexResetAction; account: NativeResetAccountEvidence }[] }): NativeResetPassRecord {
    const pass = this.#open(passId);
    if (pass.joinedToPassId !== undefined) throw new Error("A joined native reset pass has no plan of its own.");
    if (pass.plan) throw new Error("Native reset pass is already planned.");
    const plannedAtMs = int(input.plannedAtMs, "plan time");
    if (!Array.isArray(input.actions)) throw new Error("Invalid native reset plan.");
    if (input.actions.length > NATIVE_RESET_MAX_ACTIONS) {
      // Durably reject the whole pass: a shortened retry of the same native plan would silently drop actions.
      pass.closed = { reason: "oversized", at: this.#now() };
      this.#store.transactionMetadata(() => this.#write(pass));
      throw new Error(`Native reset plan exceeds ${NATIVE_RESET_MAX_ACTIONS} actions and was rejected.`);
    }
    const actions = input.actions.map(({ native, account: rawAccount }, index): NativeResetPlannedAction => {
      const account = sanitizeNativeResetAccount(rawAccount);
      if (!account.accountId && account.emailUnambiguous !== true) throw new Error("Email-only native reset evidence is ambiguous.");
      const target = record(native.target, "action target");
      if (target.credentialId !== undefined && target.credentialId !== account.credentialId
        || target.accountId !== undefined && target.accountId !== account.accountId
        || typeof target.email === "string" && (!account.email || target.email.trim().toLowerCase() !== account.email.trim().toLowerCase()))
        throw new Error("Native reset target disagrees with the verified account.");
      const reason = oneOf(native.reason, REASONS, "action reason"), remainingMs = optNum(native.remainingMs, "remaining time"), expiresInMs = optNum(native.expiresInMs, "credit expiry window");
      return defined({ index, reason, nativeAttemptKey: str(native.attemptKey, 256, "attempt key"), plannedAtMs,
        blockedUntilMs: reason === "blocked-account" && remainingMs !== undefined ? plannedAtMs + Math.round(remainingMs) : undefined,
        creditExpiresAtMs: reason === "expiring-credit" && expiresInMs !== undefined ? plannedAtMs + Math.round(expiresInMs) : undefined,
        key: nativeResetAccountKey(account, account.baseUrl), account });
    });
    if (new Set(actions.map(action => action.key)).size !== actions.length) throw new Error("Native reset plan names one account twice.");
    // The invalidation closure must commit even though the caller receives the revision error.
    let invalidated: unknown;
    this.#store.transactionMetadata(() => {
      try { this.#admissions.assertRevision(pass.startRevision); }
      catch (error) { invalidated = error; pass.closed = { reason: "invalidated", at: this.#now() }; this.#write(pass); return; }
      for (const action of actions) {
        let existing: ResetAccountInspection | undefined;
        try { existing = this.#admissions.inspect(action.key); } catch { action.joinOnly = true; continue; }
        if (existing?.generation !== undefined) action.expectedGeneration = existing.generation;
        if (existing && existing.state !== "settled") action.joinOnly = true;
      }
      pass.plan = { plannedAtMs, actions };
      this.#write(pass);
    });
    if (invalidated) throw invalidated;
    return pass;
  }

  requestDecision(passId: string): boolean {
    if (this.#disposing) return false;
    const pass = this.#load(id(passId, "pass id")).record;
    if (!pass || pass.closed || pass.finish || !pass.plan?.actions.length || pass.policy.autoRedeem !== "unset" || pass.decision.state !== "none") return false;
    pass.decision = { state: "pending", requestedAt: this.#now() };
    this.#write(pass);
    return true;
  }
  answer(passId: string, answer: "Yes" | "No" | undefined): NativeResetDecision {
    if (answer !== undefined && answer !== "Yes" && answer !== "No") throw new Error("Invalid native reset decision answer.");
    const pass = this.#open(passId);
    if (pass.decision.state !== "pending") throw new Error("Native reset pass has no pending decision.");
    pass.decision = { state: "answered", answer: answer ?? "dismissed", requestedAt: pass.decision.requestedAt, answeredAt: this.#now() };
    this.#write(pass);
    return pass.decision;
  }
  persistence(passId: string, proof: NativeResetPersistenceProof): NativeResetPassRecord {
    const clean = sanitizePersistence(proof), pass = this.#open(passId);
    if (pass.persistence) throw new Error("Native reset pass already recorded its persistence proof.");
    pass.persistence = { ...clean, recordedAt: this.#now() };
    this.#write(pass);
    return pass;
  }
  finish(passId: string, finish: NativeResetFinish): NativeResetPassRecord {
    const clean = sanitizeFinish(finish), pass = this.#require(passId);
    if (pass.finish) throw new Error("Native reset pass has already finished.");
    pass.finish = { ...clean, recordedAt: this.#now() };
    this.#write(pass);
    return pass;
  }

  #verifiedPolicy(pass: NativeResetPassRecord): boolean {
    const proof = pass.persistence, effective = proof?.effectivePolicy;
    return !!proof && proof.status === "verified" && proof.globalMode === "yes" && proof.layersUnchanged === true && !!effective
      && (pass.policy.autoRedeem === "unset" ? effective.autoRedeem !== "no" : effective.autoRedeem === pass.policy.autoRedeem)
      && same({ ...effective, autoRedeem: pass.policy.autoRedeem }, pass.policy);
  }
  #unverifiedYes(pass: NativeResetPassRecord): boolean {
    return pass.decision.state === "answered" && pass.decision.answer === "Yes" && !this.#verifiedPolicy(pass);
  }
  /** A failed/unacknowledged settings write cannot become standing consent merely because the next native pass reads in-memory Yes. */
  #authorizationHold(pass: NativeResetPassRecord): NativeResetHoldReason | undefined {
    if (pass.policy.autoRedeem === "no") return "policy-no";
    if (pass.policy.autoRedeem === "unset" && (pass.decision.state !== "answered" || pass.decision.answer !== "Yes")) return "no-consent";
    if (this.#verifiedPolicy(pass)) return undefined;
    if (pass.policy.autoRedeem === "unset" || pass.persistence) return "persistence-hold";
    return this.#loadAll().some(({ record }) => record?.provenance.sessionId === pass.provenance.sessionId && this.#unverifiedYes(record))
      ? "persistence-hold" : undefined;
  }
  admit(passId: string, actionIndex: number, input: NativeResetAdmitInput): NativeResetAdmission {
    const hold = (reason: NativeResetHoldReason): NativeResetAdmission => ({ kind: "hold", reason });
    if (this.#disposing) return hold("disposing");
    const pass = this.#load(id(passId, "pass id")).record;
    if (!pass) return hold("unknown-pass");
    if (pass.closed) return hold("closed");
    if (pass.finish) return hold("finished");
    if (!pass.plan) return hold("unplanned");
    const action = Number.isSafeInteger(actionIndex) ? pass.plan.actions[actionIndex] : undefined;
    if (!action) return hold("unknown-action");
    if (action.checkpoint) return hold("already-admitted");
    const current = record(input.current, "current native identity"), account = sanitizeNativeResetAccount(input.account), credit = sanitizeNativeResetCredit(input.credit);
    const p = pass.provenance;
    const policyRevision = this.#verifiedPolicy(pass) ? pass.persistence?.policyRevision ?? p.policyRevision : p.policyRevision;
    if (current.workerEpoch !== p.workerEpoch || current.nativeSessionId !== p.nativeSessionId || current.selectionRevision !== p.selectionRevision || current.policyRevision !== policyRevision) return hold("stale");
    if (!same(account, action.account)) return hold("binding-changed");
    if (action.creditExpiresAtMs !== undefined && credit.expiresAt !== undefined && Date.parse(credit.expiresAt) !== action.creditExpiresAtMs) return hold("binding-changed");
    const authorization = this.#authorizationHold(pass);
    if (authorization) return hold(authorization);
    const evidenceAction: NativeResetActionEvidence = defined({ index: action.index, reason: action.reason, nativeAttemptKey: action.nativeAttemptKey, plannedAtMs: action.plannedAtMs, blockedUntilMs: action.blockedUntilMs, creditExpiresAtMs: action.creditExpiresAtMs });
    const compatibilityHash = nativeResetCompatibilityHash({ key: action.key, account, action: evidenceAction, credit, provider: p.provider, modelId: p.modelId, policy: pass.policy, selectionRevision: p.selectionRevision });
    let existing: ResetAccountInspection | undefined;
    try { existing = this.#admissions.inspect(action.key); } catch { return hold("fenced"); }
    if (existing?.state === "unknown") return hold("fenced");
    if (existing?.state === "dispatching") {
      if (existing.kind !== "automatic" || !existing.attemptId) return hold("manual-collision");
      const { attempt } = this.#attempt(existing.attemptId), live = this.#live.get(existing.attemptId);
      if (!attempt || attempt.kind !== "automatic" || attempt.evidence.compatibilityHash !== compatibilityHash) return hold("incompatible");
      if (!live || live.completion) return hold("unjoinable");
      action.checkpoint = { attemptId: live.attemptId, role: "join", originPassId: live.passId, redeemRequestId: live.evidence.redeemRequestId, admittedAt: this.#now() };
      this.#write(pass);
      return { kind: "join", attemptId: live.attemptId, passId: pass.passId, originPassId: live.passId, provenance: live.evidence.provenance, key: action.key,
        credentialId: live.evidence.account.credentialId, creditId: live.evidence.credit.id, redeemRequestId: live.evidence.redeemRequestId, settlement: live.promise };
    }
    if (existing?.generation !== action.expectedGeneration || action.joinOnly) return hold("stale-generation");
    const evidence: ResetAutomaticEvidence = { provenance: p, policy: pass.policy, action: evidenceAction, account, credit, compatibilityHash, redeemRequestId: randomUUID() };
    const admitted = this.#store.transactionMetadata(() => {
      const admitted = this.#admissions.admitAutomatic({ key: action.key, expectedGeneration: action.expectedGeneration, operationId: pass.passId, evidence });
      action.checkpoint = { attemptId: admitted.attemptId, role: "origin", originPassId: pass.passId, redeemRequestId: evidence.redeemRequestId, admittedAt: this.#now() };
      this.#write(pass);
      return admitted;
    });
    let resolve!: (completion: NativeResetCompletion) => void;
    const promise = new Promise<NativeResetCompletion>(done => { resolve = done; });
    this.#live.set(admitted.attemptId, { attemptId: admitted.attemptId, passId: pass.passId, key: action.key, index: action.index, evidence, promise, resolve });
    return { kind: "execute", attemptId: admitted.attemptId, passId: pass.passId, key: action.key, generation: admitted.generation, credentialId: account.credentialId, creditId: credit.id, redeemRequestId: evidence.redeemRequestId, settlement: promise };
  }

  #settle(live: LiveAttempt, completion: NativeResetCompletion): NativeResetCompletion { live.completion = completion; live.resolve(completion); return completion; }
  /** Best-effort durable unknown marker; storage failure retains the prior dispatching fence. Never resolves the live settlement. */
  #fence(live: LiveAttempt, reason: ResetUnknownReason, observation?: ResetAttemptObservation): "durable" | "failed" {
    try {
      this.#store.transactionMetadata(() => {
        this.#admissions.markAutomaticUnknown(live.attemptId, reason, observation);
        const pass = this.#load(live.passId).record, action = pass?.plan?.actions[live.index];
        if (pass && action?.checkpoint?.attemptId === live.attemptId) {
          action.checkpoint.fence ??= { at: this.#now(), reason };
          if (observation) action.checkpoint.completion = { at: this.#now(), persistence: "failed", terminal: "native-completion", observation };
          this.#write(pass);
        }
      });
      live.fenced ??= reason;
      return "durable";
    } catch { return "failed"; }
  }
  /** The original executor's physical terminal observation. After a durable unknown fence it is retained without upgrading the fence. */
  complete(attemptId: string, provenance: NativeResetCompletionProvenance, observation: ResetAttemptObservation): NativeResetCompletion {
    const clean = sanitizeResetObservation(observation), live = this.#live.get(id(attemptId, "attempt id")), origin = record(provenance, "completion provenance");
    if (!live) {
      const { attempt } = this.#attempt(attemptId);
      if (attempt?.kind === "automatic" && attempt.state === "settled" && same(attempt.observation, clean) && this.#sameExecutor(attempt.evidence.provenance, origin))
        return { attemptId, passId: attempt.evidence.provenance.passId, key: attempt.key, persistence: "durable", authority: "settled", terminal: "native-completion", observed: classifyResetObservation(clean).effect, observation: clean };
      throw new Error("No live admitted native reset attempt accepts this completion.");
    }
    if (!this.#sameExecutor(live.evidence.provenance, origin)) throw new Error("Only the original native executor can complete this attempt.");
    if (live.completion) {
      if (live.completion.persistence === "durable" && same(live.completion.observation, clean)) return live.completion;
      throw new Error("Native reset attempt already resolved with a different result.");
    }
    try {
      const attempt = this.#store.transactionMetadata(() => {
        const attempt = this.#admissions.completeAutomatic(live.attemptId, clean);
        const pass = this.#require(live.passId), action = pass.plan?.actions[live.index];
        if (action?.checkpoint?.attemptId !== live.attemptId) throw new Error("Native reset pass checkpoint no longer matches its attempt.");
        action.checkpoint.completion = { at: this.#now(), persistence: "durable", terminal: "native-completion", observation: clean };
        this.#write(pass);
        return attempt;
      });
      return this.#settle(live, defined({ attemptId: live.attemptId, passId: live.passId, key: live.key, persistence: "durable" as const, authority: attempt.state === "settled" ? "settled" as const : "unknown" as const, terminal: "native-completion" as const,
        observed: classifyResetObservation(clean).effect, observation: clean, reason: attempt.state === "unknown" ? attempt.unknownReason ?? live.fenced ?? "settlement-failed" : undefined }));
    } catch (error) {
      this.#fence(live, "settlement-failed", clean);
      this.#settle(live, { attemptId: live.attemptId, passId: live.passId, key: live.key, persistence: "failed", authority: "unknown", terminal: "native-completion", observed: classifyResetObservation(clean).effect, observation: clean, reason: live.fenced ?? "settlement-failed" });
      throw error;
    }
  }
  #sameExecutor(original: NativeResetProvenance, offered: Record<string, unknown>): boolean {
    return offered.workerEpoch === original.workerEpoch && offered.nativeSessionId === original.nativeSessionId && offered.passId === original.passId && offered.sessionId === original.sessionId;
  }

  /** Nonterminal loss notification: fence authority and interrupt decisions, but retain possibly-live original settlement. */
  workerLost(workerEpoch: string): { attempts: string[]; passes: string[] } {
    const epoch = id(workerEpoch, "worker epoch"), attempts: string[] = [], passes: string[] = [];
    for (const live of this.#live.values()) {
      if (live.completion || live.fenced || live.evidence.provenance.workerEpoch !== epoch) continue;
      if (this.#fence(live, "worker-lost") === "durable") attempts.push(live.attemptId);
    }
    this.#store.transactionMetadata(() => {
      for (const loaded of this.#loadAll()) {
        const pass = loaded.record;
        if (!pass || pass.closed || pass.finish || pass.provenance.workerEpoch !== epoch) continue;
        pass.closed = { reason: "worker-lost", at: this.#now() }; this.#write(pass); passes.push(pass.passId);
      }
    });
    return { attempts, passes };
  }
  /** Parent-supervisor only: call on actual process exit/confirmed kill, never on disconnect, deadline or merely sending a signal.
   * No native completion is fabricated. Provider effect stays unknown even though this worker can no longer complete its operation. */
  workerExited(workerEpoch: string): readonly NativeResetCompletion[] {
    const epoch = id(workerEpoch, "worker epoch"), completions: NativeResetCompletion[] = [];
    // Persist interruption when possible, but failed journaling cannot keep waiters attached to a confirmed-dead process.
    try { this.workerLost(epoch); } catch {}
    for (const live of this.#live.values()) {
      if (live.evidence.provenance.workerEpoch !== epoch) continue;
      if (live.completion) {
        if (live.completion.terminal === "worker-exit") completions.push(live.completion);
        continue;
      }
      let persistence: NativeResetCompletion["persistence"] = "durable";
      try {
        this.#store.transactionMetadata(() => {
          this.#admissions.markAutomaticUnknown(live.attemptId, "worker-lost");
          const pass = this.#require(live.passId), action = pass.plan?.actions[live.index];
          if (action?.checkpoint?.attemptId !== live.attemptId) throw new Error("Native reset pass checkpoint no longer matches its attempt.");
          action.checkpoint.fence ??= { at: this.#now(), reason: "worker-lost" };
          action.checkpoint.completion = { at: this.#now(), persistence: "durable", terminal: "worker-exit" };
          pass.closed ??= { reason: "worker-lost", at: this.#now() };
          this.#write(pass);
        });
        live.fenced ??= "worker-lost";
      } catch {
        persistence = "failed";
        this.#fence(live, "worker-lost");
      }
      completions.push(this.#settle(live, { attemptId: live.attemptId, passId: live.passId, key: live.key, persistence,
        authority: "unknown", terminal: "worker-exit", observed: "unknown", reason: "worker-lost" }));
    }
    return completions;
  }
  beginDispose(): void { this.#disposing = true; }
  get disposing(): boolean { return this.#disposing; }
  /** Joins pending native completions or explicitly confirmed worker exits; no timer infers either terminal event. */
  drain(): Promise<readonly NativeResetCompletion[]> {
    return Promise.all([...this.#live.values()].filter(live => !live.completion).map(live => live.promise));
  }

  inspectPass(passId: string): NativeResetPassView | undefined {
    const loaded = this.#load(id(passId, "pass id"));
    if (!loaded.record) return this.#exists(loaded.passId) ? { passId: loaded.passId, status: "malformed" } : undefined;
    const pass = loaded.record;
    const attempts = (pass.plan?.actions ?? []).flatMap((action): NativeResetAttemptView[] => {
      const checkpoint = action.checkpoint; if (!checkpoint) return [];
      const { state, attempt } = this.#attempt(checkpoint.attemptId), live = this.#live.get(checkpoint.attemptId);
      const observation = live?.completion?.observation ?? checkpoint.completion?.observation ?? attempt?.observation;
      return [defined({ index: action.index, attemptId: checkpoint.attemptId, role: checkpoint.role, state, unknownReason: attempt?.state === "unknown" ? attempt.unknownReason : undefined,
        observed: observation ? classifyResetObservation(observation).effect : "unknown" as const, live: !!live && !live.completion, fence: checkpoint.fence, completion: checkpoint.completion })];
    });
    return { passId: pass.passId, status: pass.finish ? "finished" : pass.closed ? "closed" : pass.joinedToPassId !== undefined ? "joined" : pass.plan ? "planned" : "started", record: pass, attempts };
  }
  inspectAttempt(attemptId: string): NativeResetAttemptInspection {
    const clean = id(attemptId, "attempt id"), { state, attempt } = this.#attempt(clean), live = this.#live.get(clean);
    const provenance = attempt?.kind === "automatic" ? attempt.evidence.provenance : undefined, observation = live?.completion?.observation ?? attempt?.observation;
    return defined({ attemptId: clean, attempt, state, passId: provenance?.passId, provenance, live: !!live && !live.completion, fenced: live?.fenced, completion: live?.completion,
      observed: observation ? classifyResetObservation(observation).effect : "unknown" as const });
  }
}
