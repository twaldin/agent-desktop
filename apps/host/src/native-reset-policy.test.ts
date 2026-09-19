import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodexResetAction } from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { HostStore } from "./store";
import { ResetAccountAdmissions, type ResetAttemptObservation } from "./session-reset-admission";
import { NATIVE_RESET_MAX_ACTIONS, NativeResetPolicy, nativeResetCompatibilityHash, type NativeResetAccountEvidence, type NativeResetAdmission, type NativeResetAdmitInput, type NativeResetPolicyValues, type NativeResetProvenance } from "./native-reset-policy";
import { nativeResetAccountKey } from "./omp/session-usage";

const directories: string[] = [], stores: HostStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

const REPORT = "a".repeat(64);
const T0 = 1_700_000_000_000;
/** A well-formed attempt id that no authority row backs. */
const GHOST = "00000000-0000-4000-8000-000000000000";
const hex = (char: string) => char.repeat(64);
const passKey = (passId: string) => `native-reset-policy.v1:pass:${passId}`;
const account = (over: Partial<NativeResetAccountEvidence> = {}): NativeResetAccountEvidence =>
  ({ provider: "openai-codex", accountId: "acct-a", email: "a@fixture.invalid", credentialId: 7, credentialFingerprint: hex("f"), authAuthority: "auth.openai.com", ...over });
const accountB = account({ accountId: "acct-b", email: "b@fixture.invalid", credentialId: 8, credentialFingerprint: hex("e") });
const KEY_A = nativeResetAccountKey(account()), KEY_B = nativeResetAccountKey(accountB);
const credit = (over: Partial<{ id: string; expiresAt: string; fingerprint: string }> = {}) => ({ id: "RateLimitResetCredit_1", status: "available" as const, expiresAt: "2026-10-01T00:00:00.000Z", fingerprint: hex("c"), ...over });
const policy = (autoRedeem: NativeResetPolicyValues["autoRedeem"] = "yes"): NativeResetPolicyValues => ({ autoRedeem, minBlockedMinutes: 30, keepCredits: 1, salvageHorizonHours: 24 });
const native = (over: Partial<CodexResetAction> = {}): CodexResetAction =>
  ({ reason: "blocked-account", target: { credentialId: 7, accountId: "acct-a" }, accountKey: "acct-a", attemptKey: "blocked:acct-a:28333333", label: "a@fixture.invalid", remainingMs: 3_600_000, blockedWindows: ["weekly"], active: true, ...over });
const nativeB = native({ target: { credentialId: 8, accountId: "acct-b" }, accountKey: "acct-b", attemptKey: "blocked:acct-b:28333333", label: "b@fixture.invalid", active: false });
const current = (p: NativeResetProvenance) => ({ workerEpoch: p.workerEpoch, nativeSessionId: p.nativeSessionId, selectionRevision: p.selectionRevision, policyRevision: p.policyRevision });
const executor = (p: NativeResetProvenance) => ({ workerEpoch: p.workerEpoch, nativeSessionId: p.nativeSessionId, passId: p.passId, sessionId: p.sessionId });
const RESET: ResetAttemptObservation = { consumeBoundary: "passed", result: { kind: "outcome", code: "reset", ok: true } };
const NOT_REACHED: ResetAttemptObservation = { consumeBoundary: "not-reached", result: { kind: "error" } };
/** True while a settlement promise is still unresolved: probes with microtask turns only, never a wall clock. */
const pending = async (promise: Promise<unknown>) => {
  let settled = false; void promise.then(() => { settled = true; });
  for (let turn = 0; turn < 8; turn += 1) await null;
  return !settled;
};

async function fixture(options: { maxPasses?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "native-reset-policy-")); directories.push(dir);
  let clock = T0 + 1_000_000;
  const now = () => (clock += 1);
  const open = () => { const store = new HostStore(dir); stores.push(store); const admissions = new ResetAccountAdmissions(store); return { store, admissions, policy: new NativeResetPolicy({ store, admissions, now, ...options }) }; };
  const world = open();
  let sequence = 0;
  const hostId = world.store.host.id;
  /** Fresh pass provenance: distinct id, session and start time per call, same worker/native identity unless overridden. */
  const provenance = (over: Partial<NativeResetProvenance> = {}): NativeResetProvenance => {
    const n = ++sequence;
    return { hostId, sessionId: `session-${n}`, sessionFile: `/tmp/session-${n}.jsonl`, cwd: "/tmp/project", workerEpoch: "epoch-1", nativeSessionId: `native-${n}`, passId: `pass-${n}`,
      trigger: "blocked", source: "blocked", startedAtMs: T0 + n, provider: "openai-codex", modelId: "gpt-5-codex", selectionRevision: "selection-1", policyRevision: "policy-1", ...over };
  };
  const reopen = (target: HostStore) => { target.close(); stores.splice(stores.indexOf(target), 1); return open(); };
  const failWrites = (target: HostStore, key: string, times = Number.POSITIVE_INFINITY) => {
    const write = target.writeMetadata.bind(target); let failures = 0;
    target.writeMetadata = (k, value) => { if (k === key && failures < times) { failures += 1; throw new Error("fixture write failure"); } write(k, value); };
    return () => { target.writeMetadata = write; };
  };
  /** Start and plan one pass over the supplied actions with the given policy. */
  const planned = (owner: NativeResetPolicy, actions: { native: CodexResetAction; account: NativeResetAccountEvidence }[] = [{ native: native(), account: account() }], over: Partial<NativeResetProvenance> = {}, mode: NativeResetPolicyValues["autoRedeem"] = "yes") => {
    const p = provenance(over);
    owner.start({ provenance: p, policy: policy(mode) });
    const plannedAtMs = p.startedAtMs + 10;
    // One absolute episode across distinct planning clocks, as the native planner supplies.
    const timed = actions.map(action => ({ ...action, native: { ...action.native,
      remainingMs: action.native.remainingMs === undefined ? undefined : action.native.remainingMs - (plannedAtMs - (T0 + 11)),
    } }));
    owner.plan(p.passId, { reportRevision: REPORT, plannedAtMs, actions: timed });
    return p;
  };
  const admit = (owner: NativeResetPolicy, p: NativeResetProvenance, index = 0, over: Partial<NativeResetAdmitInput> = {}) =>
    owner.admit(p.passId, index, { current: current(p), account: account(), credit: credit(), ...over });
  const execute = (admission: NativeResetAdmission) => { if (admission.kind !== "execute") throw new Error(`expected execute, got ${JSON.stringify(admission)}`); return admission; };
  return { ...world, hostId, provenance, reopen, failWrites, planned, admit, execute };
}

test("compatible automatic passes join the first live attempt; completion settles both and later plans see the new generation", async () => {
  const f = await fixture();
  const p1 = f.planned(f.policy), p2 = f.planned(f.policy, [{ native: native(), account: account() }], { sessionId: "session-other", nativeSessionId: "native-other" });
  const p3 = f.planned(f.policy);
  const first = f.execute(f.admit(f.policy, p1));
  expect(first).toMatchObject({ key: KEY_A, passId: p1.passId, credentialId: 7, creditId: "RateLimitResetCredit_1" });
  expect(first.redeemRequestId).toMatch(/^[0-9a-f-]{36}$/);
  const attempt = f.admissions.getAttempt(first.attemptId)!;
  expect(attempt.kind).toBe("automatic");
  expect(attempt.evidence?.provenance).toEqual({ ...p1, reportRevision: REPORT });
  expect(attempt.evidence?.action).toEqual({ index: 0, reason: "blocked-account", nativeAttemptKey: "blocked:acct-a:28333333", plannedAtMs: p1.startedAtMs + 10, blockedUntilMs: p1.startedAtMs + 10 + 3_600_000 });
  const second = f.admit(f.policy, p2);
  expect(second.kind).toBe("join");
  if (second.kind !== "join") throw new Error("unreachable");
  expect(second).toMatchObject({ attemptId: first.attemptId, originPassId: p1.passId, provenance: p1, redeemRequestId: first.redeemRequestId, credentialId: 7 });
  expect(second.settlement).toBe(first.settlement);
  expect(f.admit(f.policy, p1)).toEqual({ kind: "hold", reason: "already-admitted" });
  expect(f.admit(f.policy, p2)).toEqual({ kind: "hold", reason: "already-admitted" });
  // Only the original executor completes; the joined session cannot.
  expect(() => f.policy.complete(first.attemptId, executor(p2), RESET)).toThrow();
  expect(await pending(first.settlement)).toBe(true);
  const completion = f.policy.complete(first.attemptId, executor(p1), RESET);
  expect(completion).toMatchObject({ attemptId: first.attemptId, persistence: "durable", authority: "settled", observed: "reset" });
  expect(await first.settlement).toBe(completion);
  expect(f.policy.complete(first.attemptId, executor(p1), RESET)).toBe(completion);
  expect(() => f.policy.complete(first.attemptId, executor(p1), NOT_REACHED)).toThrow();
  expect(f.admissions.inspect(KEY_A)?.state).toBe("settled");
  const joined = f.policy.inspectPass(p2.passId);
  expect(joined?.status).toBe("planned");
  if (joined?.status !== "planned") throw new Error("unreachable");
  expect(joined.attempts[0]).toMatchObject({ role: "join", attemptId: first.attemptId, state: "settled", observed: "reset", live: false });
  // A pass planned against the old generation holds; a fresh plan captures the new generation and executes anew.
  expect(f.admit(f.policy, p3)).toEqual({ kind: "hold", reason: "stale-generation" });
  const p4 = f.planned(f.policy);
  const again = f.execute(f.admit(f.policy, p4));
  expect(again.attemptId).not.toBe(first.attemptId);
  expect(again.generation).not.toBe(first.generation);
  f.policy.finish(p1.passId, { state: "settled", refresh: "complete", applied: 1, attemptIds: ["blocked:acct-a:28333333"] });
  expect(f.policy.inspectPass(p1.passId)).toMatchObject({ status: "finished", record: { finish: { state: "settled", refresh: "complete", applied: 1, attemptIds: ["blocked:acct-a:28333333"] } } });
  expect(() => f.policy.finish(p1.passId, { state: "settled", refresh: "complete", applied: 1, attemptIds: [] })).toThrow();
  expect(f.admit(f.policy, p1)).toEqual({ kind: "hold", reason: "finished" });
});

test("manual admissions and incompatible automatic evidence hold instead of joining or replacing", async () => {
  const f = await fixture();
  const p1 = f.planned(f.policy);
  const manual = f.admissions.admit({ key: KEY_A, operationId: "manual-1" });
  expect(f.admit(f.policy, p1)).toEqual({ kind: "hold", reason: "manual-collision" });
  f.admissions.settle(KEY_A, "manual-1", "settled");
  expect(f.admit(f.policy, p1)).toEqual({ kind: "hold", reason: "stale-generation" });
  // Automatic execution fences manual admission on the same account and leaves other accounts alone.
  const p2 = f.planned(f.policy, [{ native: native(), account: account() }, { native: nativeB, account: accountB }]);
  const auto = f.execute(f.admit(f.policy, p2));
  expect(() => f.admissions.admit({ key: KEY_A, expectedGeneration: manual.generation, operationId: "manual-2" })).toThrow();
  expect(() => f.admissions.admit({ key: KEY_A, expectedGeneration: auto.generation, operationId: "manual-2" })).toThrow();
  expect(f.admissions.admit({ key: KEY_B, operationId: "manual-b" }).state).toBe("dispatching");
  // Same account, different credit: incompatible and left unadmitted so the pass can retry after settlement.
  const p3 = f.planned(f.policy);
  expect(f.admit(f.policy, p3, 0, { credit: credit({ id: "RateLimitResetCredit_2", fingerprint: hex("d") }) })).toEqual({ kind: "hold", reason: "incompatible" });
  expect(f.policy.inspectPass(p3.passId)).toMatchObject({ status: "planned", attempts: [] });
  const p4 = f.planned(f.policy, [{ native: native(), account: account() }], { modelId: "gpt-5-mini" });
  expect(f.admit(f.policy, p4)).toEqual({ kind: "hold", reason: "incompatible" });
  f.policy.complete(auto.attemptId, executor(p2), RESET);
  // p3 was planned while the automatic attempt was dispatching: it may only have joined, never spend after settlement.
  expect(f.admit(f.policy, p3)).toEqual({ kind: "hold", reason: "stale-generation" });
  expect(f.policy.inspectPass(p3.passId)).toMatchObject({ record: { plan: { actions: [{ joinOnly: true, expectedGeneration: auto.generation }] } } });
});

test("accounts admit independently and a global revision change only invalidates unplanned passes", async () => {
  const f = await fixture();
  const p1 = f.planned(f.policy, [{ native: native(), account: account() }, { native: nativeB, account: accountB }]);
  const a = f.execute(f.admit(f.policy, p1, 0));
  const b = f.execute(f.admit(f.policy, p1, 1, { account: accountB, credit: credit({ id: "RateLimitResetCredit_b", fingerprint: hex("b") }) }));
  expect(a.attemptId).not.toBe(b.attemptId);
  f.policy.complete(a.attemptId, executor(p1), RESET);
  expect(f.policy.inspectAttempt(b.attemptId)).toMatchObject({ state: "dispatching", live: true });
  // Planned after A settled while B is still live: A executes on its new generation, B joins the live attempt.
  const p2 = f.planned(f.policy, [{ native: native(), account: account() }, { native: nativeB, account: accountB }]);
  expect(f.admit(f.policy, p2, 0).kind).toBe("execute");
  const joinB = f.admit(f.policy, p2, 1, { account: accountB, credit: credit({ id: "RateLimitResetCredit_b", fingerprint: hex("b") }) });
  expect(joinB).toMatchObject({ kind: "join", attemptId: b.attemptId, originPassId: p1.passId });
  // Start, let another admission move the shared revision, then plan: the plan is refused and the pass closes.
  const p3 = f.provenance();
  f.policy.start({ provenance: p3, policy: policy() });
  f.policy.complete(b.attemptId, executor(p1), RESET);
  f.execute(f.admit(f.policy, f.planned(f.policy, [{ native: nativeB, account: accountB }]), 0, { account: accountB, credit: credit({ id: "RateLimitResetCredit_b2", fingerprint: hex("a") }) }));
  expect(() => f.policy.plan(p3.passId, { reportRevision: REPORT, plannedAtMs: p3.startedAtMs + 10, actions: [{ native: native(), account: account() }] })).toThrow();
  expect(f.policy.inspectPass(p3.passId)).toMatchObject({ status: "closed", record: { closed: { reason: "invalidated" } } });
  expect(f.admit(f.policy, p3)).toEqual({ kind: "hold", reason: "closed" });
  expect(f.policy.requestDecision(p3.passId)).toBe(false);
});

test("email aliases of a proven account collide and join; ambiguous email-only evidence and target disagreement are rejected", async () => {
  const f = await fixture();
  const alias = account({ email: "Alias@Fixture.invalid" });
  expect(nativeResetAccountKey(alias)).toBe(KEY_A);
  const p1 = f.planned(f.policy), p2 = f.planned(f.policy, [{ native: native({ label: "Alias@Fixture.invalid" }), account: alias }]);
  const origin = f.execute(f.admit(f.policy, p1));
  const joined = f.admit(f.policy, p2, 0, { account: alias });
  expect(joined).toMatchObject({ kind: "join", attemptId: origin.attemptId });
  // Email-only identities need an explicit disambiguation flag; then case-different spellings share one key.
  const emailOnly: NativeResetAccountEvidence = { provider: "openai-codex", email: "solo@fixture.invalid", credentialId: 9, credentialFingerprint: hex("9"), authAuthority: "auth.openai.com" };
  const target = { credentialId: 9, email: "solo@fixture.invalid" };
  expect(() => f.planned(f.policy, [{ native: native({ target }), account: emailOnly }])).toThrow(/ambiguous/);
  const p3 = f.planned(f.policy, [{ native: native({ target }), account: { ...emailOnly, emailUnambiguous: true } }]);
  const p4 = f.planned(f.policy, [{ native: native({ target: { credentialId: 9, email: "SOLO@fixture.invalid" } }), account: { ...emailOnly, email: "SOLO@fixture.invalid", emailUnambiguous: true } }]);
  const solo = f.execute(f.admit(f.policy, p3, 0, { account: { ...emailOnly, emailUnambiguous: true } }));
  expect(f.admit(f.policy, p4, 0, { account: { ...emailOnly, email: "SOLO@fixture.invalid", emailUnambiguous: true } })).toMatchObject({ kind: "join", attemptId: solo.attemptId });
  // Native target versus verified account disagreement is refused at plan time.
  expect(() => f.planned(f.policy, [{ native: native({ target: { credentialId: 8 } }), account: account() }])).toThrow(/disagrees/);
  expect(() => f.planned(f.policy, [{ native: native({ target: { accountId: "acct-z" } }), account: account() }])).toThrow(/disagrees/);
  expect(() => f.planned(f.policy, [{ native: native({ target: { email: "other@fixture.invalid" } }), account: account() }])).toThrow(/disagrees/);
  expect(() => f.planned(f.policy, [{ native: native(), account: account() }, { native: native({ attemptKey: "blocked:acct-a:2" }), account: alias }])).toThrow(/twice/);
});

test("stale native identity or changed binding holds without consuming; exact credit binding is retained in evidence", async () => {
  const f = await fixture();
  const p1 = f.planned(f.policy);
  for (const stale of [{ workerEpoch: "epoch-2" }, { nativeSessionId: "native-x" }, { selectionRevision: "selection-2" }, { policyRevision: "policy-2" }])
    expect(f.admit(f.policy, p1, 0, { current: { ...current(p1), ...stale } })).toEqual({ kind: "hold", reason: "stale" });
  expect(f.admit(f.policy, p1, 0, { account: account({ credentialFingerprint: hex("0") }) })).toEqual({ kind: "hold", reason: "binding-changed" });
  expect(f.admit(f.policy, p1, 0, { account: account({ credentialId: 8 }) })).toEqual({ kind: "hold", reason: "binding-changed" });
  expect(f.admissions.inspect(KEY_A)).toBeUndefined();
  expect(f.policy.inspectPass(p1.passId)).toMatchObject({ status: "planned", attempts: [] });
  const first = f.execute(f.admit(f.policy, p1));
  f.policy.complete(first.attemptId, executor(p1), RESET);
  // Salvage actions bind the absolute credit expiry from the native clock; a different credit expiry holds.
  const expiresAt = "2026-10-01T00:00:00.000Z", plannedAtMs = T0 + 500;
  const p2 = f.provenance();
  f.policy.start({ provenance: p2, policy: policy() });
  f.policy.plan(p2.passId, { reportRevision: REPORT, plannedAtMs, actions: [{ native: native({ reason: "expiring-credit", attemptKey: "salvage:acct-a:1", expiresInMs: Date.parse(expiresAt) - plannedAtMs, salvageWindow: "weekly" }), account: account() }] });
  expect(f.admit(f.policy, p2, 0, { credit: credit({ expiresAt: "2026-10-02T00:00:00.000Z" }) })).toEqual({ kind: "hold", reason: "binding-changed" });
  const salvage = f.execute(f.admit(f.policy, p2, 0, { credit: credit({ expiresAt }) }));
  const evidence = f.admissions.getAttempt(salvage.attemptId)!.evidence!;
  expect(evidence.action).toEqual({ index: 0, reason: "expiring-credit", nativeAttemptKey: "salvage:acct-a:1", plannedAtMs, creditExpiresAtMs: Date.parse(expiresAt) });
  expect(evidence.credit).toEqual(credit({ expiresAt }));
  expect(evidence.compatibilityHash).toBe(nativeResetCompatibilityHash({ key: KEY_A, account: account(), action: evidence.action, credit: credit({ expiresAt }), provider: p2.provider, modelId: p2.modelId, policy: policy(), selectionRevision: p2.selectionRevision }));
  expect(salvage.attemptId).not.toBe(first.attemptId);
});

test("decision and persistence are separate durable checkpoints; only Yes plus verified unchanged global proof admits", async () => {
  const f = await fixture();
  const start = (mode: NativeResetPolicyValues["autoRedeem"] = "unset") => f.planned(f.policy, [{ native: native(), account: account() }], {}, mode);
  const p = start();
  expect(f.admit(f.policy, p)).toEqual({ kind: "hold", reason: "no-consent" });
  expect(() => f.policy.answer(p.passId, "Yes")).toThrow(/pending/);
  expect(f.policy.requestDecision(p.passId)).toBe(true);
  expect(f.policy.requestDecision(p.passId)).toBe(false);
  expect(f.policy.inspectPass(p.passId)).toMatchObject({ record: { decision: { state: "pending" } } });
  expect(f.admit(f.policy, p)).toEqual({ kind: "hold", reason: "no-consent" });
  expect(f.policy.answer(p.passId, "No")).toMatchObject({ state: "answered", answer: "No" });
  expect(f.admit(f.policy, p)).toEqual({ kind: "hold", reason: "no-consent" });
  const dismissed = start();
  f.policy.requestDecision(dismissed.passId);
  expect(f.policy.answer(dismissed.passId, undefined)).toMatchObject({ answer: "dismissed" });
  f.policy.persistence(dismissed.passId, { status: "verified", globalMode: "yes", layersUnchanged: true, effectivePolicy: policy("yes") });
  expect(f.admit(f.policy, dismissed)).toEqual({ kind: "hold", reason: "no-consent" });
  const yes = () => { const q = start(); f.policy.requestDecision(q.passId); f.policy.answer(q.passId, "Yes"); return q; };
  const missing = yes();
  expect(f.admit(f.policy, missing)).toEqual({ kind: "hold", reason: "persistence-hold" });
  for (const proof of [
    { status: "failed" as const, globalMode: "yes" as const, layersUnchanged: true, effectivePolicy: policy("yes") },
    { status: "verified" as const, globalMode: "yes" as const, effectivePolicy: policy("yes") },
    { status: "verified" as const, globalMode: "yes" as const, layersUnchanged: false, effectivePolicy: policy("yes") },
    { status: "verified" as const, globalMode: "no" as const, layersUnchanged: true, effectivePolicy: policy("no") },
    { status: "verified" as const, globalMode: "yes" as const, layersUnchanged: true, effectivePolicy: { ...policy("yes"), keepCredits: 2 } },
    { status: "verified" as const, globalMode: "yes" as const, layersUnchanged: true, effectivePolicy: { ...policy("unset"), salvageHorizonHours: 1 } },
    { status: "verified" as const, globalMode: "yes" as const, layersUnchanged: true },
  ]) {
    const q = yes();
    f.policy.persistence(q.passId, proof);
    expect(f.admit(f.policy, q)).toEqual({ kind: "hold", reason: "persistence-hold" });
    expect(() => f.policy.persistence(q.passId, { status: "verified", globalMode: "yes", layersUnchanged: true, effectivePolicy: policy("yes") })).toThrow(/already/);
  }
  const consented = yes();
  f.policy.persistence(consented.passId, { status: "verified", globalMode: "yes", layersUnchanged: true, effectivePolicy: policy("yes") });
  const admitted = f.execute(f.admit(f.policy, consented));
  f.policy.complete(admitted.attemptId, executor(consented), RESET);
  // Higher layers left unset read back as an unchanged effective 'unset' mode; the verified global Yes still consents to this plan only.
  const layered = yes();
  f.policy.persistence(layered.passId, { status: "verified", globalMode: "yes", layersUnchanged: true, effectivePolicy: policy("unset") });
  const layeredAdmission = f.execute(f.admit(f.policy, layered));
  f.policy.complete(layeredAdmission.attemptId, executor(layered), RESET);
  expect(f.admit(f.policy, start())).toEqual({ kind: "hold", reason: "no-consent" });
  expect(f.admit(f.policy, start("no"))).toEqual({ kind: "hold", reason: "policy-no" });
  expect(f.policy.requestDecision(start("yes").passId)).toBe(false);
  // A retained Yes plus proof never replays across reopen: the pass is interrupted and nothing is re-asked.
  const retained = yes();
  f.policy.persistence(retained.passId, { status: "verified", globalMode: "yes", layersUnchanged: true, effectivePolicy: policy("yes") });
  const asked = start();
  f.policy.requestDecision(asked.passId);
  const r = f.reopen(f.store);
  expect(r.policy.inspectPass(retained.passId)).toMatchObject({ status: "closed", record: { closed: { reason: "restarted" }, decision: { answer: "Yes" }, persistence: { status: "verified" } } });
  expect(r.policy.admit(retained.passId, 0, { current: current(retained), account: account(), credit: credit() })).toEqual({ kind: "hold", reason: "closed" });
  expect(r.policy.requestDecision(asked.passId)).toBe(false);
  expect(() => r.policy.answer(asked.passId, "Yes")).toThrow(/closed/);
  expect(r.policy.inspectPass(asked.passId)).toMatchObject({ record: { decision: { state: "pending" } } });
});

test("known no-effect settles the account and requires a fresh native pass before spending again", async () => {
  const f = await fixture();
  const p1 = f.planned(f.policy), p2 = f.planned(f.policy);
  const admitted = f.execute(f.admit(f.policy, p1));
  const completion = f.policy.complete(admitted.attemptId, executor(p1), NOT_REACHED);
  expect(completion).toMatchObject({ persistence: "durable", authority: "settled", observed: "no-effect" });
  expect(f.admissions.inspect(KEY_A)?.state).toBe("settled");
  expect(f.admit(f.policy, p1)).toEqual({ kind: "hold", reason: "already-admitted" });
  expect(f.admit(f.policy, p2)).toEqual({ kind: "hold", reason: "stale-generation" });
  const p3 = f.planned(f.policy);
  expect(f.admit(f.policy, p3).kind).toBe("execute");
  // Passing the consume boundary with an unknown outcome fences instead of settling.
  const p4 = f.planned(f.policy, [{ native: nativeB, account: accountB }]);
  const b = f.execute(f.admit(f.policy, p4, 0, { account: accountB, credit: credit({ id: "credit-b", fingerprint: hex("b") }) }));
  const fenced = f.policy.complete(b.attemptId, executor(p4), { consumeBoundary: "passed", result: { kind: "error" } });
  expect(fenced).toMatchObject({ persistence: "durable", authority: "unknown", observed: "unknown" });
  expect(f.admissions.inspect(KEY_B)?.state).toBe("unknown");
  expect(f.admit(f.policy, f.planned(f.policy, [{ native: nativeB, account: accountB }]), 0, { account: accountB, credit: credit({ id: "credit-b", fingerprint: hex("b") }) })).toEqual({ kind: "hold", reason: "fenced" });
});

test("malformed, foreign and partial pass records are retained conservatively without blocking healthy passes", async () => {
  const f = await fixture({ maxPasses: 4 });
  f.store.writeMetadata(passKey("pass-garbage"), { version: 1, hostId: f.hostId, passId: "pass-garbage", provenance: "nope" });
  f.store.writeMetadata(passKey("pass-foreign"), { version: 1, hostId: "other-host", passId: "pass-foreign" });
  const started = f.provenance();
  f.policy.start({ provenance: started, policy: policy() });
  const admitted = f.planned(f.policy);
  const live = f.execute(f.admit(f.policy, admitted));
  const ghost = f.store.readMetadata<{ plan: { actions: { checkpoint: { attemptId: string } }[] } }>(passKey(admitted.passId))!;
  ghost.plan.actions[0]!.checkpoint.attemptId = GHOST;
  f.store.writeMetadata(passKey(admitted.passId), ghost);
  const r = f.reopen(f.store);
  expect(r.policy.inspectPass("pass-garbage")).toEqual({ passId: "pass-garbage", status: "malformed" });
  expect(r.policy.inspectPass("pass-foreign")).toEqual({ passId: "pass-foreign", status: "malformed" });
  expect(r.policy.inspectPass("pass-none")).toBeUndefined();
  expect(() => r.policy.start({ provenance: { ...started, passId: "pass-garbage" }, policy: policy() })).toThrow(/retained/);
  expect(() => r.policy.plan("pass-garbage", { reportRevision: REPORT, plannedAtMs: T0, actions: [] })).toThrow(/malformed/);
  expect(r.policy.admit("pass-garbage", 0, { current: current(started), account: account(), credit: credit() })).toEqual({ kind: "hold", reason: "unknown-pass" });
  // The unplanned pass from the previous process is interrupted; the ghost checkpoint is reported, never resolved.
  expect(r.policy.inspectPass(started.passId)).toMatchObject({ status: "closed", record: { closed: { reason: "restarted" } } });
  expect(r.policy.inspectPass(admitted.passId)).toMatchObject({ status: "closed", attempts: [{ attemptId: GHOST, state: "missing", live: false }] });
  // The orphaned real claim stays dispatching: nothing in this process may resolve it.
  expect(r.admissions.inspect(KEY_A)?.state).toBe("dispatching");
  expect(r.admissions.getAttempt(live.attemptId)?.state).toBe("dispatching");
  // The interrupted unplanned pass is reclaimable history; afterwards no retained row is (open pass, malformed rows, missing attempt).
  expect(r.policy.start({ provenance: f.provenance(), policy: policy() }).passId).toBe("pass-3");
  expect(r.policy.inspectPass(started.passId)).toBeUndefined();
  expect(() => r.policy.start({ provenance: f.provenance(), policy: policy() })).toThrow(/full/);
  expect(r.policy.inspectPass(admitted.passId)?.status).toBe("closed");
  expect(r.policy.inspectPass("pass-garbage")?.status).toBe("malformed");
});

test("failed pass checkpoint writes roll back the whole admission and leave no claim", async () => {
  const f = await fixture();
  const p1 = f.planned(f.policy);
  const revision = f.admissions.revision();
  const restore = f.failWrites(f.store, passKey(p1.passId));
  expect(() => f.admit(f.policy, p1)).toThrow(/fixture/);
  restore();
  expect(f.admissions.revision()).toBe(revision);
  expect(f.admissions.inspect(KEY_A)).toBeUndefined();
  expect(f.admissions.listAttempts()).toEqual([]);
  expect(f.policy.inspectPass(p1.passId)).toMatchObject({ status: "planned", attempts: [] });
  expect(await f.policy.drain()).toEqual([]);
  const admitted = f.execute(f.admit(f.policy, p1));
  const r = f.reopen(f.store);
  expect(r.admissions.getAttempt(admitted.attemptId)?.state).toBe("unknown");
});

test("failed completion keeps the observed reset in the receipt while durable authority stays unknown", async () => {
  const f = await fixture();
  const p1 = f.planned(f.policy), p2 = f.planned(f.policy);
  const origin = f.execute(f.admit(f.policy, p1));
  const joined = f.admit(f.policy, p2);
  expect(joined.kind).toBe("join");
  // First pass write fails (completion transaction); the conservative unknown marker afterwards succeeds.
  const restore = f.failWrites(f.store, passKey(p1.passId), 1);
  expect(() => f.policy.complete(origin.attemptId, executor(p1), RESET)).toThrow(/fixture/);
  restore();
  const receipt = await origin.settlement;
  expect(receipt).toMatchObject({ persistence: "failed", authority: "unknown", observed: "reset", reason: "settlement-failed", observation: RESET });
  expect(await (joined as { settlement: Promise<unknown> }).settlement).toBe(receipt);
  expect(f.admissions.getAttempt(origin.attemptId)).toMatchObject({ state: "unknown", unknownReason: "settlement-failed", observation: RESET });
  expect(f.policy.inspectPass(p1.passId)).toMatchObject({ attempts: [{ state: "unknown", unknownReason: "settlement-failed", observed: "reset", live: false, completion: { persistence: "failed", observation: RESET } }] });
  expect(() => f.policy.complete(origin.attemptId, executor(p1), RESET)).toThrow(/different/);
  expect(f.admit(f.policy, f.planned(f.policy))).toEqual({ kind: "hold", reason: "fenced" });
  const r = f.reopen(f.store);
  expect(r.admissions.inspect(KEY_A)?.state).toBe("unknown");
  expect(r.policy.inspectPass(p1.passId)).toMatchObject({ status: "closed", attempts: [{ state: "unknown", observed: "reset" }] });
  // Storage wholly unavailable for the marker: the prior dispatching fence is retained, the receipt is still failed/unknown.
  const p3 = f.planned(r.policy, [{ native: nativeB, account: accountB }]);
  const b = r.policy.admit(p3.passId, 0, { current: current(p3), account: accountB, credit: credit({ id: "credit-b", fingerprint: hex("b") }) });
  if (b.kind !== "execute") throw new Error("expected execute");
  const restoreAll = f.failWrites(r.store, passKey(p3.passId));
  expect(() => r.policy.complete(b.attemptId, executor(p3), RESET)).toThrow(/fixture/);
  restoreAll();
  expect(await b.settlement).toMatchObject({ persistence: "failed", authority: "unknown", observed: "reset" });
  expect(r.admissions.getAttempt(b.attemptId)?.state).toBe("dispatching");
  expect(r.policy.inspectAttempt(b.attemptId)).toMatchObject({ state: "dispatching", live: false, observed: "reset" });
  const r2 = f.reopen(r.store);
  expect(r2.admissions.getAttempt(b.attemptId)).toMatchObject({ state: "unknown", unknownReason: "restarted" });
});

test("worker loss fences durable authority and interrupts decisions but only the original completion resolves the settlement", async () => {
  const f = await fixture();
  const p1 = f.planned(f.policy);
  const p2 = f.planned(f.policy, [{ native: nativeB, account: accountB }], { workerEpoch: "epoch-2" });
  const asked = f.planned(f.policy, [{ native: native(), account: account() }], {}, "unset");
  f.policy.requestDecision(asked.passId);
  const a = f.execute(f.admit(f.policy, p1));
  const b = f.execute(f.admit(f.policy, p2, 0, { account: accountB, credit: credit({ id: "credit-b", fingerprint: hex("b") }) }));
  expect(f.policy.workerLost("epoch-1")).toEqual({ attempts: [a.attemptId], passes: [p1.passId, asked.passId] });
  expect(f.admissions.getAttempt(a.attemptId)).toMatchObject({ state: "unknown", unknownReason: "worker-lost" });
  expect(f.policy.inspectAttempt(a.attemptId)).toMatchObject({ state: "unknown", live: true, fenced: "worker-lost", passId: p1.passId });
  expect(await pending(a.settlement)).toBe(true);
  expect(f.admissions.getAttempt(b.attemptId)?.state).toBe("dispatching");
  expect(f.policy.inspectPass(p2.passId)?.status).toBe("planned");
  expect(f.policy.inspectPass(asked.passId)).toMatchObject({ status: "closed", record: { closed: { reason: "worker-lost" }, decision: { state: "pending" } } });
  expect(() => f.policy.answer(asked.passId, "Yes")).toThrow(/closed/);
  expect(f.policy.workerLost("epoch-1")).toEqual({ attempts: [], passes: [] });
  // finish() records native state only; the settlement is still owned by the executor's observation.
  f.policy.finish(p1.passId, { state: "failed", refresh: "failed", applied: 0, attemptIds: [] });
  expect(await pending(a.settlement)).toBe(true);
  const late = f.policy.complete(a.attemptId, executor(p1), RESET);
  expect(late).toMatchObject({ persistence: "durable", authority: "unknown", observed: "reset", reason: "worker-lost" });
  expect(await a.settlement).toBe(late);
  expect(f.admissions.getAttempt(a.attemptId)).toMatchObject({ state: "unknown", unknownReason: "worker-lost", observation: RESET });
  expect(f.admissions.inspect(KEY_A)?.state).toBe("unknown");
  f.policy.complete(b.attemptId, executor(p2), RESET);
  expect(f.admissions.inspect(KEY_B)?.state).toBe("settled");
});

test("reopen marks admitted work unknown without reconstructing promises and interrupts unadmitted passes", async () => {
  const f = await fixture();
  const p1 = f.planned(f.policy), p2 = f.planned(f.policy, [{ native: nativeB, account: accountB }]);
  const a = f.execute(f.admit(f.policy, p1));
  const r = f.reopen(f.store);
  expect(r.admissions.getAttempt(a.attemptId)).toMatchObject({ state: "unknown", unknownReason: "restarted", evidence: { provenance: p1 } });
  expect(r.policy.inspectAttempt(a.attemptId)).toMatchObject({ state: "unknown", live: false, provenance: p1, passId: p1.passId });
  expect(r.policy.inspectPass(p1.passId)).toMatchObject({ status: "closed", record: { closed: { reason: "restarted" } }, attempts: [{ state: "unknown", unknownReason: "restarted", fence: { reason: "restarted" } }] });
  expect(() => r.policy.complete(a.attemptId, executor(p1), RESET)).toThrow(/No live/);
  expect(r.policy.inspectPass(p2.passId)).toMatchObject({ status: "closed", attempts: [] });
  expect(r.policy.admit(p2.passId, 0, { current: current(p2), account: accountB, credit: credit() })).toEqual({ kind: "hold", reason: "closed" });
  expect(await r.policy.drain()).toEqual([]);
  // The account stays fenced for every later pass until a manual operator resolves it.
  const later = f.planned(r.policy);
  expect(r.policy.admit(later.passId, 0, { current: current(later), account: account(), credit: credit() })).toEqual({ kind: "hold", reason: "fenced" });
  const r2 = f.reopen(r.store);
  expect(r2.admissions.getAttempt(a.attemptId)).toMatchObject({ state: "unknown", unknownReason: "restarted" });
});

test("disposal bars new work and drains only actual completions", async () => {
  const f = await fixture();
  const p1 = f.planned(f.policy), p2 = f.planned(f.policy, [{ native: nativeB, account: accountB }]);
  const a = f.execute(f.admit(f.policy, p1));
  f.policy.beginDispose();
  expect(f.policy.disposing).toBe(true);
  expect(() => f.policy.start({ provenance: f.provenance(), policy: policy() })).toThrow(/disposing/);
  expect(() => f.policy.plan(p2.passId, { reportRevision: REPORT, plannedAtMs: T0, actions: [] })).toThrow(/disposing/);
  expect(f.policy.requestDecision(p2.passId)).toBe(false);
  expect(f.policy.admit(p2.passId, 0, { current: current(p2), account: accountB, credit: credit() })).toEqual({ kind: "hold", reason: "disposing" });
  expect(f.admissions.inspect(KEY_B)).toBeUndefined();
  const drained = f.policy.drain();
  expect(await pending(drained)).toBe(true);
  f.policy.finish(p1.passId, { state: "settled", refresh: "not-needed", applied: 1, attemptIds: ["blocked:acct-a:28333333"] });
  expect(await pending(drained)).toBe(true);
  const completion = f.policy.complete(a.attemptId, executor(p1), RESET);
  expect(await drained).toEqual([completion]);
  expect(await f.policy.drain()).toEqual([]);
});

test("pass history is bounded by reclaiming resolved passes behind a retired-start floor, never by evicting pending work", async () => {
  const f = await fixture({ maxPasses: 2 });
  const p1 = f.planned(f.policy), p2 = f.planned(f.policy, [{ native: nativeB, account: accountB }]);
  const a = f.execute(f.admit(f.policy, p1));
  f.policy.complete(a.attemptId, executor(p1), RESET);
  f.policy.finish(p1.passId, { state: "settled", refresh: "complete", applied: 1, attemptIds: ["blocked:acct-a:28333333"] });
  // p2 is neither finished nor closed and p1 alone frees one slot.
  const p3 = f.planned(f.policy);
  expect(f.policy.inspectPass(p1.passId)).toBeUndefined();
  expect(f.policy.inspectPass(p2.passId)?.status).toBe("planned");
  expect(() => f.policy.start({ provenance: p1, policy: policy() })).toThrow(/floor/);
  expect(() => f.policy.start({ provenance: f.provenance({ startedAtMs: p1.startedAtMs }), policy: policy() })).toThrow(/floor/);
  // Both retained passes are unresolved: no eviction, new work refused, records intact.
  const b = f.execute(f.admit(f.policy, p3));
  expect(() => f.policy.start({ provenance: f.provenance(), policy: policy() })).toThrow(/full/);
  expect(f.policy.inspectPass(p2.passId)?.status).toBe("planned");
  expect(f.policy.inspectPass(p3.passId)).toMatchObject({ attempts: [{ attemptId: b.attemptId, state: "dispatching", live: true }] });
  f.policy.finish(p3.passId, { state: "settled", refresh: "complete", applied: 1, attemptIds: ["blocked:acct-a:28333333"] });
  expect(() => f.policy.start({ provenance: f.provenance(), policy: policy() })).toThrow(/full/);
  f.policy.complete(b.attemptId, executor(p3), RESET);
  f.policy.finish(p2.passId, { state: "cancelled", refresh: "not-needed", applied: 0, attemptIds: [] });
  const p4 = f.planned(f.policy);
  expect(f.policy.inspectPass(p2.passId)).toBeUndefined();
  expect(f.policy.inspectPass(p3.passId)?.status).toBe("finished");
  const r = f.reopen(f.store);
  expect(r.policy.inspectPass(p4.passId)?.status).toBe("closed");
  expect(() => r.policy.start({ provenance: f.provenance({ startedAtMs: p2.startedAtMs }), policy: policy() })).toThrow(/floor/);
  expect(r.policy.start({ provenance: f.provenance(), policy: policy() }).passId).toBeDefined();
});

test("duplicate pass starts return the retained record and never replace provenance or replay decisions", async () => {
  const f = await fixture();
  const p = f.planned(f.policy, [{ native: native(), account: account() }], {}, "unset");
  const retained = f.policy.start({ provenance: p, policy: policy("unset") });
  expect(retained.plan?.actions[0]).toMatchObject({ key: KEY_A, nativeAttemptKey: "blocked:acct-a:28333333" });
  expect(() => f.policy.start({ provenance: { ...p, cwd: "/tmp/elsewhere" }, policy: policy("unset") })).toThrow(/retained/);
  expect(() => f.policy.start({ provenance: p, policy: policy("yes") })).toThrow(/retained/);
  expect(() => f.policy.plan(p.passId, { reportRevision: REPORT, plannedAtMs: T0, actions: [] })).toThrow(/already planned/);
  f.policy.requestDecision(p.passId);
  f.policy.answer(p.passId, "Yes");
  expect(f.policy.start({ provenance: p, policy: policy("unset") }).decision).toMatchObject({ answer: "Yes" });
  expect(f.policy.requestDecision(p.passId)).toBe(false);
  expect(() => f.policy.start({ provenance: { ...p, hostId: "other-host" }, policy: policy() })).toThrow(/host/);
  expect(() => f.policy.start({ provenance: { ...p, passId: "bad id!" }, policy: policy() })).toThrow(/pass id/);
});

test("a complete 128-action plan is retained whole across reopen while 129 actions durably reject the pass without dispatch", async () => {
  const f = await fixture();
  const fleet = (count: number) => Array.from({ length: count }, (_, i) => ({
    native: native({ target: { credentialId: 100 + i, accountId: `acct-${i}` }, accountKey: `acct-${i}`, attemptKey: `blocked:acct-${i}:1`, label: `user${i}@fixture.invalid`, active: i === 0 }),
    account: account({ accountId: `acct-${i}`, email: `user${i}@fixture.invalid`, credentialId: 100 + i, credentialFingerprint: i.toString(16).padStart(64, "0") }),
  }));
  expect(NATIVE_RESET_MAX_ACTIONS).toBe(128);
  const full = f.provenance();
  f.policy.start({ provenance: full, policy: policy() });
  const planned = f.policy.plan(full.passId, { reportRevision: REPORT, plannedAtMs: full.startedAtMs + 10, actions: fleet(128) });
  expect(planned.plan?.actions.length).toBe(128);
  expect(planned.plan?.actions[127]).toMatchObject({ index: 127, key: nativeResetAccountKey(fleet(128)[127]!.account), nativeAttemptKey: "blocked:acct-127:1" });
  const last = fleet(128)[127]!;
  const admitted = f.admit(f.policy, full, 127, { account: last.account, credit: credit({ id: "credit-127", fingerprint: hex("1") }) });
  expect(admitted.kind).toBe("execute");
  const over = f.provenance();
  f.policy.start({ provenance: over, policy: policy() });
  expect(() => f.policy.plan(over.passId, { reportRevision: REPORT, plannedAtMs: over.startedAtMs + 10, actions: fleet(129) })).toThrow(/exceeds 128/);
  expect(f.policy.inspectPass(over.passId)).toMatchObject({ status: "closed", record: { closed: { reason: "oversized" } }, attempts: [] });
  expect(() => f.policy.plan(over.passId, { reportRevision: REPORT, plannedAtMs: over.startedAtMs + 10, actions: fleet(128) })).toThrow(/closed/);
  expect(f.policy.requestDecision(over.passId)).toBe(false);
  expect(f.admit(f.policy, over, 0, { account: fleet(1)[0]!.account, credit: credit() })).toEqual({ kind: "hold", reason: "closed" });
  expect(f.admissions.inspect(nativeResetAccountKey(fleet(1)[0]!.account))).toBeUndefined();
  const r = f.reopen(f.store);
  const retained = r.policy.inspectPass(full.passId);
  if (retained?.status !== "closed") throw new Error("expected the full pass to be interrupted, not truncated");
  expect(retained.record.plan?.actions.length).toBe(128);
  expect(retained.attempts).toEqual([expect.objectContaining({ index: 127, state: "unknown", unknownReason: "restarted" })]);
  expect(r.policy.inspectPass(over.passId)).toMatchObject({ status: "closed", record: { closed: { reason: "oversized" } } });
});

test("native same-session joins are retained against their original pass without any claim, consent or plan of their own", async () => {
  const f = await fixture();
  const original = f.planned(f.policy);
  const running = f.execute(f.admit(f.policy, original));
  const joinedProvenance = f.provenance({ sessionId: original.sessionId, nativeSessionId: original.nativeSessionId, trigger: "sweep", source: "background" });
  const joined = f.policy.joined({ provenance: joinedProvenance, policy: policy() }, original.passId);
  expect(joined).toMatchObject({ passId: joinedProvenance.passId, joinedToPassId: original.passId, decision: { state: "none" } });
  expect(joined.plan).toBeUndefined();
  expect(f.policy.inspectPass(joined.passId)).toMatchObject({ status: "joined", attempts: [] });
  // Idempotent retention; a different original or provenance is refused.
  expect(f.policy.joined({ provenance: joinedProvenance, policy: policy() }, original.passId)).toEqual(joined);
  expect(() => f.policy.joined({ provenance: joinedProvenance, policy: policy() }, "pass-none")).toThrow(/retained/);
  expect(() => f.policy.start({ provenance: joinedProvenance, policy: policy() })).toThrow(/retained/);
  expect(() => f.policy.joined({ provenance: f.provenance(), policy: policy() }, "pass-none")).toThrow(/original/);
  expect(() => f.policy.joined({ provenance: f.provenance({ sessionId: "session-elsewhere" }), policy: policy() }, original.passId)).toThrow(/session identity/);
  expect(() => f.policy.joined({ provenance: f.provenance({ sessionId: original.sessionId, workerEpoch: "epoch-2" }), policy: policy() }, original.passId)).toThrow(/session identity/);
  expect(() => f.policy.joined({ provenance: f.provenance({ sessionId: original.sessionId }), policy: policy() }, joined.passId)).toThrow(/original/);
  expect(() => f.policy.joined({ provenance: { ...joinedProvenance, passId: "pass-self" }, policy: policy() }, "pass-self")).toThrow(/itself/);
  // The joined pass owns nothing: no plan, decision or admission; only its native finish is recorded.
  expect(() => f.policy.plan(joined.passId, { reportRevision: REPORT, plannedAtMs: T0, actions: [{ native: native(), account: account() }] })).toThrow(/joined/);
  expect(f.policy.requestDecision(joined.passId)).toBe(false);
  expect(f.admit(f.policy, joinedProvenance)).toEqual({ kind: "hold", reason: "unplanned" });
  expect(f.admissions.listAttempts().map(attempt => attempt.id)).toEqual([running.attemptId]);
  expect(await pending(running.settlement)).toBe(true);
  f.policy.finish(joined.passId, { state: "settled", refresh: "complete", applied: 1, attemptIds: ["blocked:acct-a:28333333"] });
  expect(f.policy.inspectPass(joined.passId)).toMatchObject({ status: "finished", record: { joinedToPassId: original.passId, finish: { applied: 1 } } });
  expect(await pending(running.settlement)).toBe(true);
  // Settlement counters are bounded projections, never consume truth.
  const another = f.provenance({ sessionId: original.sessionId, nativeSessionId: original.nativeSessionId });
  f.policy.joined({ provenance: another, policy: policy() }, original.passId);
  expect(() => f.policy.finish(another.passId, { state: "settled", refresh: "complete", applied: -1, attemptIds: [] })).toThrow(/applied/);
  expect(() => f.policy.finish(another.passId, { state: "settled", refresh: "complete", applied: 0, attemptIds: Array.from({ length: NATIVE_RESET_MAX_ACTIONS + 1 }, (_, i) => `k${i}`) })).toThrow(/attempt list/);
  expect(() => f.policy.finish(another.passId, { state: "settled", refresh: "complete", applied: 5, attemptIds: ["bad\u0000id"] })).toThrow(/attempt id/);
  f.policy.finish(another.passId, { state: "held", refresh: "not-needed", applied: 5, attemptIds: [] });
  expect(f.admissions.inspect(KEY_A)?.state).toBe("dispatching");
  const r = f.reopen(f.store);
  expect(r.policy.inspectPass(joined.passId)).toMatchObject({ status: "finished", record: { joinedToPassId: original.passId, finish: { state: "settled", applied: 1, attemptIds: ["blocked:acct-a:28333333"] } } });
  expect(r.policy.inspectPass(original.passId)).toMatchObject({ status: "closed", attempts: [{ state: "unknown", unknownReason: "restarted" }] });
});

test("unverified Yes cannot become standing consent on a later pass or reopen", async () => {
  const f = await fixture({ maxPasses: 2 });
  const original = f.planned(f.policy, undefined, {}, "unset");
  expect(f.policy.requestDecision(original.passId)).toBe(true);
  f.policy.answer(original.passId, "Yes");
  f.policy.persistence(original.passId, { status: "failed" });
  f.policy.finish(original.passId, { state: "failed", refresh: "not-needed", applied: 0, attemptIds: [] });
  const sameSession = { sessionId: original.sessionId, nativeSessionId: original.nativeSessionId };
  const lingering = f.planned(f.policy, undefined, sameSession);
  expect(f.admit(f.policy, lingering)).toEqual({ kind: "hold", reason: "persistence-hold" });
  const reopened = f.reopen(f.store);
  const fresh = f.planned(reopened.policy, undefined, { ...sameSession, workerEpoch: "replacement-epoch" });
  expect(f.admit(reopened.policy, fresh)).toEqual({ kind: "hold", reason: "persistence-hold" });
  reopened.policy.persistence(fresh.passId, {
    status: "verified", globalMode: "yes", effectivePolicy: policy(), layersUnchanged: true,
    policyRevision: "verified-policy-revision",
  });
  const currentRevision = { ...current(fresh), policyRevision: "verified-policy-revision" };
  const admitted = f.execute(f.admit(reopened.policy, fresh, 0, { current: currentRevision }));
  expect(reopened.policy.inspectAttempt(admitted.attemptId).provenance?.policyRevision).toBe("policy-1");
  expect(reopened.policy.inspectPass(original.passId)).toMatchObject({ record: { persistence: { status: "failed" } } });
});

test("a damaged retained plan cannot move a fenced account onto another collision key", async () => {
  const f = await fixture(), p = f.planned(f.policy);
  f.admissions.admit({ key: KEY_A, operationId: "uncertain-manual" });
  f.admissions.settle(KEY_A, "uncertain-manual", "unknown");
  const retained = f.store.readMetadata<ReturnType<NativeResetPolicy["start"]>>(passKey(p.passId))!;
  retained.plan!.actions[0]!.key = KEY_B;
  f.store.writeMetadata(passKey(p.passId), retained);
  expect(f.admit(f.policy, p).kind).toBe("hold");
  expect(f.admissions.inspect(KEY_A)?.state).toBe("unknown");
  expect(f.admissions.inspect(KEY_B)).toBeUndefined();
  const reopened = f.reopen(f.store);
  expect(reopened.policy.inspectPass(p.passId)?.status).toBe("malformed");
  expect(f.admit(reopened.policy, p).kind).toBe("hold");
});

test("confirmed worker exit terminates only that worker's live accounting without inventing a native observation", async () => {
  const f = await fixture(), origin = f.planned(f.policy), follower = f.planned(f.policy);
  const independent = f.planned(f.policy, [{ native: nativeB, account: accountB }], { workerEpoch: "epoch-2" });
  const a = f.execute(f.admit(f.policy, origin)), joined = f.admit(f.policy, follower);
  if (joined.kind !== "join") throw new Error("expected original join");
  const b = f.execute(f.admit(f.policy, independent, 0, { account: accountB }));
  f.policy.beginDispose();
  const draining = f.policy.drain();
  f.policy.workerLost("epoch-1");
  expect(await pending(a.settlement)).toBe(true);
  expect(await pending(draining)).toBe(true);
  const exited = f.policy.workerExited("epoch-1");
  expect(exited).toHaveLength(1);
  expect(exited[0]).toMatchObject({ attemptId: a.attemptId, terminal: "worker-exit", persistence: "durable", authority: "unknown", observed: "unknown" });
  expect(exited[0]!.observation).toBeUndefined();
  expect(await a.settlement).toBe(exited[0]);
  expect(await joined.settlement).toBe(exited[0]);
  expect(f.policy.workerExited("epoch-1")).toEqual(exited);
  expect(f.admissions.getAttempt(a.attemptId)?.observation).toBeUndefined();
  expect(await pending(b.settlement)).toBe(true);
  expect(await pending(draining)).toBe(true);
  const actual = f.policy.complete(b.attemptId, executor(independent), RESET);
  expect(actual).toMatchObject({ terminal: "native-completion", observed: "reset", authority: "settled" });
  expect(await draining).toEqual([exited[0]!, actual]);
  const reopened = f.reopen(f.store);
  expect(reopened.policy.inspectPass(origin.passId)).toMatchObject({ attempts: [{ state: "unknown", observed: "unknown", live: false, completion: { terminal: "worker-exit" } }] });
  expect(reopened.admissions.getAttempt(a.attemptId)?.observation).toBeUndefined();
  const later = f.planned(reopened.policy);
  expect(f.admit(reopened.policy, later)).toEqual({ kind: "hold", reason: "fenced" });
});

test("confirmed exit still releases live waiters when storage cannot acknowledge terminal accounting", async () => {
  const f = await fixture(), p = f.planned(f.policy);
  const admitted = f.execute(f.admit(f.policy, p));
  const restore = f.failWrites(f.store, `reset-admission.v1:account:${KEY_A}`);
  const draining = f.policy.drain();
  const [terminal] = f.policy.workerExited(p.workerEpoch);
  restore();
  expect(terminal).toMatchObject({ terminal: "worker-exit", persistence: "failed", authority: "unknown", observed: "unknown" });
  expect(terminal!.observation).toBeUndefined();
  expect(await admitted.settlement).toBe(terminal);
  expect(await draining).toEqual([terminal!]);
  expect(f.admissions.getAttempt(admitted.attemptId)?.state).toBe("dispatching");
  expect(f.admissions.getAttempt(admitted.attemptId)?.observation).toBeUndefined();
  const reopened = f.reopen(f.store);
  expect(reopened.admissions.inspect(KEY_A)?.state).toBe("unknown");
  expect(reopened.admissions.getAttempt(admitted.attemptId)?.observation).toBeUndefined();
});

test("origin start carries no future report claim and plan seals one strict digest exactly once", async () => {
  const f = await fixture();
  const p = f.provenance();
  expect("reportRevision" in p).toBe(false);
  const started = f.policy.start({ provenance: p, policy: policy("yes") });
  expect("reportRevision" in started.provenance).toBe(false);
  expect(() => f.policy.start({ provenance: { ...f.provenance(), reportRevision: REPORT } as NativeResetProvenance, policy: policy("yes") })).toThrow(/cannot claim/);
  expect(() => f.policy.plan(p.passId, { reportRevision: "A".repeat(64), plannedAtMs: p.startedAtMs + 1, actions: [] })).toThrow(/report revision/);
  expect(() => f.policy.plan(p.passId, { reportRevision: "", plannedAtMs: p.startedAtMs + 1, actions: [] })).toThrow(/report revision/);
  const sealed = f.policy.plan(p.passId, { reportRevision: REPORT, plannedAtMs: p.startedAtMs + 1, actions: [] });
  expect(sealed.plan?.reportRevision).toBe(REPORT);
  expect(() => f.policy.plan(p.passId, { reportRevision: "b".repeat(64), plannedAtMs: p.startedAtMs + 2, actions: [] })).toThrow(/already planned/);
});

test("plan writes its report revision and complete plan atomically", async () => {
  const f = await fixture();
  const p = f.provenance();
  f.policy.start({ provenance: p, policy: policy("yes") });
  const restore = f.failWrites(f.store, `native-reset-policy.v1:pass:${p.passId}`, 1);
  expect(() => f.policy.plan(p.passId, { reportRevision: REPORT, plannedAtMs: p.startedAtMs + 1, actions: [{ native: native(), account: account() }] })).toThrow(/fixture write failure/);
  restore();
  const afterFailure = f.policy.inspectPass(p.passId);
  expect(afterFailure?.status).toBe("started");
  if (!afterFailure || afterFailure.status !== "started") throw new Error("missing pass");
  expect(afterFailure.record.plan).toBeUndefined();
  const sealed = f.policy.plan(p.passId, { reportRevision: REPORT, plannedAtMs: p.startedAtMs + 1, actions: [{ native: native(), account: account() }] });
  expect(sealed.plan).toMatchObject({ reportRevision: REPORT, actions: [{ index: 0 }] });
});

test("sparse and malformed plans reject before mutating the durable pass and reopen remains valid", async () => {
  const f = await fixture();
  const p = f.provenance();
  f.policy.start({ provenance: p, policy: policy("yes") });
  const key = `native-reset-policy.v1:pass:${p.passId}`;
  const before = f.store.readMetadata<unknown>(key);
  expect(() => f.policy.plan(p.passId, { reportRevision: REPORT, plannedAtMs: p.startedAtMs + 1,
    actions: new Array(1) as { native: CodexResetAction; account: NativeResetAccountEvidence }[] })).toThrow(/every action index/);
  expect(f.store.readMetadata<unknown>(key)).toEqual(before);
  expect(() => f.policy.plan(p.passId, { reportRevision: REPORT, plannedAtMs: p.startedAtMs + 1,
    actions: [{ native: { ...native(), target: null } as unknown as CodexResetAction, account: account() }] })).toThrow(/action target/);
  expect(f.store.readMetadata<unknown>(key)).toEqual(before);
  const reopened = f.reopen(f.store);
  const inspected = reopened.policy.inspectPass(p.passId);
  expect(inspected?.status).toBe("closed");
  if (!inspected || inspected.status !== "closed") throw new Error("reopened pass was not valid");
  expect(inspected.record.closed?.reason).toBe("restarted");
  expect(inspected.record.plan).toBeUndefined();
});

test("sealed report revision survives reopen and is copied into the unchanged canonical attempt evidence", async () => {
  const f = await fixture();
  const p = f.planned(f.policy);
  const admitted = f.execute(f.admit(f.policy, p));
  const attempt = f.admissions.getAttempt(admitted.attemptId);
  expect(attempt?.kind).toBe("automatic");
  if (!attempt || attempt.kind !== "automatic") throw new Error("missing automatic attempt");
  expect(attempt.evidence.provenance.reportRevision).toBe(REPORT);
  expect(f.policy.inspectPass(p.passId)).toMatchObject({ record: { version: 2, provenance: { passId: p.passId }, plan: { reportRevision: REPORT } } });
  f.policy.workerExited(p.workerEpoch);
  const reopened = f.reopen(f.store);
  expect(reopened.policy.inspectPass(p.passId)).toMatchObject({ record: { plan: { reportRevision: REPORT } } });
  const reopenedAttempt = reopened.admissions.getAttempt(admitted.attemptId);
  expect(reopenedAttempt?.kind).toBe("automatic");
  if (!reopenedAttempt || reopenedAttempt.kind !== "automatic") throw new Error("missing reopened automatic attempt");
  expect(reopenedAttempt.evidence).toEqual(attempt.evidence);
  expect(reopenedAttempt.evidenceHash).toBe(attempt.evidenceHash);
});

test("exact v1 rows remain raw legacy history, fence old dispatches, and consume capacity without gaining a sealed report", async () => {
  const f = await fixture({ maxPasses: 1 });
  const p = f.planned(f.policy);
  const admitted = f.execute(f.admit(f.policy, p));
  const key = `native-reset-policy.v1:pass:${p.passId}`;
  const rawCurrent = f.store.readMetadata<Record<string, unknown>>(key)!;
  const currentPlan = rawCurrent.plan as Record<string, unknown>;
  const legacy = { ...rawCurrent, version: 1, provenance: { ...(rawCurrent.provenance as object), reportRevision: "c64-start-report" },
    plan: { plannedAtMs: currentPlan.plannedAtMs, actions: currentPlan.actions } };
  f.store.writeMetadata(key, legacy);
  const rawBefore = f.store.readMetadata<unknown>(key);
  const reopened = f.reopen(f.store);
  expect(reopened.policy.inspectPass(p.passId)).toEqual({ passId: p.passId, status: "legacy" });
  expect(reopened.store.readMetadata<unknown>(key)).toEqual(rawBefore);
  expect(reopened.admissions.getAttempt(admitted.attemptId)).toMatchObject({ state: "unknown", unknownReason: "restarted" });
  expect(() => reopened.policy.start({ provenance: f.provenance(), policy: policy("yes") })).toThrow(/full/);
  expect(reopened.policy.admit(p.passId, 0, { current: current(p), account: account(), credit: credit() })).toEqual({ kind: "hold", reason: "unknown-pass" });
});
