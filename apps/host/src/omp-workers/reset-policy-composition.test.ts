import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResetCreditConsumeIdentity } from "@oh-my-pi/pi-ai";
import type { ResetPass, ResetPlanSnapshot } from "@oh-my-pi/pi-coding-agent";

import { NativeResetPolicy } from "../native-reset-policy";
import { OmpInteractionBridge } from "../omp/interactions";
import { nativeResetAccountKey } from "../omp/session-usage";
import { SessionUsageService } from "../session-usage";
import { HostStore } from "../store";
import type { SessionSnapshot } from "./protocol";
import { ResetPolicyChannel, ResetPolicyHostChannel } from "./reset-policy-channel";
import { NativeResetChannelOwner, type NativeResetPassContext } from "./reset-policy-native-owner";
import { NativeResetPolicyWorkerOwner } from "./reset-policy-owner";
import type { ResetPolicyWireRequest, ResetPolicyWireResult } from "./reset-policy-wire";

const directories: string[] = [], stores: HostStore[] = [], bridges: OmpInteractionBridge[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const digest = (character: string) => character.repeat(64);
const policyValues = (autoRedeem: "unset" | "yes" | "no" = "yes") =>
  ({ autoRedeem, minBlockedMinutes: 30, keepCredits: 1, salvageHorizonHours: 24 } as const);
const account = (suffix = "a") => ({ provider: "openai-codex" as const, accountId: `acct-${suffix}`, email: `${suffix}@fixture.invalid`,
  credentialId: suffix.charCodeAt(0), credentialFingerprint: digest(suffix === "a" ? "a" : "b"), authAuthority: "controlled-fixture-auth" });
const credit = (suffix = "a") => ({ id: `credit-${suffix}`, status: "available" as const, fingerprint: digest("c") });
const action = (suffix = "a") => ({ reason: "blocked-account" as const, target: { credentialId: suffix.charCodeAt(0), accountId: `acct-${suffix}` },
  accountKey: `acct-${suffix}`, attemptKey: `blocked:acct-${suffix}:1`, label: `${suffix}@fixture.invalid`, remainingMs: 3_600_000,
  blockedWindows: ["weekly" as const], active: true });
const identity = (suffix = "a"): ResetCreditConsumeIdentity => ({ provider: "openai-codex", credentialId: suffix.charCodeAt(0),
  accountId: `acct-${suffix}`, creditId: `credit-${suffix}` });

function nativePass(passId: string, nativeSessionId: string, startedAtMs: number, autoRedeem: "unset" | "yes" | "no" = "yes"): ResetPass {
  return { passId, nativeSessionId, trigger: "blocked", source: "blocked", startedAtMs, provider: "openai-codex",
    modelId: "gpt-5-codex", policy: policyValues(autoRedeem) };
}
function plan(pass: ResetPass, suffix = "a", plannedAtMs = pass.startedAtMs + 1): ResetPlanSnapshot {
  return { reportRevision: digest("d"), pass, plannedAtMs, plan: { actions: [action(suffix)], skipped: [] } };
}
function sessionSnapshot(root: string, directory: string): SessionSnapshot {
  return { revision: 1, id: root, sessionFile: path.join(directory, `${root}.jsonl`), cwd: directory,
    model: { provider: "openai-codex", id: "gpt-5-codex" }, isStreaming: false, hasPostPromptWork: false, createdAt: 1,
    activity: { goal: { availability: "available", value: null }, jobs: { availability: "available", value: { running: [], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } } },
      agents: { availability: "available", value: [] }, sources: { availability: "available", value: [] } } };
}

type ContextControl = {
  current: boolean;
  selectionRevision: string;
  policyRevision: string;
  guardCalls: number;
  admissionGate?: { reached: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> };
};

function controlledContext(control: ContextControl, bridge: OmpInteractionBridge, suffix = "a"): NativeResetPassContext {
  return {
    source: { kind: "source", selectionRevision: control.selectionRevision, policyRevision: control.policyRevision },
    dispose() {},
    assertCurrent() { if (!control.current) throw new Error("Controlled original owner retired"); },
    async plan() { return { kind: "plan", accounts: [account(suffix)] }; },
    async persistence(snapshot, mode) {
      control.policyRevision = digest("9");
      return { kind: "persistence", status: "verified", globalMode: mode, effectivePolicy: { ...snapshot.pass.policy, autoRedeem: mode },
        layersUnchanged: true, policyRevision: control.policyRevision };
    },
    async admission() {
      if (control.admissionGate) { control.admissionGate.reached.resolve(); await control.admissionGate.release.promise; }
      return { evidence: { kind: "admission", selectionRevision: control.selectionRevision, policyRevision: control.policyRevision,
        account: account(suffix), credit: credit(suffix) }, beforeConsume(candidate) { control.guardCalls++; return candidate.accountId === `acct-${suffix}`; } };
    },
    runDecision: (bind, selectNative) => bridge.runWithDecisionBinding(bind, selectNative),
  };
}

async function world() {
  const directory = await mkdtemp(path.join(tmpdir(), "reset-policy-composition-")); directories.push(directory);
  const store = new HostStore(directory); stores.push(store);
  const usage = new SessionUsageService({ store, existing: async () => undefined, open: async () => { throw new Error("unused"); },
    ordered: async <T>(_id: string, run: () => Promise<T>) => run(), assertActive() {} });
  return { directory, store, admissions: usage.admissions, policy: new NativeResetPolicy({ store, admissions: usage.admissions }) };
}

function worker(shared: Awaited<ReturnType<typeof world>>, epoch: string, root: string,
  contextFor: (pass: ResetPass) => NativeResetPassContext,
  intercept?: (request: ResetPolicyWireRequest, handle: () => Promise<ResetPolicyWireResult>) => Promise<ResetPolicyWireResult>) {
  const binding = { workerEpoch: epoch, rootSessionId: root };
  const requests: ResetPolicyWireRequest[] = [];
  const durable = new NativeResetPolicyWorkerOwner({ store: shared.store, policy: shared.policy,
    context: { workerEpoch: epoch, workerPid: 100, snapshot: sessionSnapshot(root, shared.directory) } });
  let child!: ResetPolicyChannel;
  const host = new ResetPolicyHostChannel(binding, request => {
    requests.push(request);
    return intercept ? intercept(request, () => durable.handle(request)) : durable.handle(request);
  },
    response => child.receive(response));
  child = new ResetPolicyChannel(binding, request => { void host.receive(request).catch(() => {}); });
  const native = new NativeResetChannelOwner(child, contextFor);
  return { binding, durable, host, child, native, requests };
}

async function start(native: NativeResetChannelOwner, snapshot: ResetPlanSnapshot) {
  await native.checkpoint({ phase: "started", pass: snapshot.pass });
  await native.checkpoint({ phase: "planned", snapshot });
}
const completion = { consumeBoundary: "passed", result: { kind: "outcome", outcome: { ok: true, code: "reset" } } } as const;
const refused = { consumeBoundary: "refused", result: { kind: "outcome", outcome: { ok: false, code: "guard_refused" } } } as const;

test("composed native callbacks durably execute, guard, complete and finish", async () => {
  const shared = await world(), bridge = new OmpInteractionBridge("root-1", () => {}); bridges.push(bridge);
  const control: ContextControl = { current: true, selectionRevision: digest("e"), policyRevision: digest("f"), guardCalls: 0 };
  const w = worker(shared, "epoch-1", "root-1", () => controlledContext(control, bridge));
  const snapshot = plan(nativePass("pass-1", "task-native-1", 100));
  await w.native.checkpoint({ phase: "started", pass: snapshot.pass });
  const origin = shared.policy.inspectPass(snapshot.pass.passId);
  expect(origin).toMatchObject({ status: "started" });
  if (!origin || !("record" in origin)) throw new Error("expected original pass");
  expect(Object.hasOwn(origin.record.provenance, "reportRevision")).toBe(false);
  expect(origin.record.plan).toBeUndefined();
  await w.native.checkpoint({ phase: "planned", snapshot });
  expect(shared.policy.inspectPass(snapshot.pass.passId)).toMatchObject({ record: { plan: { reportRevision: digest("d") } } });
  const admitted = await w.native.admit(snapshot, 0); if (admitted.kind !== "execute") throw new Error("expected execute");
  expect(shared.policy.inspectAttempt(admitted.permit.attemptId).provenance?.reportRevision).toBe(snapshot.reportRevision);
  expect(admitted.permit.beforeConsume(identity())).toBe(true);
  expect(admitted.permit.beforeConsume(identity())).toBe(false);
  expect(control.guardCalls).toBe(1);
  await w.native.complete(admitted.permit, completion);
  await w.native.checkpoint({ phase: "finished", pass: snapshot.pass,
    settlement: { state: "settled", applied: 1, attemptIds: [admitted.permit.attemptId], refresh: "complete" } });
  expect(shared.policy.inspectAttempt(admitted.permit.attemptId)).toMatchObject({ state: "settled", observed: "reset", live: false });
  expect(w.requests.map(request => request.operation.kind === "checkpoint" ? `checkpoint.${request.operation.event.phase}` : request.operation.kind))
    .toEqual(["checkpoint.started", "checkpoint.planned", "admit", "complete", "checkpoint.finished"]);
  w.native.beginClose(); w.durable.beginClose(); w.host.beginClose();
  await Promise.all([w.native.finish(), w.host.finish(), w.durable.drain()]);
});

test("real interaction bridge binds before Yes, then answer and Settings proof authorize execution", async () => {
  const shared = await world();
  const events: string[] = [];
  let w!: ReturnType<typeof worker>;
  const bridge = new OmpInteractionBridge("root-decision", event => {
    if (event.type !== "extension_interaction_requested") return;
    events.push(event.interaction.id);
    void bridge.respond(event.interaction.id, { value: "Yes" });
  }); bridges.push(bridge);
  const control: ContextControl = { current: true, selectionRevision: digest("e"), policyRevision: digest("f"), guardCalls: 0 };
  w = worker(shared, "epoch-decision", "root-decision", () => controlledContext(control, bridge));
  const snapshot = plan(nativePass("pass-decision", "task-native-decision", 200, "unset")); await start(w.native, snapshot);
  let selections = 0;
  await w.native.presentDecision(snapshot, async () => { selections++; return await bridge.select("Native reset", ["Yes", "No"]) as "Yes" | "No" | undefined; });
  expect(selections).toBe(1); expect(events).toHaveLength(1); expect(bridge.list()).toHaveLength(0);
  const binding = w.requests.find(request => request.operation.kind === "decision.bind");
  expect(binding?.operation.kind === "decision.bind" && binding.operation.interactionId).toBe(events[0]);
  await w.native.checkpoint({ phase: "answer", snapshot, answer: "Yes" });
  await w.native.checkpoint({ phase: "setting-written", snapshot, mode: "yes" });
  const admitted = await w.native.admit(snapshot, 0); if (admitted.kind !== "execute") throw new Error("expected execute");
  expect(admitted.permit.beforeConsume(identity())).toBe(true);
  await w.native.complete(admitted.permit, completion);
  await w.native.checkpoint({ phase: "finished", pass: snapshot.pass,
    settlement: { state: "settled", applied: 1, attemptIds: [admitted.permit.attemptId], refresh: "complete" } });
  expect(w.requests.map(request => request.operation.kind === "checkpoint" ? `checkpoint.${request.operation.event.phase}` : request.operation.kind))
    .toEqual(["checkpoint.started", "checkpoint.planned", "decision.prepare", "decision.bind", "checkpoint.answer",
      "checkpoint.setting-written", "admit", "complete", "checkpoint.finished"]);
});

test("two workers with task native ids join one account while a manual collision stays unknown", async () => {
  const shared = await world(), bridge1 = new OmpInteractionBridge("root-1", () => {}), bridge2 = new OmpInteractionBridge("root-2", () => {});
  bridges.push(bridge1, bridge2);
  const c1: ContextControl = { current: true, selectionRevision: digest("e"), policyRevision: digest("f"), guardCalls: 0 };
  const c2: ContextControl = { current: true, selectionRevision: digest("e"), policyRevision: digest("f"), guardCalls: 0 };
  const first = worker(shared, "epoch-1", "root-1", () => controlledContext(c1, bridge1));
  const second = worker(shared, "epoch-2", "root-2", pass => controlledContext(c2, bridge2, pass.passId.endsWith("manual") ? "b" : "a"));
  const p1 = plan(nativePass("pass-origin", "task-native-origin", 300), "a", 301);
  const p2 = plan(nativePass("pass-join", "task-native-join", 300), "a", 301);
  await start(first.native, p1); await start(second.native, p2);
  const origin = await first.native.admit(p1, 0); if (origin.kind !== "execute") throw new Error("expected execute");
  const joined = await second.native.admit(p2, 0); if (joined.kind !== "join") throw new Error("expected join");
  await first.native.complete(origin.permit, completion);
  expect(await joined.settled).toEqual(completion);

  const manualAccount = account("b"), manualKey = nativeResetAccountKey(manualAccount);
  shared.admissions.admit({ key: manualKey, operationId: "manual-command" });
  const manualPlan = plan(nativePass("pass-manual", "task-native-manual", 310), "b", 311);
  await start(second.native, manualPlan);
  expect(await second.native.admit(manualPlan, 0)).toEqual({ kind: "hold", reason: "unknown" });
});

test("loss is nonterminal, confirmed exit rejects the joined native waiter without an observation", async () => {
  const shared = await world(), bridge1 = new OmpInteractionBridge("root-1", () => {}), bridge2 = new OmpInteractionBridge("root-2", () => {});
  bridges.push(bridge1, bridge2);
  const c1: ContextControl = { current: true, selectionRevision: digest("e"), policyRevision: digest("f"), guardCalls: 0 };
  const c2: ContextControl = { current: true, selectionRevision: digest("e"), policyRevision: digest("f"), guardCalls: 0 };
  const first = worker(shared, "epoch-1", "root-1", () => controlledContext(c1, bridge1));
  const second = worker(shared, "epoch-2", "root-2", () => controlledContext(c2, bridge2));
  const p1 = plan(nativePass("pass-origin", "task-native-origin", 400), "a", 401);
  const p2 = plan(nativePass("pass-join", "task-native-join", 400), "a", 401);
  await start(first.native, p1); await start(second.native, p2);
  const origin = await first.native.admit(p1, 0); if (origin.kind !== "execute") throw new Error("expected execute");
  const joined = await second.native.admit(p2, 0); if (joined.kind !== "join") throw new Error("expected join");
  let settled = false; void joined.settled.finally(() => { settled = true; }).catch(() => {});
  first.durable.workerLost();
  for (let turn = 0; turn < 8; turn++) await null;
  expect(settled).toBe(false);
  first.durable.workerExited();
  await expect(joined.settled).rejects.toThrow("original worker exited");
  expect(shared.policy.inspectAttempt(origin.permit.attemptId).attempt?.observation).toBeUndefined();
});

test("retirement during durable admission returns a refusing guard, accepts real completion, and holds drain", async () => {
  const shared = await world(), bridge = new OmpInteractionBridge("root-retire", () => {}); bridges.push(bridge);
  const admittedAtHost = Promise.withResolvers<void>(), releaseResponse = Promise.withResolvers<void>();
  const control: ContextControl = { current: true, selectionRevision: digest("e"), policyRevision: digest("f"), guardCalls: 0 };
  const w = worker(shared, "epoch-retire", "root-retire", () => controlledContext(control, bridge), async (request, handle) => {
    const result = await handle();
    if (request.operation.kind === "admit") { admittedAtHost.resolve(); await releaseResponse.promise; }
    return result;
  });
  const snapshot = plan(nativePass("pass-retire", "task-native-retire", 500)); await start(w.native, snapshot);
  const pendingAdmission = w.native.admit(snapshot, 0);
  await admittedAtHost.promise;
  w.native.beginClose(); w.durable.beginClose(); w.host.beginClose();
  const drain = w.durable.drain(); let drained = false; void drain.then(() => { drained = true; });
  for (let turn = 0; turn < 8; turn++) await null;
  expect(drained).toBe(false);
  releaseResponse.resolve();
  const admitted = await pendingAdmission; if (admitted.kind !== "execute") throw new Error("expected execute");
  expect(admitted.permit.beforeConsume(identity())).toBe(false); expect(control.guardCalls).toBe(0);
  await w.native.complete(admitted.permit, refused);
  await drain;
  await w.native.checkpoint({ phase: "finished", pass: snapshot.pass,
    settlement: { state: "held", applied: 0, attemptIds: [admitted.permit.attemptId], refresh: "not-needed" } });
  await Promise.all([w.native.finish(), w.host.finish()]);
  expect(shared.policy.inspectAttempt(admitted.permit.attemptId)).toMatchObject({ state: "settled", observed: "no-effect", live: false });
});


test("shared admission during held native plan evidence invalidates the captured origin before any execution", async () => {
  const shared = await world(), bridge = new OmpInteractionBridge("root-preparation", () => {}); bridges.push(bridge);
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const control: ContextControl = { current: true, selectionRevision: digest("e"), policyRevision: digest("f"), guardCalls: 0 };
  const w = worker(shared, "epoch-preparation", "root-preparation", () => {
    const context = controlledContext(control, bridge);
    return { ...context, async plan(snapshot) {
      reached.resolve(); await release.promise;
      return context.plan(snapshot);
    } };
  });
  const snapshot = plan(nativePass("pass-preparation", "native-preparation", 600));
  await w.native.checkpoint({ phase: "started", pass: snapshot.pass });
  const pendingPlan = w.native.checkpoint({ phase: "planned", snapshot });
  const outcome = pendingPlan.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  await reached.promise;
  shared.admissions.admit({ key: nativeResetAccountKey(account()), operationId: "manual-during-preparation" });
  release.resolve();
  const result = await outcome;
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected invalidated plan");
  expect(result.error).toBeInstanceOf(Error);
  expect(result.error.message).toContain("admitted during preparation");
  const retained = shared.policy.inspectPass(snapshot.pass.passId);
  expect(retained).toMatchObject({ status: "closed", record: { closed: { reason: "invalidated" } }, attempts: [] });
  if (!retained || !("record" in retained)) throw new Error("expected retained origin");
  expect(retained.record.plan).toBeUndefined();
  expect(control.guardCalls).toBe(0);
  expect(w.requests.map(request => request.operation.kind === "checkpoint" ? request.operation.event.phase : request.operation.kind))
    .toEqual(["started", "planned"]);
  w.native.beginClose(); w.durable.beginClose();
  await expect(w.native.finish()).rejects.toThrow("drain");
  await w.durable.drain();
  await expect(w.host.finish()).rejects.toThrow("drain");
});
