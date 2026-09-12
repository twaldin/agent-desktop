import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "./runtime";
import type { WorkerEvent } from "./events";
import type { NativeBtwStatus } from "../../../../packages/shared/src/btw";

async function waitFile(file: string) {
  const deadline = Date.now() + 7_000;
  while (!await access(file).then(() => true, () => false) && Date.now() < deadline) await Bun.sleep(5);
  expect(await access(file).then(() => true, () => false)).toBe(true);
}
async function waitBtw(session: Awaited<ReturnType<WorkerRuntime["create"]>>, status: NativeBtwStatus) {
  const deadline = Date.now() + 7_000;
  let snapshot = await session.getBtw();
  while (snapshot?.status !== status && Date.now() < deadline) { await Bun.sleep(5); snapshot = await session.getBtw(); }
  expect(snapshot?.status).toBe(status);
  return snapshot!;
}
async function waitAssistantUpdate(events: WorkerEvent[], after: number) {
  const observed = () => events.slice(after).some(event => event.type === "message_update" && "message" in event && event.message?.role === "assistant");
  const deadline = Date.now() + 7_000;
  while (!observed() && Date.now() < deadline) await Bun.sleep(5);
  expect(observed()).toBe(true);
}

test("real native ephemeral turns inherit in-flight context without mutating or aborting the main lineage", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-btw-worker-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(gates)]);
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./fixtures/btw-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, BTW_CONTRACT_GATES: gates, TERM: "dumb" } });
  try {
    const events: WorkerEvent[] = [];
    const session = await runtime.create({ cwd, interactions: true, approvalOverride: "yolo", onEvent: event => events.push(event) });
    const model = { provider: "btw-contract", id: "controlled" };
    await writeFile(path.join(gates, "1.release"), "");
    const first = session.startPrompt("Persistent user context", { model });
    await first.accepted; expect(await first.completion).toBe(true);

    const parentEventStart = events.length;
    const parent = session.startPrompt("Parent remains in flight", { model });
    await parent.accepted; await waitFile(path.join(gates, "2.started")); await waitAssistantUpdate(events, parentEventStart);
    expect(session.isStreaming).toBe(true);
    const journalBeforeSide = await readFile(session.sessionFile, "utf8");

    const start = await session.startBtw({ runId: "side-one", question: "What context is visible?" });
    expect(start).toMatchObject({ runId: "side-one", sessionId: session.id, status: "running", answer: "" });
    await waitFile(path.join(gates, "3.started"));
    const streaming = await waitBtw(session, "running");
    expect(streaming.answer).toBe("Side delta 3 ");
    const same = await session.startBtw({ runId: "side-one", question: "What context is visible?" });
    expect(same).toEqual(streaming);
    expect(await access(path.join(gates, "4.started")).then(() => true, () => false)).toBe(false);

    const observed = JSON.parse(await readFile(path.join(gates, "3.started"), "utf8"));
    expect(observed.side).toBe(true);
    expect(observed.sessionId).toStartWith(`${session.id}:side:`);
    expect(observed.promptCacheKey).toBe(session.id);
    expect(observed.context).toContain("Persistent user context");
    expect(observed.context).toContain("Parent partial context 1");
    expect(observed.context).toContain("Parent remains in flight");
    expect(observed.context).toContain("Parent partial context 2");
    expect(observed.context).toContain("<btw>");
    expect(observed.context).toContain("Question:\nWhat context is visible?\n</btw>");
    expect(observed.tools.length).toBeGreaterThan(0);

    expect((await session.cancelBtw("side-one"))?.status).toBe("cancelled");
    await waitFile(path.join(gates, "3.aborted"));
    expect(session.isStreaming).toBe(true);
    expect(await readFile(session.sessionFile, "utf8")).toBe(journalBeforeSide);
    await writeFile(path.join(gates, "2.release"), "");
    expect(await parent.completion).toBe(true);

    await writeFile(path.join(gates, "4.release"), "");
    await session.startBtw({ runId: "side-two", question: "Second side question" });
    await waitFile(path.join(gates, "4.started"));
    expect((await waitBtw(session, "complete")).answer).toBe("Side delta 4 Side answer 4");
    const secondObserved = JSON.parse(await readFile(path.join(gates, "4.started"), "utf8"));
    expect(secondObserved.sessionId).not.toBe(observed.sessionId);

    await session.startBtw({ runId: "side-three", question: "Replace this side question" });
    await waitFile(path.join(gates, "5.started"));
    await session.startBtw({ runId: "side-four", question: "Replacement side question" });
    await waitFile(path.join(gates, "5.aborted")); await waitFile(path.join(gates, "6.started"));
    expect((await session.startBtw({ runId: "side-three", question: "Replace this side question" })).status).toBe("cancelled");
    expect(await access(path.join(gates, "7.started")).then(() => true, () => false)).toBe(false);
    await writeFile(path.join(gates, "6.release"), "");
    expect((await waitBtw(session, "complete")).runId).toBe("side-four");

    const journal = await readFile(session.sessionFile, "utf8");
    expect(journal).not.toContain("<btw>");
    expect(journal).not.toContain("Side answer");
    expect((await session.getMessages()).filter(message => message.role === "user").map(message => message.text))
      .toEqual(["Persistent user context", "Parent remains in flight"]);
  } finally {
    for (let call = 1; call <= 8; call++) await writeFile(path.join(gates, `${call}.release`), "").catch(() => {});
    await runtime.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
