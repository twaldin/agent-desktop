import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { beginNativePrompt } from "./prompt";
import { NativeWholeFilePrompt, WHOLE_FILE_BINDING_TYPE } from "./whole-file";
import { WorkerRuntime } from "../omp-workers/runtime";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("whole-file admission injects a native fileMention before its bound user entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-whole-file-")); roots.push(root);
  await writeFile(path.join(root, "note.txt"), "native snapshot\n");
  const manager = SessionManager.create(root, path.join(root, "sessions")); await manager.ensureOnDisk();
  try {
    const agent = { prompt: async (payload: unknown) => { for (const message of Array.isArray(payload) ? payload : [payload]) manager.appendMessage(message as never); } };
    const session = { agent, sessionManager: manager, settings: { get: () => false } } as unknown as AgentSession;
    const whole = NativeWholeFilePrompt.fromInput(session, { submissionId: "whole-submit", attachments: [{ id: "note", source: { kind: "file", hostId: "owner", path: path.join(root, "note.txt") } }] })!;
    const run = beginNativePrompt(manager, async () => {
      await whole.prepare(session);
      await session.agent.prompt({ role: "user", content: "", timestamp: 1 });
      return { agentInvoked: true };
    }, async () => {}, undefined, undefined, undefined, whole);
    expect((await run.accepted)?.kind).toBe("user-message"); await run.completion; whole.close();
    const entries = manager.getEntries();
    expect(entries.filter(entry => entry.type === "message").map(entry => entry.type === "message" ? entry.message.role : undefined)).toEqual(["fileMention", "user"]);
    const binding = entries.find(entry => entry.type === "custom" && entry.customType === WHOLE_FILE_BINDING_TYPE);
    const files = entries.filter(entry => entry.type === "message");
    expect(binding).toMatchObject({ data: { version: 1, submissionId: "whole-submit", fileEntryIds: [files[0]?.id], userEntryId: files[1]?.id } });
  } finally { await manager.close(); }
});

test("a persisted attempt marker blocks a new submission when the binding receipt is lost", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-whole-file-binding-loss-")); roots.push(root);
  const sourcePath = path.join(root, "note.txt"); await writeFile(sourcePath, "native snapshot\n");
  const manager = SessionManager.create(root, path.join(root, "sessions")); await manager.ensureOnDisk();
  try {
    const agent = { prompt: async (payload: unknown) => { for (const message of Array.isArray(payload) ? payload : [payload]) manager.appendMessage(message as never); } };
    const session = { agent, sessionManager: manager, settings: { get: () => false } } as unknown as AgentSession;
    const input = { submissionId: "lost-binding", attachments: [{ id: "note", source: { kind: "file" as const, hostId: "owner", path: sourcePath } }] };
    const whole = NativeWholeFilePrompt.fromInput(session, input)!;
    const original = manager.appendCustomEntry.bind(manager);
    manager.appendCustomEntry = ((type, data) => type === WHOLE_FILE_BINDING_TYPE ? "missing-binding" : original(type, data)) as typeof original;
    const run = beginNativePrompt(manager, async () => { await whole.prepare(session); await session.agent.prompt({ role: "user", content: "", timestamp: 1 }); return { agentInvoked: true }; }, async () => {}, undefined, undefined, undefined, whole);
    await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(run.completion).resolves.toBe(true);
    whole.close();
    expect(() => NativeWholeFilePrompt.fromInput(session, input)).toThrow("may already be recorded");
  } finally { await manager.close(); }
});

test("a missing literal path rejects the entire whole-file admission before native history changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-whole-file-missing-")); roots.push(root);
  const sourcePath = path.join(root, "present.txt"); await writeFile(sourcePath, "present\n");
  const manager = SessionManager.create(root, path.join(root, "sessions")); await manager.ensureOnDisk();
  try {
    let prompted = false;
    const agent = { prompt: async () => { prompted = true; } };
    const session = { agent, sessionManager: manager, settings: { get: () => false } } as unknown as AgentSession;
    const whole = NativeWholeFilePrompt.fromInput(session, { submissionId: "missing-one", attachments: [
      { id: "present", source: { kind: "file", hostId: "owner", path: sourcePath } },
      { id: "missing", source: { kind: "file", hostId: "owner", path: path.join(root, "missing # literal.txt") } },
    ] })!;
    await expect(whole.prepare(session)).rejects.toThrow("draft was preserved");
    expect(manager.getEntries()).toHaveLength(0);
    expect(prompted).toBe(false);
    expect(NativeWholeFilePrompt.fromInput(session, { submissionId: "missing-one", attachments: [{ id: "present", source: { kind: "file", hostId: "owner", path: sourcePath } }] })).toBeDefined();
  } finally { await manager.close(); }
});

test("real native prompt persists a generated whole-file snapshot for files-only and mixed selected-text input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-whole-file-native-")); roots.push(root);
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates");
  const name = "native # file with spaces.txt", sourcePath = path.join(cwd, name);
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("../omp-workers/fixtures/no-provider-worker.ts", import.meta.url)), environment: { HOME: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: tmpdir(), TERM: "dumb", PI_CODING_AGENT_DIR: agentDir, PI_DISABLE_DOTENV: "1", SELECTED_TEXT_CONTRACT_GATES: gates } });
  try {
    await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(gates)]);
    await writeFile(sourcePath, "whole native snapshot\n");
    await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("../omp-workers/fixtures/selected-text-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
    const session = await runtime.create({ cwd }), model = { provider: "selected-text-contract", id: "controlled" };
    const wholeFiles = { submissionId: "native-whole", attachments: [{ id: "whole", source: { kind: "file" as const, hostId: "owner", path: sourcePath } }] };
    const filesOnly = session.startPrompt("", { model, wholeFiles });
    expect((await filesOnly.accepted)?.kind).toBe("user-message"); await expect(filesOnly.completion).resolves.toBe(true);
    const first = await session.getMessages();
    expect(first.find(message => message.role === "fileMention")?.fileReferences?.[0]).toMatchObject({ path: sourcePath, lineCount: 1 });
    expect(first.find(message => message.role === "fileMention")?.fileReferences?.[0]?.content).toContain("whole native snapshot");
    expect(first.some(message => message.role === "user" && message.text === "")).toBe(true);
    const mixed = session.startPrompt("with excerpt", { model, wholeFiles: { ...wholeFiles, submissionId: "native-whole-mixed" }, selectedText: { submissionId: "native-selected-mixed", attachments: [{ id: "excerpt", text: "excerpt", source: { kind: "file" as const, hostId: "owner", path: sourcePath, range: { start: { line: 1, column: 1 }, end: { line: 1, column: 8 } } } }] } });
    expect((await mixed.accepted)?.kind).toBe("user-message"); await expect(mixed.completion).resolves.toBe(true);
    const sessionFile = session.sessionFile; await session.dispose();
    const reopened = await runtime.open({ sessionFile });
    try { expect((await reopened.getMessages()).filter(message => message.role === "fileMention")).toHaveLength(2); }
    finally { await reopened.dispose(); }
  } finally { await runtime.dispose(); }
}, 30_000);
