// Actual-native background-jobs fixture. `direct` drives NativeSessionJobs over
// a real pinned AgentSession in this process; `worker` drives the production
// WorkerRuntime/WorkerSession.nativeJobs RPC over `jobs-worker.ts`. Every job
// row is genuine: detached children spawned through the ORIGINAL task tool,
// whose turns run against the fixture's loopback provider, plus gated manager
// rows this fixture registers for owner-filtering and native id reuse. No
// provider spend, no mocked manager, no substituted delivery. HOME, the agent
// directory and the project are disposable; the process network fails closed.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentSession, SessionManager as NativeSessionManager } from "@oh-my-pi/pi-coding-agent";
import type { SessionJobRow, SessionJobsOwner, SessionJobsResult, SessionJobsSnapshot, SessionJobTarget } from "../../../../../packages/shared/src/session-jobs";
import { installJobsNetworkGuard, JOBS_FIXTURE_CHILD_AGENT, JOBS_FIXTURE_CHILD_FAILURE, JOBS_FIXTURE_CHILD_RESULT, JOBS_FIXTURE_INDEPENDENT_OWNER, JOBS_FIXTURE_MODEL, JOBS_FIXTURE_PROVIDER, prepareJobsFixture, startJobsInference, writeJobsFixtureFiles } from "./jobs-controlled";

const directory = process.argv[2]!, mode = process.argv[3]!;
assert.ok(directory && path.isAbsolute(directory), "usage: jobs-native.ts <root> direct|worker");
assert.ok(mode === "direct" || mode === "worker", "usage: jobs-native.ts <root> direct|worker");
assert.equal(process.env.HOME, directory);
const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
await mkdir(cwd, { recursive: true });

const inference = startJobsInference();
const blocked = installJobsNetworkGuard(inference.origin, "native jobs fixture");
const result: Record<string, unknown> = { mode, metadata: { model: "anthropic/claude-fable-5-1", thinking: "high", fallback: false, session: "01a0bd23-34b1-7456-b361-9bf0f6a73cb3" } };

const available = (snapshot: SessionJobsSnapshot) => { assert.equal(snapshot.availability, "available", "reason" in snapshot ? snapshot.reason : ""); return snapshot; };
const rows = (snapshot: SessionJobsSnapshot) => { const value = available(snapshot); return [...value.running, ...value.recent]; };
const rowOf = (snapshot: SessionJobsSnapshot, id: string): SessionJobRow | undefined => rows(snapshot).find(row => row.target.id === id);
const summarize = (row: SessionJobRow | undefined) => row && { id: row.target.id, type: row.type, status: row.status, queued: row.queued, label: row.label, agentId: row.agentId };
async function until<T>(read: () => Promise<T | undefined> | T | undefined, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}
/** NativeJobsError carries its code as `code` in-process and as `NativeJobsError.<CODE>` in the name across the worker RPC. */
function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string") return code;
  return /^NativeJobsError\.([A-Z_]+)$/.exec(error.name)?.[1] ?? `${error.name}: ${error.message}`;
}
const token = (name: string) => `${name}-${crypto.randomUUID()}`;

try {
  if (mode === "direct") await direct(); else await worker();
  result.blocked = blocked;
  result.inference = inference.requests;
  await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);
} finally {
  await inference.stop();
}
process.exit(0);

async function direct() {
  await writeJobsFixtureFiles(agentDir, cwd, inference.origin);
  // Dynamic on purpose: the native package reads HOME/agent configuration at
  // import time and must load after the guard and the controlled files above.
  const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
  const { AsyncJobManager } = await import("@oh-my-pi/pi-coding-agent/async");
  const { NativeSessionJobs } = await import("../session-jobs");
  interface Native { session: AgentSession; manager: NativeSessionManager; close(): Promise<void> }
  async function nativeSession(file?: string): Promise<Native> {
    const auth = await discoverAuthStorage(agentDir), settings = await Settings.loadReadOnly({ agentDir, cwd });
    const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
    const manager = file ? await SessionManager.open(file) : SessionManager.create(cwd, path.join(agentDir, "sessions"));
    const created = await createAgentSession({ agentDir, cwd, settings, authStorage: auth, modelRegistry: registry, agentRegistry: new AgentRegistry(), sessionManager: manager,
      model: file ? undefined : registry.find(JOBS_FIXTURE_PROVIDER, JOBS_FIXTURE_MODEL.id), extensions: [], hasUI: false, interactivePrompts: false, deferUsageReserveConfirmation: true });
    await manager.ensureOnDisk();
    return { session: created.session, manager, close: async () => { try { await created.session.dispose(); } finally { auth.close(); } } };
  }
  function adapter(native: Native) {
    const state = { retired: false };
    const jobs = new NativeSessionJobs(native.session, () => { if (state.retired) throw new Error("The original native session owner has retired."); });
    const read = () => (jobs.request({ action: "read" }) as Extract<SessionJobsResult, { action: "read" }>).snapshot;
    const owner = (): SessionJobsOwner => read().owner;
    const inspect = (target: SessionJobTarget) => jobs.request({ action: "inspect", owner: owner(), job: target }) as Extract<SessionJobsResult, { action: "inspect" }>;
    const cancel = (target: SessionJobTarget) => jobs.request({ action: "cancel", owner: owner(), job: target }) as Extract<SessionJobsResult, { action: "cancel" }>;
    const target = (id: string) => { const row = rowOf(read(), id); assert.ok(row, `Adapter row ${id} is missing`); return row.target; };
    return { jobs, state, read, owner, inspect, cancel, target };
  }
  const settlement = (job: { promise: Promise<void> }) => { const flag = { settled: false }; void job.promise.then(() => { flag.settled = true; }, () => { flag.settled = true; }); return flag; };

  const primary = await nativeSession();
  const session = primary.session, manager = session.asyncJobManager;
  assert.ok(manager, "The first top-level native session must own the process job manager");
  assert.equal(manager, AsyncJobManager.instance());
  const ownerId = session.getAgentId();
  assert.ok(ownerId);
  const a = adapter(primary);
  const initial = available(a.read());
  result.identity = { nativeSessionId: session.sessionId, sessionFile: primary.manager.getSessionFile(), agentId: ownerId,
    ownerMatches: initial.owner.nativeSessionId === session.sessionId && initial.owner.agentId === ownerId, epochLength: initial.owner.epoch.length,
    initiallyEmpty: initial.running.length === 0 && initial.recent.length === 0 && initial.delivery.queued === 0 };
  const task = session.getToolByName("task");
  assert.ok(task, "The original session must expose the task tool");
  const spawn = async (name: string) => {
    const hold = inference.hold(token(name));
    const accepted = await task.execute(`jobs-native-${name}`, { name, agent: JOBS_FIXTURE_CHILD_AGENT, task: `Controlled background child ${hold.token}.` });
    assert.equal(accepted.isError, undefined, accepted.content.find(part => part.type === "text")?.text);
    const job = await until(() => manager.getJob(name), `job ${name}`);
    return { hold, job };
  };

  // A second top-level session in this process gets no manager: the genuine unavailable state.
  const secondary = await nativeSession();
  try {
    assert.equal(secondary.session.getAsyncJobSnapshot(), null);
    const unavailable = adapter(secondary).read();
    result.unavailable = { availability: unavailable.availability, reason: "reason" in unavailable ? unavailable.reason : undefined, ownerDiffers: unavailable.owner.nativeSessionId !== session.sessionId };
  } finally { await secondary.close(); }

  // Native id reuse: the evicted id is handed out again; the stale target must be refused.
  const reuseGate = Promise.withResolvers<string>();
  const reuseId = manager.register("bash", "jobs reuse seed", () => reuseGate.promise, { ownerId, id: "jobs-reuse" });
  assert.equal(reuseId, "jobs-reuse");
  const staleTarget = a.target(reuseId);
  reuseGate.resolve("first generation output");
  await manager.getJob(reuseId)!.promise;
  await until(() => manager.getDeliveryState({ ownerId }).queued === 0 && !session.hasPendingAsyncWork() ? true : undefined, "first reuse delivery");
  await session.waitForIdle();
  const firstGeneration = a.inspect(staleTarget);
  manager.evictCompletedJobs({ ownerId });
  assert.equal(manager.getJob(reuseId), undefined);
  await Bun.sleep(2);
  const secondGate = Promise.withResolvers<string>();
  assert.equal(manager.register("bash", "jobs reuse seed", ({ signal }) => { const abort = Promise.withResolvers<never>(); signal.addEventListener("abort", () => abort.reject(new Error("reuse aborted")), { once: true }); return Promise.race([secondGate.promise, abort.promise]); }, { ownerId, id: "jobs-reuse" }), reuseId);
  const freshTarget = a.target(reuseId);
  const staleCancel = (() => { try { a.cancel(staleTarget); return "accepted"; } catch (error) { return errorCode(error); } })();
  const staleInspect = (() => { try { a.inspect(staleTarget); return "accepted"; } catch (error) { return errorCode(error); } })();
  const freshCancel = a.cancel(freshTarget);
  await manager.getJob(reuseId)!.promise.catch(() => {});
  result.idReuse = { sameId: freshTarget.id === staleTarget.id, differentStart: freshTarget.startTime !== staleTarget.startTime, differentGuard: freshTarget.guard !== staleTarget.guard,
    firstGenerationResult: firstGeneration.detail.resultText, staleCancel, staleInspect, freshCancelRequested: freshCancel.requested, freshStatus: manager.getJob(reuseId)?.status };

  // Independent owner: a row this fixture registered for another agent id is invisible and untouchable.
  const independentGate = Promise.withResolvers<string>();
  const independentId = manager.register("eval", "independent owner seed", () => independentGate.promise, { ownerId: JOBS_FIXTURE_INDEPENDENT_OWNER });
  const independentRow = manager.getJob(independentId)!;
  const independentCancel = (() => { try { return `accepted:${a.cancel({ id: independentId, startTime: independentRow.startTime, guard: "fabricated" }).requested}`; } catch (error) { return errorCode(error); } })();
  result.independentOwner = { id: independentId, hiddenFromRead: rowOf(a.read(), independentId) === undefined, visibleUnfiltered: manager.getAllJobs().some(job => job.id === independentId),
    cancel: independentCancel, stillRunning: independentRow.status === "running" };

  // Real detached children through the original task tool: running, queued, cancelled, completed, failed.
  const childA = await spawn("child-a");
  await childA.hold.reached;
  const runningA = await until(() => { const row = rowOf(a.read(), "child-a"); return row && !row.queued ? row : undefined; }, "child-a running");
  const childB = await spawn("child-b");
  const queuedB = await until(() => { const row = rowOf(a.read(), "child-b"); return row?.queued ? row : undefined; }, "child-b queued");
  const childRef = AgentRegistry.global().get("child-a");
  result.children = { a: summarize(runningA), b: summarize(queuedB), ownerIds: { a: childA.job.ownerId, b: childB.job.ownerId },
    childSession: { agentId: childRef?.session?.getAgentId(), sessionId: childRef?.session?.sessionId, differsFromRoot: childRef?.session?.sessionId !== session.sessionId, parentId: childRef?.parentId },
    readsDoNotConsume: [1, 2, 3].map(() => a.read()).every(snapshot => rowOf(snapshot, "child-a")?.status === "running") && !manager.isJobResultConsumed("child-a") && !manager.isJobResultConsumed("child-b") };
  const bSettled = settlement(childB.job);
  const cancelB = a.cancel(a.target("child-b"));
  const bAtCancel = { status: childB.job.status, queued: childB.job.queued, settled: bSettled.settled };
  await childB.job.promise.catch(() => {});
  const childC = await spawn("child-c");
  const queuedC = await until(() => { const row = rowOf(a.read(), "child-c"); return row?.queued ? row : undefined; }, "child-c queued");
  const aSettled = settlement(childA.job);
  const cancelA = a.cancel(a.target("child-a"));
  const aAtCancel = { status: childA.job.status, settled: aSettled.settled };
  await childA.job.promise.catch(() => {});
  const runningC = await until(() => { const row = rowOf(a.read(), "child-c"); return row && !row.queued ? row : undefined; }, "child-c acquired the released slot");
  await childC.hold.reached;
  const inspectB = a.inspect(a.target("child-b")), inspectA = a.inspect(a.target("child-a"));
  const secondInspectA = a.inspect(a.target("child-a"));
  result.cancellation = { b: { requested: cancelB.requested, atCancel: bAtCancel, finalStatus: childB.job.status, errorText: inspectB.detail.errorText, consumed: inspectB.detail.consumed },
    a: { requested: cancelA.requested, atCancel: aAtCancel, finalStatus: childA.job.status, errorText: inspectA.detail.errorText?.slice(0, 200), consumedAfterTwoInspects: secondInspectA.detail.consumed,
      inferenceAborted: inference.requests.find(request => request.token === childA.hold.token)?.outcome },
    neverDelivered: !manager.getDeliveryState({ ownerId }).pendingJobIds.some(id => id === "child-a" || id === "child-b"),
    settledCancelRequested: a.cancel(a.target("child-a")).requested, c: summarize(queuedC), cRunning: summarize(runningC) };
  childC.hold.release();
  await childC.job.promise;
  const inspectC = a.inspect(a.target("child-c"));
  a.inspect(a.target("child-c")); a.read();
  const consumedAfterInspects = manager.isJobResultConsumed("child-c");
  const deliveryAtCompletion = manager.getDeliveryState({ ownerId });
  await until(() => manager.getDeliveryState({ ownerId }).queued === 0 && !session.hasPendingAsyncWork() ? true : undefined, "child-c delivery");
  await session.waitForIdle();
  const deliveredC = a.inspect(a.target("child-c"));
  result.completion = { row: summarize(rowOf(a.read(), "child-c")), resultIncludesChildOutput: inspectC.detail.resultText?.includes(JOBS_FIXTURE_CHILD_RESULT) === true,
    truncated: inspectC.detail.truncated, consumedAtInspect: inspectC.detail.consumed, consumedAfterInspects, deliveryQueuedAtCompletion: deliveryAtCompletion.queued,
    consumedAfterNativeDelivery: deliveredC.detail.consumed, rootFollowUpTurns: inference.requests.filter(request => request.kind === "root").length };
  const childD = await spawn("child-d");
  await childD.hold.reached; childD.hold.fail();
  await childD.job.promise.catch(() => {});
  const inspectD = a.inspect(a.target("child-d"));
  result.failure = { row: summarize(rowOf(a.read(), "child-d")), errorIncludesChildFailure: inspectD.detail.errorText?.includes(JOBS_FIXTURE_CHILD_FAILURE) === true, resultText: inspectD.detail.resultText };
  await until(() => manager.getDeliveryState({ ownerId }).queued === 0 && !session.hasPendingAsyncWork() ? true : undefined, "child-d delivery");
  await session.waitForIdle();
  independentGate.resolve("independent done");
  await independentRow.promise;
  const beforeLoss = available(a.read());
  result.beforeOwnerLoss = { running: beforeLoss.running.map(summarize), recent: beforeLoss.recent.map(summarize), delivery: beforeLoss.delivery };

  // Owner loss: the original session retires; nothing survives for a later manager.
  a.state.retired = true;
  const sessionFile = primary.manager.getSessionFile()!;
  await primary.close();
  const afterLoss = (() => { try { return `read:${a.read().availability}`; } catch (error) { return errorCode(error); } })();
  result.ownerLoss = { adapter: afterLoss, sessionDisposed: session.isDisposed, managerInstanceCleared: AsyncJobManager.instance() === undefined, retainedRows: manager.getAllJobs().length };
  const fresh = await nativeSession();
  let cold: Extract<SessionJobsSnapshot, { availability: "available" }>, freshManagerIsNew: boolean;
  try {
    cold = available(adapter(fresh).read());
    freshManagerIsNew = fresh.session.asyncJobManager !== manager && fresh.session.asyncJobManager === AsyncJobManager.instance();
  } finally { await fresh.close(); }
  // Reopening the retired session's own file (as the only top-level session) owns a new manager: nothing is restored from the journal.
  const reopened = await nativeSession(sessionFile);
  try {
    const restored = adapter(reopened).read();
    result.cold = { freshOwnerDiffers: cold.owner.nativeSessionId !== session.sessionId, freshEmpty: cold.running.length === 0 && cold.recent.length === 0 && cold.delivery.queued === 0,
      freshManagerIsNew, reopenedSameNativeId: reopened.session.sessionId === session.sessionId, reopenedAvailability: restored.availability,
      reopenedEmpty: restored.availability === "available" ? restored.running.length === 0 && restored.recent.length === 0 : undefined };
  } finally { await reopened.close(); }
}

async function worker() {
  const fixture = await prepareJobsFixture(directory, { inference });
  const { WorkerRuntime } = await import("../../omp-workers/runtime");
  const runtime = new WorkerRuntime({ agentDir: fixture.agentDir, workerPath: fixture.workerPath, environment: fixture.environment });
  const failures: unknown[] = [];
  try {
    const session = await runtime.create({ cwd: fixture.cwd, model: fixture.model });
    const read = async () => available((await session.nativeJobs({ action: "read" }) as Extract<SessionJobsResult, { action: "read" }>).snapshot);
    const owner = async () => (await read()).owner;
    const target = async (id: string) => { const row = rowOf(await read(), id); assert.ok(row, `Worker row ${id} is missing`); return row.target; };
    const first = await read();
    const control = await fixture.control.session(session.id);
    const status = await control.status();
    result.identity = { sessionId: session.id, workerPid: session.workerPid, capturedPid: status.pid, capturedSessionId: status.sessionId, capturedAgentId: status.agentId,
      capturedFile: status.sessionFile, sessionFile: session.sessionFile, ownerMatches: first.owner.nativeSessionId === session.id && first.owner.agentId === status.agentId,
      initiallyEmpty: first.running.length === 0 && first.recent.length === 0 };
    const holdA = inference.hold(token("w-a")), spawnedA = await control.spawnTask("w-a", holdA.token);
    await holdA.reached;
    const holdB = inference.hold(token("w-b")), spawnedB = await control.spawnTask("w-b", holdB.token);
    const queuedB = await control.waitJob({ jobId: "w-b", queued: true });
    const running = await until(async () => { const snapshot = await read(); const rowA = rowOf(snapshot, "w-a"), rowB = rowOf(snapshot, "w-b"); return rowA && !rowA.queued && rowB?.queued ? { a: rowA, b: rowB } : undefined; }, "worker rows");
    result.children = { a: summarize(running.a), b: summarize(running.b), ownerIds: { a: spawnedA.ownerId, b: spawnedB.ownerId }, queuedViaManager: queuedB.queued, accepted: spawnedA.accepted.slice(0, 120),
      childSessions: (await control.status()).children };
    const cancelB = await session.nativeJobs({ action: "cancel", owner: await owner(), job: await target("w-b") }) as Extract<SessionJobsResult, { action: "cancel" }>;
    const settledB = await control.waitJob({ jobId: "w-b", settled: true });
    const staleB = await session.nativeJobs({ action: "cancel", owner: await owner(), job: await target("w-b") }) as Extract<SessionJobsResult, { action: "cancel" }>;
    const fabricated = await session.nativeJobs({ action: "cancel", owner: await owner(), job: { ...(await target("w-a")), guard: "fabricated-guard" } }).then(() => "accepted", errorCode);
    const staleOwner = await session.nativeJobs({ action: "cancel", owner: { ...(await owner()), epoch: "stale-epoch" }, job: await target("w-a") }).then(() => "accepted", errorCode);
    result.cancellation = { requested: cancelB.requested, finalStatus: settledB.status, errorText: settledB.errorText, consumed: settledB.consumed, settledCancelRequested: staleB.requested, fabricatedGuard: fabricated, staleOwner };
    holdA.release();
    const completedA = await control.waitJob({ jobId: "w-a", status: "completed" });
    const inspectA = await session.nativeJobs({ action: "inspect", owner: await owner(), job: await target("w-a") }) as Extract<SessionJobsResult, { action: "inspect" }>;
    const seededIndependent = await control.seed({ label: "independent owner seed", owner: "independent" });
    const seededOwned = await control.seed({ label: "owned queued seed", type: "eval", owner: "original", queued: true });
    const snapshot = await read();
    result.completion = { row: summarize(rowOf(snapshot, "w-a")), resultIncludesChildOutput: inspectA.detail.resultText?.includes(JOBS_FIXTURE_CHILD_RESULT) === true, consumedAtInspect: inspectA.detail.consumed,
      managerConsumedAtInspect: completedA.consumed, independentHidden: rowOf(snapshot, seededIndependent.jobId) === undefined, independentOwner: seededIndependent.ownerId,
      ownedQueued: summarize(rowOf(snapshot, seededOwned.jobId)) };
    await control.release(seededIndependent.jobId); await control.release(seededOwned.jobId, "fail", "seeded failure");
    const failedSeed = await control.waitJob({ jobId: seededOwned.jobId, settled: true });
    await until(async () => { const value = await read(); return value.delivery.queued === 0 && rowOf(value, seededOwned.jobId)?.status === "failed" ? true : undefined; }, "worker deliveries");
    const holdC = inference.hold(token("w-c")); await control.spawnTask("w-c", holdC.token); await holdC.reached; holdC.fail();
    const failedC = await control.waitJob({ jobId: "w-c", status: "failed" });
    const inspectC = await session.nativeJobs({ action: "inspect", owner: await owner(), job: await target("w-c") }) as Extract<SessionJobsResult, { action: "inspect" }>;
    result.failure = { seededStatus: failedSeed.status, seededError: failedSeed.errorText, childStatus: failedC.status, childErrorIncludesFailure: inspectC.detail.errorText?.includes(JOBS_FIXTURE_CHILD_FAILURE) === true };
    await until(async () => (await read()).delivery.queued === 0 ? true : undefined, "failure delivery");
    const finalSnapshot = await read();
    result.beforeOwnerLoss = { running: finalSnapshot.running.map(summarize), recent: finalSnapshot.recent.map(summarize), blockedInWorker: (await control.status()).blocked };
    // Owner loss: the production handle disposes the worker; a fresh worker owns a cold manager.
    await session.dispose();
    const disposedRead = await session.nativeJobs({ action: "read" }).then(value => `read:${value.snapshot.availability}`, errorCode);
    const fresh = await runtime.create({ cwd: fixture.cwd, model: fixture.model });
    const cold = await available((await fresh.nativeJobs({ action: "read" }) as Extract<SessionJobsResult, { action: "read" }>).snapshot);
    const freshControl = await fixture.control.session(fresh.id), freshStatus = await freshControl.status();
    result.ownerLoss = { disposedRead, oldSocketGone: (await fixture.control.workers()).every(worker => worker.status.pid !== status.pid) };
    result.cold = { freshOwnerDiffers: cold.owner.nativeSessionId !== session.id, freshEmpty: cold.running.length === 0 && cold.recent.length === 0 && cold.delivery.queued === 0,
      freshPidDiffers: freshStatus.pid !== status.pid, freshManager: freshStatus.manager, freshJobs: freshStatus.jobs.length };
    await fresh.dispose();
  } finally {
    await runtime.dispose().catch(cause => failures.push(cause));
    await fixture.stop().catch(cause => failures.push(cause));
    result.cleanupFailures = failures.map(String);
    if (failures.length) throw new AggregateError(failures, "Worker jobs fixture cleanup failed");
  }
}
