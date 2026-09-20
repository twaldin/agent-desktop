// Actual-native fixture for exact-session child owner retirement. Runs the
// public `NativeResetRuntimeOwners` factory against real pinned SDK sessions:
// a task child (TaskExecutor spawn, lifecycle park, executor revive), vibe
// worker siblings (vibe_spawn/vibe_kill) and a persisted cold revive. Every
// child owner is the real `NativeResetChannelOwner` over a real
// `ResetPolicyChannel`/`ResetPolicyHostChannel` pair with controlled host
// replies; only the pass evidence context is controlled (the fixture model is
// a local non-Codex provider, so no account evidence exists to capture).
// HOME/PI_CODING_AGENT_DIR/TMPDIR/XDG point at the disposable root. The
// process-global fetch is fail-closed before any native import; the only
// permitted origin is the local controlled inference server. Codex usage
// traffic exists only through the injected AuthStorage `usageFetch`.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentSession, CodexResetPolicySessionBinding, CodexResetPolicySessionLifecycleListener, ResetPass,
} from "@oh-my-pi/pi-coding-agent";
import type { OmpInteractionBridge } from "../../omp/interactions";
import type { ResetPolicyChannel as Channel, ResetPolicyHostChannel as HostChannel } from "../reset-policy-channel";
import type { NativeResetPassContext } from "../reset-policy-native-owner";
import type { ResetPolicyWireRequest, ResetPolicyWireResult } from "../reset-policy-wire";

let blockedFetches = 0;
const blockedNetworkAttempts: { kind: "fetch" | "preconnect"; url: string }[] = [];
let inferenceOrigin: string | undefined;
const originalFetch = globalThis.fetch;
function recordBlockedNetwork(kind: "fetch" | "preconnect", url: URL): never {
  if (kind === "fetch") blockedFetches++;
  blockedNetworkAttempts.push({ kind, url: `${url.origin}${url.pathname}` });
  throw new Error(`Network ${kind} is disabled in the native retirement fixture`);
}
globalThis.fetch = Object.assign(async (input: Request | URL | string, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (inferenceOrigin !== undefined && url.origin === inferenceOrigin) return originalFetch(input, init);
  return recordBlockedNetwork("fetch", url);
}, { preconnect: (input: URL | string) => {
  const url = new URL(String(input));
  if (inferenceOrigin !== undefined && url.origin === inferenceOrigin) return;
  recordBlockedNetwork("preconnect", url);
} }) as typeof fetch;

const directory = process.argv[2]!, scenario = process.argv[3]!;
assert.ok(directory && scenario, "usage: retirement-native.ts <root> <scenario>");
assert.equal(process.env.HOME, directory);
const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
await mkdir(path.join(cwd, ".omp", "agents"), { recursive: true });
await mkdir(agentDir, { recursive: true });

// ---------------------------------------------------------------------------
// Local controlled inference: every child turn yields immediately.
// ---------------------------------------------------------------------------
let inferenceRequests = 0;
const inferenceServer = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    assert.equal(url.pathname, "/v1/chat/completions");
    const body = (await request.json()) as { messages?: unknown[] };
    assert.ok(Array.isArray(body.messages));
    inferenceRequests++;
    const callId = `yield-${inferenceRequests}`;
    const chunk = (delta: Record<string, unknown>, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: callId, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "yield", arguments: JSON.stringify({ data: "controlled child complete" }) } }] }, null)
        + chunk({}, "tool_calls") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  },
});
inferenceOrigin = `http://127.0.0.1:${inferenceServer.port}`;

await writeFile(path.join(agentDir, "config.yml"), [
  "extensions: []", "task:", "  agentIdleTtlMs: 60000", "  maxRuntimeMs: 20000", "  agentModelOverrides:", "    sonic: fixture/base",
  "codexResets:", "  autoRedeem: no", "",
].join("\n"));
await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { fixture: {
  api: "openai-completions", baseUrl: `${inferenceOrigin}/v1`, auth: "none",
  models: [{ id: "base", name: "Controlled child", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
await writeFile(path.join(cwd, ".omp", "agents", "retire-child.md"), [
  "---", 'name: "retire-child"', 'description: "Controlled retirement child"', 'model: "fixture/base"',
  "tools: [read, yield]", "blocking: true", "---", "Return through yield immediately.", "",
].join("\n"));

// ---------------------------------------------------------------------------
// Controlled Codex usage transport behind AuthStorage.usageFetch. One held
// provider read at a time: the fixture never overlaps two owned fetches.
// ---------------------------------------------------------------------------
type Hold = { reached: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> };
let usageHold: Hold | undefined;
const usageRoutes: string[] = [];
const usageBase = Math.floor(Date.now() / 1000) * 1000;
const usageFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  usageRoutes.push(url.pathname);
  assert.equal(url.hostname, "chatgpt.com");
  if (url.pathname.endsWith("/wham/usage")) {
    const hold = usageHold;
    if (hold) { usageHold = undefined; hold.reached.resolve(); await hold.release.promise; }
    return Response.json({ plan_type: "plus", rate_limit: { allowed: true, limit_reached: false,
      primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: Math.floor((usageBase + 4 * 60 * 60 * 1000) / 1000) },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: Math.floor((usageBase + 2 * 24 * 60 * 60 * 1000) / 1000) } },
      rate_limit_reset_credits: { available_count: 0 } });
  }
  if (url.pathname.endsWith("/wham/rate-limit-reset-credits")) return Response.json({ available_count: 0, credits: [] });
  blockedFetches++;
  throw new Error(`Unexpected usage route: ${url.pathname}`);
}, { preconnect: () => {} }) as typeof fetch;

// Dynamic imports on purpose: native modules run discovery at load time and must
// only load after the outbound guard above.
const native = await import("@oh-my-pi/pi-coding-agent");
const { AgentRegistry, AuthStorage, createAgentSession, ModelRegistry, SessionManager, Settings, SqliteAuthCredentialStore } = native;
const { AgentLifecycleManager } = await import("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle");
const { createPersistedSubagentReviverFactory } = await import("@oh-my-pi/pi-coding-agent/task/persisted-revive");
const { getAgentDbPath } = await import("@oh-my-pi/pi-utils");
const { NativeResetRuntimeOwners } = await import("../../omp/native-reset-runtime");
const { NativeResetChannelOwner } = await import("../reset-policy-native-owner");
const { ResetPolicyChannel, ResetPolicyHostChannel } = await import("../reset-policy-channel");

const auth = new AuthStorage(await SqliteAuthCredentialStore.open(getAgentDbPath(agentDir)), { usageFetch });
await auth.set("openai-codex", [{ type: "oauth", refresh: "fixture-refresh", access: "fixture-access", expires: usageBase + 24 * 60 * 60 * 1000,
  accountId: "acct-retire", email: "retire@example.com" }]);
const settings = await Settings.loadReadOnly({ agentDir, cwd });
const writer = await settings.enableResetPolicyPersistence();
const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
const model = registry.find("fixture", "base");
assert.ok(model, "Controlled fixture model must resolve");

// ---------------------------------------------------------------------------
// Evidence journal: one monotonic sequence across lifecycle, host and capacity.
// ---------------------------------------------------------------------------
let seq = 0;
const events: { seq: number; event: string }[] = [];
function mark(event: string): number { const at = ++seq; events.push({ seq: at, event }); return at; }
interface HostEntry { seq: number; nativeSessionId: string; passId: string; kind: string; phase?: string }
const hostJournal: HostEntry[] = [];
const hostErrors: string[] = [];
const finishHolds = new Map<string, Hold>();

const digest = "a".repeat(64);
interface OwnerRecord {
  index: number; kind: "root" | "child" | "peer"; agentId: string | null; sessionId: string; session: object;
  sameObjectAsEarlier: boolean; sameIdAsEarlier: boolean; lifecycle: { seq: number; phase: string }[]; retired: number;
  captures: string[]; disposals: number; drained: boolean;
  closeReached: ReturnType<typeof Promise.withResolvers<void>>; drainReached: ReturnType<typeof Promise.withResolvers<void>>; retiredReached: ReturnType<typeof Promise.withResolvers<void>>;
}
const owners: OwnerRecord[] = [];
const ownerWaiters = new Map<string, ReturnType<typeof Promise.withResolvers<OwnerRecord>>>();
const peerSessions = new WeakSet<object>();
/** Resolves the exact owner bound for `agentId`; with `after`, only a binding created later than that record. */
function ownerFor(agentId: string, after?: OwnerRecord): Promise<OwnerRecord> {
  const found = owners.find(record => record.agentId === agentId && (!after || record.index > after.index));
  if (found) return Promise.resolve(found);
  let waiter = ownerWaiters.get(agentId);
  if (!waiter) { waiter = Promise.withResolvers<OwnerRecord>(); ownerWaiters.set(agentId, waiter); }
  return waiter.promise;
}
const contextDisposeThrows = new Set<OwnerRecord>();

function controlledContext(record: OwnerRecord, pass: ResetPass): NativeResetPassContext {
  record.captures.push(pass.passId);
  return {
    source: { kind: "source", selectionRevision: digest, policyRevision: digest },
    dispose() { record.disposals++; if (contextDisposeThrows.has(record)) throw new Error("controlled retirement cleanup failure"); },
    assertCurrent() {},
    async plan() { return { kind: "plan", accounts: [] }; },
    async persistence() { return { kind: "persistence", status: "failed" }; },
    async admission() { throw new Error("Controlled retirement fixture never admits"); },
    async runDecision() { throw new Error("Controlled retirement fixture never decides"); },
  };
}

let channel: Channel | undefined;
let host: HostChannel | undefined;
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
async function handleHostRequest(request: ResetPolicyWireRequest): Promise<ResetPolicyWireResult> {
  const operation = request.operation;
  const phase = operation.kind === "checkpoint" ? operation.event.phase : undefined;
  hostJournal.push({ seq: ++seq, nativeSessionId: request.nativeSessionId, passId: request.passId, kind: operation.kind, phase });
  events.push({ seq, event: `host:${request.nativeSessionId}:${operation.kind}${phase ? `:${phase}` : ""}` });
  switch (operation.kind) {
    case "checkpoint": {
      if (phase === "finished") {
        const hold = finishHolds.get(request.nativeSessionId);
        if (hold) { finishHolds.delete(request.nativeSessionId); hold.reached.resolve(); await hold.release.promise; }
      }
      return { kind: "checkpointed" };
    }
    case "decision.prepare": return { kind: "decision.prepared", decisionId: "controlled-decision" };
    case "decision.bind": return { kind: "decision.bound" };
    case "admit": return { kind: "admission.hold", reason: "owner-unavailable" };
    case "complete": return { kind: "completed" };
    default: throw new Error(`Unexpected reset operation ${operation.kind}`);
  }
}

const create = (binding: Readonly<CodexResetPolicySessionBinding>, _interactions: Pick<OmpInteractionBridge, "runWithDecisionBinding" | "runWithSignal">) => {
  if (!channel) {
    const wireBinding = { workerEpoch: "retirement-epoch", rootSessionId: binding.session.sessionId };
    channel = new ResetPolicyChannel(wireBinding, request => { void host!.receive(wire(request)).catch(error => hostErrors.push(String(error))); });
    host = new ResetPolicyHostChannel(wireBinding, handleHostRequest, response => channel!.receive(wire(response)));
  }
  const session = binding.session;
  const record: OwnerRecord = {
    index: owners.length + 1, kind: owners.length === 0 ? "root" : peerSessions.has(session) ? "peer" : "child",
    agentId: peerSessions.has(session) ? null : (session.getAgentId() ?? null), sessionId: session.sessionId, session,
    sameObjectAsEarlier: owners.some(other => other.session === session), sameIdAsEarlier: owners.some(other => other.sessionId === session.sessionId),
    lifecycle: [], retired: 0, captures: [], disposals: 0, drained: false,
    closeReached: Promise.withResolvers(), drainReached: Promise.withResolvers(), retiredReached: Promise.withResolvers(),
  };
  // Second exact-session listener beside the group's: pure observation.
  binding.registerLifecycle({
    beginClose: () => { record.lifecycle.push({ seq: mark(`owner${record.index}:beginClose`), phase: "beginClose" }); record.closeReached.resolve(); },
    drained: () => { record.drained = true; record.lifecycle.push({ seq: mark(`owner${record.index}:drained`), phase: "drained" }); record.drainReached.resolve(); },
  });
  const owner = new NativeResetChannelOwner(channel, pass => controlledContext(record, pass), () => {
    record.retired++; record.lifecycle.push({ seq: mark(`owner${record.index}:retired`), phase: "retired" }); record.retiredReached.resolve();
  });
  owners.push(record);
  if (record.agentId !== null) { ownerWaiters.get(record.agentId)?.resolve(record); ownerWaiters.delete(record.agentId); }
  return owner;
};
const group = new NativeResetRuntimeOwners({ settings, modelRegistry: registry, authStorage: auth, writer }, () => undefined, create);

// ---------------------------------------------------------------------------
// Controlled exact-binding peers: NOT native sessions. They occupy group slots
// with exact object identity and a controlled lifecycle registrar so capacity
// can be saturated without constructing 128 real AgentSessions.
// ---------------------------------------------------------------------------
const peerSettings = Settings.isolated({}, { resetPolicyWriter: writer });
let peerCount = 0;
/** A controlled slot occupant: exact object identity, no native session behind it. */
interface Peer { binding: Readonly<CodexResetPolicySessionBinding>; session: object; retire(): void }
function controlledPeer(): Peer {
  const listeners: Readonly<CodexResetPolicySessionLifecycleListener>[] = [];
  const session = {
    settings: peerSettings, modelRegistry: registry, sessionId: `controlled-peer-${++peerCount}`, isDisposed: false,
    beginDispose() { if (session.isDisposed) return; session.isDisposed = true; for (const listener of listeners) listener.beginClose(); for (const listener of listeners) listener.drained(); },
    async dispose() { session.beginDispose(); },
    getAgentId() { return null; },
  };
  peerSessions.add(session);
  // Structural stand-in for the exact-identity checks only; the group never calls session behavior beyond beginDispose.
  const peerSession = session as unknown as AgentSession;
  const binding: Readonly<CodexResetPolicySessionBinding> = Object.freeze({
    session: peerSession, settings: peerSettings, modelRegistry: registry, authStorage: auth,
    registerLifecycle: (listener: Readonly<CodexResetPolicySessionLifecycleListener>) => { listeners.push(listener); return () => { const at = listeners.indexOf(listener); if (at >= 0) listeners.splice(at, 1); }; },
  });
  return { binding, session, retire: () => session.beginDispose() };
}
const capacityRefusals: string[] = [];
function tryFactory(binding: Readonly<CodexResetPolicySessionBinding>): string {
  try { group.factory(binding); return "accepted"; }
  catch (error) { capacityRefusals.push(String(error)); return "refused"; }
}
const taskBoundary = () => new Promise<void>(resolve => setImmediate(resolve));
async function retirePeers(peers: Peer[]): Promise<void> {
  const records = peers.map(peer => owners.find(record => record.session === peer.session));
  for (const peer of peers) peer.retire();
  await Promise.all(records.map(record => record?.retiredReached.promise));
  await taskBoundary();
}
/** Fills every remaining slot with controlled peers. `probe` binds one more peer
 * and reports the outcome; an accepted probe peer stays retained for later retirement. */
function saturate() {
  const peers: Peer[] = [];
  const probe = (): string => { const peer = controlledPeer(); const outcome = tryFactory(peer.binding); if (outcome === "accepted") peers.push(peer); return outcome; };
  let refusal = probe();
  while (refusal === "accepted" && peers.length < 200) refusal = probe();
  return { peers, saturated: peers.length, refusal, probe };
}

// ---------------------------------------------------------------------------
// Held native drain: a real owned provider read, then the awaited finished
// checkpoint, are each released only after the fixture observed the child's
// exact beginClose with no drained/retirement.
// ---------------------------------------------------------------------------
function syntheticPass(nativeSessionId: string, passId: string): ResetPass {
  return { passId, nativeSessionId, trigger: "sweep", source: "manual", startedAtMs: Date.now(), provider: "fixture", modelId: "base",
    policy: { autoRedeem: "no", minBlockedMinutes: 60, keepCredits: 0, salvageHorizonHours: 12 } };
}
async function heldRetirement(session: AgentSession, record: OwnerRecord, beginDisposal: () => Promise<unknown>, capacityProbe?: () => string) {
  await auth.invalidateUsageCache("openai-codex");
  const usage: Hold = { reached: Promise.withResolvers(), release: Promise.withResolvers() };
  const finished: Hold = { reached: Promise.withResolvers(), release: Promise.withResolvers() };
  usageHold = usage; finishHolds.set(session.sessionId, finished);
  const fetched = session.fetchUsageReportsWithResetPolicy({ source: "manual" });
  const reachedUsage = await Promise.race([usage.reached.promise.then(() => true), fetched.then(() => false, () => false)]);
  assert.ok(reachedUsage, "Owned usage fetch must reach the controlled provider transport before settling");
  const usageHeldAt = mark(`owner${record.index}:usage-held`);
  const disposal = beginDisposal();
  await record.closeReached.promise;
  const duringUsageHold = { capacity: capacityProbe?.(), drained: record.drained, retired: record.retired, disposed: session.isDisposed };
  usage.release.resolve();
  const reachedFinished = await Promise.race([finished.reached.promise.then(() => true), fetched.then(() => false, () => false)]);
  assert.ok(reachedFinished, "Finished checkpoint must reach the host channel before the owned fetch settles");
  const finishedHeldAt = mark(`owner${record.index}:finished-held`);
  const duringFinishedHold = { capacity: capacityProbe?.(), drained: record.drained, retired: record.retired, disposed: session.isDisposed };
  finished.release.resolve();
  await record.drainReached.promise;
  await record.retiredReached.promise;
  const settlement = await fetched;
  await taskBoundary();
  const afterRetirement = { capacity: capacityProbe?.(), drained: record.drained, retired: record.retired };
  const exposed = session.codexResetPolicyOwner;
  assert.ok(exposed, "Bound session exposes its group wrapper");
  const latePassId = `late-${record.index}`;
  const lateCall = await exposed.checkpoint({ phase: "started", pass: syntheticPass(session.sessionId, latePassId) }).then(() => "resolved", error => String(error));
  const lateReachedHost = hostJournal.some(entry => entry.passId === latePassId);
  const lateCaptured = record.captures.includes(latePassId);
  await disposal;
  return { usageHeldAt, finishedHeldAt, duringUsageHold, duringFinishedHold, afterRetirement, policy: settlement.policy, lateCall, lateReachedHost, lateCaptured };
}

function passesFor(sessionId: string) {
  return hostJournal.filter(entry => entry.nativeSessionId === sessionId).map(entry => `${entry.kind}${entry.phase ? `:${entry.phase}` : ""}`);
}

// ---------------------------------------------------------------------------
// Root: real SDK session bound through the public group factory.
// ---------------------------------------------------------------------------
const sessionManager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
const rootRegistry = new AgentRegistry();
const created = await createAgentSession({ agentDir, cwd, settings, authStorage: auth, modelRegistry: registry, sessionManager, model,
  agentRegistry: rootRegistry, hasUI: false, interactivePrompts: false, disableExtensionDiscovery: true, extensions: [], enableLsp: false, enableMCP: false,
  toolNames: ["task", "read"], skills: [], rules: [], contextFiles: [], systemPrompt: "Controlled retirement root.", codexResetPolicyOwnerFactory: group.factory });
await sessionManager.ensureOnDisk();
const root = created.session;
const rootRecord = owners[0]!;
assert.equal(rootRecord.session, root, "First binding is the exact root session");
assert.equal(rootRecord.kind, "root");

const result: Record<string, unknown> = { scenario };
const lifecycleManager = AgentLifecycleManager.global();

async function runTaskChild(label: string): Promise<{ child: AgentSession; record: OwnerRecord }> {
  const task = root.getToolByName("task");
  assert.ok(task, "Root must expose the task tool");
  const running = task.execute(`task-${label}`, { name: label, agent: "retire-child", task: `Run controlled ${label} child.` });
  const record = await ownerFor(label);
  const outcome = await running;
  assert.equal(outcome.isError, undefined, `Task child ${label} must complete without error`);
  const ref = AgentRegistry.global().get(label);
  assert.ok(ref?.session, `Task child ${label} must stay live after its turn`);
  assert.equal(ref.session, record.session, "Task child owner is bound to the exact live child session");
  return { child: ref.session, record };
}

try {
  switch (scenario) {
    case "task-revive": {
      const { child, record: childRecord } = await runTaskChild("retire-task");
      // Saturate: root + one live child + controlled peers up to the cap.
      const capacity = saturate();
      const held = await heldRetirement(child, childRecord, () => lifecycleManager.park("retire-task"), capacity.probe);
      const parkedRef = AgentRegistry.global().get("retire-task");
      const parked = { status: parkedRef?.status, sessionNull: parkedRef?.session === null };
      // Exactly one slot was freed: the post-retirement probe took it, the next binding is refused.
      const secondReclaim = capacity.probe();
      await retirePeers(capacity.peers);
      // Executor revive: the same transcript session id in a different AgentSession object.
      const revived = await lifecycleManager.ensureLive("retire-task");
      const revivedRecord = await ownerFor("retire-task", childRecord);
      assert.notEqual(revived, child, "Executor revive constructs a replacement AgentSession");
      assert.equal(revivedRecord.session, revived, "Revived owner is bound to the exact revived object");
      const revivedHeld = await heldRetirement(revived, revivedRecord, () => revived.dispose());
      // Persisted cold revive: a parked ref with only a session file and the root-scoped reviver.
      lifecycleManager.setPersistedSubagentReviverFactory(createPersistedSubagentReviverFactory({
        session: root, authStorage: auth, modelRegistry: registry, settings, enableLsp: false, codexResetPolicyOwnerFactory: group.factory }), 60_000);
      const coldManager = SessionManager.create(cwd, path.join(agentDir, "cold-sessions"));
      coldManager.appendSessionInit({ systemPrompt: "Controlled cold child.", task: "no provider turn", tools: [], restrictToolNames: true, spawns: "", resolvedModel: "fixture/base" });
      await coldManager.ensureOnDisk(); await coldManager.flush();
      const coldFile = coldManager.getSessionFile(); assert.ok(coldFile); await coldManager.close();
      AgentRegistry.global().register({ id: "cold-child", displayName: "cold-child", kind: "sub", parentId: "Main", session: null, sessionFile: coldFile, status: "parked" });
      const cold = await lifecycleManager.ensureLive("cold-child");
      const coldRecord = await ownerFor("cold-child");
      assert.equal(coldRecord.session, cold, "Cold-revived owner is bound to the exact cold session");
      const coldHeld = await heldRetirement(cold, coldRecord, () => lifecycleManager.release("cold-child"));
      // Root keeps using the shared channel after every child retired.
      await auth.invalidateUsageCache("openai-codex");
      const rootAfter = await root.fetchUsageReportsWithResetPolicy({ source: "manual" });
      result.task = {
        childSessionId: child.sessionId, revivedSessionId: revived.sessionId, coldSessionId: cold.sessionId,
        peersAccepted: capacity.saturated, saturationRefusal: capacity.refusal, secondReclaim, parked,
        child: held, revived: revivedHeld, cold: coldHeld,
        childPasses: passesFor(child.sessionId), coldPasses: passesFor(cold.sessionId), rootPasses: passesFor(root.sessionId),
        rootAfter: rootAfter.policy, revivedBinding: { sameObjectAsEarlier: revivedRecord.sameObjectAsEarlier, sameIdAsEarlier: revivedRecord.sameIdAsEarlier, index: revivedRecord.index, childIndex: childRecord.index },
      };
      break;
    }
    case "vibe-siblings": {
      await root.activateVibeTools(["read"]);
      const spawn = root.getToolByName("vibe_spawn"), kill = root.getToolByName("vibe_kill");
      assert.ok(spawn && kill, "Vibe tools must be active on the root");
      const jobs = root.asyncJobManager; assert.ok(jobs, "Vibe workers require the root async job manager");
      const spawnWorker = async (name: string) => {
        const outcome = await spawn.execute(`spawn-${name}`, { cli: "fast", name, prompt: `Controlled ${name} worker turn.` });
        const details: unknown = outcome.details;
        assert.ok(details && typeof details === "object" && "spawned" in details, `vibe_spawn must report the spawned ${name} worker`);
        const spawned: unknown = details.spawned;
        assert.ok(spawned && typeof spawned === "object" && "id" in spawned && "jobId" in spawned
          && typeof spawned.id === "string" && typeof spawned.jobId === "string", "vibe_spawn details carry the worker id and turn job");
        const spawnedId: string = spawned.id, spawnedJobId: string = spawned.jobId;
        const record = await ownerFor(spawnedId);
        const job = jobs.getJob(spawnedJobId); assert.ok(job, "Spawned worker turn must be a registered job");
        await job.promise;
        assert.equal(job.status, "completed", `Worker ${name} turn must complete: ${job.errorText ?? ""}`);
        const ref = AgentRegistry.global().get(spawnedId);
        assert.ok(ref?.session, `Vibe worker ${name} must stay live between turns`);
        assert.equal(ref.session, record.session, "Vibe worker owner is bound to the exact live worker session");
        return { id: spawnedId, session: ref.session, record };
      };
      const a = await spawnWorker("vibe-a"), b = await spawnWorker("vibe-b");
      const aHeld = await heldRetirement(a.session, a.record, () => kill.execute("kill-a", { session: a.id }));
      // The live sibling and the root keep using the shared channel after A retired.
      const siblingStateBeforePass = { retired: b.record.retired, drained: b.record.drained, disposed: b.session.isDisposed };
      await auth.invalidateUsageCache("openai-codex");
      const siblingAfter = await b.session.fetchUsageReportsWithResetPolicy({ source: "manual" });
      await auth.invalidateUsageCache("openai-codex");
      const rootAfter = await root.fetchUsageReportsWithResetPolicy({ source: "manual" });
      const bHeld = await heldRetirement(b.session, b.record, () => kill.execute("kill-b", { session: b.id }));
      result.vibe = {
        aSessionId: a.session.sessionId, bSessionId: b.session.sessionId, a: aHeld, b: bHeld,
        siblingStateBeforePass, siblingAfter: siblingAfter.policy, rootAfter: rootAfter.policy,
        aPasses: passesFor(a.session.sessionId), bPasses: passesFor(b.session.sessionId), rootPasses: passesFor(root.sessionId),
        siblingPassSeqs: hostJournal.filter(entry => entry.nativeSessionId === b.session.sessionId).map(entry => entry.seq),
        rootPassSeqs: hostJournal.filter(entry => entry.nativeSessionId === root.sessionId).map(entry => entry.seq),
        aRetiredSeq: a.record.lifecycle.find(entry => entry.phase === "retired")?.seq,
      };
      break;
    }
    case "retained-error": {
      const { child, record: childRecord } = await runTaskChild("retire-failing");
      contextDisposeThrows.add(childRecord);
      const capacity = saturate();
      const held = await heldRetirement(child, childRecord, () => lifecycleManager.park("retire-failing"), capacity.probe);
      await retirePeers(capacity.peers);
      await auth.invalidateUsageCache("openai-codex");
      const rootAfter = await root.fetchUsageReportsWithResetPolicy({ source: "manual" });
      result.retained = { childSessionId: child.sessionId, peersAccepted: capacity.saturated, saturationRefusal: capacity.refusal,
        child: held, disposals: childRecord.disposals, rootAfter: rootAfter.policy, childPasses: passesFor(child.sessionId) };
      break;
    }
    default: assert.fail(`Scenario ${scenario} has no implementation`);
  }
  // Root teardown in production order: group close, native root disposal, group finish.
  const rootRetiredBeforeFinish = rootRecord.retired;
  group.beginClose();
  await root.dispose();
  const finish = await group.finish().then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, messages: flatten(error) }));
  result.finish = finish;
  result.root = { retiredBeforeFinish: rootRetiredBeforeFinish, retiredAfterFinish: rootRecord.retired, lifecycle: rootRecord.lifecycle, index: rootRecord.index };
} finally {
  await lifecycleManager.dispose().catch(() => {});
  inferenceServer.stop(true);
  settings.disableResetPolicyPersistence();
  auth.close();
}

function flatten(error: unknown): string[] {
  if (error instanceof AggregateError) return [error.message, ...error.errors.flatMap(flatten)];
  return [error instanceof Error ? error.message : String(error)];
}

result.owners = owners.map(record => ({ index: record.index, kind: record.kind, agentId: record.agentId, sessionId: record.sessionId,
  sameObjectAsEarlier: record.sameObjectAsEarlier, sameIdAsEarlier: record.sameIdAsEarlier, lifecycle: record.lifecycle, retired: record.retired, captures: record.captures.length }));
result.events = events;
result.hostJournal = hostJournal;
result.hostErrors = hostErrors;
result.usageRoutes = usageRoutes;
result.inferenceRequests = inferenceRequests;
result.capacityRefusals = capacityRefusals;
result.blockedFetches = blockedFetches;
result.blockedNetworkAttempts = blockedNetworkAttempts;
await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);
process.exit(0);
