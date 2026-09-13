// Actual OmpRuntime lifecycle fixture. All state lives under the supplied
// disposable HOME, and outbound provider traffic is rejected before imports.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

let blockedFetches = 0;
globalThis.fetch = Object.assign(async () => {
  blockedFetches++;
  throw new Error("Network is disabled in the OmpRuntime Plan fixture");
}, { preconnect: () => { throw new Error("Preconnect is disabled in the OmpRuntime Plan fixture"); } }) as typeof fetch;

const directory = process.argv[2]!;
assert.equal(process.env.HOME, directory);

const model = {
  id: "base", name: "Local non-executing Plan model", reasoning: true,
  input: ["text"], contextWindow: 128000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const configure = async (name: string, plan: string) => {
  const root = path.join(directory, name), agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
  await writeFile(path.join(agentDir, "config.yml"), [
    "extensions: []", plan,
    "modelRoles:", "  default: [plan-fixture/base]", "  plan: [plan-fixture/base:low]", "",
  ].join("\n"));
  await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "plan-fixture": {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", auth: "none", models: [model],
  } } }));
  return { agentDir, cwd };
};
const { OmpRuntime } = await import("../runtime");

const manual = await configure("manual", "plan:\n  enabled: true\n  defaultOnStartup: false");
let runtime = new OmpRuntime({ agentDir: manual.agentDir });
const session = await runtime.create({ cwd: manual.cwd, model: { provider: "plan-fixture", id: "base" } });
const initialBytes = await readFile(session.sessionFile, "utf8");
const initial = session.getPlan(), initialAgain = session.getPlan();
assert.equal(initial.mode, "off"); assert.equal(initial.enabled, true); assert.deepEqual(initialAgain, initial);
assert.equal(await readFile(session.sessionFile, "utf8"), initialBytes, "Plan reads must not mutate the native journal");
const actions = await session.getComposerActions();
for (const name of ["plan", "plan-review"])
  assert.equal(actions.commands.find(command => command.id === `builtin:${name}`)?.availability, "executable",
    "Connected native Plan commands must be usable from the actual composer catalog");

const slash = async () => {
  const run = session.startPrompt("/plan");
  assert.equal(await run.completion, false, "A local Plan command must not invoke a provider");
  return session.getPlan();
};
assert.equal((await slash()).mode, "active");
assert.equal((await slash()).mode, "paused");
assert.equal((await slash()).mode, "off");
assert.equal((await slash()).mode, "active");
const activeBytes = await readFile(session.sessionFile, "utf8");
const active = session.getPlan();
assert.equal(await readFile(session.sessionFile, "utf8"), activeBytes, "Active Plan reads must not mutate the native journal");
const sessionFile = session.sessionFile, nativeSessionId = session.id;
await session.dispose(); await runtime.dispose();

runtime = new OmpRuntime({ agentDir: manual.agentDir });
const reopened = await runtime.open({ sessionFile });
const restoredBytes = await readFile(sessionFile, "utf8"), restored = reopened.getPlan();
assert.equal(restored.mode, "active"); assert.equal(restored.ticket.nativeSessionId, nativeSessionId);
assert.equal(await readFile(sessionFile, "utf8"), restoredBytes, "Reopened Plan reads must not mutate the journal");
await reopened.dispose(); await runtime.dispose();

const startup = await configure("startup", "plan:\n  enabled: true\n  defaultOnStartup: true");
runtime = new OmpRuntime({ agentDir: startup.agentDir });
const started = await runtime.create({ cwd: startup.cwd, model: { provider: "plan-fixture", id: "base" } });
assert.equal(started.getPlan().mode, "active");
await started.dispose(); await runtime.dispose();

const disabled = await configure("disabled", "plan:\n  enabled: false\n  defaultOnStartup: true");
runtime = new OmpRuntime({ agentDir: disabled.agentDir });
const unavailable = await runtime.create({ cwd: disabled.cwd, model: { provider: "plan-fixture", id: "base" } });
assert.deepEqual({ mode: unavailable.getPlan().mode, enabled: unavailable.getPlan().enabled }, { mode: "off", enabled: false });
await assert.rejects(unavailable.startPrompt("/plan").completion, /Plan mode is disabled/);
assert.equal(unavailable.getPlan().mode, "off");
await unavailable.dispose(); await runtime.dispose();

const journal = (await readFile(sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
console.log(JSON.stringify({
  blockedFetches,
  lifecycle: { initial: initial.mode, transitions: ["active", "paused", "off", active.mode], restored: restored.mode },
  startup: "active", disabled: "off", nativeSessionId,
  journalModes: journal.filter(entry => entry.type === "mode_change").map(entry => entry.mode),
}));
