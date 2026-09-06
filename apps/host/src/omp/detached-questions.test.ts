import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { NativeDetachedQuestions } from "./detached-questions";

test("receipt reconciliation snapshots reject a failed native flush and exclude entries appended during the flush", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-question-snapshot-")));
  const cwd = path.join(root, "project"); await mkdir(cwd);
  const manager = SessionManager.create(cwd, path.join(root, "sessions"));
  const flush = manager.flush.bind(manager);
  const journal = new NativeDetachedQuestions(manager);
  const flushSpy = spyOn(manager, "flush");
  try {
    manager.appendMessage({ role: "user", content: "Snapshot durability fixture", timestamp: Date.now() });
    await manager.ensureOnDisk();
    journal.observe({ type: "agent_start" } as never);
    const opened = await journal.open([{ id: "choice", question: "Choose?", options: [{ label: "A" }] }]);
    flushSpy.mockRejectedValue(new Error("fixture storage unavailable"));
    await expect(journal.resolve({ ...opened, commandId: "unconfirmed-answer", answers: [{ questionId: "choice", selectedOptions: ["A"] }] })).rejects.toThrow("storage could not be verified");
    // In-memory acceptance alone must never let the host consume a saved draft.
    expect(journal.list()[0]?.status).toBe("accepted");
    await expect(journal.snapshot()).rejects.toThrow("fixture storage unavailable");
    flushSpy.mockImplementation(flush);
    expect((await journal.snapshot())[0]?.acceptance?.commandId).toBe("unconfirmed-answer");

    const gate = Promise.withResolvers<void>();
    flushSpy.mockImplementationOnce(async () => { await gate.promise; await flush(); });
    const snapshot = journal.snapshot();
    const second = await journal.open([{ id: "later", question: "Later question?", options: [] }]);
    gate.resolve();
    expect((await snapshot).some(question => question.questionId === second.questionId)).toBe(false);
    expect((await journal.snapshot()).some(question => question.questionId === second.questionId)).toBe(true);
  } finally { flushSpy.mockRestore(); journal.dispose(); await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("a flushed delivery attempt without a native receipt reopens as unknown and cannot auto replay", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-detached-journal-")));
  const cwd = path.join(root, "project"), sessions = path.join(root, "sessions");
  await mkdir(cwd);
  let manager = SessionManager.create(cwd, sessions);
  try {
    manager.appendMessage({ role: "user", content: "Native detached-question fixture", timestamp: Date.now() });
    await manager.ensureOnDisk();
    const journal = new NativeDetachedQuestions(manager);
    journal.observe({ type: "agent_start" } as never);
    const opened = await journal.open([{ id: "choice", question: "Choose?", options: [{ label: "A" }], multi: false }]);
    const resolving = journal.resolve({ questionId: opened.questionId, questionEntryId: opened.questionEntryId, commandId: "answer-command",
      answers: [{ questionId: "choice", selectedOptions: ["A"] }] });
    journal.observe({ type: "agent_end" } as never);
    await resolving;
    expect(journal.list()[0]?.status).toBe("accepted");
    const never = new Promise<never>(() => {});
    journal.startDelivery(opened.questionId, () => "followUp", () => ({ accepted: never, completion: never }));
    expect(journal.list()[0]).toMatchObject({ status: "accepted", delivery: { status: "delivering" } });
    expect(() => journal.startDelivery(opened.questionId, () => "followUp", () => ({ accepted: never, completion: never }))).toThrow("not waiting");
    await manager.flush();
    const file = manager.getSessionFile()!;
    journal.dispose(); await manager.close();
    manager = await SessionManager.open(file);
    const reopened = new NativeDetachedQuestions(manager);
    await reopened.repairOnReopen();
    expect(reopened.list()[0]).toMatchObject({ status: "accepted", delivery: { status: "unknown" } });
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});
