// Actual HTTP, SQLite command ledger, Bun worker, OMP queue and native JSONL.
// Only provider transport is controlled; no quota/network calls are permitted.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandEnvelope, CommandResult, Draft, SessionSummary } from "@agent-desktop/shared";
import { startHost } from "../server";
const root = process.argv[2]!, agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates");
await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(gates)]);
const extension = fileURLToPath(new URL("../omp-workers/fixtures/steer-provider.ts", import.meta.url));
await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\nretry:\n  enabled: false\n`);
const options = { dataDirectory: path.join(root, "data"), agentDirectory: agentDir, discoveryDirectory: cwd,
  workerPath: fileURLToPath(new URL("../omp-workers/fixtures/no-provider-worker.ts", import.meta.url)) };
const model = { provider: "steer-contract", id: "controlled" };
let host = await startHost(options);
async function command(envelope: CommandEnvelope): Promise<CommandResult> {
  const response = await fetch(`${host.connection.origin}/v1/commands`, { method: "POST", headers: {
    Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" }, body: JSON.stringify(envelope) });
  assert.equal(response.status, 200); return response.json();
}
async function draft(text: string): Promise<Draft> {
  const previous = host.store.getDraft("steer-draft");
  const result = await command({ id: crypto.randomUUID(), command: { type: "draft.put", draft: {
    id: "steer-draft", text, projectId: null, model }, expectedRevision: previous?.revision ?? 0 } });
  assert(result.ok); return result.value as Draft;
}
async function entries(file: string) { return (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line)); }
async function started(call: number) {
  const file = path.join(gates, `${call}.started`), deadline = Date.now() + 8000;
  while (!(await Bun.file(file).exists()) && Date.now() < deadline) await Bun.sleep(10);
  assert(await Bun.file(file).exists(), `Controlled provider call ${call} did not start`);
}
function steer(session: SessionSummary, current: Draft, id: string = crypto.randomUUID()): CommandEnvelope {
  return { id, command: { type: "session.steer", sessionId: session.id, text: current.text, draft: { id: current.id, revision: current.revision } } };
}
try {
  const created = await command({ id: "create", command: { type: "session.create", projectId: null, cwd } }); assert(created.ok);
  const session = created.value as SessionSummary;
  const initial = await command({ id: "prompt", command: { type: "session.prompt", sessionId: session.id, text: "Controlled native initial prompt", model } });
  assert(initial.ok); assert.equal(initial.admission?.kind, "user-message"); await started(1);

  const submitted = await draft("Exact steer input with a durable native identity"), input = steer(session, submitted, "accepted-steer");
  let settled = false;
  const accepting = command(input).then(result => { settled = true; return result; }), concurrent = command(input);
  await Bun.sleep(100);
  assert.equal(settled, false, "Enqueue is not acceptance"); assert.equal(host.store.getDraft(submitted.id)?.text, submitted.text);
  assert.equal((await entries(session.sessionFile)).some(entry => entry.message?.content?.some?.((part: any) => part.text === submitted.text)), false);
  const newer = await draft("Newer edit from a second window survives old steer admission");
  await writeFile(path.join(gates, "1.release"), "");
  const accepted = await accepting; assert(accepted.ok); assert.equal(accepted.admission?.kind, "user-message");
  assert.deepEqual(await concurrent, accepted); assert.deepEqual(await command(input), accepted);
  const persisted = (await entries(session.sessionFile)).find(entry => entry.id === (accepted.admission as { entryId: string }).entryId);
  assert.equal(persisted.message.steering, true); assert.equal(persisted.message.attribution, "user");
  assert.equal(persisted.message.content[0].text, submitted.text); assert.equal(typeof persisted.message.timestamp, "number");
  assert.deepEqual(host.store.getDraft(newer.id), newer); await started(2);

  const cancelledDraft = await draft("This still-queued steer must survive Stop"), cancelledInput = steer(session, cancelledDraft, "cancelled-steer");
  const cancelling = command(cancelledInput); await Bun.sleep(100);
  const interrupted = await command({ id: "interrupt", command: { type: "session.interrupt", sessionId: session.id } }); assert(interrupted.ok);
  const cancelled = await cancelling; assert(!cancelled.ok); assert.equal(cancelled.error.code, "STEER_NOT_RECORDED");
  assert.deepEqual(host.store.getDraft(cancelledDraft.id), cancelledDraft); assert.deepEqual(await command(cancelledInput), cancelled);
  assert.equal((await entries(session.sessionFile)).some(entry => entry.message?.content?.some?.((part: any) => part.text === cancelledDraft.text)), false);
  await Bun.sleep(100); assert.equal(await Bun.file(path.join(gates, "3.started")).exists(), false, "Stop must not auto-resume a removed steer");

  const next = await command({ id: "prompt-before-delivery-race", command: { type: "session.prompt", sessionId: session.id, text: "Controlled delivery race prompt", model } });
  assert(next.ok); await started(3);
  const deliveredDraft = await draft("Abort after dequeue but before native persistence"), deliveredInput = steer(session, deliveredDraft, "delivered-unflushed-steer");
  await writeFile(path.join(gates, "hold-persistence"), deliveredDraft.text);
  const deliveredResponse = command(deliveredInput); await Bun.sleep(100);
  await writeFile(path.join(gates, "3.release"), "");
  const persistenceDeadline = Date.now() + 5000;
  while (!(await Bun.file(path.join(gates, "persistence.started")).exists()) && Date.now() < persistenceDeadline) await Bun.sleep(5);
  assert(await Bun.file(path.join(gates, "persistence.started")).exists(), "Native extension must hold the real message-end persistence");
  // Effective inputs now persist before provider dispatch. Keep the actual
  // message-end hold, then interrupt this dequeued input before releasing it.
  assert.equal(await Bun.file(path.join(gates, "4.started")).exists(), false, "Provider must not run before effective-input persistence");
  const racingInterrupt = command({ id: "interrupt-delivered", command: { type: "session.interrupt", sessionId: session.id } });
  await Bun.sleep(25); await writeFile(path.join(gates, "persistence.release"), "");
  assert((await racingInterrupt).ok);
  const delivered = await deliveredResponse; assert(!delivered.ok); assert.equal(delivered.error.code, "OUTCOME_UNKNOWN");
  assert.deepEqual(host.store.getDraft(deliveredDraft.id), deliveredDraft);
  assert.deepEqual(await command(deliveredInput), delivered);
  assert.equal((await entries(session.sessionFile)).some(entry => entry.message?.content?.some?.((part: any) => part.text === deliveredDraft.text)), false);

  const afterRace = await command({ id: "prompt-before-worker-loss", command: { type: "session.prompt", sessionId: session.id, text: "Controlled worker loss prompt", model } });
  assert(afterRace.ok); await started(4);
  const catalogResponse = await fetch(`${host.connection.origin}/v1/models/composer`, { method: "POST", headers: {
    Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ target: { sessionId: session.id }, refresh: true }) });
  assert.equal(catalogResponse.status, 200, "A real model discovery refresh must complete during the held session");
  const uncertainDraft = await draft("Keep this steer when its worker response is lost"), uncertainInput = steer(session, uncertainDraft, "worker-loss-steer");
  const uncertainResponse = command(uncertainInput); await Bun.sleep(100);
  const workerPid = Number(await readFile(path.join(gates, "4.worker.pid"), "utf8"));
  const discoveryPid = Number(await readFile(path.join(gates, "extension-loader.pid"), "utf8"));
  assert.notEqual(workerPid, discoveryPid, "Discovery must not replace the held provider call's worker identity");
  assert(workerPid > 0 && workerPid !== process.pid);
  process.kill(workerPid, "SIGKILL");
  const uncertain = await uncertainResponse; assert(!uncertain.ok); assert.equal(uncertain.error.code, "OUTCOME_UNKNOWN");
  assert.deepEqual(host.store.getDraft(uncertainDraft.id), uncertainDraft);
  assert.deepEqual(await command(uncertainInput), uncertain);

  await host.stop(); host = await startHost(options);
  assert.deepEqual(await command(input), accepted); assert.deepEqual(await command(cancelledInput), cancelled);
  assert.deepEqual(await command(deliveredInput), delivered);
  assert.deepEqual(await command(uncertainInput), uncertain);
  assert.deepEqual(host.store.getDraft(uncertainDraft.id), uncertainDraft);
  assert.equal((await entries(session.sessionFile)).filter(entry => entry.id === persisted.id).length, 1);
  process.stdout.write("native steer HTTP admission contracts passed\n");
} finally { await host.stop(); }
