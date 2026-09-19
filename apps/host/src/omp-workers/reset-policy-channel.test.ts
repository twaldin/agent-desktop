import { expect, test } from "bun:test";
import { ResetPolicyChannel } from "./reset-policy-channel";
import { RESET_POLICY_MAX_INFLIGHT, type ResetPolicyWireRequest, type ResetPolicyWireResult } from "./reset-policy-wire";

const binding = { workerEpoch: "worker-1", rootSessionId: "root-1" };
const permit = { attemptId: "attempt-1", target: { credentialId: 1 }, creditId: "credit-1", redeemRequestId: "redeem-1" };
const observation = { consumeBoundary: "passed", result: { kind: "outcome", outcome: { ok: true, code: "redeemed" } } } as const;
const pass = { passId: "pass-1", nativeSessionId: "native-1", trigger: "blocked", source: "blocked", startedAtMs: 1,
  provider: "openai-codex", modelId: "model", policy: { autoRedeem: "yes", minBlockedMinutes: 1, keepCredits: 1, salvageHorizonHours: 1 } } as const;
const finished = { kind: "checkpoint", event: { phase: "finished", pass, settlement: {
  state: "settled", applied: 1, attemptIds: [permit.attemptId], refresh: "complete",
} } } as const;
function reply(channel: ResetPolicyChannel, request: ResetPolicyWireRequest, result: ResetPolicyWireResult): void {
  channel.receive({ type: "resetPolicyResponse", requestId: request.requestId, binding, response: { ok: true, result } });
}

test("full ordinary join queue cannot starve completion and final checkpoint during close", async () => {
  const sent: ResetPolicyWireRequest[] = [];
  const channel = new ResetPolicyChannel(binding, packet => sent.push(packet));
  const joins = Array.from({ length: RESET_POLICY_MAX_INFLIGHT }, (_, index) => channel.request("native-1", "pass-1", { kind: "join", joinId: `join-${index}` }));
  await expect(channel.request("native-1", "pass-1", { kind: "join", joinId: "overflow" })).rejects.toThrow("capacity");
  channel.beginClose();
  await expect(channel.request("native-1", "pass-1", { kind: "checkpoint", event: { phase: "started", pass } })).rejects.toThrow("closing");
  const completed = channel.request("native-1", "pass-1", { kind: "complete", permit, observation });
  const checkpoint = channel.request("native-1", "pass-1", finished);
  expect(sent.length).toBe(RESET_POLICY_MAX_INFLIGHT + 2);
  const drain = channel.finish();
  let drained = false;
  void drain.then(() => { drained = true; });
  reply(channel, sent.at(-2)!, { kind: "completed" });
  reply(channel, sent.at(-1)!, { kind: "checkpointed" });
  await Promise.all([completed, checkpoint]);
  expect(drained).toBe(false);
  for (const request of sent.slice(0, RESET_POLICY_MAX_INFLIGHT)) reply(channel, request, { kind: "joined", observation });
  await Promise.all(joins);
  await drain;
  expect(drained).toBe(true);
});

test("close reserve is independently bounded, and finish forbids additional producers", async () => {
  const sent: ResetPolicyWireRequest[] = [];
  const channel = new ResetPolicyChannel(binding, packet => sent.push(packet));
  channel.beginClose();
  const pending = Array.from({ length: RESET_POLICY_MAX_INFLIGHT }, () => channel.request("native-1", "pass-1", { kind: "complete", permit, observation }));
  await expect(channel.request("native-1", "pass-1", finished)).rejects.toThrow("capacity");
  const drain = channel.finish();
  await expect(channel.request("native-1", "pass-1", finished)).rejects.toThrow("closing");
  for (const request of sent) reply(channel, request, { kind: "completed" });
  await Promise.all(pending);
  await drain;
});

test("synchronous reply cannot erase the enclosing send failure", async () => {
  let channel: ResetPolicyChannel;
  channel = new ResetPolicyChannel(binding, packet => {
    reply(channel, packet, { kind: "completed" });
    throw new Error("send failed after delivery");
  });
  await expect(channel.request("native-1", "pass-1", { kind: "complete", permit, observation })).rejects.toThrow("send failed after delivery");
  await expect(channel.finish()).rejects.toThrow("did not drain cleanly");
});

test("matches response kind to original request and retains owner rejection for drain", async () => {
  const sent: ResetPolicyWireRequest[] = [];
  const channel = new ResetPolicyChannel(binding, packet => sent.push(packet));
  const mismatch = channel.request("native-1", "pass-1", { kind: "join", joinId: "join-1" });
  void mismatch.catch(() => {});
  reply(channel, sent[0]!, { kind: "completed" });
  await expect(mismatch).rejects.toThrow("does not match");
  const operation = channel.request("native-1", "pass-1", finished);
  void operation.catch(() => {});
  channel.receive({ type: "resetPolicyResponse", requestId: sent[1]!.requestId, binding,
    response: { ok: false, error: { name: "OwnerError", message: "durable write failed" } } });
  await expect(operation).rejects.toThrow("durable write failed");
  await expect(channel.finish()).rejects.toThrow("did not drain cleanly");
});

test("foreign binding fails all original waiters and cannot revive after disconnect", async () => {
  const sent: ResetPolicyWireRequest[] = [];
  const channel = new ResetPolicyChannel(binding, packet => sent.push(packet));
  const operation = channel.request("native-1", "pass-1", { kind: "join", joinId: "join-1" });
  void operation.catch(() => {});
  channel.receive({ type: "resetPolicyResponse", requestId: sent[0]!.requestId, binding: { ...binding, workerEpoch: "replacement" }, response: { ok: true, result: { kind: "joined", observation } } });
  await expect(operation).rejects.toThrow("foreign worker binding");
  reply(channel, sent[0]!, { kind: "joined", observation });
  await expect(channel.request("native-1", "pass-1", finished)).rejects.toThrow("foreign worker binding");
  await expect(channel.finish()).rejects.toThrow("did not drain cleanly");
});

test("unknown and duplicate replies do not settle another pass", async () => {
  const sent: ResetPolicyWireRequest[] = [];
  const channel = new ResetPolicyChannel(binding, packet => sent.push(packet));
  const one = channel.request("native-1", "pass-1", { kind: "complete", permit, observation });
  const two = channel.request("native-1", "pass-2", { kind: "complete", permit: { ...permit, attemptId: "attempt-2" }, observation });
  let secondSettled = false;
  void two.then(() => { secondSettled = true; });
  reply(channel, { ...sent[0]!, requestId: 100 }, { kind: "completed" });
  reply(channel, sent[0]!, { kind: "completed" });
  reply(channel, sent[0]!, { kind: "completed" });
  await one;
  expect(secondSettled).toBe(false);
  reply(channel, sent[1]!, { kind: "completed" });
  await two;
  await channel.finish();
});

test("drain diagnostics retain a bounded sample and report every failure", async () => {
  const sent: ResetPolicyWireRequest[] = [];
  const channel = new ResetPolicyChannel(binding, packet => sent.push(packet));
  const failureCount = RESET_POLICY_MAX_INFLIGHT + 2;
  for (let index = 0; index < failureCount; index++) {
    const operation = channel.request("native-1", `pass-${index}`, { kind: "join", joinId: `join-${index}` });
    void operation.catch(() => {});
    reply(channel, sent[index]!, { kind: "completed" });
    await expect(operation).rejects.toThrow("does not match");
  }
  const drain = channel.finish();
  void drain.catch(() => {});
  try {
    await drain;
    throw new Error("expected channel drain to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(RESET_POLICY_MAX_INFLIGHT);
    expect((error as AggregateError).message).toContain(`(${failureCount} failures)`);
  }
});
