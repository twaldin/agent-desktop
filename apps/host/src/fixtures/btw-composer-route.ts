import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandEnvelope, CommandResult, Draft, SessionSummary } from "@agent-desktop/shared";
import { startHost } from "../server";

const root = process.argv[2]!, agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates");
await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(gates)]);
const provider = fileURLToPath(new URL("../omp-workers/fixtures/btw-provider.ts", import.meta.url));
const shadow = fileURLToPath(new URL("../omp-workers/fixtures/btw-shadow-extension.ts", import.meta.url));
const config = (shadowed = false) => `extensions:\n  - ${JSON.stringify(provider)}${shadowed ? `\n  - ${JSON.stringify(shadow)}` : ""}\nretry:\n  enabled: false\n`;
await writeFile(path.join(agentDir, "config.yml"), config());
const options = { dataDirectory: path.join(root, "data"), agentDirectory: agentDir, discoveryDirectory: cwd,
  workerPath: fileURLToPath(new URL("../omp-workers/fixtures/no-provider-worker.ts", import.meta.url)) };
const host = await startHost(options);
async function command(envelope: CommandEnvelope): Promise<{ status: number; result?: CommandResult }> {
  const response = await fetch(`${host.connection.origin}/v1/commands`, { method: "POST", headers: {
    Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json",
  }, body: JSON.stringify(envelope) });
  return { status: response.status, ...(response.headers.get("content-type")?.includes("application/json") ? { result: await response.json() as CommandResult } : {}) };
}
async function putDraft(id: string, text: string, expectedRevision = 0): Promise<Draft> {
  const response = await command({ id: crypto.randomUUID(), command: { type: "draft.put", expectedRevision,
    draft: { id, text, projectId: null, model: { provider: "btw-contract", id: "controlled" } } } });
  assert(response.result?.ok); return response.result.value as Draft;
}
async function create(id: string): Promise<SessionSummary> {
  const response = await command({ id, command: { type: "session.create", projectId: null, cwd, model: { provider: "btw-contract", id: "controlled" } } });
  assert(response.result?.ok); return response.result.value as SessionSummary;
}
async function waitFile(file: string) {
  const deadline = Date.now() + 5000;
  while (!await access(file).then(() => true, () => false) && Date.now() < deadline) await Bun.sleep(5);
  assert.equal(await access(file).then(() => true, () => false), true);
}

try {
  const session = await create("create-main");
  const draft = await putDraft(`session:${session.id}`, "/btw   What changed?  ");
  const start: CommandEnvelope = { id: "native-btw", command: { type: "session.btw.start", sessionId: session.id,
    question: "What changed?", nativeCommand: "btw", draft: { id: draft.id, revision: draft.revision } } };
  const accepted = await command(start); assert.equal(accepted.status, 200); assert(accepted.result?.ok);
  const acceptedValue = accepted.result?.ok && accepted.result.value && "type" in accepted.result.value ? accepted.result.value : undefined;
  assert.equal(acceptedValue?.type, "session.btw");
  if (!acceptedValue || acceptedValue.type !== "session.btw") throw new Error("Missing native side-question receipt");
  assert.deepEqual(acceptedValue.snapshot, { runId: "native-btw", sessionId: session.id, question: "What changed?",
    status: "running", answer: "", startedAt: acceptedValue.snapshot?.startedAt, updatedAt: acceptedValue.snapshot?.updatedAt });
  assert.equal(host.store.getDraft(draft.id)?.text, "");
  await waitFile(path.join(gates, "1.started"));
  assert.deepEqual((await command(start)).result, accepted.result);
  assert.equal(await access(path.join(gates, "2.started")).then(() => true, () => false), false);
  await writeFile(path.join(gates, "1.release"), "");

  const lostDraft = await putDraft(`session:${session.id}`, "/btw receipt failure", 2);
  const lost: CommandEnvelope = { id: "native-btw-lost", command: { type: "session.btw.start", sessionId: session.id,
    question: "receipt failure", nativeCommand: "btw", draft: { id: lostDraft.id, revision: lostDraft.revision } } };
  const db = new Database(path.join(root, "data", "state.sqlite"));
  db.exec("CREATE TRIGGER reject_btw_command_receipt BEFORE UPDATE ON commands WHEN OLD.id = 'native-btw-lost' BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");
  const lostResponse = await command(lost); assert.equal(lostResponse.status, 200); assert(lostResponse.result && !lostResponse.result.ok); assert.equal(lostResponse.result.error.code, "OUTCOME_UNKNOWN");
  await waitFile(path.join(gates, "2.started"));
  assert.equal(host.store.getDraft(lostDraft.id)?.text, lostDraft.text);
  db.exec("DROP TRIGGER reject_btw_command_receipt"); db.close();
  const inspected = await command(lost); assert.equal(inspected.status, 200); assert(inspected.result && !inspected.result.ok); assert.equal(inspected.result.error.code, "OUTCOME_UNKNOWN");
  await Bun.sleep(50); assert.equal(await access(path.join(gates, "3.started")).then(() => true, () => false), false);
  await writeFile(path.join(gates, "2.release"), "");

  await writeFile(path.join(agentDir, "config.yml"), config(true));
  const shadowed = await create("create-shadowed");
  const shadowDraft = await putDraft(`session:${shadowed.id}`, "/btw blocked by extension");
  const blocked = await command({ id: "shadowed-btw", command: { type: "session.btw.start", sessionId: shadowed.id,
    question: "blocked by extension", nativeCommand: "btw", draft: { id: shadowDraft.id, revision: shadowDraft.revision } } });
  assert(blocked.result && !blocked.result.ok); assert.equal(blocked.result.error.code, "NATIVE_COMMAND_SHADOWED");
  assert.equal(host.store.getDraft(shadowDraft.id)?.text, shadowDraft.text);
  assert.equal(await access(path.join(gates, "3.started")).then(() => true, () => false), false);
  await writeFile(path.join(root, "btw-composer-route.passed"), "native /btw composer HTTP contracts passed\n");
} finally {
  for (let call = 1; call <= 4; call++) await writeFile(path.join(gates, `${call}.release`), "").catch(() => {});
  await host.stop();
}
