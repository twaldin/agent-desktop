// Authored acceptance, not App/command parsing or independent review. Two actual
// workers use one synthetic account and ONE host admission authority. Separate
// loopback transports deliberately need not observe each other's reset yet.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandResult, OmpInteraction } from "@agent-desktop/shared";
import type { SessionUsageCommand, UsageResetReceipt } from "../../../../../packages/shared/src/session-usage";
import type { WorkerSession, WorkerRuntimeOptions } from "../runtime";
import type { ResetPolicyWireRequest, ResetPolicyWireResult } from "../reset-policy-wire";

const [root, scenario] = process.argv.slice(2);
assert.ok(root && scenario);
assert.equal(process.env.HOME, root);
const fixtureBase = Math.floor(Date.now() / 1000) * 1000;
const blockedHostNetwork: string[] = [];
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  blockedHostNetwork.push(String(input instanceof Request ? input.url : input));
  throw new Error("Shared admission host attempted network access");
}, { preconnect() {} }) as typeof fetch;
const { HostStore } = await import("../../store");
const { ResetAccountAdmissions } = await import("../../session-reset-admission");
const { SessionUsageService } = await import("../../session-usage");
const { nativeResetAccountKey } = await import("../../omp/session-usage");
const { NativeResetPolicy } = await import("../../native-reset-policy");
const { NativeResetPolicyWorkerOwner } = await import("../reset-policy-owner");
const { WorkerRuntime, WorkerClient } = await import("../runtime");

interface Fact { seq: number; type: string; data: unknown }
interface WorkerStatus {
  pid: number; sessionId: string; sessionIds: { root: string; child?: string; sibling?: string };
  counts: { usage: number; credits: number; consume: number; inference: number; escaped: number; blockedPreconnect: number };
  consumes: Array<{ account_id?: string; credit_id?: string; redeem_request_id?: string }>;
  [key: string]: unknown;
}
interface WireFact { worker: string; request: ResetPolicyWireRequest; reply?: ResetPolicyWireResult; error?: string }
const facts: Fact[] = [], wire: WireFact[] = [], listeners = new Set<() => void>();
const traceFile = path.join(root, "trace.jsonl");
function record(type: string, data: unknown): void {
  const fact = JSON.parse(JSON.stringify({ seq: facts.length + 1, type, data })) as Fact;
  facts.push(fact); appendFileSync(traceFile, JSON.stringify(fact) + "\n");
  for (const listener of [...listeners]) listener();
}
function waitFor<T>(get: () => T | undefined): Promise<T> {
  const pending = Promise.withResolvers<T>();
  const check = () => { const value = get(); if (value !== undefined) { listeners.delete(check); pending.resolve(value); } };
  listeners.add(check); check(); return pending.promise;
}
function control<T = unknown>(directory: string, command: Record<string, unknown>): Promise<T> {
  record("control.request", { worker: path.basename(directory), command });
  return new Promise((resolve, reject) => {
    const socket = createConnection(path.join(directory, "control.sock")); let text = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("data", chunk => { text += chunk.toString(); });
    socket.once("end", () => {
      try { const reply = JSON.parse(text); record("control.reply", { worker: path.basename(directory), command, reply });
        if (!reply.ok) throw new Error(reply.error); resolve(reply.value as T);
      } catch (error) { reject(error); }
    });
  });
}
const deferred = () => ({ reached: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() });
let store = new HostStore(path.join(root, "host"));
let admissions = new ResetAccountAdmissions(store);
let policy = new NativeResetPolicy({ store, admissions });
const accountKey = nativeResetAccountKey({ provider: "openai-codex", accountId: "fixture-shared-account" });
const owners: Array<Parameters<NonNullable<WorkerRuntimeOptions["createResetPolicyOwner"]>>[0]> = [];
let heldNativeRead: ReturnType<typeof Promise.withResolvers<number>> | undefined;
function describeError(error: unknown): unknown {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack,
    ...(error instanceof AggregateError ? { errors: error.errors.map(describeError) } : {}) } : String(error);
}
function ownerOptions(worker: string): Pick<WorkerRuntimeOptions, "createResetPolicyOwner"> {
  return { createResetPolicyOwner: context => {
    owners.push(context); record("owner.bound", { worker, context });
    const owner = new NativeResetPolicyWorkerOwner({ store, policy, context });
    return {
      async handle(request) {
        const fact: WireFact = { worker, request: structuredClone(request) }; wire.push(fact);
        record("native.request", fact);
        try {
          const reply = await owner.handle(request);
          if (worker === "native" && heldNativeRead && request.operation.kind === "checkpoint"
            && request.operation.event.phase === "started" && request.operation.event.pass.trigger === "blocked") {
            const gate = heldNativeRead; heldNativeRead = undefined;
            const directory = workerRoots.get(worker)!;
            const status = await control<WorkerStatus>(directory, { op: "status" });
            await control(directory, { op: "gate", route: "usage" });
            gate.resolve(status.counts.usage + 1);
          }
          fact.reply = structuredClone(reply); record("native.reply", fact); return reply;
        }
        catch (error) { fact.error = String(error); record("native.error", fact); throw error; }
      },
      beginClose() { record("owner.beginClose", { worker }); owner.beginClose(); },
      workerLost() { record("owner.lost", { worker }); owner.workerLost(); },
      workerExited() { record("owner.exited", { worker }); owner.workerExited(); },
      drain: () => owner.drain(),
    };
  } };
}
const decisionMode = scenario.includes("decision");
const runtimes: InstanceType<typeof WorkerRuntime>[] = [];
const handles = new Map<string, WorkerSession>();
const workerRoots = new Map<string, string>();
const interactions: Array<{ worker: string; interaction: OmpInteraction }> = [];
async function startWorker(name: string) {
  const directory = path.join(root, name);
  await Promise.all(["agent", "project"].map(value => mkdir(path.join(directory, value), { recursive: true })));
  await writeFile(path.join(directory, "agent/config.yml"), `extensions: []\ncodexResets:\n  autoRedeem: ${decisionMode && name === "native" ? "unset" : "yes"}\n  minBlockedMinutes: 30\n  keepCredits: 0\n  salvageHorizonHours: 24\n`);
  const environment = { HOME: directory, PATH: process.env.PATH, TMPDIR: directory, TERM: "dumb", NO_COLOR: "1", PI_DISABLE_DOTENV: "1", PI_NO_TITLE: "1",
    PI_TELEMETRY_DISABLED: "1", PI_CODEX_WEBSOCKET: "0", PI_CODING_AGENT_DIR: path.join(directory, "agent"), SHARED_RESET_FIXTURE_ROOT: directory,
    SHARED_RESET_FIXTURE_BASE_MS: String(fixtureBase),
    XDG_CONFIG_HOME: path.join(directory, "xdg-config"), XDG_DATA_HOME: path.join(directory, "xdg-data"), XDG_CACHE_HOME: path.join(directory, "xdg-cache") };
  const runtime = new WorkerRuntime({ agentDir: environment.PI_CODING_AGENT_DIR, environment,
    workerPath: fileURLToPath(new URL("./shared-native-manual-admission-worker.ts", import.meta.url)), ...ownerOptions(name) });
  runtimes.push(runtime); workerRoots.set(name, directory);
  const session = await runtime.create({ cwd: path.join(directory, "project"), model: { provider: "openai-codex", id: "gpt-5.4-mini" }, interactions: true,
    onEvent: event => { if (event.type === "extension_interaction_requested") { interactions.push({ worker: name, interaction: event.interaction }); record("interaction.requested", { worker: name, interaction: event.interaction }); }
      else if (event.type === "extension_interaction_resolved") record("interaction.resolved", { worker: name, event }); } });
  handles.set(session.id, session);
  // Authenticated actual worker PIDs are retained for the outer watchdog's failure cleanup.
  appendFileSync(path.join(root, "owned-pids.jsonl"), JSON.stringify({ pid: session.workerPid, sessionId: session.id, directory }) + "\n");
  record("worker.created", { name, pid: session.workerPid, id: session.id, file: session.sessionFile, cwd: session.cwd });
  return { directory, runtime, session, control: <T = unknown>(command: Record<string, unknown>) => control<T>(directory, command) };
}
let manualCheckpoint: ReturnType<typeof deferred> | undefined;
let failCheckpoint = false;
const activeCommands = new Set<string>();
function makeUsage() {
  return new SessionUsageService({ store, admissions,
    existing: async id => {
      if (manualCheckpoint) {
        const gate = manualCheckpoint; manualCheckpoint = undefined;
        record("manual.durable-checkpoint", { account: admissions.inspect(accountKey) });
        gate.reached.resolve(); await gate.release.promise;
        if (failCheckpoint) throw new Error("Controlled host failure after durable manual admission");
      }
      return handles.get(id);
    }, open: async id => { const handle = handles.get(id); assert.ok(handle); return handle; },
    ordered: (_id, run) => run(), assertActive() {}, commandActive: id => activeCommands.has(id),
  });
}
let usage = makeUsage();
async function command(id: string, input: SessionUsageCommand): Promise<CommandResult> {
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex"), claim = store.claimCommand(id, hash, input);
  record("manual.command.claim", { id, input, claim });
  if (claim.kind === "done") return claim.record.result!;
  if (claim.kind !== "claimed") return { ok: false, commandId: id, error: { code: "OUTCOME_UNKNOWN", message: "Original command remains unresolved" } };
  activeCommands.add(id);
  let result: CommandResult;
  try {
    const receipt = input.type === "session.usage.reset.prepare" ? await usage.prepare(id, input) : await usage.answer(id, input);
    result = { ok: true, commandId: id, value: { type: "session.usage.reset", receipt } };
  } catch (error) { result = { ok: false, commandId: id, error: { code: "OUTCOME_UNKNOWN", message: String(error) } }; }
  try { result = store.finishCommand(id, hash, result).result!; record("manual.command.finished", { id, result }); return result; }
  finally { activeCommands.delete(id); }
}
function receipt(result: CommandResult): UsageResetReceipt {
  assert.ok(result.ok && result.value && "type" in result.value && result.value.type === "session.usage.reset", JSON.stringify(result));
  return result.value.receipt;
}
function nativeStarted() { return waitFor(() => wire.find(row => row.worker === "native" && row.reply?.kind === "checkpointed" && row.request.operation.kind === "checkpoint" && row.request.operation.event.phase === "started" && row.request.operation.event.pass.trigger === "blocked")); }
function nativeExecuted() { return waitFor(() => wire.find(row => row.worker === "native" && row.reply?.kind === "admission.execute")); }
function nativeDecision() { return waitFor(() => interactions.find(row => row.worker === "native")); }
const result: Record<string, unknown> = { scenario, accountKey, seam: "production native automatic retry policy on controlled loopback 429; production manual service and durable command journal; no App integration" };
let recovered: InstanceType<typeof WorkerClient> | undefined;
let manual: Awaited<ReturnType<typeof startWorker>> | undefined, automatic: Awaited<ReturnType<typeof startWorker>> | undefined;
let failed = false;
try {
  automatic = await startWorker("native"); manual = await startWorker("manual");
  const credits = await usage.read(manual.session.id, "credits"); record("manual.credits", credits);
  assert.ok(credits.snapshot);
  const account = credits.snapshot.credits.find(row => row.accountId === "fixture-shared-account" && row.canPrepare); assert.ok(account);
  const prepareId = randomUUID(), answerId = randomUUID();
  const prepare: SessionUsageCommand = { type: "session.usage.reset.prepare", sessionId: manual.session.id,
    epoch: credits.snapshot.epoch, revision: credits.snapshot.revision, accountRef: account.accountRef };
  const answer: SessionUsageCommand = { type: "session.usage.reset.respond", sessionId: manual.session.id, operationId: prepareId, confirm: true };
  const original = receipt(await command(prepareId, prepare)); assert.equal(original.state, "prepared");
  result.original = original; result.commandIds = { prepareId, answerId };
  const nativePrompt = async (target = "root") => {
    await automatic!.control({ op: "armBlocked", target });
    const pending = target === "root" ? automatic!.session.prompt("Controlled native automatic reset contention.") : automatic!.control({ op: "prompt", target });
    // Native prompt failures are observations, not unhandled rejection or invented clean completion.
    return { completion: pending.then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error) })) };
  };
  const statuses = async () => ({ native: await automatic!.control<WorkerStatus>({ op: "status" }), manual: await manual!.control<WorkerStatus>({ op: "status" }) });
  const totalConsumes = (s: Awaited<ReturnType<typeof statuses>>) => s.native.counts.consume + s.manual.counts.consume;
  const inspect = async (label: string) => {
    const value = { receipt: await usage.read(manual!.session.id, "cached", answerId), account: admissions.inspect(accountKey), attempts: admissions.listAttempts(), statuses: await statuses() };
    record(label, value); return value;
  };

  if (["native-read-first", "checkpoint-first-read", "native-decision-first", "checkpoint-first-decision"].includes(scenario)) {
    const checkpoint = deferred();
    let turn: Awaited<ReturnType<typeof nativePrompt>>;
    let heldDecision: Awaited<ReturnType<typeof nativeDecision>> | undefined;
    const readGate = decisionMode ? undefined : Promise.withResolvers<number>();
    if (readGate) heldNativeRead = readGate;
    const nativeFirst = scenario.startsWith("native-");
    if (nativeFirst) {
      turn = await nativePrompt(); await nativeStarted();
      if (decisionMode) heldDecision = await nativeDecision();
      else await automatic.control({ op: "wait", route: "usage", count: await readGate!.promise });
    }
    manualCheckpoint = checkpoint;
    const answering = command(answerId, answer);
    await checkpoint.reached.promise;
    const held = await inspect("competition.manual-checkpoint-held");
    assert.equal(held.account?.state, "dispatching"); assert.equal(held.account?.kind, "manual"); assert.equal(totalConsumes(held.statuses), 0);
    if (!nativeFirst) {
      turn = await nativePrompt(); await nativeStarted();
      if (decisionMode) heldDecision = await nativeDecision();
      else await automatic.control({ op: "wait", route: "usage", count: await readGate!.promise });
    }
    if (decisionMode) await automatic.session.respondInteraction(heldDecision!.interaction.id, { value: "Yes" });
    else await automatic.control({ op: "release", route: "usage" });
    result.nativePrompt = await turn!.completion;
    result.nativeDrain = await automatic.control({ op: "drain" });
    const beforeRelease = await inspect("competition.native-finished-manual-still-held");
    assert.equal(totalConsumes(beforeRelease.statuses), 0);
    checkpoint.release.resolve();
    result.manualResult = receipt(await answering);
    assert.equal((result.manualResult as UsageResetReceipt).outcome, "reset");
    const after = await inspect("competition.settled"); assert.equal(totalConsumes(after.statuses), 1);
    assert.equal(after.account?.operationId, prepareId); assert.equal(after.account?.kind, "manual");
    result.held = held; result.after = after;
  } else if (scenario === "native-admission-first" || scenario === "native-consume-failure" || scenario === "original-worker-recovery") {
    await automatic.control({ op: "gate", route: "consume" });
    if (scenario === "native-consume-failure") await automatic.control({ op: "setConsumeMode", mode: "throw" });
    const turn = await nativePrompt(); const execution = await nativeExecuted();
    assert.equal(execution.reply?.kind, "admission.execute");
    await automatic.control({ op: "wait", route: "consume", count: 1 });
    result.manualResult = receipt(await command(answerId, answer));
    assert.equal((result.manualResult as UsageResetReceipt).state, "rejected");
    const held = await inspect("competition.native-consume-held");
    assert.equal(held.account?.kind, "automatic"); assert.equal(held.account?.state, "dispatching"); assert.equal(totalConsumes(held.statuses), 1);
    if (scenario === "original-worker-recovery") {
      const endpoint = await automatic.session.enableBrowserRecovery!(path.join(automatic.directory, "worker.sock"), randomBytes(32).toString("hex"), randomUUID());
      // Real clean handoff is held by the original consume; neither fake workerLost nor replacement is used.
      const detach = automatic.runtime.dispose({ preserveReconnect: true });
      record("recovery.detach-started", endpoint);
      await automatic.control({ op: "release", route: "consume" });
      result.nativePrompt = await turn.completion; await detach; await policy.drain();
      // Detaching the host settles its RPC as UNKNOWN; it does not prove the
      // actual SDK retry is idle. Await that original session before takeover.
      result.originalIdle = await automatic.control({ op: "idle" });
      recovered = await WorkerClient.recover({ ...ownerOptions("recovered-native"), startupTimeoutMs: 10_000, shutdownTimeoutMs: 5_000 }, endpoint);
      assert.equal(recovered.pid, endpoint.pid);
      result.recovery = { original: endpoint, pid: recovered.pid, context: owners.at(-1), snapshot: recovered.snapshot };
      assert.equal(owners.at(-1)?.workerEpoch, endpoint.resetPolicy?.workerEpoch);
      assert.equal(owners.at(-1)?.snapshot.id, endpoint.resetPolicy?.rootSessionId);
      const requestsAfterRecovery = wire.filter(row => row.worker === "recovered-native");
      assert.equal(requestsAfterRecovery.some(row => row.request.operation.kind === "admit"), false);
    } else {
      await automatic.control({ op: "release", route: "consume" }); result.nativePrompt = await turn.completion;
    }
    result.nativeDrain = await automatic.control({ op: "drain" });
    const after = await inspect("competition.native-settled"); assert.equal(totalConsumes(after.statuses), 1);
    assert.equal(after.account?.attemptId, held.account?.attemptId); assert.equal(after.account?.operationId, held.account?.operationId);
    if (scenario === "native-consume-failure") assert.equal(after.account?.state, "unknown");
    else assert.equal(after.account?.state, "settled");
    result.held = held; result.after = after;
  } else if (scenario === "manual-checkpoint-failure" || scenario === "manual-consume-failure") {
    const checkpoint = deferred(); manualCheckpoint = checkpoint;
    const answering = command(answerId, answer); await checkpoint.reached.promise;
    if (scenario === "manual-checkpoint-failure") failCheckpoint = true;
    else await manual.control({ op: "setConsumeMode", mode: "malformed" });
    const turn = await nativePrompt(); result.nativePrompt = await turn.completion;
    result.nativeDrain = await automatic.control({ op: "drain" });
    const held = await inspect("failure.manual-checkpoint-held"); assert.equal(totalConsumes(held.statuses), 0);
    checkpoint.release.resolve(); result.manualResult = receipt(await answering);
    assert.equal((result.manualResult as UsageResetReceipt).state, "unknown");
    const after = await inspect("failure.original-fenced"); assert.equal(after.account?.state, "unknown");
    assert.equal(after.account?.operationId, prepareId);
    assert.equal(totalConsumes(after.statuses), scenario === "manual-consume-failure" ? 1 : 0);
    result.held = held; result.after = after;
  } else if (scenario === "cancelled-child-retirement") {
    await automatic.control({ op: "createChildren" });
    const readGate = Promise.withResolvers<number>(); heldNativeRead = readGate;
    const turn = await nativePrompt("child"); await nativeStarted();
    await automatic.control({ op: "wait", route: "usage", count: await readGate.promise });
    const cancelled = receipt(await command(answerId, { ...answer, confirm: false })); assert.equal(cancelled.state, "cancelled");
    const disposal = automatic.control({ op: "disposeChild", target: "child" });
    result.childClosing = await automatic.control({ op: "waitLifecycle", target: "child", phase: "beginClose" });
    await automatic.control({ op: "release", route: "usage" });
    result.nativePrompt = await turn.completion; result.childDisposal = await disposal;
    assert.equal(totalConsumes(await statuses()), 0);
    const sibling = await nativePrompt("sibling"); result.siblingPrompt = await sibling.completion;
    await automatic.control({ op: "drain", target: "sibling" });
    result.rootPrompt = await automatic.session.prompt("Root remains usable after exact child retirement.");
    result.manualResult = receipt(await command(randomUUID(), answer)); assert.equal((result.manualResult as UsageResetReceipt).state, "cancelled");
    const after = await inspect("retirement.original-cancellation-retained"); assert.equal(totalConsumes(after.statuses), 1);
    assert.equal(after.receipt.reset?.operationId, prepareId); assert.equal(after.receipt.reset?.state, "cancelled");
    result.after = after;
  } else throw new Error(`Unknown shared admission scenario: ${scenario}`);

  const beforeReplay = await statuses();
  result.replay = await command(answerId, scenario === "cancelled-child-retirement" ? { ...answer, confirm: false } : answer);
  result.originalReceipt = await usage.read(manual.session.id, "cached", answerId);
  const afterReplay = await statuses(); assert.equal(totalConsumes(afterReplay), totalConsumes(beforeReplay));
  assert.ok(totalConsumes(afterReplay) <= 1, "The two actual workers dispatched more than one consume");
  // Native eager preconnect is denied before any IO; retain that attempt rather
  // than misreport it as absent. No fetch or WebSocket escape is permitted.
  for (const status of Object.values(afterReplay)) assert.equal(status.counts.escaped, status.counts.blockedPreconnect);
  assert.deepEqual(blockedHostNetwork, []);
  result.final = { statuses: afterReplay, attempts: admissions.listAttempts(), account: admissions.inspect(accountKey), owners };
  const passIds = [...new Set(wire.map(row => row.request.passId))];
  result.passes = passIds.map(passId => policy.inspectPass(passId));
  assert.ok(result.passes && wire.some(row => row.request.operation.kind === "checkpoint" && row.request.operation.event.phase === "started"
    && row.request.operation.event.pass.trigger === "blocked" && row.request.operation.event.pass.source === "blocked"), "No actual native blocked automatic policy entry observed");
} catch (error) {
  failed = true; result.failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
} finally {
  // Only fixture-owned gates/processes. Keep raw input/output/trace files for the caller.
  for (const directory of workerRoots.values()) for (const route of ["usage", "credits", "consume", "inference"]) {
    try { await control(directory, { op: "release", route }); } catch { /* The actual worker may already have exited. */ }
  }
  const cleanup: unknown[] = [];
  if (recovered) try { await recovered.close({ requireAcknowledgement: true }); } catch (error) { cleanup.push(describeError(error)); }
  for (const runtime of runtimes.reverse()) try { await runtime.dispose(); } catch (error) { cleanup.push(describeError(error)); }
  try { await policy.drain(); } catch (error) { cleanup.push(describeError(error)); }
  result.cleanupErrors = cleanup; result.blockedHostNetwork = blockedHostNetwork;
  result.workerExit = [...new Set(owners.map(owner => owner.workerPid))].map(pid => {
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
    return { pid, alive };
  });
  store.close();
  result.wire = wire; result.facts = facts;
  writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
if (failed) process.exitCode = 1;
