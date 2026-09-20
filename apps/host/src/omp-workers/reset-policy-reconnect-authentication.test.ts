import { afterEach, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { WorkerClient, type WorkerRuntimeOptions } from "./runtime";
import { WORKER_PROTOCOL_VERSION, type ParentMessage, type SessionSnapshot } from "./protocol";
import { WorkerReconnectServer, type WorkerResetPolicyReconnect } from "./reconnect-wire";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function peer(change?: (frame: Record<string, unknown>) => Record<string, unknown>, busy = false) {
  const root = await mkdtemp("/tmp/reset-auth-");
  const binding: WorkerResetPolicyReconnect = { workerEpoch: randomUUID(), rootSessionId: randomUUID(), sessionFile: path.join(root, "session.jsonl"), cwd: root };
  const snapshot: SessionSnapshot = { revision: 1, id: binding.rootSessionId, sessionFile: binding.sessionFile, cwd: root,
    model: null, isStreaming: busy, hasPostPromptWork: false, createdAt: 1,
    activity: { goal: { availability: "available", value: null }, jobs: { availability: "available", value: { running: [], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } } },
      agents: { availability: "available", value: [] }, sources: { availability: "available", value: [] } } };
  const instanceId = randomUUID(), trace: string[] = [];
  let server!: WorkerReconnectServer, acknowledged = false;
  server = await WorkerReconnectServer.listen({ socketPath: path.join(root, "socket"), token: randomBytes(32).toString("hex"), instanceId, resetPolicy: binding }, value => {
    const message = value as ParentMessage;
    if (message.type === "resetPolicyReconnect") {
      trace.push("reconnect");
      if (acknowledged) server.send({ type: "resetPolicyQuiescent", binding, snapshot });
    } else if (message.type === "resetPolicyResponse") {
      acknowledged = true;
      trace.push(message.response.ok ? "settlement-ack" : "settlement-refused");
      if (trace.includes("reconnect")) server.send({ type: "resetPolicyQuiescent", binding, snapshot });
    } else if (message.type === "resetPolicyResume") {
      trace.push("resume"); server.send({ type: "resetPolicyResumed", binding, snapshot });
    } else if (message.type === "request") {
      server.send({ type: "response", id: "1", ok: true, value: "old original RPC result" });
      server.send({ type: "response", id: message.id, ok: true, value: "current RPC result" });
    }
  }, () => {
    const frame = { type: "recovered", version: WORKER_PROTOCOL_VERSION, pid: process.pid, instanceId, resetPolicy: binding, snapshot };
    return change ? change(frame) : frame;
  });
  server.send({ type: "resetPolicyRequest", requestId: 17, binding: { workerEpoch: binding.workerEpoch, rootSessionId: binding.rootSessionId },
    nativeSessionId: binding.rootSessionId, passId: "original-pass", operation: { kind: "complete",
      permit: { attemptId: "original-attempt", target: { credentialId: 1 }, creditId: "original-credit", redeemRequestId: "original-request" },
      observation: { consumeBoundary: "passed", result: { kind: "outcome", outcome: { ok: true, code: "reset" } } } } });
  cleanup.push(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  return { server, binding, snapshot, trace };
}

function ownerOptions(trace: string[]) {
  let lost = 0, exited = 0;
  const failed = Promise.withResolvers<void>();
  const options: WorkerRuntimeOptions = { startupTimeoutMs: 1000, onWorkerFailure: () => failed.resolve(), createResetPolicyOwner: context => {
    trace.push(`owner:${context.workerEpoch}`);
    return { async handle(request) {
      expect(request.binding.workerEpoch).toBe(context.workerEpoch);
      expect(request.binding.rootSessionId).toBe(context.snapshot.id);
      trace.push(`handle:${request.requestId}`);
      return { kind: "completed" };
    }, beginClose() {}, workerLost() { lost++; }, workerExited() { exited++; }, async drain() { trace.push("drain"); } };
  } };
  return { options, failed: failed.promise, counts: () => ({ lost, exited }) };
}

test("source-bound recovered owner is installed before queued settlement dispatch and before resume", async () => {
  const p = await peer(), owner = ownerOptions(p.trace);
  const client = await WorkerClient.recover(owner.options, p.server.endpoint);
  expect(p.trace).toEqual([`owner:${p.binding.workerEpoch}`, "handle:17", "reconnect", "settlement-ack", "drain", "resume"]);
  expect(client.snapshot?.id).toBe(p.binding.rootSessionId);
  await client.abandonRecoveryAttempt();
  expect(owner.counts()).toEqual({ lost: 1, exited: 0 });
});

test("authenticated reconnect rejects forged PID, epoch and original snapshot before any owner or queued callback exists", async () => {
  const changes = [
    (frame: Record<string, unknown>) => ({ ...frame, pid: process.pid + 1 }),
    (frame: Record<string, unknown>) => ({ ...frame, resetPolicy: { ...(frame.resetPolicy as object), workerEpoch: "replacement" } }),
    (frame: Record<string, unknown>) => ({ ...frame, snapshot: { ...(frame.snapshot as object), sessionFile: "/replacement.jsonl" } }),
    (frame: Record<string, unknown>) => ({ ...frame, snapshot: { ...(frame.snapshot as object), cwd: "/replacement" } }),
  ];
  for (const change of changes) {
    const p = await peer(change), owner = ownerOptions(p.trace);
    await expect(WorkerClient.recover(owner.options, p.server.endpoint)).rejects.toThrow(/identity changed|binding changed|snapshot changed/);
    expect(p.trace).toEqual([]);
    expect(owner.counts()).toEqual({ lost: 0, exited: 0 });
  }
});

test("socket closure is worker loss, not confirmed exit, and does not fabricate an exit drain", async () => {
  const p = await peer(), owner = ownerOptions(p.trace);
  const client = await WorkerClient.recover(owner.options, p.server.endpoint);
  await p.server.close();
  await owner.failed;
  expect(owner.counts()).toEqual({ lost: 1, exited: 0 });
  await client.abandonRecoveryAttempt();
  expect(owner.counts()).toEqual({ lost: 1, exited: 0 });
});

test("native busy recovery remains rejected and never receives admission resume", async () => {
  const p = await peer(undefined, true), owner = ownerOptions(p.trace);
  await expect(WorkerClient.recover(owner.options, p.server.endpoint)).rejects.toThrow("native work in flight");
  expect(p.trace).not.toContain("resume");
  expect(owner.counts().exited).toBe(0);
});

test("two independently authenticated original workers never select each other's owner from packet identifiers", async () => {
  const first = await peer(), second = await peer();
  const owners = [ownerOptions(first.trace), ownerOptions(second.trace)];
  const clients = await Promise.all([WorkerClient.recover(owners[0]!.options, first.server.endpoint), WorkerClient.recover(owners[1]!.options, second.server.endpoint)]);
  first.server.send({ type: "resetPolicyRequest", requestId: 18, binding: { workerEpoch: second.binding.workerEpoch, rootSessionId: second.binding.rootSessionId },
    nativeSessionId: second.binding.rootSessionId, passId: "foreign-pass", operation: { kind: "join", joinId: "foreign-join" } });
  await owners[0]!.failed;
  expect(first.trace).not.toContain("handle:18");
  expect(second.trace).not.toContain("handle:18");
  expect(clients[1]!.failure).toBeUndefined();
  await Promise.all(clients.map(client => client.abandonRecoveryAttempt().catch(() => {})));
  expect(owners.map(owner => owner.counts().exited)).toEqual([0, 0]);
});

test("a late original RPC response cannot satisfy a new recovered host request", async () => {
  const p = await peer(), owner = ownerOptions(p.trace);
  const client = await WorkerClient.recover(owner.options, p.server.endpoint);
  try {
    expect(await client.request<unknown>({ operation: "getControls" })).toBe("current RPC result");
  } finally { await client.abandonRecoveryAttempt(); }
});

test("a live recovered PID and disposal ACK never substitute for confirmed process exit", async () => {
  const p = await peer(), owner = ownerOptions(p.trace);
  const client = await WorkerClient.recover({ ...owner.options, shutdownTimeoutMs: 1 }, p.server.endpoint);
  try {
    await expect(client.close({ requireAcknowledgement: true })).rejects.toThrow();
    expect(process.kill(p.server.endpoint.pid, 0)).toBe(true);
    expect(owner.counts().exited).toBe(0);
  } finally { await client.abandonRecoveryAttempt(); }
}, 40_000);
