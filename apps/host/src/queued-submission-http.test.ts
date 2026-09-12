import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandEnvelope, CommandResult, Draft, NativeQueuedMessagesSnapshot, SessionSummary } from "@agent-desktop/shared";
import { NATIVE_QUEUED_MESSAGES_OWNER_HEADER } from "@agent-desktop/shared";
import { startHost } from "./server";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const waitFor = async (predicate: () => boolean | Promise<boolean>, timeout = 8_000) => {
  const deadline = Date.now() + timeout; while (!await predicate() && Date.now() < deadline) await Bun.sleep(5); expect(await predicate()).toBe(true);
};

test("v13 admits consecutive captured follow-ups without waiting for the turn and exact retries do not enqueue twice", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-follow-up-http-")));
  const agent = path.join(root, "agent"), project = path.join(root, "project"), gates = path.join(root, "gates");
  await Promise.all([mkdir(agent), mkdir(project), mkdir(gates)]);
  await writeFile(path.join(agent, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./omp-workers/fixtures/steer-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  const previous = process.env.STEER_CONTRACT_GATES; process.env.STEER_CONTRACT_GATES = gates;
  const host = await startHost({ dataDirectory: path.join(root, "data"), agentDirectory: agent, discoveryDirectory: project,
    workerPath: fileURLToPath(new URL("./omp-workers/fixtures/no-provider-worker.ts", import.meta.url)), tailscale: false, port: 0 });
  cleanups.push(async () => { await host.stop(); if (previous === undefined) delete process.env.STEER_CONTRACT_GATES; else process.env.STEER_CONTRACT_GATES = previous; await rm(root, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" };
  const command = async (envelope: CommandEnvelope, endpoint = "/v13/commands"): Promise<CommandResult> => {
    const response = await fetch(host.connection.origin + endpoint, { method: "POST", headers, body: JSON.stringify(envelope) });
    expect(response.status).toBe(200); return response.json();
  };
  const created = await command({ id: crypto.randomUUID(), commandVersion: 13, command: { type: "session.create", projectId: null, cwd: project } });
  expect(created.ok).toBe(true); const session = created.ok ? created.value as SessionSummary : undefined; if (!session) throw new Error("session creation failed");
  const prompt = await command({ id: crypto.randomUUID(), commandVersion: 13, command: { type: "session.prompt", sessionId: session.id,
    text: "hold native turn", model: { provider: "steer-contract", id: "controlled" } } });
  expect(prompt.ok).toBe(true); await waitFor(() => Bun.file(path.join(gates, "1.started")).exists());

  let revision = 0;
  const submit = async (id: string, text: string, delivery: "follow-up" | "steer") => {
    const draft: Draft = { id: `session:${session.id}`, text, projectId: null, model: null, revision, updatedAt: 0 };
    const put = await command({ id: crypto.randomUUID(), commandVersion: 13, command: { type: "draft.put", draft, expectedRevision: revision } });
    expect(put.ok).toBe(true); revision++;
    const envelope: CommandEnvelope = { id, commandVersion: 13, command: { type: "session.follow-up", sessionId: session.id, text, delivery,
      draft: { id: draft.id, revision } } };
    const result = await command(envelope); expect(result).toMatchObject({ ok: true, value: { type: "session.follow-up", receipt: { commandId: id, phase: "queued", outcome: "pending", delivery } } });
    revision++;
    return { envelope, result };
  };
  const first = await submit("follow-one", "first captured follow-up", "follow-up");
  const second = await submit("follow-two", "second captured follow-up", "follow-up");
  const retried = await command(first.envelope);
  expect(retried).toEqual(first.result);
  const response = await fetch(`${host.connection.origin}/v1/sessions/${session.id}/queued-messages`, { headers: { ...headers, [NATIVE_QUEUED_MESSAGES_OWNER_HEADER]: host.store.host.id } });
  expect(response.status).toBe(200); const queue = await response.json() as NativeQueuedMessagesSnapshot;
  expect(queue.messages.filter(item => item.text === "first captured follow-up")).toHaveLength(1);
  expect(queue.messages.filter(item => item.text === "second captured follow-up")).toHaveLength(1);
  expect(host.store.getDraft(`session:${session.id}`)).toMatchObject({ text: "", revision });

  await writeFile(path.join(gates, "1.release"), "");
  let settled = false;
  const finals = Promise.all([first, second].map(async item => {
    for (;;) { const result = await command(item.envelope); if (result.ok && result.value && "type" in result.value && result.value.type === "session.follow-up" && result.value.receipt.phase === "settled") return result.value.receipt; await Bun.sleep(5); }
  })).then(value => { settled = true; return value; });
  for (let call = 2; call <= 4 && !settled; call++) {
    await waitFor(async () => settled || Bun.file(path.join(gates, `${call}.started`)).exists());
    if (!settled) { await writeFile(path.join(gates, `${call}.release`), ""); await Bun.sleep(20); }
  }
  const receipts = await finals;
  expect(receipts.every(item => item.outcome === "succeeded")).toBe(true);
  expect(new Set(receipts.map(item => item.entryId)).size).toBe(2);
}, 40_000);
