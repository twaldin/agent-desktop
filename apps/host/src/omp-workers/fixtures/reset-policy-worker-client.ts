import { appendFileSync } from "node:fs";
import { WORKER_PROTOCOL_VERSION, type ParentMessage, type SessionSnapshot, type WorkerInit } from "../protocol";
import type { ResetPolicyWireBinding, ResetPolicyWireOperation, ResetPolicyWireResponse } from "../reset-policy-wire";

const logPath = process.env.RESET_POLICY_WORKER_LOG!;
const scenario = process.env.RESET_POLICY_WORKER_SCENARIO ?? "normal";
const unavailable = { availability: "unsupported", reason: "Controlled reset-policy worker" } as const;
let binding: ResetPolicyWireBinding | undefined;
let nextResetId = 0;
let disposeId: string | undefined;
const resetReplies = new Map<number, ReturnType<typeof Promise.withResolvers<ResetPolicyWireResponse["response"]>>>();

function record(event: string, value: unknown = undefined): void {
  appendFileSync(logPath, `${JSON.stringify({ event, ...(value === undefined ? {} : { value }) })}\n`);
}

function snapshot(cwd: string): SessionSnapshot {
  return { revision: 1, id: "reset-policy-root", sessionFile: `${cwd}/session.jsonl`, cwd, model: null,
    isStreaming: false, hasPostPromptWork: false, createdAt: 1,
    activity: { goal: unavailable, agents: unavailable, jobs: unavailable, sources: unavailable } };
}

async function reset(operation: ResetPolicyWireOperation): Promise<ResetPolicyWireResponse["response"]> {
  if (!binding) throw new Error("Reset-policy binding is unavailable");
  const requestId = ++nextResetId;
  const pending = Promise.withResolvers<ResetPolicyWireResponse["response"]>();
  resetReplies.set(requestId, pending);
  process.send!({ type: "resetPolicyRequest", binding, requestId, nativeSessionId: binding.rootSessionId,
    passId: "pass-1", operation });
  return pending.promise;
}

async function initialize(id: string, init: WorkerInit): Promise<void> {
  record("init", { mode: init.mode, resetPolicy: init.resetPolicy });
  if (init.mode === "create" || init.mode === "open") {
    if (!init.resetPolicy?.workerEpoch) throw new Error("Configured session omitted reset-policy epoch");
    const cwd = init.mode === "create" ? init.options.cwd : init.options.expectedIdentity!.cwd;
    binding = { workerEpoch: init.resetPolicy.workerEpoch, rootSessionId: "reset-policy-root" };
    const before = await reset({ kind: "decision.bind", decisionId: "before-init", interactionId: "before-init" });
    record("before-init-response", before);
    process.send!({ type: "response", id, ok: true, snapshot: snapshot(scenario === "bad-identity" ? `${cwd}/changed` : cwd) });
    return;
  }
  if (init.resetPolicy) throw new Error(`${init.mode} unexpectedly received reset-policy configuration`);
  if (init.mode === "browser" || init.mode === "mcp-owner") {
    process.send!({ type: "response", id, ok: true, value: { ownerId: init.owner.id, cwd: init.owner.cwd } });
  } else process.send!({ type: "response", id, ok: true });
}

async function handle(message: ParentMessage): Promise<void> {
  if (message.type === "resetPolicyResponse") {
    const pending = resetReplies.get(message.requestId);
    if (pending) { resetReplies.delete(message.requestId); pending.resolve(message.response); }
    return;
  }
  if (message.type === "disposeAck" && message.id === disposeId) {
    record("dispose-ack");
    process.exit(0);
  }
  if (message.type !== "request") return;
  if (message.operation === "init") { await initialize(message.id, message.args); return; }
  if (message.operation === "getMessages") {
    if (scenario === "loss") { record("disconnect"); setInterval(() => {}, 60_000); process.disconnect(); return; }
    const active = await reset({ kind: "decision.bind", decisionId: "active", interactionId: "active" });
    record("active-response", active);
    process.send!({ type: "response", id: message.id, ok: true, value: [] });
    return;
  }
  if (message.operation === "listModels") { process.send!({ type: "response", id: message.id, ok: true, value: [] }); return; }
  if (message.operation === "dispose") {
    if (binding) {
      const settlement = await reset({ kind: "complete",
        permit: { attemptId: "attempt-1", target: { credentialId: 1 }, creditId: "credit-1", redeemRequestId: "redeem-1" },
        observation: { consumeBoundary: "passed", result: { kind: "outcome", outcome: { ok: true, code: "redeemed" } } } });
      record("settlement-response", settlement);
    }
    disposeId = message.id;
    process.send!({ type: "response", id: message.id, ok: true });
  }
}

process.on("message", (message: ParentMessage) => { void handle(message).catch(error => {
  record("fixture-error", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(70);
}); });
process.send!({ type: "ready", version: WORKER_PROTOCOL_VERSION });
