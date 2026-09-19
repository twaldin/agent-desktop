import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ResetPass, ResetPlanSnapshot } from "@oh-my-pi/pi-coding-agent";
import { OmpInteractionBridge } from "../omp/interactions";
import { NativeResetChannelOwner, type NativeResetPassContext } from "./reset-policy-native-owner";
import { ResetPolicyChannel, ResetPolicyHostChannel } from "./reset-policy-channel";
import type { ResetPolicyWireRequest, ResetPolicyWireResult } from "./reset-policy-wire";

const digest = "a".repeat(64);
const pass: ResetPass = { passId: "pass-a", nativeSessionId: "native-a", trigger: "blocked", source: "blocked",
  startedAtMs: 100, provider: "openai-codex", modelId: "gpt-5", policy: { autoRedeem: "yes", minBlockedMinutes: 10, keepCredits: 1, salvageHorizonHours: 24 } };
const snapshot: ResetPlanSnapshot = { reportRevision: digest, pass, plannedAtMs: 101, plan: { actions: [{ reason: "blocked-account", target: { credentialId: 7, accountId: "account-a" },
  accountKey: "key-a", attemptKey: "native-attempt", label: "account-a", availableCount: 2, weeklyUsedFraction: 1, remainingMs: 2000, active: true }], skipped: [] } };
const identity = { provider: "openai-codex", credentialId: 7, accountId: "account-a", creditId: "credit-a" };
const execute: ResetPolicyWireResult = { kind: "admission.execute", permit: { attemptId: "attempt-a", target: { credentialId: 7 }, creditId: "credit-a", redeemRequestId: "request-a" }, consumeIdentity: identity };

function setup(custom?: (request: ResetPolicyWireRequest) => Promise<ResetPolicyWireResult> | ResetPolicyWireResult,
  capture?: (pass: ResetPass, owner: NativeResetChannelOwner) => NativeResetPassContext) {
  const binding = { workerEpoch: "epoch-a", rootSessionId: "root-a" }, requests: ResetPolicyWireRequest[] = [];
  let current = true, captures = 0, guarded = 0;
  const context: NativeResetPassContext = {
    source: { kind: "source", selectionRevision: digest, policyRevision: digest },
    dispose() {},
    assertCurrent() { if (!current) throw new Error("Original native owner changed"); },
    async plan() { return { kind: "plan", accounts: [{ provider: "openai-codex", accountId: "account-a", credentialId: 7, credentialFingerprint: digest, authAuthority: "original-auth" }] }; },
    async persistence() { return { kind: "persistence", status: "verified", globalMode: "yes", effectivePolicy: pass.policy, layersUnchanged: true }; },
    async admission() { return { evidence: { kind: "admission", selectionRevision: digest, policyRevision: digest,
      account: { provider: "openai-codex", accountId: "account-a", credentialId: 7, credentialFingerprint: digest, authAuthority: "original-auth" },
      credit: { id: "credit-a", status: "available", fingerprint: digest } }, beforeConsume(candidate) { guarded++; return candidate.accountId === "account-a"; } }; },
    async runDecision() { throw new Error("Install actual interaction bridge for decision fixture"); },
  };
  const channel = new ResetPolicyChannel(binding, request => { void host.receive(request).catch(() => {}); });
  const host = new ResetPolicyHostChannel(binding, async request => {
    requests.push(request);
    if (custom) return custom(request);
    switch (request.operation.kind) {
      case "checkpoint": return { kind: "checkpointed" };
      case "decision.prepare": return { kind: "decision.prepared", decisionId: "decision-a" };
      case "decision.bind": return { kind: "decision.bound" };
      case "admit": return execute;
      case "complete": return { kind: "completed" };
      default: throw new Error("Unexpected join");
    }
  }, response => channel.receive(response));
  let owner!: NativeResetChannelOwner;
  owner = new NativeResetChannelOwner(channel, native => { captures++; return capture?.(native, owner) ?? context; });
  return { owner, context, requests, captures: () => captures, guarded: () => guarded, invalidate: () => { current = false; } };
}

function subscribedContext(label: string, options: { assertError?: unknown; disposeError?: unknown; onDispose?(): void } = {}) {
  const events = new EventEmitter();
  const record = { disposed: 0, notifications: 0 };
  const listener = () => { record.notifications++; };
  events.on("change", listener);
  const context: NativeResetPassContext = {
    source: { kind: "source", selectionRevision: digest, policyRevision: digest },
    dispose() {
      record.disposed++;
      events.off("change", listener);
      options.onDispose?.();
      if (Object.hasOwn(options, "disposeError")) throw options.disposeError;
    },
    assertCurrent() { if (Object.hasOwn(options, "assertError")) throw options.assertError; },
    async plan() { return { kind: "plan", accounts: [] }; },
    async persistence() { return { kind: "persistence", status: "failed" }; },
    async admission() { throw new Error(`Unexpected admission for ${label}`); },
    async runDecision() { throw new Error(`Unexpected decision for ${label}`); },
  };
  return { context, events, record };
}

function messages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(messages);
  return [error instanceof Error ? error.message : String(error)];
}

async function outcome(promise: Promise<unknown>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}

async function start(f: ReturnType<typeof setup>) { await f.owner.checkpoint({ phase: "started", pass }); await f.owner.checkpoint({ phase: "planned", snapshot }); }

test("captures one original pass and executes a single guarded native permit without serializing callbacks", async () => {
  const f = setup(); await start(f);
  const admitted = await f.owner.admit(snapshot, 0); if (admitted.kind !== "execute") throw new Error("Expected execute");
  expect(admitted.permit.beforeConsume(identity)).toBe(true);
  expect(admitted.permit.beforeConsume(identity)).toBe(false);
  expect(f.guarded()).toBe(1); expect(f.captures()).toBe(1);
  await f.owner.complete(admitted.permit, { consumeBoundary: "passed", result: { kind: "outcome", outcome: { ok: true, code: "reset", creditId: "credit-a" } } });
  const completed = f.requests.at(-1)!;
  expect(completed.operation.kind).toBe("complete");
  expect(JSON.stringify(completed)).not.toContain("beforeConsume");
  await f.owner.checkpoint({ phase: "finished", pass, settlement: { state: "settled", applied: 1, attemptIds: ["attempt-a"], refresh: "complete" } });
  await f.owner.finish();
});

test("retirement during durable admission returns a refusing permit and still delivers real completion", async () => {
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = setup(async request => {
    if (request.operation.kind === "admit") { reached.resolve(); await release.promise; return execute; }
    return request.operation.kind === "complete" ? { kind: "completed" } : { kind: "checkpointed" };
  });
  await start(f); const pending = f.owner.admit(snapshot, 0);
  await reached.promise; f.invalidate(); f.owner.beginClose(); release.resolve();
  const admitted = await pending; if (admitted.kind !== "execute") throw new Error("Expected original permit");
  expect(admitted.permit.beforeConsume(identity)).toBe(false); expect(f.guarded()).toBe(0);
  await f.owner.complete(admitted.permit, { consumeBoundary: "refused", result: { kind: "outcome", outcome: { ok: false, code: "guard_refused" } } });
  expect(f.requests.at(-1)?.operation.kind).toBe("complete");
  await f.owner.checkpoint({ phase: "finished", pass, settlement: { state: "held", applied: 0, attemptIds: ["attempt-a"], refresh: "not-needed" } });
  await f.owner.finish();
});

test("binds the actual native selector interaction before publication and invokes the closure once", async () => {
  const f = setup(); await start(f);
  let selected = 0;
  const ui = new OmpInteractionBridge("root-a", event => {
    if (event.type !== "extension_interaction_requested") return;
    const bound = f.requests.find(request => request.operation.kind === "decision.bind");
    expect(bound?.operation.kind === "decision.bind" && bound.operation.interactionId).toBe(event.interaction.id);
    void ui.respond(event.interaction.id, { value: "Yes" });
  });
  f.context.runDecision = (bind, select) => ui.runWithDecisionBinding(bind, select);
  try {
    await f.owner.presentDecision(snapshot, async () => { selected++; return await ui.select("Native reset", ["Yes", "No"]) as "Yes" | "No" | undefined; });
    expect(selected).toBe(1); expect(ui.list()).toHaveLength(0);
  } finally { ui.dispose(); }
});

test("persisted readback failure is recorded before the original error propagates, without a write retry", async () => {
  const f = setup(); await start(f); let reads = 0;
  f.context.persistence = async () => { reads++; throw new Error("Readback unavailable"); };
  await expect(f.owner.checkpoint({ phase: "setting-written", snapshot, mode: "yes" })).rejects.toThrow("Readback unavailable");
  expect(reads).toBe(1);
  expect(f.requests.at(-1)?.evidence).toEqual({ kind: "persistence", status: "failed" });
});

test("foreign permits and repeated completion cannot dispatch, and native errors are sanitized", async () => {
  const f = setup(); await start(f);
  const admitted = await f.owner.admit(snapshot, 0); if (admitted.kind !== "execute") throw new Error("Expected execute");
  const failure = { consumeBoundary: "not-reached", result: { kind: "error", error: new Error("credential material must not leave child") } } as const;
  await expect(f.owner.complete({ ...admitted.permit }, failure)).rejects.toThrow("foreign");
  await f.owner.complete(admitted.permit, failure);
  await expect(f.owner.complete(admitted.permit, failure)).rejects.toThrow("already completing");
  expect(f.requests.filter(r => r.operation.kind === "complete")).toHaveLength(1);
  expect(JSON.stringify(f.requests)).not.toContain("credential material");
});

test("worker-exit join rejection propagates without fabricating a native observation or consume", async () => {
  const f = setup(request => {
    if (request.operation.kind === "admit") return { kind: "admission.join", attemptId: "other-attempt", joinId: "join-a" };
    if (request.operation.kind === "join") throw new Error("Original worker exited with unknown outcome");
    return { kind: "checkpointed" };
  });
  await start(f); const admitted = await f.owner.admit(snapshot, 0);
  if (admitted.kind !== "join") throw new Error("Expected join");
  await expect(admitted.settled).rejects.toThrow("unknown outcome");
  expect(f.requests.some(r => r.operation.kind === "complete")).toBe(false); expect(f.guarded()).toBe(0);
  await expect(f.owner.finish()).rejects.toThrow("did not drain cleanly");
});

test("property order does not rebind a pass, while changed provenance and stale ownership refuse", async () => {
  const f = setup(); await start(f);
  const same = Object.fromEntries(Object.entries(pass).reverse()) as unknown as ResetPass;
  await f.owner.checkpoint({ phase: "answer", snapshot: { ...snapshot, pass: same }, answer: undefined });
  await expect(f.owner.admit({ ...snapshot, pass: { ...pass, modelId: "replacement" } }, 0)).rejects.toThrow("original captured");
  f.invalidate(); await expect(f.owner.admit(snapshot, 0)).rejects.toThrow("owner changed");
  expect(f.requests.filter(r => r.operation.kind === "admit")).toHaveLength(0);
});

test("readback and durable failure-accounting errors are both retained", async () => {
  const f = setup(request => {
    if (request.operation.kind === "checkpoint" && request.operation.event.phase === "setting-written") throw new Error("Journal unavailable");
    return { kind: "checkpointed" };
  });
  await start(f); f.context.persistence = async () => { throw new Error("Readback unavailable"); };
  try {
    await f.owner.checkpoint({ phase: "setting-written", snapshot, mode: "yes" });
    throw new Error("Expected both failures");
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(error => error.message)).toEqual(["Readback unavailable", "Journal unavailable"]);
  }
});

test("a foreign host-selected credit cannot pass the original admission guard", async () => {
  const f = setup(request => request.operation.kind === "admit"
    ? { ...execute as Extract<ResetPolicyWireResult, { kind: "admission.execute" }>, permit: { attemptId: "attempt-a", target: { credentialId: 7 }, creditId: "replacement-credit", redeemRequestId: "request-a" }, consumeIdentity: { ...identity, creditId: "replacement-credit" } }
    : { kind: "checkpointed" });
  await start(f); const admitted = await f.owner.admit(snapshot, 0);
  if (admitted.kind !== "execute") throw new Error("Expected guarded permit");
  expect(admitted.permit.beforeConsume({ ...identity, creditId: "replacement-credit" })).toBe(false);
  expect(f.guarded()).toBe(0);
});

test("the settled finished checkpoint releases its original subscribed context exactly once", async () => {
  const owned = subscribedContext("successful");
  const f = setup(undefined, () => owned.context);
  await start(f);
  owned.events.emit("change");
  expect(owned.record.notifications).toBe(1);
  expect(owned.events.listenerCount("change")).toBe(1);
  await f.owner.checkpoint({ phase: "finished", pass,
    settlement: { state: "held", applied: 0, attemptIds: [], refresh: "not-needed" } });
  expect(owned.record.disposed).toBe(1);
  expect(owned.events.listenerCount("change")).toBe(0);
  await f.owner.finish();
  expect(owned.record.disposed).toBe(1);
});

test("a failed final checkpoint and throwing cleanup both reach the callback and retained finish failure", async () => {
  const owned = subscribedContext("double-failure", { disposeError: new Error("subscription cleanup failed") });
  const f = setup(request => {
    if (request.operation.kind === "checkpoint" && request.operation.event.phase === "finished") throw new Error("final checkpoint failed");
    return { kind: "checkpointed" };
  }, () => owned.context);
  await start(f);
  const result = await f.owner.checkpoint({ phase: "finished", pass,
    settlement: { state: "held", applied: 0, attemptIds: [], refresh: "not-needed" } }).then(
      () => undefined, error => error);
  expect(messages(result)).toContain("final checkpoint failed");
  expect(messages(result)).toContain("subscription cleanup failed");
  expect(owned.record.disposed).toBe(1);
  const drained = await f.owner.finish().then(() => undefined, error => error);
  expect(messages(drained)).toContain("final checkpoint failed");
  expect(messages(drained)).toContain("subscription cleanup failed");
});

test("a rejected capture removes its subscription and retains both ownership and cleanup failures", async () => {
  const owned = subscribedContext("rejected-capture", {
    assertError: new Error("captured owner already changed"), disposeError: new Error("rejected capture cleanup failed"),
  });
  const f = setup(undefined, () => owned.context);
  const capture = await f.owner.checkpoint({ phase: "started", pass }).then(() => undefined, error => error);
  expect(messages(capture)).toContain("captured owner already changed");
  expect(messages(capture)).toContain("rejected capture cleanup failed");
  expect(owned.record.disposed).toBe(1);
  expect(owned.events.listenerCount("change")).toBe(0);
  const drained = await f.owner.finish().then(() => undefined, error => error);
  expect(messages(drained)).toContain("captured owner already changed");
  expect(messages(drained)).toContain("rejected capture cleanup failed");
});

test("two captured passes retain and release independent subscriptions", async () => {
  const first = subscribedContext("first"), second = subscribedContext("second");
  const secondPass: ResetPass = { ...pass, passId: "pass-b", nativeSessionId: "native-b", startedAtMs: 200 };
  const f = setup(undefined, native => native.passId === pass.passId ? first.context : second.context);
  await f.owner.checkpoint({ phase: "started", pass });
  await f.owner.checkpoint({ phase: "started", pass: secondPass });
  await f.owner.checkpoint({ phase: "finished", pass,
    settlement: { state: "held", applied: 0, attemptIds: [], refresh: "not-needed" } });
  expect(first.record.disposed).toBe(1);
  expect(second.record.disposed).toBe(0);
  second.events.emit("change");
  expect(second.record.notifications).toBe(1);
  await f.owner.checkpoint({ phase: "finished", pass: secondPass,
    settlement: { state: "held", applied: 0, attemptIds: [], refresh: "not-needed" } });
  expect(second.record.disposed).toBe(1);
  await f.owner.finish();
});

test("finish releases a stranded pass once and repeated finish stays idempotent", async () => {
  const owned = subscribedContext("stranded");
  const f = setup(undefined, () => owned.context);
  await f.owner.checkpoint({ phase: "started", pass });
  await f.owner.finish();
  expect(owned.record.disposed).toBe(1);
  expect(owned.events.listenerCount("change")).toBe(0);
  await f.owner.finish();
  expect(owned.record.disposed).toBe(1);
});

test("a synchronous reentrant close refuses storage and disposes the newly captured context", async () => {
  const owned = subscribedContext("reentrant-close");
  let finishing: Promise<void> | undefined;
  const f = setup(undefined, (_native, owner) => { finishing = owner.finish(); return owned.context; });
  await expect(f.owner.checkpoint({ phase: "started", pass })).rejects.toThrow("capture is unavailable");
  expect(owned.record.disposed).toBe(1);
  expect(owned.events.listenerCount("change")).toBe(0);
  await expect(f.owner.checkpoint({ phase: "started", pass })).rejects.toThrow("capture is unavailable");
  const drained = await finishing!.then(() => undefined, error => error);
  expect(messages(drained)).toContain("Reset pass capture is unavailable");
  await expect(f.owner.finish()).rejects.toBeInstanceOf(AggregateError);
});

test("raw false checkpoint and undefined cleanup rejections are retained without truthiness sentinels", async () => {
  const planned = subscribedContext("false-plan");
  planned.context.plan = async () => { throw false; };
  const first = setup(undefined, () => planned.context);
  await first.owner.checkpoint({ phase: "started", pass });
  const rejectedPlan = await outcome(first.owner.checkpoint({ phase: "planned", snapshot }));
  expect(rejectedPlan).toEqual({ ok: false, error: false });
  const firstDrain = await outcome(first.owner.finish());
  expect(firstDrain.ok).toBe(false);
  if (firstDrain.ok) throw new Error("Expected retained false checkpoint failure");
  expect((firstDrain.error as AggregateError).errors).toContain(false);

  const cleanup = subscribedContext("undefined-cleanup", { disposeError: undefined });
  const second = setup(undefined, () => cleanup.context);
  await start(second);
  const rejectedFinish = await outcome(second.owner.checkpoint({ phase: "finished", pass,
    settlement: { state: "held", applied: 0, attemptIds: [], refresh: "not-needed" } }));
  expect(rejectedFinish).toEqual({ ok: false, error: undefined });
  const secondDrain = await outcome(second.owner.finish());
  expect(secondDrain.ok).toBe(false);
  if (secondDrain.ok) throw new Error("Expected retained undefined cleanup failure");
  expect((secondDrain.error as AggregateError).errors).toContain(undefined);
});

test("a disposer reentering finish observes the complete two-context cleanup failure", async () => {
  let owner!: NativeResetChannelOwner, reentered: ReturnType<typeof outcome> | undefined;
  const first = subscribedContext("reentrant-disposer", { onDispose() { reentered = outcome(owner.finish()); } });
  const second = subscribedContext("later-failure", { disposeError: new Error("second stranded cleanup failed") });
  const fixture = setup(undefined, native => native.passId === pass.passId ? first.context : second.context);
  owner = fixture.owner;
  const secondPass: ResetPass = { ...pass, passId: "pass-b", nativeSessionId: "native-b", startedAtMs: 200 };
  await owner.checkpoint({ phase: "started", pass });
  await owner.checkpoint({ phase: "started", pass: secondPass });
  const original = outcome(owner.finish());
  const originalResult = await original;
  if (!reentered) throw new Error("Expected disposal to reenter finish");
  const reenteredResult = await reentered;
  expect(first.record.disposed).toBe(1);
  expect(second.record.disposed).toBe(1);
  expect(originalResult.ok).toBe(false);
  expect(reenteredResult.ok).toBe(false);
  if (originalResult.ok || reenteredResult.ok) throw new Error("Expected complete cleanup failure");
  expect(messages(originalResult.error)).toContain("second stranded cleanup failed");
  expect(messages(reenteredResult.error)).toContain("second stranded cleanup failed");
});
