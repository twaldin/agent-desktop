import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime, type WorkerSession } from "./runtime";

async function fixture(workerPath = fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url))) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-detached-question-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(gates)]);
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./fixtures/detached-question-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  const runtime = new WorkerRuntime({ agentDir, workerPath,
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, DETACHED_QUESTION_GATES: gates, TERM: "dumb" } });
  const session = await runtime.create({ cwd, interactions: true, approvalOverride: "yolo" });
  await session.setModel({ provider: "detached-contract", id: "controlled" });
  const started = async () => {
    const file = path.join(gates, "hold.started"), deadline = Date.now() + 7_000;
    let exists = false;
    while (!(exists = await access(file).then(() => true, () => false)) && Date.now() < deadline) await Bun.sleep(5);
    if (!exists) throw new Error(`Shared hold did not start; interactions=${JSON.stringify(await session.listInteractions())}: ${await readFile(session.sessionFile, "utf8")}`);
  };
  return { root, cwd, agentDir, gates, runtime, session, started, close: async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); } };
}

function entries(session: WorkerSession) {
  return readFile(session.sessionFile, "utf8").then(text => text.trim().split("\n").map(line => JSON.parse(line)));
}

test("Stop completed during an attempt flush prevents later native answer dispatch", async () => {
  const f = await fixture(fileURLToPath(new URL("./fixtures/detached-question-stop-worker.ts", import.meta.url)));
  try {
    const origin = f.session.startPrompt("Open a detached question before stopping delivery"); void origin.completion.catch(() => {});
    await origin.accepted; await f.started();
    const question = (await f.session.listQuestions())[0]!;
    await f.session.resolveQuestion({ questionId: question.questionId, questionEntryId: question.questionEntryId,
      commandId: "answer-before-stop", answers: [{ questionId: "density", selectedOptions: ["Compact"] }, { questionId: "note", selectedOptions: [] }] });
    const delivery = f.session.startQuestionDelivery(question.questionId); void delivery.completion.catch(() => {});
    const deadline = Date.now() + 7_000;
    while (!await Bun.file(path.join(f.gates, "attempt.flushed")).exists() && Date.now() < deadline) await Bun.sleep(5);
    expect(await Bun.file(path.join(f.gates, "attempt.flushed")).exists()).toBe(true);
    await f.session.abort();
    await writeFile(path.join(f.gates, "attempt.release"), "");
    expect(await delivery.accepted).toMatchObject({ outcome: "rejected", message: "Interrupted before native answer delivery." });
    await expect(delivery.completion).rejects.toThrow("Interrupted before native answer delivery");
    const journal = await entries(f.session);
    expect(journal.filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
    expect((await f.session.listQuestions())[0]?.delivery.status).toBe("rejected");
  } finally { await writeFile(path.join(f.gates, "attempt.release"), "").catch(() => {}); await f.close(); }
}, 30_000);

test("an answer arriving while native Stop settles is rejected without accepting or delivering it", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.gates, "hold.delay-abort"), "");
    const run = f.session.startPrompt("Open a detached question before stopping"); void run.completion.catch(() => {});
    await run.accepted; await f.started();
    const question = (await f.session.listQuestions())[0]!;
    const stopping = f.session.abort();
    const deadline = Date.now() + 7_000;
    while (!await Bun.file(path.join(f.gates, "abort.started")).exists() && Date.now() < deadline) await Bun.sleep(5);
    expect(await Bun.file(path.join(f.gates, "abort.started")).exists()).toBe(true);
    try {
      await expect(f.session.resolveQuestion({ questionId: question.questionId, questionEntryId: question.questionEntryId,
        commandId: "answer-during-stop", answers: [{ questionId: "density", selectedOptions: ["Compact"] }, { questionId: "note", selectedOptions: [] }] }))
        .rejects.toMatchObject({ name: "DetachedQuestionRejected", message: expect.stringContaining("being interrupted") });
      expect((await entries(f.session)).some(entry => entry.customType === "agent-desktop.question-accepted")).toBe(false);
    } finally { await writeFile(path.join(f.gates, "abort.release"), ""); await stopping; }
    expect((await f.session.listQuestions())[0]?.status).toBe("closed");
  } finally { await writeFile(path.join(f.gates, "abort.release"), "").catch(() => {}); await f.close(); }
}, 30_000);

test("ask_async returns while another shared tool runs and agent_end closes its unanswered journal entry", async () => {
  const f = await fixture();
  try {
    const run = f.session.startPrompt("Open a detached question and continue independent work"); await run.accepted; await f.started();
    const [question] = await f.session.listQuestions();
    expect(question).toMatchObject({ status: "open", questions: [{ id: "density" }, { id: "note" }], delivery: { status: "waiting" } });
    expect((await entries(f.session)).some(entry => entry.id === question!.questionEntryId && entry.customType === "agent-desktop.question-opened")).toBe(true);
    await writeFile(path.join(f.gates, "hold.release"), "");
    expect(await run.completion).toBe(true);
    expect((await f.session.listQuestions())[0]).toMatchObject({ status: "closed", close: { reason: "origin-ended" } });
  } finally { await f.close(); }
}, 30_000);

test("a synchronously reserved answer survives agent_end, persists across reopen, and tracks idle follow-up completion separately", async () => {
  const f = await fixture();
  try {
    const run = f.session.startPrompt("Open a detached question for later delivery"); await run.accepted; await f.started();
    const question = (await f.session.listQuestions())[0]!;
    const resolving = f.session.resolveQuestion({ questionId: question.questionId, questionEntryId: question.questionEntryId, commandId: "answer-command-1", answers: [
      { questionId: "density", selectedOptions: ["Compact"] }, { questionId: "note", selectedOptions: [], customInput: "Keep the toolbar visible" },
    ] });
    await writeFile(path.join(f.gates, "hold.release"), "");
    const accepted = await resolving; await run.completion;
    expect(accepted.delivery).toBe("waiting");
    expect((await f.session.listQuestions())[0]).toMatchObject({ status: "accepted", delivery: { status: "waiting" }, acceptance: { commandId: "answer-command-1" } });
    await expect(f.session.resolveQuestion({ questionId: question.questionId, questionEntryId: question.questionEntryId,
      commandId: "answer-command-definite-duplicate", answers: [
        { questionId: "density", selectedOptions: ["Compact"] }, { questionId: "note", selectedOptions: [] },
      ] })).rejects.toMatchObject({ name: "DetachedQuestionRejected", message: expect.stringContaining("already been resolved") });
    const sessionFile = f.session.sessionFile;
    await f.session.dispose();
    const reopened = await f.runtime.open({ sessionFile, interactions: true });
    expect((await reopened.listQuestions())[0]).toMatchObject({ status: "accepted", delivery: { status: "waiting" } });
    const delivery = reopened.startQuestionDelivery(question.questionId);
    const receipt = await delivery.accepted;
    expect(receipt).toMatchObject({ outcome: "delivered", mode: "followUp" });
    expect(await delivery.completion).toBe(true);
    expect((await reopened.listQuestions())[0]).toMatchObject({ delivery: { status: "delivered", nativeEntryId: receipt.outcome === "delivered" ? receipt.nativeEntryId : "" } });
    const journal = await entries(reopened);
    expect(journal.some(entry => entry.id === (receipt.outcome === "delivered" ? receipt.nativeEntryId : "") && entry.type === "message" && entry.message.role === "user"
      && entry.message.content.some((part: {text?:string}) => part.text?.includes("Keep the toolbar visible")))).toBe(true);
  } finally { await f.close(); }
}, 30_000);

test("an accepted answer steers its still-running native origin and reports that run's completion separately", async () => {
  const f = await fixture();
  try {
    const origin = f.session.startPrompt("Open a detached question while continuing work"); await origin.accepted; await f.started();
    const question = (await f.session.listQuestions())[0]!;
    await f.session.resolveQuestion({ questionId: question.questionId, questionEntryId: question.questionEntryId, commandId: "answer-command-streaming", answers: [
      { questionId: "density", selectedOptions: ["Comfortable"] }, { questionId: "note", selectedOptions: [] },
    ] });
    const delivery = f.session.startQuestionDelivery(question.questionId);
    expect((await f.session.listQuestions())[0]).toMatchObject({ delivery: { status: "delivering" } });
    await writeFile(path.join(f.gates, "hold.release"), "");
    const receipt = await delivery.accepted;
    expect(receipt).toMatchObject({ outcome: "delivered", mode: "steer" });
    expect(await delivery.completion).toBe(true);
    await origin.completion;
    expect((await f.session.listQuestions())[0]).toMatchObject({ status: "accepted", delivery: { status: "delivered", mode: "steer" } });
  } finally { await f.close(); }
}, 30_000);

test("reopen repairs a persisted question whose native origin turn was lost", async () => {
  const f = await fixture();
  const sessionFile = f.session.sessionFile;
  try {
    const run = f.session.startPrompt("Open a detached question before this worker is lost"); void run.completion.catch(() => {});
    await run.accepted; await f.started();
    expect((await f.session.listQuestions())[0]?.status).toBe("open");
    process.kill(f.session.workerPid, "SIGKILL");
    await new Promise<void>(resolve => { const stop = f.session.subscribeWorkerFailure(() => { stop(); resolve(); }); });
    const replacement = new WorkerRuntime({ agentDir: f.agentDir, workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
      environment: { HOME: f.root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: f.agentDir, DETACHED_QUESTION_GATES: f.gates, TERM: "dumb" } });
    try {
      const reopened = await replacement.open({ sessionFile, interactions: true });
      expect((await reopened.listQuestions())[0]).toMatchObject({ status: "closed", close: { reason: "reopen-repair" } });
    } finally { await replacement.dispose(); }
  } finally { await f.close(); }
}, 30_000);

test("worker loss after native answer flush reports outcome unknown and preserves the accepted journal", async () => {
  const f = await fixture(fileURLToPath(new URL("./fixtures/detached-question-crash-worker.ts", import.meta.url)));
  try {
    const run = f.session.startPrompt("Open a detached question before losing its acceptance response"); void run.completion.catch(() => {});
    await run.accepted; await f.started();
    const question = (await f.session.listQuestions())[0]!;
    const resolving = f.session.resolveQuestion({ questionId: question.questionId, questionEntryId: question.questionEntryId,
      commandId: "answer-command-lost-response", answers: [
        { questionId: "density", selectedOptions: ["Compact"] }, { questionId: "note", selectedOptions: [], customInput: "Persist this answer" },
      ] });
    const flushed = path.join(f.gates, "acceptance.flushed");
    const deadline = Date.now() + 7_000;
    while (!await Bun.file(flushed).exists() && Date.now() < deadline) await Bun.sleep(5);
    expect(await Bun.file(flushed).exists()).toBe(true);
    expect((await entries(f.session)).some(entry => entry.type === "custom" && entry.customType === "agent-desktop.question-accepted"
      && entry.data?.commandId === "answer-command-lost-response")).toBe(true);
    const failed = new Promise<void>(resolve => { const stop = f.session.subscribeWorkerFailure(() => { stop(); resolve(); }); });
    process.kill(f.session.workerPid, "SIGKILL"); await failed;
    await expect(resolving).rejects.toMatchObject({ name: "DetachedQuestionOutcomeUnknown", code: "OUTCOME_UNKNOWN" });

    const replacement = new WorkerRuntime({ agentDir: f.agentDir, workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
      environment: { HOME: f.root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: f.agentDir, DETACHED_QUESTION_GATES: f.gates, TERM: "dumb" } });
    try {
      const reopened = await replacement.open({ sessionFile: f.session.sessionFile, interactions: true });
      expect((await reopened.listQuestions())[0]).toMatchObject({ status: "accepted", delivery: { status: "waiting" },
        acceptance: { commandId: "answer-command-lost-response" } });
    } finally { await replacement.dispose(); }
  } finally { await f.close(); }
}, 30_000);
