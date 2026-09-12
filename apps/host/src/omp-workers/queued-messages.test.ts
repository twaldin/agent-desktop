import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "./runtime";

test("owning worker transports live queue snapshots, invalidations and revision-fenced mutations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-queue-worker-"));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(gates)]);
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./fixtures/steer-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  const runtime = new WorkerRuntime({ agentDir,
    workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir,
      STEER_CONTRACT_GATES: gates, TERM: "dumb" } });
  const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 7_000;
    while (!await predicate() && Date.now() < deadline) await Bun.sleep(5);
    expect(await predicate()).toBe(true);
  };
  try {
    const session = await runtime.create({ cwd, interactions: true });
    const events: number[] = [];
    session.subscribe(event => { if (event.type === "queued_messages_changed") events.push(event.snapshot.revision); });
    const run = session.startPrompt("hold native queue", { model: { provider: "steer-contract", id: "controlled" } });
    await run.accepted; await waitFor(() => Bun.file(path.join(gates, "1.started")).exists());

    const first = session.steer("first queued steer"), second = session.steer("second queued steer");
    let snapshot = await session.getQueuedMessages();
    while (snapshot.messages.length < 2) { await Bun.sleep(5); snapshot = await session.getQueuedMessages(); }
    expect(snapshot.messages.map(item => item.text)).toEqual(["first queued steer", "second queued steer"]);
    expect(snapshot.messages.every(item => item.ownership === "desktop-pending")).toBe(true);

    const reordered = await session.mutateQueuedMessages({ type: "reorder", expectedRevision: snapshot.revision,
      messageIds: snapshot.messages.map(item => item.id).reverse() });
    expect(reordered.snapshot.messages.map(item => item.text)).toEqual(["second queued steer", "first queued steer"]);
    await expect(session.mutateQueuedMessages({ type: "remove", expectedRevision: snapshot.revision,
      messageId: snapshot.messages[0]!.id })).rejects.toThrow("changed");

    const removedSecond = await session.mutateQueuedMessages({ type: "remove", expectedRevision: reordered.snapshot.revision,
      messageId: reordered.snapshot.messages[0]!.id });
    expect(removedSecond.snapshot.messages.map(item => item.text)).toEqual(["first queued steer"]);
    const removedFirst = await session.mutateQueuedMessages({ type: "remove", expectedRevision: removedSecond.snapshot.revision,
      messageId: removedSecond.snapshot.messages[0]!.id });
    expect(removedFirst.snapshot.messages).toEqual([]);
    expect((await first).kind).toBe("not-recorded");
    expect((await second).kind).toBe("not-recorded");
    await waitFor(() => events.includes(removedFirst.snapshot.revision));

    await session.abort(); await run.completion;
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
