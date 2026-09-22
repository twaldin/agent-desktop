// Actual-native subagents browse fixture. `direct` drives NativeSessionSubagents
// over real pinned AgentSessions in this process; `worker` drives the production
// WorkerRuntime/WorkerSession.nativeSubagents RPC over `jobs-worker.ts`. Every
// child is genuine: spawned through the ORIGINAL task tool against the jobs
// fixture's loopback provider, parked/revived/killed through the ORIGINAL
// lifecycle manager. Nothing substitutes a task child, and the adapter under
// test never writes, resumes, sends or stops anything. HOME, the agent
// directory and the project are disposable; the process network fails closed.
import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentSession, SessionManager as NativeSessionManager } from "@oh-my-pi/pi-coding-agent";
import type { SessionSubagentRow, SessionSubagentsRequest, SessionSubagentsResult, SessionSubagentTarget } from "../../../../../packages/shared/src/session-subagents";
import { installJobsNetworkGuard, JOBS_FIXTURE_CHILD_AGENT, JOBS_FIXTURE_MODEL, JOBS_FIXTURE_PROVIDER, prepareJobsFixture, startJobsInference, writeJobsFixtureFiles, type InferenceHold } from "./jobs-controlled";

const directory = process.argv[2]!, mode = process.argv[3]!;
assert.ok(directory && path.isAbsolute(directory), "usage: subagents-native.ts <root> direct|worker");
assert.ok(mode === "direct" || mode === "worker", "usage: subagents-native.ts <root> direct|worker");
assert.equal(process.env.HOME, directory);
const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
await mkdir(cwd, { recursive: true });

const inference = startJobsInference();
const blocked = installJobsNetworkGuard(inference.origin, "native subagents fixture");
/** Authoring metadata is the author's own session model; every child's model below is read from the child session and journal. */
const result: Record<string, unknown> = { mode, metadata: { author: { model: "anthropic/claude-fable-5-1" }, controlledChildModel: `${JOBS_FIXTURE_PROVIDER}/${JOBS_FIXTURE_MODEL.id}` } };

type List = Extract<SessionSubagentsResult, { action: "list" }>;
type Transcript = Extract<SessionSubagentsResult, { action: "transcript" }>;
type FileRead = Extract<SessionSubagentsResult, { action: "file" }>;
const rowOf = (list: List, id: string): SessionSubagentRow | undefined => list.rows.find(row => row.target.id === id);
const summarize = (row: SessionSubagentRow | undefined) => row && { id: row.target.id, sessionId: row.target.sessionId, displayName: row.displayName, status: row.status, running: row.running, hasActivity: row.activity !== undefined };
const transcriptFacts = (value: Transcript, token?: string) => ({ availability: value.availability, messages: value.messages.length, roles: [...new Set(value.messages.map(message => message.role))].sort(),
  hasTask: token === undefined ? undefined : value.messages.some(message => message.text.includes(token)), cwd: value.cwd, truncated: value.truncated, reason: value.reason,
  nativeIds: value.messages.filter(message => message.nativeId).length });
async function until<T>(read: () => Promise<T | undefined> | T | undefined, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}
/** NativeSubagentsError carries its code as `code` in-process and as `NativeSubagentsError.<CODE>` in the name across the worker RPC. */
function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string") return code;
  return /^NativeSubagentsError\.([A-Z_]+)$/.exec(error.name)?.[1] ?? `${error.name}: ${error.message}`;
}
const outcome = (promise: Promise<unknown>) => promise.then(() => "accepted", errorCode);
const token = (name: string) => `${name}-${crypto.randomUUID()}`;
/** Journal-exposed identity of one child: header id/cwd plus the session_init model facts the native roster reads. */
async function journalFacts(sessionFile: string) {
  const lines = (await readFile(sessionFile, "utf8")).split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
  const header = lines.find(entry => entry.type === "session"), init = lines.find(entry => entry.type === "session_init"), modelChange = lines.findLast(entry => entry.type === "model_change");
  // Same precedence as the native persisted roster: session_init first, then the latest model_change record.
  return { path: sessionFile, headerId: header?.id, headerCwd: header?.cwd, agent: init?.agent, resolvedModel: init?.resolvedModel ?? modelChange?.model, modelRole: init?.modelRole ?? modelChange?.role, entries: lines.length };
}

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
  await writeFile(path.join(cwd, "notes.txt"), "controlled child notes\n");
  await writeFile(path.join(cwd, "large.txt"), "x".repeat(300 * 1024));
  await writeFile(path.join(directory, "outside.txt"), "outside the project\n");
  await symlink(path.join(directory, "outside.txt"), path.join(cwd, "escape.txt"));
  // Dynamic on purpose: the native package reads HOME/agent configuration at
  // import time and must load after the guard and the controlled files above.
  const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
  const { AgentLifecycleManager } = await import("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle");
  const { NativeSessionSubagents } = await import("../session-subagents");
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
    const subagents = new NativeSessionSubagents(native.session, () => { if (state.retired) throw new Error("The original native session owner has retired."); }, native.manager.getSessionId());
    const request = (value: SessionSubagentsRequest) => subagents.request(value);
    const list = async () => { const value = await request({ action: "list", owner: subagents.owner }) as List; assert.equal(value.availability, "available", value.reason); return value; };
    const target = async (id: string) => { const row = rowOf(await list(), id); assert.ok(row, `Adapter row ${id} is missing`); return row.target; };
    const transcript = (target: SessionSubagentTarget) => request({ action: "transcript", owner: subagents.owner, target }) as Promise<Transcript>;
    const file = (target: SessionSubagentTarget, path: string) => request({ action: "file", owner: subagents.owner, target, path }) as Promise<FileRead>;
    return { subagents, state, request, list, target, transcript, file };
  }
  const spawn = async (native: Native, name: string, hold?: InferenceHold) => {
    const task = native.session.getToolByName("task");
    assert.ok(task, "The original session must expose the task tool");
    const accepted = await task.execute(`subagents-native-${name}-${crypto.randomUUID().slice(0, 8)}`, { name, agent: JOBS_FIXTURE_CHILD_AGENT, task: `Controlled background child ${hold?.token ?? name}.` });
    assert.equal(accepted.isError, undefined, accepted.content.find(part => part.type === "text")?.text);
    return until(() => AgentRegistry.global().get(name), `registry ref ${name}`);
  };
  const lifecycle = AgentLifecycleManager.global();

  const primary = await nativeSession();
  const rootFile = primary.manager.getSessionFile()!;
  const rootDir = rootFile.slice(0, -".jsonl".length);
  const a = adapter(primary);
  const initial = await a.list();
  result.identity = { nativeSessionId: primary.manager.getSessionId(), providerSessionId: primary.session.sessionId, sessionFile: rootFile, artifactsDir: primary.manager.getArtifactsDir(),
    ownerMatches: a.subagents.owner.nativeSessionId === primary.manager.getSessionId(), epochLength: a.subagents.owner.epoch.length,
    initiallyEmpty: initial.rows.length === 0 && initial.omitted === 0, initialActivity: a.subagents.activity() };

  // A real detached child through the original task tool, held mid-turn on the loopback provider.
  const holdA = inference.hold(token("child-a"));
  const refA = await spawn(primary, "child-a", holdA);
  await holdA.reached;
  const runningRow = await until(async () => { const row = rowOf(await a.list(), "child-a"); return row?.status === "running" ? row : undefined; }, "child-a running row");
  const childSession = refA.session;
  assert.ok(childSession, "The held task child must be attached to its registry ref");
  const liveTranscript = await a.transcript(runningRow.target);
  const liveActivity = a.subagents.activity();
  result.live = { row: summarize(runningRow), sessionIdMatchesChildManager: runningRow.target.sessionId === childSession.sessionManager.getSessionId(),
    sessionIdDiffersFromRoot: runningRow.target.sessionId !== primary.manager.getSessionId(), guardLength: runningRow.target.guard.length,
    childSessionFile: refA.sessionFile, journalBelowRoot: refA.sessionFile === path.join(rootDir, "child-a.jsonl"), parentId: refA.parentId,
    childModel: childSession.model ? { provider: childSession.model.provider, id: childSession.model.id } : null, childAgentId: childSession.getAgentId(),
    transcript: transcriptFacts(liveTranscript, holdA.token), cwdIsProject: liveTranscript.cwd === cwd,
    validate: await outcome(a.request({ action: "validate", owner: a.subagents.owner, target: runningRow.target })),
    activity: liveActivity.availability === "available" ? liveActivity.value.map(agent => ({ id: agent.id, status: agent.status, running: agent.running, parentId: agent.parentId })) : liveActivity,
    staleOwner: await outcome(a.request({ action: "list", owner: { ...a.subagents.owner, epoch: "stale-epoch" } })),
    staleOwnerTranscript: await outcome(a.request({ action: "transcript", owner: { ...a.subagents.owner, epoch: "stale-epoch" }, target: runningRow.target })),
    fabricatedGuard: await outcome(a.transcript({ ...runningRow.target, guard: "fabricated-guard" })),
    fabricatedSessionId: await outcome(a.transcript({ ...runningRow.target, sessionId: primary.manager.getSessionId() })),
    rejectedAction: await outcome(a.request({ action: "resume", owner: a.subagents.owner, target: runningRow.target } as unknown as SessionSubagentsRequest)) };
  const notes = await a.file(runningRow.target, "notes.txt"), large = await a.file(runningRow.target, "large.txt");
  result.files = { notes: { text: notes.text, truncated: notes.truncated, path: notes.path }, large: { chars: large.text.length, truncated: large.truncated },
    parentEscape: await outcome(a.file(runningRow.target, "../outside.txt")), absolute: await outcome(a.file(runningRow.target, path.join(directory, "outside.txt"))),
    symlinkEscape: await outcome(a.file(runningRow.target, "escape.txt")), directory: await outcome(a.file(runningRow.target, ".omp")), missing: await outcome(a.file(runningRow.target, "absent.txt")) };
  // Reads consumed nothing native: the held turn is still held and the child still streams.
  result.readsAreInert = { stillStreaming: childSession.isStreaming, stillHeld: inference.requests.find(request => request.token === holdA.token)?.releasedAt === undefined, transcriptsIdentical: JSON.stringify((await a.transcript(runningRow.target)).messages) === JSON.stringify(liveTranscript.messages) };

  holdA.release();
  // The detached job settles only after the original executor finalized the child (idle + lifecycle adoption).
  const jobManager = primary.session.asyncJobManager;
  assert.ok(jobManager, "The first top-level native session must own the process job manager");
  await (await until(() => jobManager.getJob("child-a"), "detached job child-a")).promise;
  const idleRow = await until(async () => { const row = rowOf(await a.list(), "child-a"); return row?.status === "idle" ? row : undefined; }, "child-a idle row");
  const idleTranscript = await a.transcript(idleRow.target);
  result.idle = { row: summarize(idleRow), sameGuardAsRunning: idleRow.target.guard === runningRow.target.guard, sameSessionId: idleRow.target.sessionId === runningRow.target.sessionId,
    transcript: transcriptFacts(idleTranscript, holdA.token) };

  // Persist a real native image entry after the controlled turn. Browsing must
  // resolve this child's entry both live and parked, without replaying a prompt.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hZkAAAAASUVORK5CYII=", "base64");
  const imageEntryId = childSession.sessionManager.appendMessage({ role: "user", content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }], timestamp: Date.now() });
  await childSession.sessionManager.flush();
  const liveImage = await a.request({ action: "image", owner: a.subagents.owner, target: idleRow.target, nativeEntryId: imageEntryId, blockIndex: 0 });
  assert.equal(liveImage.action, "image");
  if (liveImage.action !== "image") throw new Error("Wrong image response");
  assert.deepEqual(Buffer.from(liveImage.image.base64, "base64"), png);

  // Original lifecycle park: the same ref, a detached session generation, the journal on disk.
  await lifecycle.park("child-a");
  const parkedRef = AgentRegistry.global().get("child-a");
  const parkedList = await a.list();
  const parkedRow = rowOf(parkedList, "child-a");
  assert.ok(parkedRow, "The parked child must stay listed without revival");
  const parkedTranscript = await a.transcript(parkedRow.target);
  const parkedActivity = a.subagents.activity();
  result.parked = { sameRef: parkedRef === refA, refStatus: parkedRef?.status, sessionNull: parkedRef?.session === null, row: summarize(parkedRow),
    staleLiveTarget: await outcome(a.transcript(idleRow.target)), staleLiveValidate: await outcome(a.request({ action: "validate", owner: a.subagents.owner, target: idleRow.target })),
    guardChanged: parkedRow.target.guard !== idleRow.target.guard, sameSessionId: parkedRow.target.sessionId === idleRow.target.sessionId,
    transcript: transcriptFacts(parkedTranscript, holdA.token), cwdFromHeader: parkedTranscript.cwd === cwd,
    validate: await outcome(a.request({ action: "validate", owner: a.subagents.owner, target: parkedRow.target })),
    file: (await a.file(parkedRow.target, "notes.txt")).text,
    stillParkedAfterReads: AgentRegistry.global().get("child-a")?.status, stillDetached: AgentRegistry.global().get("child-a")?.session === null,
    activity: parkedActivity.availability === "available" ? parkedActivity.value.map(agent => ({ id: agent.id, status: agent.status, running: agent.running })) : parkedActivity,
    journal: await journalFacts(refA.sessionFile!) };
  const parkedImage = await a.request({ action: "image", owner: a.subagents.owner, target: parkedRow.target, nativeEntryId: imageEntryId, blockIndex: 0 });
  assert.equal(parkedImage.action, "image");
  if (parkedImage.action !== "image") throw new Error("Wrong parked image response");
  assert.deepEqual(Buffer.from(parkedImage.image.base64, "base64"), png);
  result.images = { nativeEntryId: imageEntryId, childSessionId: parkedRow.target.sessionId, rootSessionId: primary.manager.getSessionId(), live: liveImage.image, parked: parkedImage.image,
    staleLiveTarget: await outcome(a.request({ action: "image", owner: a.subagents.owner, target: idleRow.target, nativeEntryId: imageEntryId, blockIndex: 0 })), stillDetached: refA.session === null };

  // Journal replacement, removal and symlink escape against the exact parked target.
  const childFile = refA.sessionFile!, movedFile = `${childFile}.moved`;
  await rename(childFile, movedFile);
  await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "01a0c208-ef91-7000-a67f-000000000000", timestamp: new Date().toISOString(), cwd })}\n`);
  const replaced = await outcome(a.transcript(parkedRow.target));
  await rm(childFile);
  const missing = await a.transcript(parkedRow.target);
  await symlink(rootFile, childFile);
  const escaped = await outcome(a.transcript(parkedRow.target));
  await rm(childFile);
  await rename(movedFile, childFile);
  const restored = await a.transcript(parkedRow.target);
  result.replacement = { replaced, missing: { availability: missing.availability, messages: missing.messages.length, reasonNamesJournal: missing.reason === `The child's journal is missing: ${childFile}` }, escaped, restored: transcriptFacts(restored, holdA.token).availability };

  // Original executor revive: a replacement AgentSession object on the same ref → the parked target is stale.
  const revived = await lifecycle.ensureLive("child-a");
  const revivedRow = await a.target("child-a");
  result.revived = { differentSessionObject: revived !== childSession, sameRef: AgentRegistry.global().get("child-a") === refA, staleParkedTarget: await outcome(a.transcript(parkedRow.target)),
    row: summarize(rowOf(await a.list(), "child-a")), guardChanged: revivedRow.guard !== parkedRow.target.guard, sameSessionId: revivedRow.sessionId === parkedRow.target.sessionId,
    transcript: transcriptFacts(await a.transcript(revivedRow), holdA.token) };

  // Original kill path: tombstoned `aborted` ref stays listed, detached, readable from disk, never equated with success.
  await lifecycle.release("child-a", undefined, { tombstone: true });
  const abortedRow = await a.target("child-a");
  const abortedTranscript = await a.transcript(abortedRow);
  result.aborted = { row: summarize(rowOf(await a.list(), "child-a")), refStatus: AgentRegistry.global().get("child-a")?.status, sessionNull: AgentRegistry.global().get("child-a")?.session === null,
    tombstone: await stat(`${childFile}.tombstone`).then(() => true, () => false), staleRevivedTarget: await outcome(a.transcript(revivedRow)), transcript: transcriptFacts(abortedTranscript, holdA.token) };

  // Independent root in the same process and the same global registry: its live child with the recycled id is invisible and untouchable here.
  await lifecycle.release("child-a");
  const secondary = await nativeSession();
  const b = adapter(secondary);
  try {
    const refForeign = await spawn(secondary, "child-a");
    await until(() => refForeign.status === "idle" ? true : undefined, "foreign child idle");
    const primaryList = await a.list(), secondaryList = await b.list();
    const foreignTarget = await b.target("child-a");
    const foreignActivity = a.subagents.activity();
    result.foreign = { registeredLive: refForeign.session !== null, foreignJournal: refForeign.sessionFile, belowSecondaryRoot: refForeign.sessionFile === path.join(secondary.manager.getArtifactsDir()!, "child-a.jsonl"),
      hiddenFromPrimary: rowOf(primaryList, "child-a") === undefined, primaryOmitted: primaryList.omitted, primaryRows: primaryList.rows.length,
      hiddenFromPrimaryActivity: foreignActivity.availability === "available" && !foreignActivity.value.some(agent => agent.id === "child-a"),
      visibleToSecondary: summarize(rowOf(secondaryList, "child-a")), secondaryTranscript: transcriptFacts(await b.transcript(foreignTarget), "child-a").availability,
      staleAbortedTarget: await outcome(a.transcript(abortedRow)), crossRootTarget: await outcome(a.transcript(foreignTarget)),
      crossRootValidate: await outcome(a.request({ action: "validate", owner: a.subagents.owner, target: foreignTarget })),
      crossRootFile: await outcome(a.file(foreignTarget, "notes.txt")), primaryJournalStillOnDisk: await stat(childFile).then(() => true, () => false) };
  } finally { await lifecycle.release("child-a").catch(() => {}); await secondary.close(); }

  // Owner loss: the original session retires; the lexical activity projection stays readable, every request fails closed.
  // Let the native completion delivery and its root follow-up turn finish first, as the jobs fixture does before disposal.
  const rootOwnerId = primary.session.getAgentId();
  await until(() => jobManager.getDeliveryState(rootOwnerId ? { ownerId: rootOwnerId } : undefined).queued === 0 && !primary.session.hasPendingAsyncWork() ? true : undefined, "root delivery");
  await primary.session.waitForIdle();
  a.state.retired = true;
  const retiredRead = await outcome(a.list());
  await primary.close();
  result.ownerLoss = { retired: retiredRead, disposed: await outcome(a.list()), sessionDisposed: primary.session.isDisposed, activityAfterLoss: a.subagents.activity().availability };
  // Reopening the retired root's own file: no scan, no import; only refs the native registry still holds.
  const reopened = await nativeSession(rootFile);
  try {
    const c = adapter(reopened);
    const cold = await c.list();
    result.cold = { reopenedSameNativeId: reopened.manager.getSessionId() === primary.manager.getSessionId(), availability: cold.availability, rows: cold.rows.map(summarize), omitted: cold.omitted,
      journalOnDisk: await stat(childFile).then(() => true, () => false), registryHasChild: AgentRegistry.global().get("child-a") !== undefined };
  } finally { await reopened.close(); }
}

async function worker() {
  const fixture = await prepareJobsFixture(directory, { inference });
  await writeFile(path.join(fixture.cwd, "notes.txt"), "controlled child notes\n");
  const { WorkerRuntime } = await import("../../omp-workers/runtime");
  const runtime = new WorkerRuntime({ agentDir: fixture.agentDir, workerPath: fixture.workerPath, environment: fixture.environment });
  const failures: unknown[] = [];
  try {
    const session = await runtime.create({ cwd: fixture.cwd, model: fixture.model });
    const request = (value: SessionSubagentsRequest) => session.nativeSubagents(value);
    const list = async () => { const value = await request({ action: "list" }) as List; assert.equal(value.availability, "available", value.reason); return value; };
    const owner = async () => (await list()).owner;
    const target = async (id: string) => { const row = rowOf(await list(), id); assert.ok(row, `Worker row ${id} is missing`); return row.target; };
    const first = await list();
    const control = await fixture.control.session(session.id);
    const status = await control.status();
    const rootDir = status.sessionFile!.slice(0, -".jsonl".length);
    result.identity = { sessionId: session.id, workerPid: session.workerPid, capturedPid: status.pid, capturedSessionId: status.sessionId, capturedFile: status.sessionFile, sessionFile: session.sessionFile,
      ownerMatches: first.owner.nativeSessionId === session.id, initiallyEmpty: first.rows.length === 0 && first.omitted === 0 };
    const holdA = inference.hold(token("w-a")), spawnedA = await control.spawnTask("w-a", holdA.token);
    await holdA.reached;
    const runningRow = await until(async () => { const row = rowOf(await list(), "w-a"); return row?.status === "running" ? row : undefined; }, "worker w-a running row");
    const activity = await session.getSessionActivity();
    const liveTranscript = await request({ action: "transcript", owner: await owner(), target: runningRow.target }) as Transcript;
    const childFile = path.join(rootDir, "w-a.jsonl");
    result.live = { row: summarize(runningRow), ownerId: spawnedA.ownerId, childSessions: (await control.status()).children, childJournal: childFile, journalOnDisk: await stat(childFile).then(() => true, () => false),
      activityAgents: activity.agents.availability === "available" ? activity.agents.value.map(agent => ({ id: agent.id, status: agent.status, running: agent.running, parentId: agent.parentId })) : activity.agents,
      transcript: transcriptFacts(liveTranscript, holdA.token), cwdIsProject: liveTranscript.cwd === fixture.cwd,
      validate: await outcome(request({ action: "validate", owner: await owner(), target: runningRow.target })),
      file: await request({ action: "file", owner: await owner(), target: runningRow.target, path: "notes.txt" }) as FileRead,
      staleOwner: await outcome(request({ action: "list", owner: { ...(await owner()), epoch: "stale-epoch" } })),
      fabricatedGuard: await outcome(request({ action: "transcript", owner: await owner(), target: { ...runningRow.target, guard: "fabricated-guard" } })),
      parentEscape: await outcome(request({ action: "file", owner: await owner(), target: runningRow.target, path: "../outside.txt" })) };
    holdA.release();
    await control.waitJob({ jobId: "w-a", status: "completed" });
    const idleRow = await until(async () => { const row = rowOf(await list(), "w-a"); return row?.status === "idle" ? row : undefined; }, "worker w-a idle row");
    const idleTranscript = await request({ action: "transcript", owner: await owner(), target: idleRow.target }) as Transcript;
    result.idle = { row: summarize(idleRow), sameGuard: idleRow.target.guard === runningRow.target.guard, transcript: transcriptFacts(idleTranscript, holdA.token), journal: await journalFacts(childFile),
      activityAgents: (await session.getSessionActivity()).agents };
    // An independent production worker owns another process-global registry: nothing of this root is visible there.
    const other = await runtime.create({ cwd: fixture.cwd, model: fixture.model });
    try {
      const otherList = await other.nativeSubagents({ action: "list" }) as List;
      result.independent = { availability: otherList.availability, rows: otherList.rows.length, omitted: otherList.omitted, ownerDiffers: otherList.owner.nativeSessionId !== session.id,
        crossWorkerTarget: await outcome(other.nativeSubagents({ action: "transcript", owner: otherList.owner, target: idleRow.target })) };
    } finally { await other.dispose(); }
    // Owner loss: the production handle disposes the worker; the child journal remains on disk untouched.
    await session.dispose();
    result.ownerLoss = { disposedList: await outcome(request({ action: "list" })), journalOnDisk: await stat(childFile).then(() => true, () => false) };
  } finally {
    await runtime.dispose().catch(cause => failures.push(cause));
    await fixture.stop().catch(cause => failures.push(cause));
    result.cleanupFailures = failures.map(String);
    if (failures.length) throw new AggregateError(failures, "Worker subagents fixture cleanup failed");
  }
}
