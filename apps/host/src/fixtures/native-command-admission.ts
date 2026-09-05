// Full HTTP/store/actual-worker contract in an isolated HOME and native store.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandEnvelope, CommandResult, Draft, OmpInteraction, SessionSummary } from "@agent-desktop/shared";
import { startHost } from "../server";
const root = process.argv[2]!, agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
await Promise.all([mkdir(agentDir), mkdir(cwd)]);
const extension = fileURLToPath(new URL("../omp-workers/fixtures/admission-extension.ts", import.meta.url));
await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\n`);
const options = { dataDirectory: path.join(root, "data"), agentDirectory: agentDir, discoveryDirectory: cwd, workerPath: fileURLToPath(new URL("../omp-workers/fixtures/no-provider-worker.ts", import.meta.url)) };
let host = await startHost(options);
async function command(envelope: CommandEnvelope): Promise<CommandResult> {
  const response = await fetch(`${host.connection.origin}/v1/commands`, { method: "POST", headers: { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" }, body: JSON.stringify(envelope) });
  assert.equal(response.status, 200); return response.json();
}
async function draft(text: string) {
  const previous = host.store.getDraft("contract-draft");
  const result = await command({ id: crypto.randomUUID(), command: { type: "draft.put", draft: { id: "contract-draft", text, projectId: null, model: null }, expectedRevision: previous?.revision ?? 0 } });
  assert(result.ok); return result.value as Draft;
}
async function entries(file: string) { return (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line)); }
try {
  const created = await command({ id: "create-session", command: { type: "session.create", projectId: null, cwd } }); assert(created.ok);
  const session = created.value as SessionSummary;
  const initial = await draft("/admission-contract once");
  const input: CommandEnvelope = { id: "native-command-once", command: { type: "session.prompt", sessionId: session.id, text: initial.text, draft: { id: initial.id, revision: initial.revision } } };
  const [first, simultaneous] = await Promise.all([command(input), command(input)]);
  assert(first.ok); assert.deepEqual(first.admission, { kind: "native-command", command: "admission-contract" });
  assert.deepEqual(simultaneous, first); assert.deepEqual(await command(input), first);
  assert.equal(host.store.getDraft(initial.id)?.text, "");
  assert.equal(host.store.getSession(session.id)?.title, "New conversation");
  assert.equal((await entries(session.sessionFile)).filter(entry => entry.customType === "admission-contract").length, 1);
  const conflict = await command({ ...input, command: { type: "session.prompt", sessionId: session.id, text: "different payload" } });
  assert(!conflict.ok); assert.equal(conflict.error.code, "COMMAND_ID_REUSED");
  await host.stop(); host = await startHost(options);
  assert.deepEqual(await command(input), first);
  assert.deepEqual(host.store.getCommand(input.id)?.result, first);
  assert.equal((await entries(session.sessionFile)).filter(entry => entry.customType === "admission-contract").length, 1);

  // Failures can leave actual native side effects; do not acknowledge success or
  // re-run the failed operation for the same client command identity.
  const failedDraft = await draft("/admission-contract throw-after");
  const failedInput: CommandEnvelope = { id: "partial-command-error", command: { type: "session.prompt", sessionId: session.id, text: failedDraft.text, draft: { id: failedDraft.id, revision: failedDraft.revision } } };
  const failed = await command(failedInput); assert(!failed.ok); assert.equal(failed.error.code, "OUTCOME_UNKNOWN");
  assert.match(failed.error.message, /failed after side effect/);
  assert.equal(host.store.getDraft(failedDraft.id)?.text, failedDraft.text);
  const failedAgain = await command(failedInput); assert.deepEqual(failedAgain, failed);
  assert(!failedAgain.ok); assert.equal(failedAgain.error.code, "OUTCOME_UNKNOWN");
  assert.equal((await entries(session.sessionFile)).filter(entry => entry.data?.args === "throw-after").length, 1);

  const waitingDraft = await draft("/admission-contract wait");
  const waitingInput: CommandEnvelope = { id: "cancelled-native-dialog", command: { type: "session.prompt", sessionId: session.id, text: waitingDraft.text, draft: { id: waitingDraft.id, revision: waitingDraft.revision } } };
  const waiting = command(waitingInput);
  const deadline = Date.now() + 5000; let interactions: OmpInteraction[] = [];
  while (!interactions.length && Date.now() < deadline) {
    const response = await fetch(`${host.connection.origin}/v1/sessions/${session.id}/interactions`, { headers: { Authorization: `Bearer ${host.connection.token}` } });
    assert.equal(response.status, 200); interactions = await response.json();
    if (!interactions.length) await Bun.sleep(10);
  }
  assert.equal(interactions[0]?.method, "confirm");
  const newer = await draft("New edit from the other client");
  const interrupted = await command({ id: "interrupt-native-dialog", command: { type: "session.interrupt", sessionId: session.id } }); assert(interrupted.ok);
  const cancelled = await waiting; assert(cancelled.ok);
  // Native confirm resolves false, and this handler returns normally without
  // its side effect. The receipt means handled input, not approved execution.
  assert.deepEqual(cancelled.admission, { kind: "native-command", command: "admission-contract" });
  assert.equal(host.store.getDraft(newer.id)?.text, newer.text);
  assert.equal(host.store.getDraft(newer.id)?.revision, newer.revision);
  assert.equal((await entries(session.sessionFile)).filter(entry => entry.data?.args === "wait").length, 0);
  assert.equal((await entries(session.sessionFile)).filter(entry => entry.type === "message").length, 0);
  await host.stop(); host = await startHost(options);
  const failedAfterRestart = await command(failedInput); assert.deepEqual(failedAfterRestart, failed);
  assert(!failedAfterRestart.ok); assert.equal(failedAfterRestart.error.code, "OUTCOME_UNKNOWN");
  assert.deepEqual(await command(waitingInput), cancelled);
  assert.equal((await entries(session.sessionFile)).filter(entry => entry.data?.args === "throw-after").length, 1);
  const renamed = await command({ id: "native-command-title", command: { type: "session.prompt", sessionId: session.id, text: "/admission-contract rename" } });
  assert(renamed.ok); assert.equal(host.store.getSession(session.id)?.title, "Native command title");
  process.stdout.write("native slash-command HTTP admission contracts passed\n");
} finally { await host.stop(); }
