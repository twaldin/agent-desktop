import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { CommandEnvelope, CommandResult } from "@agent-desktop/shared";
import type { SessionUsageResponse } from "../../../../../packages/shared/src/session-usage";
const directory = process.argv[2]!;
assert.equal(process.env.HOME, directory); assert.equal(process.env.USAGE_FIXTURE_DIRECTORY, directory);
const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
await writeFile(path.join(agentDir, "config.yml"), "extensions: []\ncodexResets:\n  autoRedeem: yes\n");
await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "usage-fixture": { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", auth: "none", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  if (new URL(input instanceof Request ? input.url : String(input)).hostname !== "127.0.0.1") throw new Error("Nonlocal network disabled in usage host fixture.");
  return realFetch(input, init);
}, { preconnect: () => {} }) as typeof fetch;
const { discoverAuthStorage } = await import("@oh-my-pi/pi-coding-agent");
const auth = await discoverAuthStorage(agentDir);
await auth.set("openai-codex", ["first", "second"].map(id => ({ type: "oauth" as const, access: `fixture-access-${id}`, refresh: `fixture-refresh-${id}`,
  accountId: id, orgId: `org-${id}`, email: "same@fixture.invalid", expires: Date.now() + 86_400_000 })));
auth.close();
const { startHost } = await import("../../server");
const options = { dataDirectory: path.join(directory, "data"), agentDirectory: agentDir, discoveryDirectory: cwd,
  workerPath: fileURLToPath(new URL("./usage-worker.ts", import.meta.url)), port: 0 };
let host = await startHost(options);
const headers = () => ({ Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json", "X-Agent-Host-Id": host.store.host.id });
const command = async (envelope: CommandEnvelope): Promise<CommandResult> => {
  const response = await fetch(`${host.connection.origin}/v20/commands`, { method: "POST", headers: headers(), body: JSON.stringify({ ...envelope, commandVersion: 20 }) });
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
};
const read = async (sessionId: string, mode = "cached", commandId?: string): Promise<SessionUsageResponse> => {
  const response = await fetch(`${host.connection.origin}/v1/sessions/${sessionId}/usage${commandId ? `?commandId=${commandId}` : ""}`, {
    headers: headers(), ...(mode === "cached" ? {} : { method: "POST", body: JSON.stringify({ mode }) }),
  });
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
};
const consumes = async () => (await readFile(path.join(directory, "consume.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
try {
  const creation = await command({ id: "usage-create", command: { type: "session.create", projectId: null, cwd, model: { provider: "usage-fixture", id: "fixture" } } });
  assert.equal(creation.ok, true, JSON.stringify(creation));
  assert(creation.ok && creation.value && "id" in creation.value); const sessionId = creation.value.id;
  assert.equal((await read(sessionId)).snapshot, null); assert.equal((await consumes()).length, 0);
  const reports = await read(sessionId, "reports"); assert(reports.snapshot?.reports.length); assert.equal(reports.snapshot.policy.autoRedeem, "yes");
  assert.equal((await consumes()).length, 0); // Existing yes never turns U1 report refresh into a sweep.
  const credits = await read(sessionId, "credits"), snapshot = credits.snapshot!;
  assert.equal(snapshot.credits.length, 2); assert(snapshot.credits.every(account => account.canPrepare));
  const account = snapshot.credits.find(account => account.accountId === "first")!;
  const cancelledPrepare = { id: "cancelled-prepare", command: { type: "session.usage.reset.prepare" as const, sessionId, epoch: snapshot.epoch, revision: snapshot.revision, accountRef: account.accountRef } };
  for (const owner of ["different-host", ""]) {
    const rejected = await fetch(`${host.connection.origin}/v20/commands`, { method: "POST", headers: { ...headers(), "X-Agent-Host-Id": owner }, body: JSON.stringify({ ...cancelledPrepare, commandVersion: 20 }) });
    assert.equal(rejected.status, 409); assert.equal((await read(sessionId, "cached", cancelledPrepare.id)).command?.state, "absent");
    assert.equal((await consumes()).length, 0);
  }
  assert((await command(cancelledPrepare)).ok);
  assert((await command({ id: "cancelled-answer", command: { type: "session.usage.reset.respond", sessionId, operationId: cancelledPrepare.id, confirm: false } })).ok);
  assert.equal((await consumes()).length, 0);
  const changedPrepare = { ...cancelledPrepare, id: "changed-credit-prepare" };
  assert((await command(changedPrepare)).ok); await writeFile(path.join(directory, "wire-mode"), "redeemed");
  const changed = await command({ id: "changed-credit-answer", command: { type: "session.usage.reset.respond", sessionId, operationId: changedPrepare.id, confirm: true } });
  assert(changed.ok && changed.value && "type" in changed.value && changed.value.type === "session.usage.reset");
  assert.equal(changed.value.receipt.state, "rejected"); assert.equal((await consumes()).length, 0);
  await writeFile(path.join(directory, "wire-mode"), "normal");
  const prepare = { id: "usage-prepare", command: { type: "session.usage.reset.prepare" as const, sessionId, epoch: snapshot.epoch, revision: snapshot.revision, accountRef: account.accountRef } };
  const prepared = await command(prepare); assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal((await consumes()).length, 0);
  assert.deepEqual(await command(prepare), prepared);
  const answer = { id: "usage-answer", command: { type: "session.usage.reset.respond" as const, sessionId, operationId: prepare.id, confirm: true } };
  const [result, duplicate] = await Promise.all([command(answer), command(answer)]);
  assert.deepEqual(duplicate, result); assert(result.ok && result.value && "type" in result.value && result.value.type === "session.usage.reset");
  assert.equal(result.value.receipt.state, "settled", JSON.stringify(result)); assert.equal(result.value.receipt.outcome, "reset");
  const wire = await consumes(); assert.equal(wire.length, 1); assert.equal(wire[0].account, "first"); assert.equal(wire[0].body.credit_id, "first-soon"); assert.match(wire[0].body.redeem_request_id, /^[a-f0-9-]{36}$/);
  assert.equal((await read(sessionId, "cached", answer.id)).command?.state, "done");
  await host.stop(); host = await startHost(options);
  assert.deepEqual(await command(answer), result); assert.equal((await consumes()).length, 1);
  const restored = await read(sessionId); assert.equal(restored.snapshot, null); assert.equal(restored.reset?.outcome, "reset");
  const fresh = (await read(sessionId, "credits")).snapshot!;
  const next = { id: "usage-unknown-prepare", command: { type: "session.usage.reset.prepare" as const, sessionId, epoch: fresh.epoch, revision: fresh.revision, accountRef: fresh.credits.find(row => row.accountId === "first")!.accountRef } };
  assert((await command(next)).ok); await writeFile(path.join(directory, "wire-mode"), "unknown");
  const unknownAnswer = { id: "usage-unknown-answer", command: { type: "session.usage.reset.respond" as const, sessionId, operationId: next.id, confirm: true } };
  const unknown = await command(unknownAnswer); assert(unknown.ok && unknown.value && "type" in unknown.value && unknown.value.type === "session.usage.reset"); assert.equal(unknown.value.receipt.state, "unknown");
  assert.equal((await consumes()).length, 2); assert.deepEqual(await command(unknownAnswer), unknown);
  await host.stop(); host = await startHost(options);
  assert.equal((await read(sessionId)).reset?.state, "unknown");
  assert.deepEqual(await command(unknownAnswer), unknown); assert.equal((await consumes()).length, 2);
  const forbidden = await command({ ...next, id: "must-not-replace" }); assert.equal(forbidden.ok, false);
  assert.equal((await consumes()).length, 2);
  const serialized = JSON.stringify({ reports, credits, prepared, result, restored, unknown });
  assert(!serialized.includes("fixture-access")); assert(!serialized.includes("fixture-refresh")); assert(!serialized.includes("nativeTicket"));
  process.stdout.write(JSON.stringify({ nativeReports: true, nativeCredits: 2, cancelAndChangedCreditRefused: true, explicitReset: true, exactFirstAccountCredit: true, duplicatesAndRestartNoReplay: true, unknownBlocksReplacement: true, consumeCalls: 2 }) + "\n");
} finally { await host.stop(); }
