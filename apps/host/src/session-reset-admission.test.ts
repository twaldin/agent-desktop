import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HostStore } from "./store";
import { classifyResetObservation, ResetAccountAdmissions, sanitizeResetObservation, type ResetAdmissionAttempt, type ResetAttemptObservation, type ResetAutomaticEvidence } from "./session-reset-admission";
const directories: string[] = [], stores: HostStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64), D = "d".repeat(64);
const accountKey = (key: string) => `reset-admission.v1:account:${key}`;
const attemptKey = (id: string) => `reset-admission.v1:attempt:${id}`;
const evidence = (hostId: string, overrides: Partial<ResetAutomaticEvidence> = {}): ResetAutomaticEvidence => ({
  provenance: { hostId, sessionId: "session", sessionFile: "/tmp/session.jsonl", cwd: "/tmp", workerEpoch: "epoch", nativeSessionId: "native", passId: "pass-1",
    trigger: "blocked", source: "background", startedAtMs: 1_000, provider: "openai-codex", modelId: "gpt", reportRevision: "r1", selectionRevision: "s1", policyRevision: "p1" },
  policy: { autoRedeem: "yes", minBlockedMinutes: 30, keepCredits: 1, salvageHorizonHours: 24 },
  action: { index: 0, reason: "blocked-account", nativeAttemptKey: "attempt-key", plannedAtMs: 2_000, blockedUntilMs: 5_000 },
  account: { provider: "openai-codex", accountId: "acct", credentialId: 3, credentialFingerprint: "1".repeat(64), authAuthority: "https://auth.example" },
  credit: { id: "credit-1", status: "available", fingerprint: "2".repeat(64) },
  compatibilityHash: "3".repeat(64), redeemRequestId: "11111111-1111-4111-8111-111111111111", ...overrides,
});
const passed = (code: string, ok = code === "reset"): ResetAttemptObservation => ({ consumeBoundary: "passed", result: { kind: "outcome", code: code as never, ok } });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "reset-admission-")); directories.push(dir);
  const open = () => { const store = new HostStore(dir); stores.push(store); return store; };
  const store = open();
  /** Simulate a host restart: the same SQLite file behind a fresh store and authority. */
  const reopen = (current: HostStore) => { current.close(); stores.splice(stores.indexOf(current), 1); const next = open(); return { store: next, admissions: new ResetAccountAdmissions(next) }; };
  const failWrites = (target: HostStore, key: string) => {
    const write = target.writeMetadata.bind(target);
    target.writeMetadata = (k, value) => { if (k === key) throw new Error("fixture write failure"); write(k, value); };
    return () => { target.writeMetadata = write; };
  };
  /** A real SQLite failure: triggers abort any insert/update of matching metadata keys until dropped. */
  const failSqlite = (pattern: string) => {
    const run = (sql: string) => { const db = new Database(path.join(dir, "state.sqlite")); db.exec(sql); db.close(); };
    run(`CREATE TRIGGER fixture_insert BEFORE INSERT ON metadata WHEN NEW.key LIKE '${pattern}' BEGIN SELECT RAISE(ABORT, 'fixture sqlite failure'); END;
         CREATE TRIGGER fixture_update BEFORE UPDATE ON metadata WHEN NEW.key LIKE '${pattern}' BEGIN SELECT RAISE(ABORT, 'fixture sqlite failure'); END;`);
    return () => run("DROP TRIGGER fixture_insert; DROP TRIGGER fixture_update;");
  };
  return { store, admissions: new ResetAccountAdmissions(store), reopen, failWrites, failSqlite, evidence: (overrides?: Partial<ResetAutomaticEvidence>) => evidence(store.host.id, overrides) };
}
test("independent accounts claim, settle and re-admit without touching each other's fence", async () => {
  const { admissions } = await fixture();
  const first = admissions.admit({ key: A, operationId: "op-a" });
  const second = admissions.admit({ key: B, operationId: "op-b" });
  expect(admissions.inspect(A)).toMatchObject({ generation: first.generation, operationId: "op-a", state: "dispatching", kind: "manual", attemptId: first.attemptId });
  expect(admissions.inspect(B)).toMatchObject({ generation: second.generation, operationId: "op-b", state: "dispatching" });
  // Settling one operation binds to its own account; a neighbour's identity cannot settle it.
  expect(() => admissions.settle(A, "op-b", "settled")).toThrow();
  admissions.settle(A, "op-a", "settled");
  expect(admissions.inspect(B)?.state).toBe("dispatching");
  expect(() => admissions.admit({ key: B, expectedGeneration: second.generation, operationId: "op-b-again" })).toThrow();
  admissions.settle(B, "op-b", "unknown");
  expect(admissions.inspect(A)).toMatchObject({ generation: first.generation, operationId: "op-a", state: "settled" });
  const next = admissions.admit({ key: A, expectedGeneration: first.generation, operationId: "op-a-next" });
  expect(next.generation).not.toBe(first.generation);
  expect(admissions.inspect(B)?.state).toBe("unknown");
  // Canonical attempts stay distinct per admission and mirror their account's state.
  expect(admissions.getAttempt(first.attemptId!)).toMatchObject({ kind: "manual", key: A, state: "settled", generation: first.generation });
  expect(admissions.getAttempt(next.attemptId!)).toMatchObject({ kind: "manual", key: A, state: "dispatching", generation: next.generation });
  expect(admissions.getAttempt(second.attemptId!)?.state).toBe("unknown");
  expect(admissions.listAttempts().map(attempt => attempt.id).sort()).toEqual([first.attemptId!, second.attemptId!, next.attemptId!].sort());
});
test("two authority instances over one store share exclusion, revision and settlement identity", async () => {
  const { store, admissions: manual } = await fixture();
  const automatic = new ResetAccountAdmissions(store);
  const captured = automatic.revision();
  const record = manual.admit({ key: A, operationId: "manual" });
  expect(() => automatic.assertRevision(captured)).toThrow();
  expect(automatic.inspect(A)).toMatchObject({ generation: record.generation, operationId: "manual", state: "dispatching" });
  expect(() => automatic.admit({ key: A, operationId: "automatic" })).toThrow();
  expect(() => automatic.admit({ key: A, expectedGeneration: record.generation, operationId: "automatic" })).toThrow();
  expect(() => automatic.settle(A, "automatic", "settled")).toThrow();
  expect(automatic.inspect(A)?.state).toBe("dispatching");
  manual.settle(A, "manual", "settled");
  expect(() => automatic.admit({ key: A, operationId: "stale" })).toThrow();
  const fresh = automatic.admit({ key: A, expectedGeneration: record.generation, operationId: "automatic" });
  expect(manual.inspect(A)).toMatchObject({ generation: fresh.generation, operationId: "automatic", state: "dispatching" });
  expect(() => manual.admit({ key: A, expectedGeneration: fresh.generation, operationId: "manual-again" })).toThrow();
  // Owners must bind to the one existing authority's store object, not merely the same database file.
  const other = new HostStore(directories[0]!); stores.push(other);
  expect(() => automatic.assertStore(other)).toThrow();
  automatic.assertStore(store);
});
test("unfinished and unknown admissions survive reopen and never authorize a replacement", async () => {
  const f = await fixture();
  const dispatched = f.admissions.admit({ key: A, operationId: "op-a" });
  const lost = f.admissions.admit({ key: B, operationId: "op-b" });
  f.admissions.settle(B, "op-b", "unknown");
  const { admissions } = f.reopen(f.store);
  expect(admissions.inspect(A)).toMatchObject({ generation: dispatched.generation, operationId: "op-a", state: "dispatching" });
  expect(() => admissions.admit({ key: A, operationId: "restart" })).toThrow();
  expect(() => admissions.admit({ key: A, expectedGeneration: dispatched.generation, operationId: "restart" })).toThrow();
  expect(() => admissions.settle(A, "other", "unknown")).toThrow();
  expect(admissions.inspect(B)).toMatchObject({ generation: lost.generation, operationId: "op-b", state: "unknown" });
  expect(() => admissions.settle(B, "op-b", "settled")).toThrow();
  admissions.settle(B, "op-b", "unknown");
  expect(admissions.inspect(B)?.state).toBe("unknown");
  expect(() => admissions.admit({ key: B, expectedGeneration: lost.generation, operationId: "restart" })).toThrow();
  // A restart may only downgrade the unresolved dispatch to unknown, never resolve it.
  admissions.settle(A, "op-a", "unknown");
  expect(() => admissions.settle(A, "op-a", "settled")).toThrow();
  expect(admissions.inspect(A)?.state).toBe("unknown");
});
test("command-bound settlements stay unknown while their journal receipt is pending, failed or missing", async () => {
  const f = await fixture();
  const failed = f.admissions.admit({ key: A, operationId: "op-a", commandId: "answer-a" });
  const missing = f.admissions.admit({ key: B, operationId: "op-b", commandId: "answer-b" });
  const done = f.admissions.admit({ key: C, operationId: "op-c", commandId: "answer-c" });
  f.store.claimCommand("answer-a", "hash"); f.store.claimCommand("answer-c", "hash");
  f.admissions.settle(A, "op-a", "settled"); f.admissions.settle(B, "op-b", "settled"); f.admissions.settle(C, "op-c", "settled");
  expect(f.admissions.inspect(A)?.state).toBe("unknown");
  expect(f.admissions.inspect(B)?.state).toBe("unknown");
  expect(f.admissions.inspect(C)?.state).toBe("unknown");
  expect(f.admissions.getAttempt(missing.attemptId!)?.state).toBe("unknown");
  f.store.finishCommand("answer-a", "hash", { ok: false, commandId: "answer-a", error: { code: "OUTCOME_UNKNOWN", message: "Unsettled" } });
  f.store.finishCommand("answer-c", "hash", { ok: true, commandId: "answer-c" });
  // Repeating a settled settlement cannot lift a journal-derived unknown.
  f.admissions.settle(A, "op-a", "settled");
  const { admissions } = f.reopen(f.store);
  expect(admissions.inspect(A)?.state).toBe("unknown");
  expect(() => admissions.admit({ key: A, expectedGeneration: failed.generation, operationId: "replacement" })).toThrow();
  expect(admissions.inspect(B)?.state).toBe("unknown");
  expect(() => admissions.admit({ key: B, expectedGeneration: missing.generation, operationId: "replacement" })).toThrow();
  expect(admissions.inspect(C)).toMatchObject({ generation: done.generation, operationId: "op-c", state: "settled", commandId: "answer-c", kind: "manual" });
  expect(admissions.getAttempt(done.attemptId!)).toMatchObject({ state: "settled", commandId: "answer-c" });
  admissions.admit({ key: C, expectedGeneration: done.generation, operationId: "replacement" });
  // Journal-derived unknown history is never reclaimed as settled.
  admissions.pruneSettledAttempts();
  expect(admissions.getAttempt(failed.attemptId!)?.state).toBe("unknown");
  expect(admissions.getAttempt(missing.attemptId!)?.state).toBe("unknown");
});
test("malformed retained account records never authorize a spend", async () => {
  const f = await fixture();
  const cases: unknown[] = [
    { generation: "g", operationId: "op" },
    { generation: "g", operationId: "op", state: "resolved" },
    { generation: "g", operationId: "op", state: "settled", commandId: "never-claimed" },
    { version: 1, hostId: f.store.host.id, kind: "automatic", attemptId: "missing-attempt", generation: "g", operationId: "op", state: "settled" },
    { version: 1, hostId: "other-host", kind: "manual", attemptId: "11111111-1111-4111-8111-111111111111", generation: "g", operationId: "op", state: "settled" },
    "corrupt",
    42,
    "x".repeat(5_000),
  ];
  for (const record of cases) {
    f.store.writeMetadata(accountKey(A), record);
    expect(f.admissions.inspect(A)?.state).toBe("unknown");
    expect(() => f.admissions.admit({ key: A, operationId: "spend" })).toThrow();
    expect(() => f.admissions.admit({ key: A, expectedGeneration: "g", operationId: "spend" })).toThrow();
    expect(() => f.admissions.admitAutomatic({ key: A, expectedGeneration: "g", operationId: "pass-1", evidence: f.evidence() })).toThrow();
  }
  const { admissions } = f.reopen(f.store);
  expect(admissions.inspect(A)).toEqual({ state: "unknown", fence: "malformed" });
  expect(() => admissions.admit({ key: A, expectedGeneration: "g", operationId: "spend" })).toThrow();
  expect(() => admissions.inspect("not-a-native-account-key")).toThrow();
  expect(() => admissions.admit({ key: "not-a-native-account-key", operationId: "spend" })).toThrow();
});
test("partial retained records missing their identity are fenced instead of treated as settled", async () => {
  const f = await fixture();
  f.store.writeMetadata(accountKey(A), { operationId: "op", state: "settled" });
  expect(() => f.admissions.admit({ key: A, operationId: "spend" })).toThrow();
  f.store.writeMetadata(accountKey(B), { generation: "g", state: "settled" });
  expect(() => f.admissions.admit({ key: B, expectedGeneration: "g", operationId: "spend" })).toThrow();
  // A stateless record cannot be completed into a settled fence by a bare settlement.
  f.store.writeMetadata(accountKey(C), { generation: "g", operationId: "op" });
  expect(() => f.admissions.settle(C, "op", "settled")).toThrow();
  expect(() => f.admissions.admit({ key: C, expectedGeneration: "g", operationId: "spend" })).toThrow();
});
test("failed admission writes leave no phantom claim and send nothing", async () => {
  const f = await fixture();
  const captured = f.admissions.revision();
  let restore = f.failWrites(f.store, "reset-admission.v1:revision");
  expect(() => f.admissions.admit({ key: A, operationId: "op-a" })).toThrow();
  restore();
  expect(f.admissions.revision()).toBe(captured);
  expect(f.admissions.inspect(A)).toBeUndefined();
  restore = f.failWrites(f.store, accountKey(A));
  expect(() => f.admissions.admit({ key: A, operationId: "op-a" })).toThrow();
  restore();
  // The revision written before the failed account write rolled back with it.
  expect(f.admissions.revision()).toBe(captured);
  expect(f.admissions.inspect(A)).toBeUndefined();
  expect(f.admissions.listAttempts()).toEqual([]);
  expect(() => f.admissions.settle(A, "op-a", "settled")).toThrow();
  const { admissions } = f.reopen(f.store);
  expect(admissions.inspect(A)).toBeUndefined();
  const record = admissions.admit({ key: A, operationId: "op-a" });
  expect(admissions.inspect(A)).toMatchObject({ generation: record.generation, operationId: "op-a", state: "dispatching" });
});
test("failed settlement writes keep the dispatched account fenced across reopen", async () => {
  const f = await fixture();
  const record = f.admissions.admit({ key: A, operationId: "op-a" });
  const restore = f.failWrites(f.store, accountKey(A));
  expect(() => f.admissions.settle(A, "op-a", "settled")).toThrow();
  restore();
  expect(f.admissions.inspect(A)).toMatchObject({ generation: record.generation, operationId: "op-a", state: "dispatching" });
  expect(f.admissions.getAttempt(record.attemptId!)?.state).toBe("dispatching");
  expect(() => f.admissions.admit({ key: A, expectedGeneration: record.generation, operationId: "replacement" })).toThrow();
  const { admissions } = f.reopen(f.store);
  expect(admissions.inspect(A)?.state).toBe("dispatching");
  expect(() => admissions.admit({ key: A, operationId: "replacement" })).toThrow();
  admissions.settle(A, "op-a", "unknown");
  expect(() => admissions.settle(A, "op-a", "settled")).toThrow();
});
test("automatic admission commits claim, attempt and revision together or not at all under a real SQLite failure", async () => {
  const f = await fixture();
  const captured = f.admissions.revision();
  const restore = f.failSqlite("reset-admission.v1:attempt:%");
  expect(() => f.admissions.admitAutomatic({ key: A, operationId: "pass-1", evidence: f.evidence() })).toThrow("fixture sqlite failure");
  restore();
  expect(f.admissions.revision()).toBe(captured);
  expect(f.admissions.inspect(A)).toBeUndefined();
  expect(f.admissions.listAttempts()).toEqual([]);
  const admitted = f.admissions.admitAutomatic({ key: A, operationId: "pass-1", evidence: f.evidence() });
  expect(() => f.admissions.assertRevision(captured)).toThrow();
  expect(f.admissions.inspect(A)).toMatchObject({ generation: admitted.generation, operationId: "pass-1", state: "dispatching", kind: "automatic", attemptId: admitted.attemptId });
  const { admissions } = f.reopen(f.store);
  const attempt = admissions.getAttempt(admitted.attemptId);
  expect(attempt).toMatchObject({ version: 1, hostId: f.store.host.id, id: admitted.attemptId, key: A, generation: admitted.generation, operationId: "pass-1", kind: "automatic", state: "dispatching" });
  expect(attempt?.evidence).toEqual(f.evidence());
  expect(attempt?.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(attempt?.commandId).toBeUndefined();
  expect(() => admissions.admit({ key: A, expectedGeneration: admitted.generation, operationId: "manual" })).toThrow();
  expect(() => admissions.admitAutomatic({ key: A, expectedGeneration: admitted.generation, operationId: "pass-2", evidence: f.evidence({ provenance: { ...f.evidence().provenance, passId: "pass-2" } }) })).toThrow();
});
test("automatic evidence must be complete, host- and pass-bound, and untampered before or after it is retained", async () => {
  const f = await fixture();
  const base = f.evidence();
  const rejected: [string, Partial<ResetAutomaticEvidence> | unknown][] = [
    ["another host", { provenance: { ...base.provenance, hostId: "other-host" } }],
    ["missing credit", { credit: undefined }],
    ["unknown field", { ...base, extra: true }],
    ["ambiguous email-only identity", { account: { ...base.account, accountId: undefined, email: "user@example.com" } }],
    ["credential blob", { account: { ...base.account, credential: { token: "secret" } } }],
    ["short fingerprint", { account: { ...base.account, credentialFingerprint: "abc" } }],
    ["float timestamp", { action: { ...base.action, plannedAtMs: 1.5 } }],
    ["unknown reason", { action: { ...base.action, reason: "curiosity" } }],
    ["consumed credit", { credit: { ...base.credit, status: "redeemed" } }],
    ["non-uuid redeem request", { redeemRequestId: "request" }],
    ["oversized", { provenance: { ...base.provenance, cwd: "/".padEnd(20_000, "x") } }],
  ];
  for (const [label, overrides] of rejected) {
    const value = { ...base, ...(overrides as object) } as ResetAutomaticEvidence;
    expect(() => f.admissions.admitAutomatic({ key: A, operationId: "pass-1", evidence: value }), label).toThrow();
  }
  expect(() => f.admissions.admitAutomatic({ key: A, operationId: "not-the-pass", evidence: base })).toThrow();
  expect(f.admissions.inspect(A)).toBeUndefined();
  expect(f.admissions.listAttempts()).toEqual([]);
  const unambiguous = f.admissions.admitAutomatic({ key: B, operationId: "pass-1", evidence: f.evidence({ account: { ...base.account, accountId: undefined, email: "user@example.com", emailUnambiguous: true } }) });
  expect(f.admissions.getAttempt(unambiguous.attemptId)?.evidence?.account.email).toBe("user@example.com");
  // Retained evidence is integrity-checked on every read; a damaged row fences its account rather than vanishing.
  const admitted = f.admissions.admitAutomatic({ key: A, operationId: "pass-1", evidence: base });
  const stored = f.store.readMetadata<ResetAdmissionAttempt & { kind: "automatic" }>(attemptKey(admitted.attemptId))!;
  f.store.writeMetadata(attemptKey(admitted.attemptId), { ...stored, evidence: { ...stored.evidence, credit: { ...stored.evidence.credit, id: "credit-2" } } });
  expect(() => f.admissions.getAttempt(admitted.attemptId)).toThrow();
  expect(() => f.admissions.listAttempts()).toThrow();
  expect(f.admissions.inspect(A)).toEqual({ state: "unknown", fence: "malformed" });
  expect(() => f.admissions.completeAutomatic(admitted.attemptId, passed("reset"))).toThrow();
  expect(() => f.admissions.markAutomaticUnknown(admitted.attemptId, "worker-lost")).toThrow();
  expect(() => f.admissions.admit({ key: A, expectedGeneration: admitted.generation, operationId: "spend" })).toThrow();
  f.store.writeMetadata(attemptKey(admitted.attemptId), stored);
  expect(f.admissions.inspect(A)?.state).toBe("dispatching");
  // An account row pointing at a different generation's attempt is not a valid claim either.
  const account = f.store.readMetadata<{ attemptId: string }>(accountKey(A))!;
  f.store.writeMetadata(accountKey(A), { ...account, attemptId: unambiguous.attemptId });
  expect(f.admissions.inspect(A)).toEqual({ state: "unknown", fence: "malformed" });
  const { admissions } = f.reopen(f.store);
  expect(admissions.inspect(A)).toEqual({ state: "unknown", fence: "malformed" });
  expect(() => admissions.admit({ key: A, expectedGeneration: admitted.generation, operationId: "spend" })).toThrow();
});

test("partial or contradictory automatic settlements never release their account after reopen", async () => {
  for (const observation of [undefined, passed("unknown"), { consumeBoundary: "refused", result: { kind: "outcome", code: "reset", ok: true } }]) {
    const f = await fixture();
    const admitted = f.admissions.admitAutomatic({ key: A, operationId: "pass-1", evidence: f.evidence() });
    f.admissions.completeAutomatic(admitted.attemptId, passed("reset"));
    const retained = f.store.readMetadata<ResetAdmissionAttempt>(attemptKey(admitted.attemptId))!;
    f.store.writeMetadata(attemptKey(admitted.attemptId), { ...retained, observation });
    const { admissions } = f.reopen(f.store);
    expect(admissions.inspect(A)?.state).toBe("unknown");
    expect(() => admissions.admit({ key: A, expectedGeneration: admitted.generation, operationId: "replacement" })).toThrow();
  }
});
test("observed native results settle or fence by consume boundary and are stored only in sanitized form", async () => {
  const f = await fixture();
  const admitFor = (key: string, passId: string) => f.admissions.admitAutomatic({ key, operationId: passId, evidence: f.evidence({ provenance: { ...f.evidence().provenance, passId } }) });
  const reset = admitFor(A, "pass-a");
  const settled = f.admissions.completeAutomatic(reset.attemptId, passed("reset"));
  expect(settled).toMatchObject({ state: "settled", observation: { consumeBoundary: "passed", result: { kind: "outcome", code: "reset", ok: true } } });
  expect(settled.unknownReason).toBeUndefined();
  expect(f.admissions.inspect(A)).toMatchObject({ generation: reset.generation, state: "settled", kind: "automatic" });
  // Identical completion is idempotent; a conflicting one is refused without touching the durable record.
  expect(f.admissions.completeAutomatic(reset.attemptId, passed("reset"))).toEqual(settled);
  expect(() => f.admissions.completeAutomatic(reset.attemptId, passed("no_credit"))).toThrow();
  expect(f.admissions.getAttempt(reset.attemptId)).toEqual(settled);
  const next = f.admissions.admitAutomatic({ key: A, expectedGeneration: reset.generation, operationId: "pass-a2", evidence: f.evidence({ provenance: { ...f.evidence().provenance, passId: "pass-a2" } }) });
  expect(next.generation).not.toBe(reset.generation);
  // A superseded settled attempt cannot be completed again into a fresh generation's account claim.
  expect(() => f.admissions.completeAutomatic(reset.attemptId, passed("no_credit"))).toThrow();
  expect(f.admissions.inspect(A)?.state).toBe("dispatching");
  const noEffect = admitFor(B, "pass-b");
  const proved = f.admissions.completeAutomatic(noEffect.attemptId, { consumeBoundary: "not-reached", result: { kind: "error" } });
  expect(proved.state).toBe("settled");
  expect(classifyResetObservation(proved.observation!)).toEqual({ state: "settled", effect: "no-effect" });
  expect(f.admissions.inspect(B)?.state).toBe("settled");
  const contradictory = admitFor(C, "pass-c");
  const fenced = f.admissions.completeAutomatic(contradictory.attemptId, { consumeBoundary: "refused", result: { kind: "outcome", code: "reset", ok: true } });
  expect(fenced).toMatchObject({ state: "unknown", unknownReason: "settlement-failed", observation: { consumeBoundary: "refused", result: { code: "reset", ok: true } } });
  expect(f.admissions.inspect(C)?.state).toBe("unknown");
  const raw = admitFor(D, "pass-d");
  const stripped = f.admissions.completeAutomatic(raw.attemptId, { consumeBoundary: "passed", result: { kind: "outcome", code: "provider_exploded: token abc", ok: false, detail: "stack" } } as never);
  expect(stripped.observation).toEqual({ consumeBoundary: "passed", result: { kind: "outcome", code: "unknown", ok: false } });
  expect(stripped.state).toBe("unknown");
  expect(JSON.stringify(f.store.readMetadata(attemptKey(raw.attemptId)))).not.toContain("provider_exploded");
  expect(sanitizeResetObservation({ consumeBoundary: "passed", result: { kind: "error", message: "raw", error: new Error("x") } })).toEqual({ consumeBoundary: "passed", result: { kind: "error" } });
  expect(() => sanitizeResetObservation({ consumeBoundary: "done", result: { kind: "error" } })).toThrow();
  expect(classifyResetObservation(passed("already_redeemed"))).toEqual({ state: "settled", effect: "no-effect" });
  expect(classifyResetObservation(passed("reset", false))).toEqual({ state: "unknown", effect: "unknown" });
  expect(classifyResetObservation({ consumeBoundary: "passed", result: { kind: "error" } })).toEqual({ state: "unknown", effect: "unknown" });
});
test("unknown automatic attempts keep their evidence and observation, survive reopen and are never upgraded", async () => {
  const f = await fixture();
  const admitted = f.admissions.admitAutomatic({ key: A, operationId: "pass-1", evidence: f.evidence() });
  const lost = f.admissions.markAutomaticUnknown(admitted.attemptId, "worker-lost", passed("reset"));
  expect(lost).toMatchObject({ state: "unknown", unknownReason: "worker-lost", observation: passed("reset"), evidence: f.evidence() });
  expect(f.admissions.inspect(A)).toMatchObject({ generation: admitted.generation, state: "unknown", kind: "automatic", attemptId: admitted.attemptId });
  expect(() => f.admissions.completeAutomatic(admitted.attemptId, passed("no_credit"))).toThrow();
  expect(f.admissions.completeAutomatic(admitted.attemptId, passed("reset")).state).toBe("unknown");
  expect(f.admissions.markAutomaticUnknown(admitted.attemptId, "restarted")).toEqual(lost);
  // The manual settlement path can neither resolve nor re-fence an automatic attempt.
  expect(() => f.admissions.settle(A, "pass-1", "settled")).toThrow();
  expect(() => f.admissions.settle(A, "pass-1", "unknown")).toThrow();
  const { admissions } = f.reopen(f.store);
  expect(admissions.getAttempt(admitted.attemptId)).toEqual(lost);
  expect(admissions.inspect(A)?.state).toBe("unknown");
  expect(() => admissions.admit({ key: A, expectedGeneration: admitted.generation, operationId: "manual" })).toThrow();
  expect(() => admissions.admitAutomatic({ key: A, expectedGeneration: admitted.generation, operationId: "pass-1", evidence: f.evidence() })).toThrow();
  admissions.pruneSettledAttempts();
  expect(admissions.getAttempt(admitted.attemptId)).toEqual(lost);
  // Manual attempts are settled only through their journal path.
  const manual = admissions.admit({ key: B, operationId: "manual" });
  expect(() => admissions.completeAutomatic(manual.attemptId!, passed("reset"))).toThrow();
  expect(() => admissions.markAutomaticUnknown(manual.attemptId!, "worker-lost")).toThrow();
  expect(admissions.getAttempt(manual.attemptId!)).toMatchObject({ kind: "manual", state: "dispatching" });
  expect(admissions.getAttempt(manual.attemptId!)?.evidence).toBeUndefined();
});
test("a failed completion write leaves the attempt dispatching so it can only be fenced, never claimed", async () => {
  const f = await fixture();
  const admitted = f.admissions.admitAutomatic({ key: A, operationId: "pass-1", evidence: f.evidence() });
  const restore = f.failSqlite(accountKey(A));
  expect(() => f.admissions.completeAutomatic(admitted.attemptId, passed("reset"))).toThrow("fixture sqlite failure");
  expect(() => f.admissions.markAutomaticUnknown(admitted.attemptId, "settlement-failed", passed("reset"))).toThrow("fixture sqlite failure");
  restore();
  expect(f.admissions.getAttempt(admitted.attemptId)).toMatchObject({ state: "dispatching" });
  expect(f.admissions.getAttempt(admitted.attemptId)?.observation).toBeUndefined();
  expect(f.admissions.inspect(A)?.state).toBe("dispatching");
  expect(() => f.admissions.admitAutomatic({ key: A, expectedGeneration: admitted.generation, operationId: "pass-1", evidence: f.evidence() })).toThrow();
  const fenced = f.admissions.markAutomaticUnknown(admitted.attemptId, "settlement-failed", passed("reset"));
  expect(fenced).toMatchObject({ state: "unknown", unknownReason: "settlement-failed", observation: passed("reset") });
  expect(f.reopen(f.store).admissions.inspect(A)?.state).toBe("unknown");
});
test("orphan attempts fence their account durably and unassignable rows close admissions", async () => {
  const f = await fixture();
  const admitted = f.admissions.admitAutomatic({ key: A, operationId: "pass-1", evidence: f.evidence() });
  const stored = f.store.readMetadata<ResetAdmissionAttempt>(attemptKey(admitted.attemptId))!;
  const orphanId = "22222222-2222-4222-8222-222222222222";
  f.store.writeMetadata(attemptKey(orphanId), { ...stored, id: orphanId, key: B, generation: "orphan", state: "settled", observation: passed("reset") });
  const audited = new ResetAccountAdmissions(f.store);
  expect(audited.inspect(B)).toEqual({ state: "unknown", fence: "orphan" });
  expect(() => audited.admit({ key: B, operationId: "spend" })).toThrow();
  expect(() => audited.admit({ key: B, expectedGeneration: "orphan", operationId: "spend" })).toThrow();
  expect(() => audited.settle(B, "pass-1", "settled")).toThrow();
  audited.pruneSettledAttempts();
  expect(audited.getAttempt(orphanId)?.key).toBe(B);
  // A damaged attempt that still names its account fences that account; one that names nothing closes new admissions.
  f.store.writeMetadata(attemptKey("33333333-3333-4333-8333-333333333333"), { key: C, garbage: true });
  f.store.writeMetadata(attemptKey("44444444-4444-4444-8444-444444444444"), "corrupt");
  const { store, admissions } = f.reopen(f.store);
  expect(admissions.inspect(B)).toEqual({ state: "unknown", fence: "orphan" });
  expect(admissions.inspect(C)).toEqual({ state: "unknown", fence: "orphan" });
  expect(() => admissions.admit({ key: D, operationId: "spend" })).toThrow(/closed/);
  expect(() => admissions.admitAutomatic({ key: D, operationId: "pass-1", evidence: f.evidence() })).toThrow(/closed/);
  expect(() => admissions.listAttempts()).toThrow();
  expect(admissions.inspect(A)?.state).toBe("dispatching");
  // Resolving already-admitted work stays possible while new claims are refused.
  expect(admissions.markAutomaticUnknown(admitted.attemptId, "restarted").state).toBe("unknown");
  store.deleteMetadata(attemptKey("44444444-4444-4444-8444-444444444444"));
  const repaired = f.reopen(store).admissions;
  expect(repaired.admit({ key: D, operationId: "spend" }).state).toBe("dispatching");
  expect(repaired.inspect(C)).toEqual({ state: "unknown", fence: "orphan" });
});
test("legacy account rows stay readable and conservative until a fresh admission links them to an attempt", async () => {
  const f = await fixture();
  f.store.writeMetadata(accountKey(A), { generation: "legacy", operationId: "op", state: "settled" });
  f.store.writeMetadata(accountKey(B), { generation: "legacy", operationId: "op", state: "dispatching" });
  const { admissions } = f.reopen(f.store);
  expect(admissions.inspect(A)).toEqual({ generation: "legacy", operationId: "op", state: "settled" });
  expect(admissions.listAttempts()).toEqual([]);
  expect(() => admissions.admit({ key: A, operationId: "spend" })).toThrow();
  expect(() => admissions.admit({ key: B, expectedGeneration: "legacy", operationId: "spend" })).toThrow();
  admissions.settle(B, "op", "unknown");
  expect(admissions.inspect(B)).toEqual({ generation: "legacy", operationId: "op", state: "unknown" });
  const linked = admissions.admit({ key: A, expectedGeneration: "legacy", operationId: "spend" });
  expect(admissions.inspect(A)).toMatchObject({ generation: linked.generation, kind: "manual", attemptId: linked.attemptId, state: "dispatching" });
  expect(admissions.getAttempt(linked.attemptId!)).toMatchObject({ key: A, kind: "manual", state: "dispatching" });
});
test("compaction reclaims only superseded settled history and capacity refuses new work instead of evicting fences", async () => {
  const f = await fixture();
  const admissions = new ResetAccountAdmissions(f.store, { maxAccounts: 3, maxAttempts: 3 });
  const evidenceFor = (passId: string) => f.evidence({ provenance: { ...f.evidence().provenance, passId } });
  const first = admissions.admitAutomatic({ key: A, operationId: "pass-1", evidence: evidenceFor("pass-1") });
  admissions.completeAutomatic(first.attemptId, passed("reset"));
  const second = admissions.admitAutomatic({ key: A, expectedGeneration: first.generation, operationId: "pass-2", evidence: evidenceFor("pass-2") });
  const manual = admissions.admit({ key: B, operationId: "manual", commandId: "never-finished" });
  admissions.settle(B, "manual", "settled");
  admissions.pruneSettledAttempts();
  expect(admissions.getAttempt(first.attemptId)).toBeUndefined();
  expect(admissions.getAttempt(second.attemptId)?.state).toBe("dispatching");
  expect(admissions.getAttempt(manual.attemptId!)?.state).toBe("unknown");
  expect(admissions.inspect(A)?.attemptId).toBe(second.attemptId);
  // Two unresolved attempts plus one more fill the attempt bound; a fourth distinct claim is refused, nothing is evicted.
  const third = admissions.admit({ key: C, operationId: "manual-c" });
  expect(() => admissions.admit({ key: D, operationId: "manual-d" })).toThrow();
  expect(admissions.listAttempts().map(attempt => attempt.id).sort()).toEqual([second.attemptId, manual.attemptId!, third.attemptId!].sort());
  expect(admissions.inspect(B)?.state).toBe("unknown");
  // Settling one attempt lets its own account re-admit by reclaiming the superseded settled row, but not a new account.
  admissions.settle(C, "manual-c", "settled");
  expect(() => admissions.admit({ key: D, operationId: "manual-d" })).toThrow();
  const replaced = admissions.admit({ key: C, expectedGeneration: third.generation, operationId: "manual-c2" });
  expect(admissions.getAttempt(third.attemptId!)).toBeUndefined();
  expect(admissions.getAttempt(replaced.attemptId!)?.state).toBe("dispatching");
  expect(admissions.listAttempts()).toHaveLength(3);
  // Account capacity: three retained accounts; a fourth distinct key is refused even with room in the attempt bound.
  const roomy = new ResetAccountAdmissions(f.store, { maxAccounts: 3, maxAttempts: 100 });
  expect(() => roomy.admit({ key: D, operationId: "manual-d" })).toThrow();
  roomy.settle(C, "manual-c2", "settled");
  expect(roomy.admit({ key: C, expectedGeneration: replaced.generation, operationId: "manual-c3" }).state).toBe("dispatching");
  expect(roomy.inspect(B)?.state).toBe("unknown");
  expect(roomy.inspect(A)?.state).toBe("dispatching");
});
