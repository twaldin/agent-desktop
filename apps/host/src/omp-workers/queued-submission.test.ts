import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "./runtime";

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeout = 8_000) => {
  const deadline = Date.now() + timeout;
  while (!await predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(await predicate()).toBe(true);
};

test("held native turn acknowledges two follow-ups and one steer separately, then preserves exact removal and entry receipts", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-queued-submission-worker-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(gates)]);
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./fixtures/steer-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, STEER_CONTRACT_GATES: gates, TERM: "dumb" } });
  try {
    const session = await runtime.create({ cwd, interactions: true });
    const prompt = session.startPrompt("hold native turn", { model: { provider: "steer-contract", id: "controlled" } });
    await prompt.accepted; await waitFor(() => Bun.file(path.join(gates, "1.started")).exists());

    const followOne = session.startFollowUp("first exact follow-up", "follow-up");
    const followTwo = session.startFollowUp("second exact follow-up", "follow-up");
    const steer = session.startFollowUp("exact steering message", "steer");
    expect(await followOne.accepted).toEqual({ kind: "queued", delivery: "follow-up" });
    expect(await followTwo.accepted).toEqual({ kind: "queued", delivery: "follow-up" });
    expect(await steer.accepted).toEqual({ kind: "queued", delivery: "steer" });

    let snapshot = await session.getQueuedMessages();
    await waitFor(async () => (snapshot = await session.getQueuedMessages()).messages.length === 3);
    expect(snapshot.messages.map(item => [item.text, item.lane])).toEqual([
      ["exact steering message", "steer"],
      ["first exact follow-up", "follow-up"],
      ["second exact follow-up", "follow-up"],
    ]);
    const steering = snapshot.messages.find(item => item.text === "exact steering message")!;
    await session.mutateQueuedMessages({ type: "remove", expectedRevision: snapshot.revision, messageId: steering.id });
    expect(await steer.completion).toMatchObject({ kind: "not-recorded" });

    await writeFile(path.join(gates, "1.release"), "");
    // Follow-up delivery may create multiple native provider turns. Release only
    // calls that the isolated provider has actually started.
    let settled = false;
    const receipts = Promise.all([followOne.completion, followTwo.completion]).then(value => { settled = true; return value; });
    for (let call = 2; call <= 4 && !settled; call++) {
      await waitFor(async () => settled || Bun.file(path.join(gates, `${call}.started`)).exists());
      if (!settled) { await writeFile(path.join(gates, `${call}.release`), ""); await Bun.sleep(20); }
    }
    const final = await receipts;
    expect(final.every(receipt => receipt.kind === "user-message")).toBe(true);
    expect(new Set(final.map(receipt => receipt.kind === "user-message" ? receipt.entryId : "")).size).toBe(2);
    await prompt.completion;
    const lines = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const userTexts = lines.filter(entry => entry.message?.role === "user").map(entry => entry.message.content[0].text);
    expect(userTexts.filter(text => text.includes("exact follow-up"))).toEqual(["first exact follow-up", "second exact follow-up"]);
    expect(userTexts).not.toContain("exact steering message");
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 40_000);

test("restart after a real native enqueue retains one unknown command and never replays it", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-queued-submission-restart-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates"), data = path.join(root, "data");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(gates), mkdir(data)]);
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./fixtures/steer-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  const { HostStore } = await import("../store");
  let store = new HostStore(data);
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, STEER_CONTRACT_GATES: gates, TERM: "dumb" } });
  try {
    const session = await runtime.create({ cwd, interactions: true });
    const prompt = session.startPrompt("hold restart boundary", { model: { provider: "steer-contract", id: "controlled" } });
    await prompt.accepted; await waitFor(() => Bun.file(path.join(gates, "1.started")).exists());
    const saved = store.putDraft({ id: "session:owned", text: "native accepted before restart", projectId: null, model: null }, 0);
    if (!saved.ok) throw new Error("fixture draft conflict");
    const command = { type: "session.follow-up" as const, sessionId: "owned", text: saved.draft.text, delivery: "follow-up" as const,
      draft: { id: saved.draft.id, revision: saved.draft.revision } };
    store.claimCommand("restart-command", "restart-hash", command); store.beginQueuedSubmission("restart-command", "restart-hash");
    const queued = session.startFollowUp(command.text, command.delivery); await queued.accepted;
    store.advanceQueuedSubmission("restart-command", "restart-hash", { phase: "queued" });
    store.close();
    await runtime.dispose(); await prompt.completion;
    store = new HostStore(data);
    expect(store.getQueuedSubmission("restart-command")).toMatchObject({ commandId: "restart-command", phase: "settled", outcome: "unknown", revision: 3 });
    expect(store.claimCommand("restart-command", "restart-hash", command)).toMatchObject({ kind: "done", record: { command } });
    const lines = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(lines.filter(entry => entry.message?.role === "user").map(entry => entry.message.content[0].text)).toEqual(["hold restart boundary"]);
  } finally { try { store.close(); } catch {} await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
