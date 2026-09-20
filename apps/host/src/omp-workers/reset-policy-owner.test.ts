import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { NativeResetPolicy } from "../native-reset-policy";
import { SessionUsageService } from "../session-usage";
import { HostStore } from "../store";
import type { SessionSnapshot } from "./protocol";
import { ResetPolicyHostChannel } from "./reset-policy-channel";
import { NativeResetPolicyWorkerOwner } from "./reset-policy-owner";
import type {
  ResetPassWire,
  ResetPlanSnapshotWire,
  ResetPolicyWireBinding,
  ResetPolicyWireEvidence,
  ResetPolicyWireOperation,
  ResetPolicyWireRequest,
  ResetPolicyWireResponse,
  ResetPolicyWireResult,
} from "./reset-policy-wire";

const directories: string[] = [], stores: HostStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const hex = (char: string) => char.repeat(64);
const policyValues = { autoRedeem: "yes", minBlockedMinutes: 30, keepCredits: 1, salvageHorizonHours: 24 } as const;
const account = (suffix = "a") => ({ provider: "openai-codex" as const, accountId: `acct-${suffix}`, email: `${suffix}@fixture.invalid`,
  credentialId: suffix.charCodeAt(0), credentialFingerprint: hex(suffix === "a" ? "a" : "b"), authAuthority: "auth.openai.com" });
const credit = { id: "RateLimitResetCredit_1", status: "available" as const, expiresAt: "2026-10-01T00:00:00.000Z", fingerprint: hex("c") };
const source = { kind: "source", selectionRevision: hex("e"), policyRevision: hex("f") } as const;
const action = (suffix = "a") => ({ reason: "blocked-account" as const, target: { credentialId: suffix.charCodeAt(0), accountId: `acct-${suffix}` },
  accountKey: `acct-${suffix}`, attemptKey: `blocked:acct-${suffix}:1`, label: `${suffix}@fixture.invalid`, remainingMs: 3_600_000,
  blockedWindows: ["weekly" as const], active: true });

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "reset-policy-owner-")); directories.push(directory);
  const store = new HostStore(directory); stores.push(store);
  const usage = new SessionUsageService({ store, existing: async () => undefined, open: async () => { throw new Error("unused"); },
    ordered: async <T>(_id: string, run: () => Promise<T>) => run(), assertActive() {} });
  const admissions = usage.admissions;
  const policy = new NativeResetPolicy({ store, admissions: usage.admissions });
  const snapshot = (id: string): SessionSnapshot => ({ revision: 1, id, sessionFile: path.join(directory, `${id}.jsonl`), cwd: directory,
    model: { provider: "openai-codex", id: "gpt-5-codex" }, isStreaming: false, hasPostPromptWork: false, createdAt: 1,
    activity: { goal: { availability: "available", value: null }, jobs: { availability: "available", value: { running: [], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } } },
      agents: { availability: "available", value: [] }, sources: { availability: "available", value: [] } } });
  const owner = (epoch: string, root = `root-${epoch}`) => new NativeResetPolicyWorkerOwner({ store, policy,
    context: { workerEpoch: epoch, workerPid: 100, snapshot: snapshot(root) } });
  return { directory, store, admissions, policy, owner, snapshot };
}

function pass(passId: string, nativeSessionId = "native-1", over: Partial<ResetPassWire> = {}): ResetPassWire {
  return { passId, nativeSessionId, trigger: "blocked", source: "blocked", startedAtMs: Date.now(), provider: "openai-codex",
    modelId: "gpt-5-codex", policy: policyValues, ...over };
}
function plan(p: ResetPassWire, suffix = "a"): ResetPlanSnapshotWire {
  return { reportRevision: hex("d"), pass: p, plannedAtMs: p.startedAtMs + 1, plan: { actions: [action(suffix)], skipped: [] } };
}
function request(binding: ResetPolicyWireBinding, requestId: number, p: ResetPassWire, operation: ResetPolicyWireOperation,
  proof?: ResetPolicyWireEvidence): ResetPolicyWireRequest {
  return { type: "resetPolicyRequest", requestId, binding, nativeSessionId: p.nativeSessionId, passId: p.passId, operation,
    ...(proof === undefined ? {} : { evidence: proof }) };
}
async function invoke(owner: NativeResetPolicyWorkerOwner, binding: ResetPolicyWireBinding, id: number, p: ResetPassWire,
  operation: ResetPolicyWireOperation, proof?: ResetPolicyWireEvidence): Promise<ResetPolicyWireResult> {
  return owner.handle(request(binding, id, p, operation, proof));
}
async function startedAndPlanned(owner: NativeResetPolicyWorkerOwner, binding: ResetPolicyWireBinding, p: ResetPassWire, suffix = "a") {
  await invoke(owner, binding, 1, p, { kind: "checkpoint", event: { phase: "started", pass: p } }, source);
  const snapshot = plan(p, suffix);
  await invoke(owner, binding, 2, p, { kind: "checkpoint", event: { phase: "planned", snapshot } },
    { kind: "plan", accounts: [account(suffix)] });
  return snapshot;
}
const admission = (suffix = "a") => ({ kind: "admission", selectionRevision: source.selectionRevision, policyRevision: source.policyRevision,
  account: account(suffix), credit } as const);

test("actual host store and wire channel durably admit and settle the original permit", async () => {
  const f = await fixture(), owner = f.owner("epoch-1"), binding = { workerEpoch: "epoch-1", rootSessionId: "root-epoch-1" };
  const p = pass("pass-1"), snapshot = await startedAndPlanned(owner, binding, p);
  const responses: ResetPolicyWireResponse[] = [];
  const channel = new ResetPolicyHostChannel(binding, packet => owner.handle(packet), response => responses.push(response));
  await channel.receive(request(binding, 1, p, { kind: "admit", snapshot, actionIndex: 0 }, admission()));
  const result = responses[0]!.response;
  expect(result.ok).toBe(true);
  if (!result.ok || result.result.kind !== "admission.execute") throw new Error("expected execute");
  expect(result.result.consumeIdentity).toEqual({ provider: "openai-codex", credentialId: 97, accountId: "acct-a",
    email: "a@fixture.invalid", creditId: credit.id });
  await channel.receive(request(binding, 2, p, { kind: "complete", permit: result.result.permit,
    observation: { consumeBoundary: "passed", result: { kind: "outcome", outcome: { ok: true, code: "reset", accountId: "discarded" } } } }));
  expect(responses[1]?.response).toEqual({ ok: true, result: { kind: "completed" } });
  expect(f.policy.inspectAttempt(result.result.permit.attemptId)).toMatchObject({ state: "settled", observed: "reset", live: false });
  owner.beginClose(); await owner.drain(); await channel.finish();
});

test("phase evidence and captured worker binding fail closed before durable mutation", async () => {
  const f = await fixture(), owner = f.owner("epoch-1"), binding = { workerEpoch: "epoch-1", rootSessionId: "root-epoch-1" };
  const p = pass("pass-proof");
  await expect(invoke(owner, binding, 1, p, { kind: "checkpoint", event: { phase: "started", pass: p } })).rejects.toThrow("source evidence");
  expect(f.policy.inspectPass(p.passId)).toBeUndefined();
  await expect(invoke(owner, { ...binding, rootSessionId: "replacement" }, 2, p,
    { kind: "checkpoint", event: { phase: "started", pass: p } }, source)).rejects.toThrow("another worker owner");
  expect(f.policy.inspectPass(p.passId)).toBeUndefined();
  await invoke(owner, binding, 3, p, { kind: "checkpoint", event: { phase: "started", pass: p } }, source);
  await expect(invoke(owner, binding, 4, p, { kind: "checkpoint", event: { phase: "planned", snapshot: plan(p) } },
    { kind: "plan", accounts: [] })).rejects.toThrow("every action");
  expect(f.policy.inspectPass(p.passId)).toMatchObject({ status: "started" });
});

test("the actual select binding is one-use and remains tied to its prepared pass", async () => {
  const f = await fixture(), owner = f.owner("epoch-1"), binding = { workerEpoch: "epoch-1", rootSessionId: "root-epoch-1" };
  const p = pass("pass-decision", "native-decision", { policy: { ...policyValues, autoRedeem: "unset" } });
  const snapshot = await startedAndPlanned(owner, binding, p);
  const prepared = await invoke(owner, binding, 3, p, { kind: "decision.prepare", snapshot });
  if (prepared.kind !== "decision.prepared") throw new Error("expected prepared decision");
  await expect(invoke(owner, binding, 4, pass("other", p.nativeSessionId),
    { kind: "decision.bind", decisionId: prepared.decisionId, interactionId: "actual-select-id" })).rejects.toThrow("unavailable");
  expect(await invoke(owner, binding, 5, p,
    { kind: "decision.bind", decisionId: prepared.decisionId, interactionId: "actual-select-id" })).toEqual({ kind: "decision.bound" });
  await expect(invoke(owner, binding, 6, p,
    { kind: "decision.bind", decisionId: prepared.decisionId, interactionId: "actual-select-id" })).rejects.toThrow("unavailable");
  await invoke(owner, binding, 7, p, { kind: "checkpoint", event: { phase: "answer", snapshot, answer: "Yes" } });
  await invoke(owner, binding, 8, p, { kind: "checkpoint", event: { phase: "setting-written", snapshot, mode: "yes" } },
    { kind: "persistence", status: "verified", globalMode: "yes", effectivePolicy: { ...policyValues, autoRedeem: "yes" },
      layersUnchanged: true, policyRevision: "policy-2" });
  expect(f.policy.inspectPass(p.passId)).toMatchObject({ record: { decision: { state: "answered", answer: "Yes" }, persistence: { status: "verified" } } });
});

test("loss fences without settling, while confirmed exit rejects the original join", async () => {
  const f = await fixture(), owner = f.owner("epoch-1"), binding = { workerEpoch: "epoch-1", rootSessionId: "root-epoch-1" };
  const origin = pass("pass-origin"), originPlan = await startedAndPlanned(owner, binding, origin);
  const execute = await invoke(owner, binding, 3, origin, { kind: "admit", snapshot: originPlan, actionIndex: 0 }, admission());
  expect(execute.kind).toBe("admission.execute");
  const follower = pass("pass-follower", origin.nativeSessionId, { startedAtMs: origin.startedAtMs });
  const followerPlan = await startedAndPlanned(owner, binding, follower);
  const admitted = await invoke(owner, binding, 6, follower, { kind: "admit", snapshot: followerPlan, actionIndex: 0 }, admission());
  if (admitted.kind !== "admission.join") throw new Error("expected join");
  const joined = invoke(owner, binding, 7, follower, { kind: "join", joinId: admitted.joinId });
  let settled = false; void joined.finally(() => { settled = true; }).catch(() => {});
  owner.workerLost();
  for (let turn = 0; turn < 8; turn++) await null;
  expect(settled).toBe(false);
  owner.workerExited();
  await expect(joined).rejects.toThrow("original worker exited");
  await owner.drain();
});

test("two worker adapters share one host-lifetime policy and closing one does not dispose the other", async () => {
  const f = await fixture();
  const first = f.owner("epoch-1", "root-1"), second = f.owner("epoch-2", "root-2");
  const firstBinding = { workerEpoch: "epoch-1", rootSessionId: "root-1" }, secondBinding = { workerEpoch: "epoch-2", rootSessionId: "root-2" };
  const p1 = pass("pass-first", "native-first"), p2 = pass("pass-second", "native-second");
  await startedAndPlanned(first, firstBinding, p1, "a");
  first.beginClose();
  const secondPlan = await startedAndPlanned(second, secondBinding, p2, "b");
  const admitted = await invoke(second, secondBinding, 3, p2, { kind: "admit", snapshot: secondPlan, actionIndex: 0 }, admission("b"));
  expect(admitted.kind).toBe("admission.execute");
  expect(f.policy.disposing).toBe(false);
  second.workerExited();
  await Promise.all([first.drain(), second.drain()]);
});

test("failed confirmed-exit persistence releases joins but fails exit and drain without touching another epoch", async () => {
  const f = await fixture();
  const first = f.owner("epoch-1", "root-1"), second = f.owner("epoch-2", "root-2");
  const firstBinding = { workerEpoch: "epoch-1", rootSessionId: "root-1" }, secondBinding = { workerEpoch: "epoch-2", rootSessionId: "root-2" };
  const origin = pass("pass-failing-origin", "native-first"), originPlan = await startedAndPlanned(first, firstBinding, origin);
  const execute = await invoke(first, firstBinding, 3, origin, { kind: "admit", snapshot: originPlan, actionIndex: 0 }, admission());
  if (execute.kind !== "admission.execute") throw new Error("expected execute");
  const follower = pass("pass-failing-follower", origin.nativeSessionId, { startedAtMs: origin.startedAtMs });
  const followerPlan = await startedAndPlanned(first, firstBinding, follower);
  const admitted = await invoke(first, firstBinding, 6, follower, { kind: "admit", snapshot: followerPlan, actionIndex: 0 }, admission());
  if (admitted.kind !== "admission.join") throw new Error("expected join");
  const joined = invoke(first, firstBinding, 7, follower, { kind: "join", joinId: admitted.joinId });

  const independent = pass("pass-independent", "native-second");
  const independentPlan = await startedAndPlanned(second, secondBinding, independent, "b");
  const independentExecute = await invoke(second, secondBinding, 3, independent,
    { kind: "admit", snapshot: independentPlan, actionIndex: 0 }, admission("b"));
  if (independentExecute.kind !== "admission.execute") throw new Error("expected independent execute");

  const attempt = f.policy.inspectAttempt(execute.permit.attemptId).attempt;
  if (!attempt) throw new Error("missing retained attempt");
  const failedKey = `reset-admission.v1:account:${attempt.key}`;
  const write = f.store.writeMetadata.bind(f.store);
  f.store.writeMetadata = (key, value) => { if (key === failedKey) throw new Error("fixture exit persistence failure"); write(key, value); };
  expect(() => first.workerExited()).toThrow("persistence failure");
  f.store.writeMetadata = write;

  await expect(joined).rejects.toThrow("original worker exited");
  await expect(first.drain()).rejects.toThrow("did not drain cleanly");
  expect(f.policy.inspectAttempt(execute.permit.attemptId)).toMatchObject({ state: "dispatching", live: false,
    completion: { terminal: "worker-exit", persistence: "failed" } });
  expect(f.policy.inspectAttempt(execute.permit.attemptId).attempt?.observation).toBeUndefined();
  expect(f.policy.inspectAttempt(independentExecute.permit.attemptId)).toMatchObject({ state: "dispatching", live: true });

  await invoke(second, secondBinding, 4, independent, { kind: "complete", permit: independentExecute.permit,
    observation: { consumeBoundary: "passed", result: { kind: "outcome", outcome: { ok: true, code: "reset" } } } });
  await second.drain();
  expect(f.policy.inspectAttempt(independentExecute.permit.attemptId)).toMatchObject({ state: "settled", observed: "reset", live: false });
});

for (const phase of ["answer", "setting-written", "decision.prepare", "admit"] as const) {
  test(`sealed report revision rejects a changed ${phase} callback without mutation`, async () => {
    const f = await fixture(), owner = f.owner("epoch-report"), binding = { workerEpoch: "epoch-report", rootSessionId: "root-epoch-report" };
    const p = pass(`report-${phase}`, "native-report", { policy: { ...policyValues, autoRedeem: "unset" } });
    const original = await startedAndPlanned(owner, binding, p);
    const before = f.policy.inspectPass(p.passId);
    const snapshot = { ...original, reportRevision: hex("9") };
    const operation: ResetPolicyWireOperation = phase === "answer"
      ? { kind: "checkpoint", event: { phase, snapshot, answer: "Yes" } }
      : phase === "setting-written"
        ? { kind: "checkpoint", event: { phase, snapshot, mode: "yes" } }
        : phase === "admit" ? { kind: phase, snapshot, actionIndex: 0 } : { kind: phase, snapshot };
    const proof: ResetPolicyWireEvidence | undefined = phase === "admit" ? admission()
      : phase === "setting-written" ? { kind: "persistence", status: "verified", globalMode: "yes",
        effectivePolicy: { ...policyValues, autoRedeem: "yes" }, layersUnchanged: true, policyRevision: hex("f") } : undefined;
    await expect(invoke(owner, binding, 3, p, operation, proof)).rejects.toThrow("sealed report");
    expect(f.policy.inspectPass(p.passId)).toEqual(before);
  });
}


test("recovered original owner records late completion without clearing the durable unknown fence", async () => {
  const f = await fixture(), oldOwner = f.owner("epoch-recovery"), binding = { workerEpoch: "epoch-recovery", rootSessionId: "root-epoch-recovery" };
  const p = pass("pass-recovery"), snapshot = await startedAndPlanned(oldOwner, binding, p);
  const admitted = await invoke(oldOwner, binding, 3, p, { kind: "admit", snapshot, actionIndex: 0 }, admission());
  if (admitted.kind !== "admission.execute") throw new Error("expected original permit");
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const store = new HostStore(f.directory); stores.push(store);
  const usage = new SessionUsageService({ store, existing: async () => undefined, open: async () => { throw new Error("unused"); },
    ordered: async <T>(_id: string, run: () => Promise<T>) => run(), assertActive() {} });
  const policy = new NativeResetPolicy({ store, admissions: usage.admissions });
  const context = { workerEpoch: binding.workerEpoch, workerPid: 100, snapshot: f.snapshot(binding.rootSessionId) };
  const operation: ResetPolicyWireOperation = { kind: "complete", permit: admitted.permit,
    observation: { consumeBoundary: "passed", result: { kind: "outcome", outcome: { ok: true, code: "reset" } } } };
  // A normal new owner cannot silently adopt an old worker's completion.
  await expect(invoke(new NativeResetPolicyWorkerOwner({ store, policy, context }), binding, 4, p, operation)).rejects.toThrow("No live");
  const recovered = new NativeResetPolicyWorkerOwner({ store, policy, context: { ...context, recovered: true } });
  await expect(invoke(recovered, binding, 4, p, { ...operation, permit: { ...admitted.permit, redeemRequestId: "replacement" } })).rejects.toThrow("original permit");
  expect(policy.inspectAttempt(admitted.permit.attemptId)).toMatchObject({ state: "unknown", observed: "unknown", live: false });
  expect(await invoke(recovered, binding, 4, p, operation)).toEqual({ kind: "completed" });
  expect(await invoke(recovered, binding, 5, p, operation)).toEqual({ kind: "completed" });
  for (const changedSnapshot of [{ ...context.snapshot, cwd: "/replacement" }, { ...context.snapshot, sessionFile: "/replacement.jsonl" }]) {
    const replacement = new NativeResetPolicyWorkerOwner({ store, policy, context: { ...context, snapshot: changedSnapshot, recovered: true } });
    await expect(invoke(replacement, binding, 4, p, operation)).rejects.toThrow("original permit");
  }
  expect(policy.inspectAttempt(admitted.permit.attemptId)).toMatchObject({ state: "unknown", observed: "reset", live: false });
  recovered.beginClose(); await recovered.drain();
  expect(await policy.drain()).toEqual([]);
});
