import { expect, test } from "bun:test";
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

function setup(custom?: (request: ResetPolicyWireRequest) => Promise<ResetPolicyWireResult> | ResetPolicyWireResult) {
  const binding = { workerEpoch: "epoch-a", rootSessionId: "root-a" }, requests: ResetPolicyWireRequest[] = [];
  let current = true, captures = 0, guarded = 0;
  const context: NativeResetPassContext = {
    source: { kind: "source", selectionRevision: digest, policyRevision: digest },
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
  const owner = new NativeResetChannelOwner(channel, () => { captures++; return context; });
  return { owner, context, requests, captures: () => captures, guarded: () => guarded, invalidate: () => { current = false; } };
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
