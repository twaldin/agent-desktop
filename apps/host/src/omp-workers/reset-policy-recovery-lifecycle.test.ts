import { expect, test } from "bun:test";
import type { NativeResetAnswer, ResetPass, ResetPlanSnapshot } from "@oh-my-pi/pi-coding-agent";
import { ResetPolicyChannel, ResetPolicyHostChannel } from "./reset-policy-channel";
import { NativeResetChannelOwner, type NativeResetPassContext } from "./reset-policy-native-owner";
import type { ResetPolicyWireRequest, ResetPolicyWireResult } from "./reset-policy-wire";

const binding = { workerEpoch: "epoch-a", rootSessionId: "root-a" };
const digest = "a".repeat(64);
const permit = { attemptId: "attempt-a", target: { credentialId: 7 }, creditId: "credit-a", redeemRequestId: "request-a" };
const observation = { consumeBoundary: "passed", result: { kind: "outcome", outcome: { ok: true, code: "redeemed" } } } as const;
const identity = { provider: "openai-codex", credentialId: 7, accountId: "account-a", creditId: "credit-a" };
const execute: ResetPolicyWireResult = { kind: "admission.execute", permit, consumeIdentity: identity };
const settled = { state: "settled", applied: 1, attemptIds: ["attempt-a"], refresh: "complete" } as const;

function passOf(passId: string): ResetPass {
  return { passId, nativeSessionId: "native-a", trigger: "blocked", source: "blocked", startedAtMs: 100, provider: "openai-codex", modelId: "gpt-5",
    policy: { autoRedeem: "yes", minBlockedMinutes: 10, keepCredits: 1, salvageHorizonHours: 24 } };
}
function snapshotOf(pass: ResetPass): ResetPlanSnapshot {
  return { reportRevision: digest, pass, plannedAtMs: 101, plan: { actions: [{ reason: "blocked-account", target: { credentialId: 7, accountId: "account-a" },
    accountKey: "key-a", attemptKey: "native-attempt", label: "account-a", availableCount: 2, weeklyUsedFraction: 1, remainingMs: 2000, active: true }], skipped: [] } };
}
const pass = passOf("pass-a");
const snapshot = snapshotOf(pass);

function outcome(promise: Promise<unknown>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}

/** Immediately-observed settlement state, without awaiting anything. */
async function state(promise: Promise<unknown>): Promise<"pending" | "resolved" | "rejected"> {
  let current: "pending" | "resolved" | "rejected" = "pending";
  void promise.then(() => { current = "resolved"; }, () => { current = "rejected"; });
  await Promise.resolve();
  await Promise.resolve();
  return current;
}

test("pause fences ordinary admission while settlements flow, and resume needs an idle live channel", async () => {
  const sent: ResetPolicyWireRequest[] = [];
  const channel = new ResetPolicyChannel(binding, packet => sent.push(packet));
  channel.pause();
  await expect(channel.request("native-a", "pass-a", { kind: "join", joinId: "join-1" })).rejects.toThrow("paused");
  await expect(channel.request("native-a", "pass-a", { kind: "checkpoint", event: { phase: "started", pass } })).rejects.toThrow("paused");
  const completed = channel.request("native-a", "pass-a", { kind: "complete", permit, observation });
  expect(sent.map(packet => packet.operation.kind)).toEqual(["complete"]);
  expect(() => channel.resume()).toThrow("pending");
  channel.receive({ type: "resetPolicyResponse", requestId: sent[0]!.requestId, binding, response: { ok: true, result: { kind: "completed" } } });
  await completed;
  channel.resume();
  const join = channel.request("native-a", "pass-b", { kind: "join", joinId: "join-2" });
  expect(sent.at(-1)?.operation.kind).toBe("join");
  channel.receive({ type: "resetPolicyResponse", requestId: sent.at(-1)!.requestId, binding, response: { ok: true, result: { kind: "joined", observation } } });
  await expect(join).resolves.toEqual({ kind: "joined", observation });
  await expect(channel.finish()).resolves.toBeUndefined();
});

test("transport loss fails ordinary RPCs locally, retains settlements under their IDs, and reconnect retransmits once in order", async () => {
  const sent: ResetPolicyWireRequest[] = [];
  const channel = new ResetPolicyChannel(binding, packet => sent.push(packet));
  const joins = [channel.request("native-a", "pass-a", { kind: "join", joinId: "join-1" }), channel.request("native-a", "pass-b", { kind: "join", joinId: "join-2" })];
  const completed = channel.request("native-a", "pass-a", { kind: "complete", permit, observation });
  const completeId = sent[2]!.requestId;
  const lost = new Error("socket closed");
  channel.transportLost(lost);
  for (const join of joins) await expect(join).rejects.toBe(lost);
  expect(await state(completed)).toBe("pending");
  expect(sent).toHaveLength(3);

  const finished = channel.request("native-a", "pass-a", { kind: "checkpoint", event: { phase: "finished", pass, settlement: settled } });
  await expect(channel.request("native-a", "pass-c", { kind: "join", joinId: "join-3" })).rejects.toBe(lost);
  expect(sent).toHaveLength(3);
  // A reply cannot arrive over a lost transport; a straggler is not trusted.
  channel.receive({ type: "resetPolicyResponse", requestId: completeId, binding, response: { ok: true, result: { kind: "completed" } } });
  expect(await state(completed)).toBe("pending");
  expect(() => channel.resume()).toThrow("not connected");

  channel.reconnect();
  expect(sent.slice(3).map(packet => packet.requestId)).toEqual([completeId, completeId + 1]);
  expect(sent[3]).toBe(sent[2]);
  expect(sent[4]!.operation.kind).toBe("checkpoint");
  channel.reconnect();
  expect(sent).toHaveLength(5);
  const quiet = channel.quiesce();
  expect(await state(quiet)).toBe("pending");
  expect(() => channel.resume()).toThrow("pending");
  channel.receive({ type: "resetPolicyResponse", requestId: completeId, binding, response: { ok: true, result: { kind: "completed" } } });
  channel.receive({ type: "resetPolicyResponse", requestId: completeId + 1, binding, response: { ok: true, result: { kind: "checkpointed" } } });
  await expect(completed).resolves.toEqual({ kind: "completed" });
  await expect(finished).resolves.toEqual({ kind: "checkpointed" });
  await quiet;
  channel.resume();
  const revived = channel.request("native-a", "pass-c", { kind: "join", joinId: "join-3" });
  expect(sent.at(-1)!.requestId).toBe(completeId + 2);
  channel.receive({ type: "resetPolicyResponse", requestId: completeId + 2, binding, response: { ok: true, result: { kind: "joined", observation } } });
  await revived;
  // The interrupted joins were genuine failures and remain in the drain diagnostics.
  const drain = await outcome(channel.finish());
  expect(drain.ok).toBe(false);
  if (drain.ok) throw new Error("unreachable");
  expect(drain.error).toBeInstanceOf(AggregateError);
  expect((drain.error as AggregateError).errors).toEqual([lost]);
  expect((drain.error as AggregateError).message).toContain("(1 failures)");
});

test("a settlement whose send fails after the adapter reports loss is retained, while plain send failure still rejects", async () => {
  let channel!: ResetPolicyChannel;
  let failure: "lost" | "plain" | undefined = "lost";
  const attempts: ResetPolicyWireRequest[] = [];
  channel = new ResetPolicyChannel(binding, packet => {
    attempts.push(packet);
    if (failure === "lost") { channel.transportLost(new Error("write EPIPE")); throw new Error("write EPIPE"); }
    if (failure === "plain") throw new Error("serialization failed");
  });
  const completed = channel.request("native-a", "pass-a", { kind: "complete", permit, observation });
  expect(await state(completed)).toBe("pending");
  failure = undefined;
  channel.reconnect();
  expect(attempts.map(packet => packet.requestId)).toEqual([1, 1]);
  channel.receive({ type: "resetPolicyResponse", requestId: 1, binding, response: { ok: true, result: { kind: "completed" } } });
  await expect(completed).resolves.toEqual({ kind: "completed" });

  failure = "plain";
  await expect(channel.request("native-a", "pass-b", { kind: "complete", permit: { ...permit, attemptId: "attempt-b" }, observation })).rejects.toThrow("serialization failed");
  failure = undefined;
  channel.reconnect();
  expect(attempts).toHaveLength(3);
  await expect(channel.finish()).rejects.toThrow("1 failures");
});

test("reconnect and resume never revive disconnect, finish or close", async () => {
  const closed = new ResetPolicyChannel(binding, () => {});
  const retained = closed.request("native-a", "pass-a", { kind: "complete", permit, observation });
  closed.transportLost(new Error("socket closed"));
  const fatal = new Error("parent replaced");
  closed.disconnect(fatal);
  await expect(retained).rejects.toBe(fatal);
  expect(() => closed.reconnect()).toThrow("disconnected");
  expect(() => closed.resume()).toThrow("closing");

  const sealed = new ResetPolicyChannel(binding, () => {});
  sealed.pause();
  await sealed.finish();
  expect(() => sealed.resume()).toThrow("closing");
  await expect(sealed.request("native-a", "pass-a", { kind: "complete", permit, observation })).rejects.toThrow("closing");

  const closing = new ResetPolicyChannel(binding, () => {});
  closing.pause();
  closing.beginClose();
  expect(() => closing.resume()).toThrow("closing");
});

test("quiesce resolves on settlement regardless of outcome while finish keeps the diagnostics", async () => {
  const sent: ResetPolicyWireRequest[] = [];
  const channel = new ResetPolicyChannel(binding, packet => sent.push(packet));
  await expect(channel.quiesce()).resolves.toBeUndefined();
  const join = channel.request("native-a", "pass-a", { kind: "join", joinId: "join-1" });
  void join.catch(() => {});
  const quiet = channel.quiesce();
  expect(quiet).toBe(channel.quiesce());
  expect(await state(quiet)).toBe("pending");
  channel.receive({ type: "resetPolicyResponse", requestId: sent[0]!.requestId, binding, response: { ok: false, error: { name: "OwnerError", message: "owner refused" } } });
  await expect(join).rejects.toThrow("owner refused");
  await quiet;
  await expect(channel.finish()).rejects.toThrow("1 failures");
});

type Intercept = (request: ResetPolicyWireRequest) => Promise<ResetPolicyWireResult | undefined> | ResetPolicyWireResult | undefined;
type Decide = NativeResetPassContext["runDecision"];

function setup(intercept?: Intercept) {
  const requests: ResetPolicyWireRequest[] = [], attempts: ResetPolicyWireRequest[] = [];
  const contexts: { passId: string; disposed: number }[] = [];
  let offline: Error | undefined, guarded = 0;
  // Default native select: bind, then wait until the owner's signal cancels it.
  const decision: { run: Decide } = { run: async (bind, _select, signal) => {
    await bind("interaction-a");
    signal.throwIfAborted();
    await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } };
  let channel!: ResetPolicyChannel;
  const host = new ResetPolicyHostChannel(binding, async request => {
    requests.push(request);
    const custom = await intercept?.(request);
    if (custom) return custom;
    switch (request.operation.kind) {
      case "checkpoint": return { kind: "checkpointed" };
      case "decision.prepare": return { kind: "decision.prepared", decisionId: "decision-a" };
      case "decision.bind": return { kind: "decision.bound" };
      case "admit": return execute;
      case "complete": return { kind: "completed" };
      default: return { kind: "joined", observation };
    }
  }, response => channel.receive(response));
  channel = new ResetPolicyChannel(binding, request => {
    attempts.push(request);
    if (offline) { channel.transportLost(offline); throw offline; }
    void host.receive(request).catch(() => {});
  });
  const owner = new NativeResetChannelOwner(channel, native => {
    const record = { passId: native.passId, disposed: 0 };
    contexts.push(record);
    const context: NativeResetPassContext = {
      source: { kind: "source", selectionRevision: digest, policyRevision: digest },
      dispose() { record.disposed++; },
      assertCurrent() {},
      async plan() { return { kind: "plan", accounts: [{ provider: "openai-codex", accountId: "account-a", credentialId: 7, credentialFingerprint: digest, authAuthority: "original-auth" }] }; },
      async persistence() { return { kind: "persistence", status: "verified", globalMode: "yes", effectivePolicy: pass.policy, layersUnchanged: true }; },
      async admission() { return { evidence: { kind: "admission", selectionRevision: digest, policyRevision: digest,
        account: { provider: "openai-codex", accountId: "account-a", credentialId: 7, credentialFingerprint: digest, authAuthority: "original-auth" },
        credit: { id: "credit-a", status: "available", fingerprint: digest } }, beforeConsume() { guarded++; return true; } }; },
      runDecision: (bind, select, signal) => decision.run(bind, select, signal),
    };
    return context;
  });
  return { owner, channel, requests, attempts, contexts, decision, guarded: () => guarded,
    goOffline(error: Error) { offline = error; },
    goOnline() { offline = undefined; channel.reconnect(); } };
}

async function start(owner: NativeResetChannelOwner, started: ResetPass = pass) {
  await owner.checkpoint({ phase: "started", pass: started });
  await owner.checkpoint({ phase: "planned", snapshot: snapshotOf(started) });
}

function selectNever(): Promise<NativeResetAnswer> { throw new Error("native select must not run"); }

/** Spins microtasks until the host has received the bind for a pending decision. */
async function bound(requests: ResetPolicyWireRequest[]): Promise<void> {
  for (let spins = 0; spins < 100 && !requests.some(request => request.operation.kind === "decision.bind"); spins++) await Promise.resolve();
  expect(requests.some(request => request.operation.kind === "decision.bind")).toBe(true);
}

function phaseOf(request: ResetPolicyWireRequest | undefined): string | undefined {
  return request?.operation.kind === "checkpoint" ? request.operation.event.phase : request?.operation.kind;
}

test("pause cancels exactly the registered native select, fences the pass, and refuses a pre-pause answer's write authority", async () => {
  const f = setup();
  await start(f.owner);
  let signal: AbortSignal | undefined;
  const run = f.decision.run;
  f.decision.run = (bind, select, given) => { signal = given; return run(bind, select, given); };
  const decision = outcome(f.owner.presentDecision(snapshot, selectNever));
  await bound(f.requests);
  expect(signal?.aborted).toBe(false);
  f.owner.pause();
  expect(signal?.aborted).toBe(true);
  expect((signal?.reason as Error).message).toContain("cancelled by the owner");
  const failed = await decision;
  expect(failed.ok).toBe(false);
  // The user's answer arrived just as the worker paused: native must not gain
  // Settings write authority from it, so it is refused before any journaling.
  await expect(f.owner.checkpoint({ phase: "answer", snapshot, answer: "Yes" })).rejects.toThrow("fenced by pause");
  expect(f.requests.filter(request => phaseOf(request) === "answer")).toHaveLength(0);
  await expect(f.owner.checkpoint({ phase: "answer", snapshot, answer: undefined })).resolves.toBeUndefined();
  expect(phaseOf(f.requests.at(-1))).toBe("answer");
  await expect(f.owner.checkpoint({ phase: "planned", snapshot })).rejects.toThrow("fenced by pause");
  await expect(f.owner.presentDecision(snapshot, selectNever)).rejects.toThrow("fenced by pause");
  await expect(f.owner.admit(snapshot, 0)).rejects.toThrow("fenced by pause");
  expect(f.contexts[0]!.disposed).toBe(0);
  expect(() => f.owner.resume()).toThrow("still holds");
  await f.owner.checkpoint({ phase: "finished", pass, settlement: { state: "cancelled", applied: 0, attemptIds: [], refresh: "not-needed" } });
  expect(f.contexts[0]!.disposed).toBe(1);
  await f.channel.quiesce();
  f.owner.resume();
  f.channel.resume();
  await start(f.owner, passOf("pass-b"));
  expect(f.contexts.map(context => context.passId)).toEqual(["pass-a", "pass-b"]);
});

test("an in-flight pre-pause answer settles the journal but never authorizes the write", async () => {
  const held = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>();
  const f = setup(async request => {
    if (phaseOf(request) === "answer") { reached.resolve(); await held.promise; }
    return undefined;
  });
  await start(f.owner);
  const answer = outcome(f.owner.checkpoint({ phase: "answer", snapshot, answer: "Yes" }));
  await reached.promise;
  f.owner.pause();
  held.resolve();
  const result = await answer;
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect((result.error as Error).message).toContain("fenced by pause");
  expect(phaseOf(f.requests.at(-1))).toBe("answer");
});

test("an admission reply landing after pause yields a refusing permit whose completion still settles", async () => {
  const held = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>();
  const f = setup(async request => {
    if (request.operation.kind === "admit") { reached.resolve(); await held.promise; }
    return undefined;
  });
  await start(f.owner);
  const admitted = f.owner.admit(snapshot, 0);
  await reached.promise;
  f.owner.pause();
  held.resolve();
  const admission = await admitted;
  if (admission.kind !== "execute") throw new Error("Expected the original permit");
  expect(admission.permit.beforeConsume(identity)).toBe(false);
  expect(f.guarded()).toBe(0);
  await f.owner.complete(admission.permit, { consumeBoundary: "refused", result: { kind: "outcome", outcome: { ok: false, code: "guard_refused" } } });
  expect(phaseOf(f.requests.at(-1))).toBe("complete");
  await f.owner.checkpoint({ phase: "finished", pass, settlement: { state: "held", applied: 0, attemptIds: ["attempt-a"], refresh: "not-needed" } });
  expect(f.contexts[0]!.disposed).toBe(1);
  f.owner.resume();
  await expect(f.owner.finish()).resolves.toBeUndefined();
});

test("a join admitted for a pass fenced during admission is never followed", async () => {
  const held = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>();
  const f = setup(async request => {
    if (request.operation.kind === "admit") { reached.resolve(); await held.promise; return { kind: "admission.join", attemptId: "attempt-a", joinId: "join-a" }; }
    return undefined;
  });
  await start(f.owner);
  const admitted = f.owner.admit(snapshot, 0);
  await reached.promise;
  f.owner.pause();
  held.resolve();
  const admission = await admitted;
  if (admission.kind !== "join") throw new Error("Expected the durable join admission");
  expect(admission.attemptId).toBe("attempt-a");
  await expect(admission.settled).rejects.toThrow("fenced by pause");
  expect(f.attempts.some(request => request.operation.kind === "join")).toBe(false);
});

test("pause refuses new capture without touching a finished decision, and resume follows the last original settlement", async () => {
  const f = setup();
  await start(f.owner);
  let signal: AbortSignal | undefined, selected = 0;
  f.decision.run = async (bind, select, given) => { signal = given; await bind("interaction-a"); await select(); };
  await f.owner.presentDecision(snapshot, async () => { selected++; return "No"; });
  expect(selected).toBe(1);
  f.owner.pause();
  expect(signal?.aborted).toBe(false);
  await expect(f.owner.checkpoint({ phase: "started", pass: passOf("pass-b") })).rejects.toThrow("capture is unavailable");
  expect(f.contexts.map(context => [context.passId, context.disposed])).toEqual([["pass-a", 0]]);
  expect(() => f.owner.resume()).toThrow("still holds");
  await f.owner.checkpoint({ phase: "answer", snapshot, answer: undefined });
  await f.owner.checkpoint({ phase: "finished", pass, settlement: { state: "cancelled", applied: 0, attemptIds: [], refresh: "not-needed" } });
  f.owner.resume();
  f.channel.resume();
  await start(f.owner, passOf("pass-b"));
  expect(f.contexts.at(-1)).toEqual({ passId: "pass-b", disposed: 0 });
});


test("transport loss during completion holds the authentic settlement until reconnect delivers the original request", async () => {
  const f = setup();
  await start(f.owner);
  const admission = await f.owner.admit(snapshot, 0);
  if (admission.kind !== "execute") throw new Error("Expected execute");
  expect(admission.permit.beforeConsume(identity)).toBe(true);
  f.goOffline(new Error("socket closed"));
  f.owner.pause();
  const completed = f.owner.complete(admission.permit, { consumeBoundary: "passed", result: { kind: "outcome", outcome: { ok: true, code: "reset", creditId: "credit-a" } } });
  const finished = f.owner.checkpoint({ phase: "finished", pass, settlement: settled });
  expect(await state(completed)).toBe("pending");
  expect(await state(finished)).toBe("pending");
  // The completion send failed and reported loss; the final checkpoint was never attempted offline.
  const envelope = f.attempts.at(-1)!;
  expect(envelope.operation.kind).toBe("complete");
  const attemptedOffline = f.attempts.length;
  expect(f.requests.some(request => request.operation.kind === "complete")).toBe(false);
  f.goOnline();
  await Promise.all([completed, finished]);
  expect(f.attempts[attemptedOffline]).toBe(envelope);
  const delivered = f.requests.filter(request => phaseOf(request) === "complete" || phaseOf(request) === "finished");
  expect(delivered.map(request => [phaseOf(request), request.requestId])).toEqual([["complete", envelope.requestId], ["finished", envelope.requestId + 1]]);
  expect(f.contexts[0]!.disposed).toBe(1);
  await f.channel.quiesce();
  f.owner.resume();
  f.channel.resume();
  // A recovered settlement with nothing interrupted leaves the drain clean.
  await expect(f.owner.finish()).resolves.toBeUndefined();
});
