import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OmpRuntime } from "./runtime";

test("original native session retries a failed turn, performs a real file tool, rotates provider state, and reopens", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-session-recovery-native-"));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), trace = path.join(root, "provider.jsonl");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("../omp-workers/fixtures/session-recovery-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  const previousTrace = process.env.SESSION_RECOVERY_TRACE; process.env.SESSION_RECOVERY_TRACE = trace;
  const runtime = new OmpRuntime({ agentDir });
  try {
    const session = await runtime.create({ cwd, approvalOverride: "yolo" });
    const local = { id: session.id, file: session.sessionFile, cwd: session.cwd };
    const model = { provider: "session-recovery-contract", id: "controlled" };
    const failed = session.startPrompt("Create recovered.txt after recovery.", { model });
    expect((await failed.accepted)?.kind).toBe("user-message"); expect(await failed.completion).toBe(true);
    expect(session.getMessages().at(-1)).toMatchObject({ role: "assistant", assistant: { stopReason: "error", errorMessage: "Controlled original failure" } });

    const retry = session.startPrompt("/retry");
    expect(await retry.accepted).toMatchObject({ kind: "native-command", command: "retry", output: "Retrying the last failed turn." });
    expect(await retry.completion).toBe(true);
    expect(await readFile(path.join(cwd, "recovered.txt"), "utf8")).toBe("recovered by original native session\n");
    expect(session.getMessages().at(-1)).toMatchObject({ role: "assistant", text: "Recovered turn completed.", assistant: { stopReason: "stop" } });

    const beforeFresh = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line)).at(-1).sessionId;
    const oldTodos = session.getTodos(), oldPlan = session.getPlan(), oldJobs = session.nativeJobs({ action: "read" }).snapshot.owner;
    const fresh = session.startPrompt("/fresh");
    expect(await fresh.accepted).toMatchObject({ kind: "native-command", command: "fresh", output: expect.stringContaining("Fresh provider session started") });
    expect(await fresh.completion).toBe(false);
    expect({ id: session.id, file: session.sessionFile, cwd: session.cwd }).toEqual(local);
    const newTodos = session.getTodos(), newPlan = session.getPlan(), newJobs = session.nativeJobs({ action: "read" }).snapshot.owner;
    expect(newTodos.ticket.nativeSessionId).toBe(local.id); expect(newTodos.ticket.epoch).not.toBe(oldTodos.ticket.epoch);
    expect(newPlan.ticket.nativeSessionId).toBe(local.id); expect(newPlan.ticket.epoch).not.toBe(oldPlan.ticket.epoch);
    expect(newJobs.nativeSessionId).toBe(local.id); expect(newJobs.epoch).not.toBe(oldJobs.epoch);
    expect(() => session.nativeJobs({ action: "read", owner: oldJobs })).toThrow("another native owner generation");
    await expect(session.mutateTodos("stale-after-fresh", { sessionId: local.id, ticket: oldTodos.ticket,
      mutation: { action: "edit", markdown: oldTodos.markdown } })).rejects.toThrow("another native owner");
    await expect(session.controlPlan({ sessionId: local.id, ticket: oldPlan.ticket, action: "toggle" })).rejects.toThrow("changed");
    expect((await session.getControls()).sessionId).toBe(local.id);
    await expect(session.readUsage("cached")).resolves.toBeNull();
    const probe = session.startPrompt("fresh identity probe", { model }); expect((await probe.accepted)?.kind).toBe("user-message"); expect(await probe.completion).toBe(true);
    const afterFresh = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line)).at(-1).sessionId;
    expect(afterFresh).not.toBe(beforeFresh);
    const file = session.sessionFile; await session.dispose();
    const reopened = await runtime.open({ sessionFile: file });
    try {
      expect(reopened.id).toBe(local.id); expect(reopened.cwd).toBe(local.cwd);
      const messages = reopened.getMessages();
      expect(messages.some(message => message.role === "assistant" && message.assistant?.errorMessage === "Controlled original failure")).toBe(true);
      expect(messages.some(message => message.role === "commandOutput" && message.commandOutput?.command === "retry")).toBe(true);
      expect(messages.some(message => message.role === "commandOutput" && message.commandOutput?.command === "fresh")).toBe(true);
    } finally { await reopened.dispose(); }
  } finally {
    await runtime.dispose(); if (previousTrace === undefined) delete process.env.SESSION_RECOVERY_TRACE; else process.env.SESSION_RECOVERY_TRACE = previousTrace;
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("Stop cancels an active scheduled retry and recovery commands retain idle guards", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-session-recovery-stop-"));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), trace = path.join(root, "provider.jsonl"), hold = path.join(root, "hold");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]); await writeFile(hold, "hold");
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("../omp-workers/fixtures/session-recovery-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  const oldTrace = process.env.SESSION_RECOVERY_TRACE, oldHold = process.env.SESSION_RECOVERY_HOLD;
  process.env.SESSION_RECOVERY_TRACE = trace; process.env.SESSION_RECOVERY_HOLD = hold;
  const runtime = new OmpRuntime({ agentDir });
  try {
    const session = await runtime.create({ cwd, approvalOverride: "yolo" });
    try {
      const model = { provider: "session-recovery-contract", id: "controlled" };
      const failed = session.startPrompt("fail for Stop", { model }); await failed.accepted; await failed.completion;
      const retry = session.startPrompt("/retry"); await expect(retry.accepted).resolves.toMatchObject({ command: "retry" });
      for (let i = 0; i < 200 && (await readFile(trace, "utf8")).trim().split("\n").length < 2; i++) await Bun.sleep(5);
      expect(session.isStreaming || session.hasPostPromptWork).toBe(true);
      expect(() => session.startPrompt("/fresh")).toThrow("busy");
      await session.abort(); await unlink(hold);
      await expect(retry.completion).rejects.toThrow("maintenance is still settling");
      expect(await Bun.file(path.join(cwd, "recovered.txt")).exists()).toBe(false);
    } finally { await session.dispose(); }
  } finally {
    await runtime.dispose();
    if (oldTrace === undefined) delete process.env.SESSION_RECOVERY_TRACE; else process.env.SESSION_RECOVERY_TRACE = oldTrace;
    if (oldHold === undefined) delete process.env.SESSION_RECOVERY_HOLD; else process.env.SESSION_RECOVERY_HOLD = oldHold;
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
