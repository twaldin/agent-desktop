import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CommandResult, HostCommand, HostState, Project, SessionSummary, TranscriptMessage } from "../../packages/shared/src/protocol";
import type { LocalConnection } from "../../apps/host/src/paths";

// Explicit live-provider check, never part of the routine unit test command.
const dataDirectory = resolve(process.argv[2] ?? ".data/dev");
const connection = JSON.parse(await readFile(join(dataDirectory, "connection.json"), "utf8")) as LocalConnection;
const artifactDirectory = join(dataDirectory, "acceptance", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
const projectDirectory = join(artifactDirectory, "project");
await mkdir(projectDirectory, { mode: 0o700 });
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${connection.origin}${path}`, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
async function command<T>(command: HostCommand): Promise<T> {
  const result = await request<CommandResult>("/v1/commands", { id: crypto.randomUUID(), command });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value as T;
}
const model = { provider: "openai-codex", id: "gpt-5.4-mini" };
const state = await request<HostState>("/v1/state");
if (!state.models.some(candidate => candidate.authenticated && candidate.provider === model.provider && candidate.id === model.id)) {
  throw new Error("Live acceptance model is not configured on this host.");
}
const project = await command<Project>({ type: "project.add", path: projectDirectory, name: "Live acceptance" });
const session = await command<SessionSummary>({ type: "session.create", projectId: project.id, model });
const content = `agent-desktop-live-${crypto.randomUUID()}`;
console.log(JSON.stringify({ phase: "session-created", hostId: state.host.id, sessionId: session.id, projectDirectory, model }));
const prompt = `This is a live integration acceptance check in a disposable project. Use your file tools to create acceptance.txt in the current working directory containing exactly this line followed by a newline: ${content}. Read it back with a tool, then reply briefly that you verified it. Do not touch any other files or contact other services.`;
await command({ type: "session.prompt", sessionId: session.id, text: prompt, model, thinkingLevel: "low" });
console.log(JSON.stringify({ phase: "prompt-recorded", sessionId: session.id }));
const deadline = Date.now() + 180_000;
let latest: SessionSummary | undefined;
while (Date.now() < deadline) {
  latest = (await request<HostState>("/v1/state")).sessions.find(candidate => candidate.id === session.id);
  if (latest && latest.status !== "running") break;
  await Bun.sleep(750);
}
const messages = await request<TranscriptMessage[]>(`/v1/sessions/${session.id}/messages`);
await Bun.write(join(artifactDirectory, "transcript.json"), JSON.stringify(messages, null, 2));
const actual = await readFile(join(projectDirectory, "acceptance.txt"), "utf8").catch(() => null);
const passed = actual === content + "\n" && latest?.status === "idle" && messages.some(message => message.role === "assistant" && message.text.length > 0) && messages.some(message => message.role === "toolResult");
const evidence = { passed, checkedAt: new Date().toISOString(), host: state.host, model, sessionId: session.id,
  sessionFile: session.sessionFile, projectDirectory, finalStatus: latest?.status, error: latest?.error,
  fileMatches: actual === content + "\n", roles: messages.map(message => message.role), artifactDirectory };
await Bun.write(join(artifactDirectory, "result.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
if (!passed) process.exitCode = 1;
