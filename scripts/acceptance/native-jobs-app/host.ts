// Disposable real host for the native Jobs App acceptance. Owns the loopback
// inference server and the short control-socket directory (prepareJobsFixture),
// starts the production host with the transparent `jobs-worker.ts` entry, creates
// two isolated conversations, and exposes a token-guarded loopback control
// bridge so the single Electron driver can create/hold/release REAL detached
// task children in the original native sessions. No renderer bridge, host RPC
// or native job API is added or replaced.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import type { CommandEnvelope, CommandResult, Project, SessionSummary } from "../../../packages/shared/src/protocol";
import { JOBS_FIXTURE_CHILD_RESULT, prepareJobsFixture, type InferenceHold, type JobsWorkerControl } from "../../../apps/host/src/omp/fixtures/jobs-controlled";

const root = resolve(process.argv[2]!);
if (process.env.HOME !== root || process.env.PI_CODING_AGENT_DIR !== join(root, "agent") || process.env.PI_DISABLE_DOTENV !== "1"
  || process.env.PATH?.split(delimiter)[0] !== join(root, "bin") || await readFile(join(root, "bin/tailscale"), "utf8") !== "#!/bin/sh\nexit 1\n")
  throw new Error("Isolated dotenv-disabled jobs fixture and explicit tailnet refusal required.");
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Non-loopback fetch forbidden in the jobs host fixture.");
  return originalFetch(input, { ...init, redirect: "error" });
}, { preconnect: () => {} }) as typeof fetch;

const fixture = await prepareJobsFixture(root);
// Workers spawned by the production host inherit this process environment.
for (const [key, value] of Object.entries(fixture.environment)) process.env[key] = value;
await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
// Dynamic on purpose: the host module must load after the guard and the prepared native profile.
const { startHost } = await import("../../../apps/host/src/server");
const hostOptions = { dataDirectory: join(root, "data"), agentDirectory: fixture.agentDir, discoveryDirectory: fixture.cwd, workerPath: fixture.workerPath, tailscale: false, port: 0 };
let host = await startHost(hostOptions).catch(async cause => {
    const drained = await Promise.allSettled([fixture.stop()]);
    throw new AggregateError([cause, ...drained.flatMap(result => result.status === "rejected" ? [result.reason] : [])], "Jobs fixture host startup failed.");
  });
const fixedPort = Number(new URL(host.connection.origin).port);
let restarting = false;

const holds = new Map<string, InferenceHold>();
const controlToken = crypto.randomUUID();
type ControlCommand =
  | { op: "spawnTask"; sessionId: string; name: string }
  | { op: "awaitReached" | "release" | "fail"; name: string }
  | { op: "job"; sessionId: string; jobId: string }
  | { op: "waitJob"; sessionId: string; jobId: string; status?: string; settled?: boolean; queued?: boolean }
  | { op: "status"; sessionId: string }
  | { op: "workers" }
  | { op: "inference" }
  | { op: "restartHost" };
async function workerFor(sessionId: string): Promise<JobsWorkerControl> { return fixture.control.session(sessionId, 20_000); }
async function control(command: ControlCommand): Promise<unknown> {
  switch (command.op) {
    case "spawnTask": {
      if (holds.has(command.name)) throw new Error(`Child ${command.name} was already spawned`);
      const hold = fixture.inference.hold(`${command.name}-${crypto.randomUUID()}`);
      holds.set(command.name, hold);
      // A queued child reaches the provider only once a slot frees; the driver awaits that separately.
      return (await workerFor(command.sessionId)).spawnTask(command.name, hold.token);
    }
    case "awaitReached": case "release": case "fail": {
      const hold = holds.get(command.name);
      if (!hold) throw new Error(`Child ${command.name} has no held turn`);
      if (command.op === "awaitReached") { const reached = await Promise.race([hold.reached, Bun.sleep(30_000).then(() => undefined)]); if (!reached) throw new Error(`Child ${command.name} never reached the loopback provider`); return { seq: reached.seq, kind: reached.kind, token: reached.token }; }
      if (command.op === "release") hold.release(); else hold.fail();
      return null;
    }
    case "job": return (await workerFor(command.sessionId)).job(command.jobId);
    case "waitJob": return (await workerFor(command.sessionId)).waitJob({ jobId: command.jobId, status: command.status as "running" | undefined, settled: command.settled, queued: command.queued, timeoutMs: 20_000 });
    case "status": return (await workerFor(command.sessionId)).status();
    case "workers": return (await fixture.control.workers()).map(worker => ({ socket: worker.socket, pid: worker.status.pid, sessionId: worker.status.sessionId, captured: worker.status.captured }));
    case "inference": return fixture.inference.requests;
    case "restartHost": {
      // Owner loss: the production host stops cleanly (every original worker and
      // native session retires) and restarts on the same port/host id with a
      // rotated token. Nothing native survives; no jobs read revives a worker.
      if (restarting) throw new Error("A host restart is already in progress");
      restarting = true;
      try {
        const before = (await fixture.control.workers()).map(worker => worker.status.pid);
        await host.stop();
        host = await startHost({ ...hostOptions, port: fixedPort });
        return { hostId: host.connection.hostId, origin: host.connection.origin, retiredWorkerPids: before, liveWorkers: (await fixture.control.workers()).length };
      } finally { restarting = false; }
    }
  }
  throw new Error(`Unknown control operation: ${(command as { op: string }).op}`);
}
const bridge = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 60,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/control" || request.headers.get("authorization") !== `Bearer ${controlToken}`)
      return Response.json({ ok: false, error: "Refused" }, { status: 403 });
    try { return Response.json({ ok: true, value: await control(await request.json() as ControlCommand) }); }
    catch (error) { return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
  },
});

async function drain() {
  // Sequential on purpose: the workers must be gone before the fixture checks its sockets.
  const failures: unknown[] = [];
  for (const step of [() => Promise.resolve(bridge.stop(true)), () => host.stop(), () => fixture.stop()]) await step().catch(cause => failures.push(cause));
  if (failures.length) throw new AggregateError(failures, "Jobs fixture bridge/host/provider drain failed.");
}
async function command(command: CommandEnvelope["command"]) {
  const response = await fetch(`${host.connection.origin}/v19/commands`, { method: "POST", headers: { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: crypto.randomUUID(), commandVersion: 19, command } satisfies CommandEnvelope) });
  const result = await response.json() as CommandResult;
  if (!response.ok || !result.ok) throw new Error(`Fixture setup command failed: ${JSON.stringify(result)}`);
  return result.value;
}
try {
  const project = await command({ type: "project.add", path: fixture.cwd, name: "Native jobs acceptance workspace" }) as Project;
  const sessions: Record<string, { id: string; sessionFile: string }> = {};
  for (const name of ["primary", "other"]) {
    const session = await command({ type: "session.create", projectId: project.id, model: fixture.model, approvalMode: "yolo" }) as SessionSummary;
    await command({ type: "session.rename", sessionId: session.id, title: `Jobs ${name} acceptance` });
    sessions[name] = { id: session.id, sessionFile: session.sessionFile };
  }
  await writeFile(join(root, "ready.json"), JSON.stringify({ connection: host.connection, context: { projectId: project.id, projectPath: fixture.cwd, sessions, model: fixture.model,
    childResult: JOBS_FIXTURE_CHILD_RESULT, control: { origin: `http://127.0.0.1:${bridge.port}`, token: controlToken }, inferenceOrigin: fixture.inference.origin, controlDirectory: fixture.control.directory } }), { mode: 0o600 });
  let stopping = false;
  async function stop() {
    if (stopping) return; stopping = true;
    try { await drain(); process.exit(0); } catch (cause) { console.error(cause); process.exit(1); }
  }
  process.on("SIGTERM", () => void stop());
  for await (const chunk of process.stdin) if (String(chunk).trim() === "stop") await stop();
} catch (cause) {
  const drained = await Promise.allSettled([drain()]);
  throw new AggregateError([cause, ...drained.flatMap(result => result.status === "rejected" ? [result.reason] : [])], "Jobs fixture setup or shutdown failed.");
}
