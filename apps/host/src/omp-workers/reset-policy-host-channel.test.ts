import { expect, test } from "bun:test";
import { ResetPolicyChannel, ResetPolicyHostChannel } from "./reset-policy-channel";
import {
  RESET_POLICY_MAX_INFLIGHT,
  type ResetPolicyWireBinding,
  type ResetPolicyWireOperation,
  type ResetPolicyWireRequest,
  type ResetPolicyWireResponse,
  type ResetPolicyWireResult,
} from "./reset-policy-wire";

const binding = { workerEpoch: "worker-1", rootSessionId: "root-1" } satisfies ResetPolicyWireBinding;
const permit = { attemptId: "attempt-1", target: { credentialId: 1 }, creditId: "credit-1", redeemRequestId: "redeem-1" };
const observation = { consumeBoundary: "passed", result: { kind: "outcome", outcome: { ok: true, code: "redeemed" } } } as const;

function request(requestId: number, operation: ResetPolicyWireOperation): ResetPolicyWireRequest {
  return { type: "resetPolicyRequest", requestId, binding, nativeSessionId: "native-1", passId: "pass-1", operation };
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

test("composed channels retain the original binding and reject replay", async () => {
  const original = { ...binding };
  const delivered: Promise<void>[] = [];
  const sent: ResetPolicyWireRequest[] = [];
  let child!: ResetPolicyChannel;
  const host = new ResetPolicyHostChannel(original, async packet => {
    expect(packet.binding).toEqual(binding);
    return { kind: "decision.bound" };
  }, response => child.receive(response));
  child = new ResetPolicyChannel(original, packet => {
    sent.push(packet);
    delivered.push(host.receive(packet));
  });
  original.workerEpoch = "replacement";
  original.rootSessionId = "replacement-root";

  await expect(child.request("native-1", "pass-1", { kind: "decision.bind", decisionId: "decision-1", interactionId: "interaction-1" }))
    .resolves.toEqual({ kind: "decision.bound" });
  await Promise.all(delivered);
  await expect(host.receive(sent[0])).rejects.toThrow("already delivered or reordered");
  await Promise.all([child.finish(), host.finish()]);
});

test("nested composed dispatch remains reentrant and drains only after both replies", async () => {
  const delivered: Promise<void>[] = [];
  let child!: ResetPolicyChannel;
  const host = new ResetPolicyHostChannel(binding, async packet => {
    if (packet.operation.kind === "decision.bind" && packet.operation.interactionId === "outer") {
      const joined = await child.request("native-1", "pass-1", { kind: "join", joinId: "inner" });
      expect(joined.kind).toBe("joined");
      return { kind: "decision.bound" };
    }
    if (packet.operation.kind === "join") return { kind: "joined", observation };
    throw new Error("unexpected operation");
  }, response => child.receive(response));
  child = new ResetPolicyChannel(binding, packet => delivered.push(host.receive(packet)));

  await expect(child.request("native-1", "pass-1", { kind: "decision.bind", decisionId: "decision-1", interactionId: "outer" }))
    .resolves.toEqual({ kind: "decision.bound" });
  await Promise.all(delivered);
  await Promise.all([child.finish(), host.finish()]);
});

test("held dispatch and malformed late result keep both drains pending then failed", async () => {
  const held = deferred<ResetPolicyWireResult>();
  const delivered: Promise<void>[] = [];
  let child!: ResetPolicyChannel;
  const host = new ResetPolicyHostChannel(binding, () => held.promise, response => child.receive(response));
  child = new ResetPolicyChannel(binding, packet => delivered.push(host.receive(packet)));
  const operation = child.request("native-1", "pass-1", { kind: "join", joinId: "held" });
  void operation.catch(() => {});
  child.beginClose();
  host.beginClose();
  const childDrain = child.finish();
  const hostDrain = host.finish();
  void childDrain.catch(() => {});
  void hostDrain.catch(() => {});
  let settled = false;
  void Promise.allSettled([childDrain, hostDrain]).then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);

  held.resolve({ kind: "completed", extra: true } as unknown as ResetPolicyWireResult);
  await expect(operation).rejects.toThrow("extra");
  await Promise.allSettled(delivered);
  await expect(childDrain).rejects.toThrow("did not drain cleanly");
  await expect(hostDrain).rejects.toThrow("did not drain cleanly");
});

test("normal and refusal response send failures remain host drain failures", async () => {
  const ordinary = new ResetPolicyHostChannel(binding, async () => ({ kind: "decision.bound" }), () => {
    throw new Error("normal response send failed");
  });
  await expect(ordinary.receive(request(1, { kind: "decision.bind", decisionId: "decision-1", interactionId: "interaction-1" })))
    .rejects.toThrow("normal response send failed");
  await expect(ordinary.finish()).rejects.toThrow("did not drain cleanly");

  let handled = false;
  const refusing = new ResetPolicyHostChannel(binding, async () => {
    handled = true;
    return { kind: "decision.bound" };
  }, () => { throw new Error("refusal send failed"); });
  refusing.beginClose();
  await expect(refusing.receive(request(1, { kind: "decision.bind", decisionId: "decision-1", interactionId: "interaction-1" })))
    .rejects.toThrow("refusal send failed");
  expect(handled).toBe(false);
  await expect(refusing.finish()).rejects.toThrow("did not drain cleanly");
});

test("ordinary capacity and settlement reserve are independent and bounded", async () => {
  const held = new Map<number, ReturnType<typeof deferred<ResetPolicyWireResult>>>();
  const responses: ResetPolicyWireResponse[] = [];
  const host = new ResetPolicyHostChannel(binding, packet => {
    const item = deferred<ResetPolicyWireResult>();
    held.set(packet.requestId, item);
    return item.promise;
  }, response => responses.push(response));
  const receives: Promise<void>[] = [];
  let id = 0;
  for (let index = 0; index < RESET_POLICY_MAX_INFLIGHT; index++) {
    receives.push(host.receive(request(++id, { kind: "join", joinId: `join-${index}` })));
  }
  for (let index = 0; index < RESET_POLICY_MAX_INFLIGHT; index++) {
    receives.push(host.receive(request(++id, { kind: "complete", permit: { ...permit, attemptId: `attempt-${index}` }, observation })));
  }
  await host.receive(request(++id, { kind: "join", joinId: "ordinary-overflow" }));
  await host.receive(request(++id, { kind: "complete", permit: { ...permit, attemptId: "settlement-overflow" }, observation }));
  expect(held.size).toBe(RESET_POLICY_MAX_INFLIGHT * 2);
  expect(responses.map(item => item.response.ok ? "ok" : item.response.error.message)).toEqual([
    "Reset-policy owner capacity exceeded",
    "Reset-policy owner capacity exceeded",
  ]);

  const drain = host.finish();
  let drained = false;
  void drain.then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  for (const [requestId, item] of held) item.resolve(requestId <= RESET_POLICY_MAX_INFLIGHT
    ? { kind: "joined", observation }
    : { kind: "completed" });
  await Promise.all(receives);
  await drain;
  expect(responses).toHaveLength(RESET_POLICY_MAX_INFLIGHT * 2 + 2);
});

test("successful closing refusal reaches the child and does not fabricate host failure", async () => {
  const delivered: Promise<void>[] = [];
  let child!: ResetPolicyChannel;
  const host = new ResetPolicyHostChannel(binding, async () => {
    throw new Error("handler must not run");
  }, response => child.receive(response));
  child = new ResetPolicyChannel(binding, packet => delivered.push(host.receive(packet)));
  host.beginClose();
  const operation = child.request("native-1", "pass-1", { kind: "decision.bind", decisionId: "decision-1", interactionId: "interaction-1" });
  void operation.catch(() => {});
  await expect(operation).rejects.toThrow("owner is closing");
  await Promise.all(delivered);
  await host.finish();
  await expect(child.finish()).rejects.toThrow("did not drain cleanly");
});
