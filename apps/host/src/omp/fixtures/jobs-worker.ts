// Actual production worker entry with three controlled seams: a fail-closed
// network guard whose only permitted origin is the fixture's loopback
// inference server, a transparent one-shot AgentRegistry registration tap that
// remembers the FIRST main registration so the original native session can be
// observed later, and a Unix control socket in the short fixture directory.
// No native job API, session method, runtime class or RPC is replaced. Every
// control operation works on the original captured session: real task-tool
// spawns, owner-scoped non-consuming reads, and gated manager rows this fixture
// registered itself. Cancellation, inspection and delivery stay production.
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import type { AgentRegistry, AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { installJobsNetworkGuard, JOBS_FIXTURE_CHILD_AGENT, JOBS_FIXTURE_ENV, JOBS_FIXTURE_INDEPENDENT_OWNER, type JobsFixtureJob, type JobsWorkerCommand, type JobsWorkerStatus } from "./jobs-controlled";

const root = process.env[JOBS_FIXTURE_ENV.root], controlDir = process.env[JOBS_FIXTURE_ENV.controlDir], inferenceOrigin = process.env[JOBS_FIXTURE_ENV.inferenceOrigin];
assert.ok(root && path.isAbsolute(root) && controlDir && inferenceOrigin, "jobs-worker.ts requires the prepared fixture environment");
assert.equal(process.env.HOME, root, "The controlled worker must run inside the disposable fixture HOME");
assert.equal(process.env.PI_CODING_AGENT_DIR, path.join(root, "agent"));
const blocked = installJobsNetworkGuard(inferenceOrigin, "native jobs worker fixture");

// Dynamic on purpose: the guard above must exist before any value-level SDK
// import, and the production entry below must load after the registry tap.
const native = await import("@oh-my-pi/pi-coding-agent");

let originalRegistry: AgentRegistry | undefined, originalAgentId: string | undefined;
const register = native.AgentRegistry.prototype.register;
native.AgentRegistry.prototype.register = function (input) {
  const registered = register.call(this, input);
  if (input.kind === "main" && !originalRegistry) {
    originalRegistry = this; originalAgentId = registered.id;
    native.AgentRegistry.prototype.register = register;
  }
  return registered;
};

/** The original session attached to the first main registration; undefined until the SDK attaches it. */
function original(): AgentSession | undefined {
  return originalAgentId === undefined ? undefined : originalRegistry?.get(originalAgentId)?.session ?? undefined;
}
function requireOriginal(): AgentSession {
  const session = original();
  assert.ok(session, "The original native session has not been captured yet");
  return session;
}
function requireManager(session: AgentSession): AsyncJobManager {
  const manager = session.asyncJobManager;
  assert.ok(manager, "The original native session has no asynchronous job manager");
  return manager;
}

interface Seeded { gate: ReturnType<typeof Promise.withResolvers<{ outcome: "complete" | "fail"; text: string }>>; ownerId: string }
const seeded = new Map<string, Seeded>();
const settled = new WeakSet<AsyncJob>();
const tracked = new WeakSet<AsyncJob>();
function project(manager: AsyncJobManager, job: AsyncJob): JobsFixtureJob {
  if (!tracked.has(job)) { tracked.add(job); void job.promise.then(() => settled.add(job), () => settled.add(job)); }
  return { id: job.id, type: job.type, status: job.status, queued: job.queued === true, label: job.label, startTime: job.startTime,
    ownerId: job.ownerId, agentId: job.agentId, resultText: job.resultText, errorText: job.errorText,
    consumed: manager.isJobResultConsumed(job.id), settled: settled.has(job), seeded: seeded.has(job.id) };
}
function status(): JobsWorkerStatus {
  const session = original();
  const manager = session?.asyncJobManager;
  const ownerId = session?.getAgentId();
  const jobs = manager ? manager.getAllJobs().filter(job => job.ownerId === ownerId || job.ownerId === JOBS_FIXTURE_INDEPENDENT_OWNER).map(job => project(manager, job)) : [];
  return { pid: process.pid, captured: Boolean(session), sessionId: session?.sessionId, sessionFile: session?.sessionManager.getSessionFile() ?? undefined,
    agentId: ownerId, isDisposed: session?.isDisposed, manager: Boolean(manager), jobs,
    delivery: manager ? manager.getDeliveryState(ownerId ? { ownerId } : undefined) : undefined, blocked: [...blocked],
    children: native.AgentRegistry.global().list().filter(ref => ref.kind !== "main").map(ref => ({ id: ref.id, sessionId: ref.session?.sessionId, agentId: ref.session?.getAgentId(), status: ref.status })) };
}
async function waitFor<T>(read: () => T | undefined, label: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

async function control(command: JobsWorkerCommand): Promise<unknown> {
  if (command.op === "status") return status();
  const session = requireOriginal(), manager = requireManager(session);
  const ownerId = session.getAgentId();
  assert.ok(ownerId, "The original native session must expose its owner agent id");
  switch (command.op) {
    case "spawnTask": {
      assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(command.name) && command.token.length >= 8, "spawnTask needs a safe name and token");
      const task = session.getToolByName("task");
      assert.ok(task, "The original session must expose the task tool");
      const toolCallId = `jobs-fixture-${command.name}`;
      const accepted = await task.execute(toolCallId, { name: command.name, agent: JOBS_FIXTURE_CHILD_AGENT, task: `Controlled background child ${command.token}.` });
      const text = accepted.content.find(part => part.type === "text")?.text ?? "";
      assert.ok(accepted.isError !== true, `The original task tool refused the detached spawn: ${text}`);
      const job = await waitFor(() => manager.getJob(command.name), `detached job ${command.name}`, 5_000);
      return { jobId: job.id, agentId: job.agentId, ownerId: job.ownerId, startTime: job.startTime, toolCallId, accepted: text };
    }
    case "seed": {
      const owner = command.owner === "independent" ? JOBS_FIXTURE_INDEPENDENT_OWNER : ownerId;
      const gate = Promise.withResolvers<{ outcome: "complete" | "fail"; text: string }>();
      const jobId = manager.register(command.type ?? "bash", command.label, async ({ signal }) => {
        const abort = Promise.withResolvers<never>();
        signal.addEventListener("abort", () => abort.reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"))), { once: true });
        const decision = await Promise.race([gate.promise, abort.promise]);
        if (decision.outcome === "fail") throw new Error(decision.text);
        return decision.text;
      }, { ownerId: owner, queued: command.queued === true, ...(command.id ? { id: command.id } : {}) });
      seeded.set(jobId, { gate, ownerId: owner });
      const job = manager.getJob(jobId);
      assert.ok(job);
      return { jobId, ownerId: owner, startTime: job.startTime };
    }
    case "markRunning": {
      assert.ok(seeded.has(command.jobId), "Only fixture-seeded rows may be marked running here");
      const job = manager.getJob(command.jobId);
      assert.ok(job && job.status === "running" && job.queued, "The seeded row is not queued");
      // The manager only exposes markRunning to the running body; a seeded body
      // never observes the semaphore, so this mirrors that exact flag change.
      job.queued = false;
      return project(manager, job);
    }
    case "release": {
      const entry = seeded.get(command.jobId);
      assert.ok(entry, "Only fixture-seeded rows may be released; production rows settle on their own");
      entry.gate.resolve({ outcome: command.outcome ?? "complete", text: command.text ?? `released ${command.jobId}` });
      const job = manager.getJob(command.jobId);
      assert.ok(job);
      await job.promise.catch(() => {});
      return project(manager, job);
    }
    case "job": {
      const job = manager.getJob(command.jobId);
      return job ? project(manager, job) : null;
    }
    case "waitJob": {
      const timeoutMs = command.timeoutMs ?? 15_000;
      return waitFor(() => {
        const job = manager.getJob(command.jobId);
        if (!job) return undefined;
        const view = project(manager, job);
        if (command.status !== undefined && view.status !== command.status) return undefined;
        if (command.settled !== undefined && view.settled !== command.settled) return undefined;
        if (command.queued !== undefined && view.queued !== command.queued) return undefined;
        return view;
      }, `job ${command.jobId} ${JSON.stringify(command)}`, timeoutMs);
    }
  }
  throw new Error(`Unknown controlled jobs operation: ${(command as { op: string }).op}`);
}

const sockets = new Set<Socket>();
const server = createServer(socket => {
  sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  let input = "", handled = false;
  socket.on("data", chunk => {
    if (handled) return;
    input += chunk.toString();
    if (input.length > 65_536) { handled = true; socket.end(`${JSON.stringify({ ok: false, error: "Control request too large" })}\n`); return; }
    const newline = input.indexOf("\n"); if (newline < 0) return;
    handled = true;
    void Promise.resolve().then(() => control(JSON.parse(input.slice(0, newline)) as JobsWorkerCommand)).then(
      value => socket.end(`${JSON.stringify({ ok: true, value: value ?? null })}\n`),
      error => socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`));
  });
});
const socketPath = path.join(controlDir, `w${process.pid}.sock`);
const listening = Promise.withResolvers<void>();
server.once("error", listening.reject);
server.listen(socketPath, listening.resolve);
await listening.promise;
// Production entry owns shutdown; the fixture only removes its own socket on exit.
process.once("exit", () => { server.close(); for (const socket of sockets) socket.destroy(); try { unlinkSync(socketPath); } catch { /* already gone */ } });
await import("../../omp-workers/entry");
