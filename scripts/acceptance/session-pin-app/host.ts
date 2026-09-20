import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import type { CommandEnvelope, CommandResult, Project, SessionSummary } from "../../../packages/shared/src/protocol";
import type { LocalConnection } from "../../../apps/host/src/paths";
import type { SessionPinFixture } from "../../../apps/host/src/omp/fixtures/session-pin-controlled";

const root = resolve(process.argv[2]!);
if (process.env.HOME !== root || process.env.PI_CODING_AGENT_DIR !== join(root, "agent") || process.env.PI_DISABLE_DOTENV !== "1"
  || process.env.PATH?.split(delimiter)[0] !== join(root, "bin") || await readFile(join(root, "bin/tailscale"), "utf8") !== "#!/bin/sh\nexit 1\n")
  throw new Error("Private dotenv-disabled session-pin fixture required.");
// No ambient provider credentials or discovery. The shared helper alone owns
// synthetic OAuth, guarded canonical provider routing and the production worker.
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Non-loopback host fetch forbidden.");
  return originalFetch(input, { ...init, redirect: "error" });
}, { preconnect: () => {} }) as typeof fetch;
// Import only after the network guard is installed: native initialization can
// capture fetch at module evaluation, so static imports cannot enforce this fence.
const { prepareSessionPinFixture } = await import("../../../apps/host/src/omp/fixtures/session-pin-controlled");
const { startHost } = await import("../../../apps/host/src/server");
let fixture: SessionPinFixture | undefined;
const start = () => startHost({ dataDirectory: join(root, "data"), agentDirectory: fixture!.agentDir,
  discoveryDirectory: fixture!.cwd, workerPath: fixture!.workerPath, tailscale: false, port: 0 });
let host: { connection: LocalConnection; stop(): Promise<void> } | undefined;
let generation = 0;
let context: { projectId: string; model: { provider: string; id: string }; sessions: Record<string, { id: string; sessionFile: string }>; requestsFile: string };
async function publish() {
  await writeFile(join(root, "ready.next.json"), JSON.stringify({ connection: host!.connection, context, generation }), { mode: 0o600 });
  await rename(join(root, "ready.next.json"), join(root, "ready.json"));
}
async function command(command: CommandEnvelope["command"]) {
  const response = await fetch(`${host!.connection.origin}/v1/commands`, { method: "POST", headers: {
    Authorization: `Bearer ${host!.connection.token}`, "Content-Type": "application/json",
  }, body: JSON.stringify({ id: crypto.randomUUID(), command } satisfies CommandEnvelope) });
  const result = await response.json() as CommandResult;
  if (!response.ok || !result.ok) throw new Error(`Native App fixture setup command failed (${response.status}): ${JSON.stringify(result)}`);
  return result.value;
}
function redact(text: string) {
  const safe = text.replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.session-pin-not-a-signature/g, "[REDACTED_SYNTHETIC_ACCESS]")
    .replace(/session-pin-refresh[^\s"'\\]*/g, "[REDACTED_SYNTHETIC_REFRESH]")
    .replace(/Bearer\s+[^\s"'\\]+/gi, "Bearer [REDACTED]");
  return host?.connection.token ? safe.split(host.connection.token).join("[REDACTED_LOCAL_TRANSPORT]") : safe;
}
function errorEvidence(error: unknown, seen = new Set<unknown>()): unknown {
  if (!(error instanceof Error)) return { name: "NonError", message: redact(String(error)) };
  if (seen.has(error)) return { name: error.name, message: "[circular error]" };
  seen.add(error);
  return { name: redact(error.name), message: redact(error.message), stack: error.stack && redact(error.stack),
    ...(error.cause === undefined ? {} : { cause: errorEvidence(error.cause, seen) }),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(value => errorEvidence(value, seen)) } : {}) };
}
let stopping = false;
async function stop(...primary: [] | [unknown]) {
  if (stopping) return;
  stopping = true;
  const failures: { stage: string; error: unknown }[] = [];
  if (primary.length) failures.push({ stage: "setup-or-restart", error: errorEvidence(primary[0]) });
  try { await host?.stop(); } catch (error) { failures.push({ stage: "host-drain", error: errorEvidence(error) }); }
  try { await fixture?.stop(); } catch (error) { failures.push({ stage: "provider-drain", error: errorEvidence(error) }); }
  try { await writeFile(join(root, "host-errors.json"), JSON.stringify({ failures }, null, 2), { mode: 0o600 }); }
  catch (error) { failures.push({ stage: "error-evidence-write", error: errorEvidence(error) }); }
  if (failures.length) console.error(JSON.stringify({ failures }));
  process.exit(failures.length ? 1 : 0);
}
process.on("SIGTERM", () => void stop());
try {
  fixture = await prepareSessionPinFixture(root);
  for (const [name, value] of Object.entries(fixture.environment)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await mkdir(join(root, "data"), { recursive: true });
  host = await start();
  const project = await command({ type: "project.add", path: fixture.cwd, name: "Native session pin acceptance" }) as Project;
  const sessions: Record<string, { id: string; sessionFile: string }> = {};
  for (const name of ["original", "independent"]) {
    const session = await command({ type: "session.create", projectId: project.id, model: fixture.model }) as SessionSummary;
    await command({ type: "session.rename", sessionId: session.id, title: `Pin ${name} acceptance` });
    sessions[name] = { id: session.id, sessionFile: session.sessionFile };
  }
  context = { projectId: project.id, model: fixture.model, sessions, requestsFile: fixture.requestsFile };
  await publish();
  let buffered = "";
  for await (const chunk of process.stdin) {
    buffered += String(chunk);
    let boundary: number;
    while ((boundary = buffered.indexOf("\n")) !== -1) {
      const instruction = buffered.slice(0, boundary).trim(); buffered = buffered.slice(boundary + 1);
      if (instruction === "stop") await stop();
      if (instruction === "restart") {
        // Drain every production worker; keep only the controlled HTTP server.
        // No account reseeding, new session or journal rewrite on cold reopen.
        await host.stop(); host = undefined;
        host = await start(); generation++; await publish();
      }
    }
  }
  await stop();
} catch (error) {
  await stop(error);
}
