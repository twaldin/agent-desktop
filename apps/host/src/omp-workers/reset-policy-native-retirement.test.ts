import { expect, test } from "bun:test";
import type { NativeResetAnswer, ResetObservation, ResetPass, ResetPlanSnapshot } from "@oh-my-pi/pi-coding-agent";
import { ResetPolicyChannel, ResetPolicyHostChannel } from "./reset-policy-channel";
import { NativeResetChannelOwner, type NativeResetPassContext } from "./reset-policy-native-owner";
import type { ResetPolicyWireRequest, ResetPolicyWireResult } from "./reset-policy-wire";

const binding = { workerEpoch: "epoch-a", rootSessionId: "root-a" };
const digest = "a".repeat(64);
const identity = { provider: "openai-codex", credentialId: 7, accountId: "account-a", creditId: "credit-a" };
const execute: ResetPolicyWireResult = { kind: "admission.execute",
  permit: { attemptId: "attempt-a", target: { credentialId: 7 }, creditId: "credit-a", redeemRequestId: "request-a" }, consumeIdentity: identity };
const held = { state: "held", applied: 0, attemptIds: [], refresh: "not-needed" } as const;
const refused: ResetObservation = { consumeBoundary: "refused", result: { kind: "outcome", outcome: { ok: false, code: "guard_refused" } } };

/** One native session per owner; `suffix` distinguishes successive passes of the same session. */
function passOf(session: string, suffix = ""): ResetPass {
  return { passId: `pass-${session}${suffix}`, nativeSessionId: `native-${session}`, trigger: "blocked", source: "blocked", startedAtMs: 100,
    provider: "openai-codex", modelId: "gpt-5", policy: { autoRedeem: "yes", minBlockedMinutes: 10, keepCredits: 1, salvageHorizonHours: 24 } };
}
function snapshotOf(session: string, suffix = ""): ResetPlanSnapshot {
  return { reportRevision: digest, pass: passOf(session, suffix), plannedAtMs: 101, plan: { actions: [{ reason: "blocked-account",
    target: { credentialId: 7, accountId: "account-a" }, accountKey: "key-a", attemptKey: "native-attempt", label: "account-a",
    availableCount: 2, weeklyUsedFraction: 1, remainingMs: 2000, active: true }], skipped: [] } };
}

type Intercept = (request: ResetPolicyWireRequest) => Promise<ResetPolicyWireResult | undefined> | ResetPolicyWireResult | undefined;
type OwnerOptions = { disposeErrors?: Record<string, unknown>; onDispose?(): void; onRetiredError?: unknown };
type ContextRecord = { passId: string; disposed: number; signal?: AbortSignal };

/** One shared child channel and host, as in a worker hosting several sessions. */
function setup(intercept?: Intercept) {
  const requests: ResetPolicyWireRequest[] = [];
  let channel!: ResetPolicyChannel;
  const host = new ResetPolicyHostChannel(binding, async request => {
    requests.push(request);
    const custom = await intercept?.(request);
    if (custom) return custom;
    switch (request.operation.kind) {
      case "checkpoint": return { kind: "checkpointed" };
      case "decision.prepare": return { kind: "decision.prepared", decisionId: `decision-${request.passId}` };
      case "decision.bind": return { kind: "decision.bound" };
      case "admit": return execute;
      case "complete": return { kind: "completed" };
      default: throw new Error("Unexpected join");
    }
  }, response => channel.receive(response));
  channel = new ResetPolicyChannel(binding, request => { void host.receive(request).catch(() => {}); });
  const owner = (session: string, options: OwnerOptions = {}) => {
    const contexts: ContextRecord[] = [], record = { retired: 0 };
    let guarded = 0;
    const instance = new NativeResetChannelOwner(channel, native => {
      const context: ContextRecord = { passId: native.passId, disposed: 0 };
      contexts.push(context);
      const captured: NativeResetPassContext = {
        source: { kind: "source", selectionRevision: digest, policyRevision: digest },
        dispose() {
          context.disposed++;
          options.onDispose?.();
          if (options.disposeErrors && Object.hasOwn(options.disposeErrors, native.passId)) throw options.disposeErrors[native.passId];
        },
        assertCurrent() {},
        async plan() { return { kind: "plan", accounts: [{ provider: "openai-codex", accountId: "account-a", credentialId: 7, credentialFingerprint: digest, authAuthority: "original-auth" }] }; },
        async persistence() { return { kind: "persistence", status: "verified", globalMode: "yes", effectivePolicy: native.policy, layersUnchanged: true }; },
        async admission() { return { evidence: { kind: "admission", selectionRevision: digest, policyRevision: digest,
          account: { provider: "openai-codex", accountId: "account-a", credentialId: 7, credentialFingerprint: digest, authAuthority: "original-auth" },
          credit: { id: "credit-a", status: "available", fingerprint: digest } }, beforeConsume() { guarded++; return true; } }; },
        // Bind, then hold the native select until this owner's signal cancels it.
        async runDecision(bind, _select, signal) {
          context.signal = signal;
          await bind(`interaction-${native.passId}`);
          signal.throwIfAborted();
          await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        },
      };
      return captured;
    }, () => {
      record.retired++;
      if (Object.hasOwn(options, "onRetiredError")) throw options.onRetiredError;
    });
    return { owner: instance, contexts, record, guarded: () => guarded };
  };
  /** Operation kinds the host received for one native session, in order. */
  const kinds = (nativeSessionId: string) => requests.filter(request => request.nativeSessionId === nativeSessionId)
    .map(request => request.operation.kind === "checkpoint" ? `checkpoint.${request.operation.event.phase}` : request.operation.kind);
  return { channel, requests, owner, kinds };
}

async function start(owner: NativeResetChannelOwner, session: string, suffix = "") {
  await owner.checkpoint({ phase: "started", pass: passOf(session, suffix) });
  await owner.checkpoint({ phase: "planned", snapshot: snapshotOf(session, suffix) });
}

function selectNever(): Promise<NativeResetAnswer> { throw new Error("native select must not run"); }

function outcome(promise: Promise<unknown>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}

async function state(promise: Promise<unknown>): Promise<"pending" | "settled"> {
  let current: "pending" | "settled" = "pending";
  void promise.then(() => { current = "settled"; }, () => { current = "settled"; });
  for (let spins = 0; spins < 8; spins++) await Promise.resolve();
  return current;
}

/** Spins microtasks until the host has received `count` decision binds. */
async function bound(requests: ResetPolicyWireRequest[], count: number): Promise<void> {
  const binds = () => requests.filter(request => request.operation.kind === "decision.bind").length;
  for (let spins = 0; spins < 200 && binds() < count; spins++) await Promise.resolve();
  expect(binds()).toBe(count);
}

function messages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(messages);
  return [error instanceof Error ? error.message : String(error)];
}

test("a child's local close fences only its own passes while sibling and root keep using the shared channel", async () => {
  const f = setup();
  const root = f.owner("root"), child = f.owner("child"), sibling = f.owner("sibling");
  await Promise.all([start(root.owner, "root"), start(child.owner, "child"), start(sibling.owner, "sibling")]);
  child.owner.beginSessionClose();
  await expect(child.owner.admit(snapshotOf("child"), 0)).rejects.toThrow("fenced by close");
  await expect(child.owner.checkpoint({ phase: "started", pass: passOf("child", "-b") })).rejects.toThrow("capture is unavailable");
  expect(f.kinds("native-child")).toEqual(["checkpoint.started", "checkpoint.planned"]);
  const admitted = await Promise.all([sibling.owner.admit(snapshotOf("sibling"), 0), root.owner.admit(snapshotOf("root"), 0)]);
  expect(admitted.map(admission => admission.kind)).toEqual(["execute", "execute"]);
  // The child's factual settlement still flows and its context is released by that settlement, not by the close.
  await child.owner.checkpoint({ phase: "finished", pass: passOf("child"), settlement: held });
  expect(f.kinds("native-child").at(-1)).toBe("checkpoint.finished");
  expect(child.contexts.map(context => context.disposed)).toEqual([1]);
  await child.owner.retireSession();
  expect(child.record.retired).toBe(1);
  expect(child.contexts.map(context => context.disposed)).toEqual([1]);
  // Retirement never closed the shared channel: a later sibling pass still captures and admits over it.
  await start(sibling.owner, "sibling", "-b");
  expect((await sibling.owner.admit(snapshotOf("sibling", "-b"), 0)).kind).toBe("execute");
});

test("local close cancels only the child's held native select; the sibling's select stays live", async () => {
  const f = setup();
  const child = f.owner("child"), sibling = f.owner("sibling");
  await Promise.all([start(child.owner, "child"), start(sibling.owner, "sibling")]);
  const childDecision = outcome(child.owner.presentDecision(snapshotOf("child"), selectNever));
  const siblingDecision = outcome(sibling.owner.presentDecision(snapshotOf("sibling"), selectNever));
  await bound(f.requests, 2);
  expect(child.contexts[0]!.signal?.aborted).toBe(false);
  child.owner.beginSessionClose();
  expect(child.contexts[0]!.signal?.aborted).toBe(true);
  expect((child.contexts[0]!.signal?.reason as Error).message).toContain("cancelled by the owner");
  expect(sibling.contexts[0]!.signal?.aborted).toBe(false);
  expect((await childDecision).ok).toBe(false);
  expect(await state(siblingDecision)).toBe("pending");
  sibling.owner.beginSessionClose();
  expect((await siblingDecision).ok).toBe(false);
});

test("retirement disposes stranded contexts once under reentry, retains raw cleanup and hook errors, and still notifies onRetired", async () => {
  const f = setup();
  let reentered: Promise<void> | undefined;
  const child = f.owner("child", {
    disposeErrors: { "pass-child": new Error("stranded cleanup failed"), "pass-child-b": undefined },
    onDispose() { reentered ??= child.owner.retireSession(); child.owner.beginSessionClose(); },
    onRetiredError: new Error("retired hook failed"),
  });
  await start(child.owner, "child");
  await child.owner.checkpoint({ phase: "started", pass: passOf("child", "-b") });
  const first = child.owner.retireSession();
  expect(child.owner.retireSession()).toBe(first);
  const result = await outcome(first);
  expect(reentered).toBe(first);
  expect(child.contexts.map(context => context.disposed)).toEqual([1, 1]);
  expect(child.record.retired).toBe(1);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected retained retirement failures");
  expect(result.error).toBeInstanceOf(AggregateError);
  expect((result.error as AggregateError).errors).toContain(undefined);
  expect(messages(result.error)).toContain("stranded cleanup failed");
  expect(messages(result.error)).toContain("retired hook failed");
  // A late final checkpoint after retirement neither redisposes the context nor reaches the host.
  await expect(child.owner.checkpoint({ phase: "finished", pass: passOf("child"), settlement: held })).rejects.toThrow("original captured");
  expect(child.contexts.map(context => context.disposed)).toEqual([1, 1]);
  expect(f.kinds("native-child")).not.toContain("checkpoint.finished");
  const sibling = f.owner("sibling");
  await start(sibling.owner, "sibling");
  expect((await sibling.owner.admit(snapshotOf("sibling"), 0)).kind).toBe("execute");
});

test("a permit issued before local close refuses consume, still completes factually, and cannot complete after retirement", async () => {
  const f = setup();
  const child = f.owner("child");
  await start(child.owner, "child");
  const early = await child.owner.admit(snapshotOf("child"), 0);
  if (early.kind !== "execute") throw new Error("Expected the original permit");
  child.owner.beginSessionClose();
  expect(early.permit.beforeConsume(identity)).toBe(false);
  expect(child.guarded()).toBe(0);
  await child.owner.complete(early.permit, refused);
  await child.owner.checkpoint({ phase: "finished", pass: passOf("child"), settlement: held });
  expect(f.kinds("native-child").slice(-2)).toEqual(["complete", "checkpoint.finished"]);
  expect(child.contexts.map(context => context.disposed)).toEqual([1]);

  const late = f.owner("late");
  await start(late.owner, "late");
  const admitted = await late.owner.admit(snapshotOf("late"), 0);
  if (admitted.kind !== "execute") throw new Error("Expected the original permit");
  await late.owner.retireSession();
  expect(late.contexts.map(context => context.disposed)).toEqual([1]);
  await expect(late.owner.complete(admitted.permit, refused)).rejects.toThrow("retired");
  expect(f.kinds("native-late")).not.toContain("complete");
});

test("whole finish closes the shared channel and joins its drain even after local cleanup fails", async () => {
  const release = Promise.withResolvers<void>();
  const f = setup(async request => { if (request.operation.kind === "complete") await release.promise; return undefined; });
  const root = f.owner("root", { disposeErrors: { "pass-root": new Error("root cleanup failed") } }), sibling = f.owner("sibling");
  await Promise.all([start(root.owner, "root"), start(sibling.owner, "sibling")]);
  const admitted = await sibling.owner.admit(snapshotOf("sibling"), 0);
  if (admitted.kind !== "execute") throw new Error("Expected the original permit");
  const completing = sibling.owner.complete(admitted.permit, refused);
  root.owner.beginClose();
  // Unlike a child's local close, the root's close fences the shared channel for everyone.
  await expect(sibling.owner.admit(snapshotOf("sibling"), 0)).rejects.toThrow("channel is closing");
  const finished = root.owner.finish();
  expect(root.owner.finish()).toBe(finished);
  expect(await state(finished)).toBe("pending");
  expect(root.contexts.map(context => context.disposed)).toEqual([1]);
  expect(root.record.retired).toBe(1);
  release.resolve();
  await completing;
  const result = await outcome(finished);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the retained local cleanup failure");
  expect(messages(result.error)).toContain("root cleanup failed");
  expect(root.record.retired).toBe(1);
  await expect(f.channel.finish()).resolves.toBeUndefined();
});
