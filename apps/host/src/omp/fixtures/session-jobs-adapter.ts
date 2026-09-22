// Controlled public-native jobs adapter fixture. No external provider request; HOME and
// the agent directory are disposable. Every job row, flag and control goes
// through the real native session and its real AsyncJobManager. Job bodies and
// initial delivery are gated; a local provider settles native idle continuations.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Api } from "@oh-my-pi/pi-ai";
import type { SessionJobsRequest, SessionJobsResult, SessionJobTarget } from "@agent-desktop/shared";

let blockedFetches = 0;
globalThis.fetch = Object.assign(async () => {
  blockedFetches++; throw new Error("Network is disabled in the native jobs fixture");
}, { preconnect: () => { throw new Error("Preconnect is disabled in the native jobs fixture"); } }) as typeof fetch;

const directory = process.argv[2]!;
assert.equal(process.env.HOME, directory);
const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
const config = "extensions: []\ndefaultThinkingLevel: low\n";
const configPath = path.join(agentDir, "config.yml"); await writeFile(configPath, config);
await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "jobs-fixture": {
  api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", auth: "none",
  models: [{ id: "base", name: "Local non-executing base", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
// Deferred on purpose: the native package reads HOME/agent configuration at import time.
const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
const { NativeSessionJobs, NativeJobsError } = await import("../session-jobs");
const { SESSION_JOBS_MAX_OUTPUT_CHARS, SESSION_JOBS_MAX_RUNNING } = await import("@agent-desktop/shared");

const auth = await discoverAuthStorage(agentDir), settings = await Settings.loadReadOnly({ agentDir, cwd });
const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
// Native delivery can wake an idle agent. Give that real loop a bounded local
// provider response instead of pointing it at a deliberately blocked network.
const { AssistantMessageEventStream } = await import("@oh-my-pi/pi-ai/utils/event-stream");
let providerCalls = 0;
registry.registerProvider("jobs-fixture", {
  api: "jobs-fixture-api" as Api, baseUrl: "https://controlled.invalid", apiKey: "isolated-jobs-fixture-key",
  models: [{ id: "base", name: "Controlled native job continuation", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple(model) {
    providerCalls++;
    const stream = new AssistantMessageEventStream();
    const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "Background result received." }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "stop" as const, timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  },
});
const manager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
const created = await createAgentSession({ agentDir, cwd, settings, authStorage: auth, modelRegistry: registry, agentRegistry: new AgentRegistry(),
  sessionManager: manager, model: registry.find("jobs-fixture", "base"), extensions: [], hasUI: false, interactivePrompts: false, deferUsageReserveConfirmation: true });
const session = created.session;
const jobs = session.asyncJobManager; assert.ok(jobs, "the first top-level native session owns the AsyncJobManager");
const ownerId = session.getAgentId(); assert.ok(ownerId, "the main native session has a truthy agent id");

const state = { retired: false };
const adapter = new NativeSessionJobs(session, () => { if (state.retired) throw new Error("The original native session owner has retired."); });
const owner = adapter.owner;
const read = () => { const value = adapter.request({ action: "read" }); assert.equal(value.action, "read"); assert.equal(value.snapshot.availability, "available"); return value.snapshot; };
const rows = () => { const snapshot = read(); return snapshot.availability === "available" ? [...snapshot.running, ...snapshot.recent] : []; };
const rowOf = (id: string) => { const row = rows().find(row => row.target.id === id); assert.ok(row, `job ${id} is visible`); return row; };
const control = (action: "inspect" | "cancel", job: SessionJobTarget, requestOwner = owner): SessionJobsResult => adapter.request({ action, owner: requestOwner, job } as SessionJobsRequest);
const refuses = (work: () => unknown, code: "STALE_OWNER" | "STALE_JOB" | "JOBS_REJECTED") => {
  try { work(); } catch (error) { assert.ok(error instanceof NativeJobsError && error.code === code, `expected ${code}, got ${String(error)}`); return; }
  assert.fail(`expected ${code} refusal`);
};
const gate = <T,>() => Promise.withResolvers<T>();
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const result: Record<string, unknown> = {};
const releaseDelivery = gate<void>();
const originalEnqueue = session.yieldQueue.enqueueWithReceipt;

try {
  // Foreign owner: the SDK's own snapshot scope is the adapter's scope; forged targets never resolve.
  const foreignGate = gate<string>();
  const foreignId = jobs.register("bash", "foreign", () => foreignGate.promise, { ownerId: "Other" });
  const foreignJob = jobs.getJob(foreignId)!;
  assert.ok(!session.getAsyncJobSnapshot()!.running.some(job => job.id === foreignId), "the SDK snapshot hides the foreign job");
  assert.ok(!rows().some(row => row.target.id === foreignId));
  const forged = { id: foreignId, startTime: foreignJob.startTime, guard: "forged" };
  refuses(() => control("inspect", forged), "STALE_JOB");
  refuses(() => control("cancel", forged), "STALE_JOB");
  assert.equal(foreignJob.status, "running", "a refused cancel leaves the foreign job untouched");
  refuses(() => adapter.request({ action: "read", owner: { ...owner, epoch: "other-generation" } }), "STALE_OWNER");
  refuses(() => adapter.request({ action: "read", owner: { nativeSessionId: owner.nativeSessionId, epoch: owner.epoch } }), "STALE_OWNER");
  refuses(() => adapter.request({ action: "read", owner: { ...owner, nativeSessionId: "other-session" } }), "STALE_OWNER");
  refuses(() => adapter.request({ action: "cancel", owner } as never), "JOBS_REJECTED");
  state.retired = true; refuses(() => adapter.request({ action: "read" }), "STALE_OWNER"); state.retired = false;
  const second = new NativeSessionJobs(session, () => {});
  assert.notEqual(second.owner.epoch, owner.epoch, "each adapter is its own owner generation");
  result.foreign = { hidden: true, ownerId, agentId: owner.agentId };

  // Queued is a flag on a running row that the native body clears through markRunning().
  const queuedStart = gate<void>(), queuedGate = gate<string>();
  const queuedId = jobs.register("task", "Indexer", async ({ markRunning }) => { await queuedStart.promise; markRunning(); return queuedGate.promise; }, { ownerId, agentId: "Indexer", queued: true });
  const parked = rowOf(queuedId);
  assert.deepEqual({ status: parked.status, queued: parked.queued, agentId: parked.agentId, type: parked.type }, { status: "running", queued: true, agentId: "Indexer", type: "task" });
  queuedStart.resolve(); await tick();
  const started = rowOf(queuedId);
  assert.deepEqual({ status: started.status, queued: started.queued, guard: started.target.guard }, { status: "running", queued: false, guard: parked.target.guard });
  result.queued = { parked: parked.queued, started: started.queued };

  // Cancellation is an abort request before the body settles; it is never a completion claim.
  const runningGate = gate<string>();
  let aborted = false, settled = false;
  const runningId = jobs.register("bash", "sleep", ({ signal }) => { signal.addEventListener("abort", () => { aborted = true; }); return runningGate.promise.finally(() => { settled = true; }); }, { ownerId });
  const running = rowOf(runningId);
  const cancelled = control("cancel", running.target);
  assert.equal(cancelled.action, "cancel"); assert.equal(cancelled.requested, true);
  const abortedBeforeSettle = aborted && !settled;
  assert.deepEqual({ aborted, settled, status: jobs.getJob(runningId)!.status }, { aborted: true, settled: false, status: "cancelled" });
  const afterCancel = rowOf(runningId);
  assert.equal(afterCancel.status, "cancelled"); assert.equal(afterCancel.target.guard, running.target.guard);
  const again = control("cancel", running.target);
  assert.equal(again.action, "cancel"); assert.equal(again.requested, false, "a settled or already-cancelled job cannot be cancelled again");
  runningGate.resolve("late output"); await jobs.getJob(runningId)!.promise;
  assert.ok(!jobs.getDeliveryState({ ownerId }).pendingJobIds.includes(runningId), "cancelled jobs never deliver");
  const lateInspect = control("inspect", running.target);
  assert.equal(lateInspect.action, "inspect"); assert.equal(lateInspect.detail.resultText, "late output");
  result.cancel = { requested: cancelled.requested, abortedBeforeSettle, settledLater: settled, second: again.requested };

  // Hold the public yield-queue boundary so native delivery cannot finish before
  // the pending-result assertions. All formatting, manager state and reads stay real.
  session.yieldQueue.enqueueWithReceipt = function<P>(kind: string, entry: P): Promise<void> {
    if (kind === "async-result")
      return releaseDelivery.promise.then(() => originalEnqueue.call(this, kind, entry));
    return originalEnqueue.call(this, kind, entry);
  };
  // Inspection is non-consuming: the agent's own delivery stays pending and unsuppressed.
  const completedId = jobs.register("eval", "compute", async () => "hello", { ownerId });
  await jobs.getJob(completedId)!.promise; await tick();
  const completed = rowOf(completedId);
  assert.equal(completed.status, "completed");
  const inspections = Array.from({ length: 3 }, () => control("inspect", completed.target));
  for (const value of inspections) { assert.equal(value.action, "inspect"); assert.deepEqual(value.detail, { target: completed.target, resultText: "hello", truncated: false, consumed: false }); }
  const delivery = jobs.getDeliveryState({ ownerId }), consumedAfterInspections = jobs.isJobResultConsumed(completedId);
  assert.deepEqual({ consumed: consumedAfterInspections, suppressed: jobs.isDeliverySuppressed(completedId), pending: delivery.pendingJobIds.includes(completedId), wake: session.hasPendingAsyncWork() },
    { consumed: false, suppressed: false, pending: true, wake: true });
  const snapshotDelivery = read(); assert.equal(snapshotDelivery.availability, "available");
  assert.ok(snapshotDelivery.availability === "available" && snapshotDelivery.delivery.pendingJobIds.includes(completedId) && snapshotDelivery.delivery.queued >= 1);
  const largeId = jobs.register("bash", "large", async () => "x".repeat(SESSION_JOBS_MAX_OUTPUT_CHARS + 1), { ownerId });
  await jobs.getJob(largeId)!.promise; await tick();
  const large = control("inspect", rowOf(largeId).target);
  assert.equal(large.action, "inspect"); assert.equal(large.detail.resultText?.length, SESSION_JOBS_MAX_OUTPUT_CHARS); assert.equal(large.detail.truncated, true);
  const failedId = jobs.register("bash", "boom", async () => { throw new Error("boom"); }, { ownerId });
  await jobs.getJob(failedId)!.promise; await tick();
  const failed = control("inspect", rowOf(failedId).target);
  assert.equal(failed.action, "inspect"); assert.deepEqual({ status: rowOf(failedId).status, errorText: failed.detail.errorText, resultText: failed.detail.resultText }, { status: "failed", errorText: "boom", resultText: undefined });
  result.inspect = { inspections: inspections.length, consumed: consumedAfterInspections, pending: delivery.pendingJobIds.includes(completedId), truncated: large.detail.truncated, errorText: failed.detail.errorText };

  session.yieldQueue.enqueueWithReceipt = originalEnqueue;
  releaseDelivery.resolve();
  assert.equal(await jobs.drainDeliveries({ filter: { ownerId }, timeoutMs: 5000 }), true);
  assert.equal(jobs.isJobResultConsumed(completedId), true, "original native delivery may consume after release");
  assert.equal(jobs.isJobResultConsumed(largeId), true, "asynchronously formatted output also reaches native delivery");
  assert.equal(jobs.isJobResultConsumed(failedId), true, "failed job output also reaches native delivery");
  await session.waitForIdle();
  assert.ok(providerCalls > 0, "native idle delivery invokes the controlled provider");
  const delivered = control("inspect", completed.target);
  assert.equal(delivered.action, "inspect");
  assert.equal(delivered.detail.consumed, true, "inspection reports an already-delivered result honestly");
  assert.equal(delivered.detail.resultText, "hello");
  assert.ok(!jobs.getDeliveryState({ ownerId }).pendingJobIds.includes(completedId));
  result.nativeDelivery = { consumedAfterDelivery: delivered.detail.consumed, controlledProviderCalls: providerCalls };

  // Native id reuse: after the SDK's own eviction the same id names a different job; old targets die with the old object.
  const staleTarget = completed.target;
  jobs.evictCompletedJobs({ ownerId });
  assert.equal(jobs.getJob(completedId), undefined);
  refuses(() => control("inspect", staleTarget), "STALE_JOB");
  const reuseGate = gate<string>();
  const reusedId = jobs.register("bash", "reused", () => reuseGate.promise, { ownerId, id: completedId });
  assert.equal(reusedId, completedId, "the evicted id is handed out again");
  const reused = rowOf(reusedId);
  assert.notEqual(reused.target.guard, staleTarget.guard);
  refuses(() => control("inspect", staleTarget), "STALE_JOB");
  refuses(() => control("cancel", staleTarget), "STALE_JOB");
  refuses(() => control("cancel", { ...reused.target, guard: staleTarget.guard }), "STALE_JOB");
  refuses(() => control("cancel", { ...reused.target, startTime: reused.target.startTime + 1 }), "STALE_JOB");
  refuses(() => control("cancel", reused.target, second.owner), "STALE_OWNER");
  assert.equal(jobs.getJob(reusedId)!.status, "running", "no refused control touched the reused job");
  const reusedCancel = control("cancel", reused.target);
  assert.equal(reusedCancel.action, "cancel"); assert.equal(reusedCancel.requested, true);
  reuseGate.resolve("done");
  result.reuse = { sameId: reusedId === completedId, sameStartTime: reused.target.startTime === staleTarget.startTime, guardChanged: reused.target.guard !== staleTarget.guard };

  // Response bounds must refuse a partial list, never silently hide live jobs.
  const overflowGate = gate<string>();
  const overflowIds = Array.from({ length: SESSION_JOBS_MAX_RUNNING + 1 }, (_, index) => jobs.register("eval", `bounded-${index}`, () => overflowGate.promise, { ownerId, queued: true }));
  assert.throws(() => adapter.request({ action: "read" }), /no partial job list/);
  assert.ok(overflowIds.every(id => jobs.getJob(id)?.status === "running"), "refusing the oversized read must not mutate jobs");
  result.overflow = { refused: true, untouched: overflowIds.length };
  overflowGate.resolve("bounded done");
  await Promise.all(overflowIds.map(id => jobs.getJob(id)!.promise));

  // Original owner loss: a disposed session is retired, not empty.
  foreignGate.resolve("foreign done"); queuedGate.resolve("indexed");
  await session.dispose();
  refuses(() => adapter.request({ action: "read" }), "STALE_OWNER");
  refuses(() => second.request({ action: "read" }), "STALE_OWNER");
  result.disposed = { retired: true };

  assert.equal(blockedFetches, 0);
  assert.equal(await readFile(configPath, "utf8"), config);
  result.blockedFetches = blockedFetches; result.configUnchanged = true;
  console.log(JSON.stringify(result));
} finally {
  session.yieldQueue.enqueueWithReceipt = originalEnqueue;
  releaseDelivery.resolve();
  await session.dispose().catch(() => {});
  auth.close();
}
