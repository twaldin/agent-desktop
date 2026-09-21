// Real OMP session/agent/queue/storage. The provider stream and explicit storage
// failure are controlled fixtures; this is not external provider acceptance.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeSteerAdmission } from "../omp/steer";
globalThis.fetch = Object.assign(async () => { throw new Error("No outbound transport in native steer identity contract"); }, { preconnect() {} }) as typeof fetch;
const { createAgentSession, SessionManager, Settings, AgentRegistry } = await import("@oh-my-pi/pi-coding-agent");
const root = process.argv[2]!, cwd = path.join(root, "project"), agentDir = path.join(root, "agent"), gates = path.join(root, "gates");
await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(gates)]);
await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("../omp-workers/fixtures/steer-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
const manager = SessionManager.create(cwd, path.join(root, "sessions"));
const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager, agentRegistry: new AgentRegistry(),
  settings: await Settings.loadReadOnly({ cwd, agentDir }), hasUI: false });
const admission = new NativeSteerAdmission(session, manager);
await session.setModel(session.modelRegistry.getAll().find(model => model.provider === "steer-contract")!);
session.agent.setSteeringMode("one-at-a-time");
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 7000;
  while (!await predicate() && Date.now() < deadline) await Bun.sleep(5);
  assert(await predicate(), label);
}
async function started(call: number) { await waitFor(() => Bun.file(path.join(gates, `${call}.started`)).exists(), `Provider call ${call}`); }
async function release(call: number) { await writeFile(path.join(gates, `${call}.release`), ""); }
async function entries() { await manager.flush(); return (await readFile(manager.getSessionFile()!, "utf8")).trim().split("\n").map(line => JSON.parse(line)); }
let run: Promise<boolean> | undefined;
try {
  run = session.prompt("Controlled native initial prompt"); await started(1);
  const text = "Same text does not mean the same native steer";
  const foreign = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() - 100, attribution: "user" as const, steering: true };
  session.agent.steer(foreign);
  let ownSettled = false;
  const own = admission.submit(text).then(receipt => { ownSettled = true; return receipt; });
  const parallel = admission.submit("Independent concurrent steer");
  await waitFor(() => session.agent.peekSteeringQueue().length === 3, "Three real queued messages");
  const ownMessage = session.agent.peekSteeringQueue()[1]!;
  await release(1); await started(2);
  assert.equal(ownSettled, false, "Another same-text native entry is not this submission's receipt");
  const foreignEntry = (await entries()).find(entry => entry.message?.timestamp === foreign.timestamp);
  assert(foreignEntry);
  await release(2); const receipt = await own; assert.equal(receipt.kind, "user-message");
  if (receipt.kind !== "user-message") throw new Error("Expected native user entry");
  assert.notEqual(receipt.entryId, foreignEntry.id);
  const ownEntry = (await entries()).find(entry => entry.id === receipt.entryId);
  // Disk JSON cannot contain native runtime-only symbol metadata; compare every serialized message field.
  assert.deepEqual(ownEntry.message, JSON.parse(JSON.stringify(ownMessage))); await started(3);
  await release(3); const otherReceipt = await parallel; assert.equal(otherReceipt.kind, "user-message");
  if (otherReceipt.kind !== "user-message") throw new Error("Expected second native user entry");
  assert.notEqual(otherReceipt.entryId, receipt.entryId); await started(4);

  const cancelled = admission.submit("Only this pending desktop steer is removed");
  await waitFor(() => session.agent.peekSteeringQueue().length === 1, "Desktop steer queued");
  const preserved = { ...foreign, timestamp: Date.now(), content: [{ type: "text" as const, text: "Unrelated extension queue entry" }] };
  session.agent.steer(preserved);
  admission.cancelQueued("Controlled stop before delivery");
  assert.equal((await cancelled).kind, "not-recorded");
  assert.deepEqual(session.agent.peekSteeringQueue(), [preserved], "Stop preserves unrelated queue objects");
  const cancelledFollowUp = admission.submitFollowUp("Only this pending desktop follow-up is removed");
  await waitFor(() => session.agent.peekFollowUpQueue().length === 1, "Desktop follow-up queued");
  const preservedFollowUp = { ...foreign, timestamp: Date.now() + 1, content: [{ type: "text" as const, text: "Unrelated follow-up queue entry" }] };
  session.agent.followUp(preservedFollowUp);
  admission.cancelQueued("Controlled stop before follow-up delivery");
  assert.equal((await cancelledFollowUp).kind, "not-recorded");
  assert.deepEqual(session.agent.peekSteeringQueue(), [preserved], "Stop still preserves an unrelated steering queue object");
  assert.deepEqual(session.agent.peekFollowUpQueue(), [preservedFollowUp], "Stop preserves unrelated follow-up queue objects");
  // Test-owned extension cleanup, separate from the adapter cancellation.
  session.agent.replaceQueues([], []);

  const clock = Date.now, fixed = clock();
  let firstCollision!: ReturnType<typeof admission.submit>;
  try {
    Date.now = () => fixed;
    firstCollision = admission.submit("Identical native timestamp and content");
    // Text normalization is asynchronous even without image attachments.
    while (!session.agent.peekSteeringQueue().length) await Promise.resolve();
    const collision = await admission.submit("Identical native timestamp and content");
    assert.equal(collision.kind, "not-recorded");
    if (collision.kind === "not-recorded") assert.match(collision.reason, /collides/);
    assert.equal(session.agent.peekSteeringQueue().length, 1);
  } finally { Date.now = clock; }
  admission.cancelQueued("Controlled collision cleanup"); assert.equal((await firstCollision).kind, "not-recorded");

  const failedStorage = admission.submit("Storage verification failure retains uncertain delivery");
  await waitFor(() => session.agent.peekSteeringQueue().length === 1, "Storage-failure steer queued");
  const flush = manager.flush.bind(manager);
  manager.flush = async () => { throw new Error("Controlled native flush verification failure"); };
  await release(4);
  try { const failed = await failedStorage; assert.equal(failed.kind, "outcome-unknown"); }
  finally { manager.flush = flush; }
  await started(5);
  assert((await entries()).some(entry => entry.message?.content?.some?.((part: any) => part.text === "Storage verification failure retains uncertain delivery")), "Native append can exist despite failed verification; never call this a fresh retry");
  admission.cancelQueued("Controlled cleanup"); await session.abort(); await admission.settleCancelled("Controlled cleanup"); await run;
  process.stdout.write("native steer identity and persistence contracts passed\n");
} finally {
  admission.cancelQueued("Fixture cleanup");
  await session.dispose(); await admission.settleCancelled("Fixture disposed"); admission.close();
  await run?.catch(() => {});
}
