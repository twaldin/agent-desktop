import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { beginNativePrompt } from "./prompt";
import { serializeRepeatedWholeFilePrompt, serializeWholeFilePrompt } from "@agent-desktop/shared";
import { copyNativeWholeFileInput, NativeWholeFilePrompt, WHOLE_FILE_BINDING_TYPE } from "./whole-file";
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

test("inline whole-file admission binds authored offsets to the exact serialized user text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-inline-whole-file-")); roots.push(root);
  const sourcePath = path.join(root, "@note #.txt"); await writeFile(sourcePath, "native snapshot\n");
  const manager = SessionManager.create(root, path.join(root, "sessions")); await manager.ensureOnDisk();
  try {
    const authoredText = "Read 😀 this", attachments = [{ id: "note", textOffset: 7, source: { kind: "file" as const, hostId: "owner", path: sourcePath } }];
    const nativeText = serializeWholeFilePrompt(authoredText, attachments);
    const agent = { prompt: async (payload: unknown) => { for (const message of Array.isArray(payload) ? payload : [payload]) manager.appendMessage(message as never); } };
    const session = { agent, sessionManager: manager, settings: { get: () => false } } as unknown as AgentSession;
    const whole = NativeWholeFilePrompt.fromInput(session, { submissionId: "inline-submit", attachments }, authoredText)!;
    const run = beginNativePrompt(manager, async () => {
      await whole.prepare(session); await session.agent.prompt({ role: "user", content: nativeText, timestamp: 1 }); return { agentInvoked: true };
    }, async () => {}, undefined, undefined, undefined, whole);
    expect((await run.accepted)?.kind).toBe("user-message"); await run.completion; whole.close();
    const entries = manager.getEntries(), binding = entries.find(entry => entry.type === "custom" && entry.customType === WHOLE_FILE_BINDING_TYPE);
    expect(entries.filter(entry => entry.type === "message").map(entry => entry.type === "message" ? entry.message.role : undefined)).toEqual(["fileMention", "user"]);
    expect(entries.find(entry => entry.type === "message" && entry.message.role === "user")).toMatchObject({ message: { content: nativeText } });
    expect(binding).toMatchObject({ data: { version: 2, submissionId: "inline-submit", authoredText, attachments } });
  } finally { await manager.close(); }
});

test("repeated inline mentions read one native snapshot and persist binding v3", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-repeated-whole-file-")); roots.push(root);
  const sourcePath = path.join(root, "repeat.txt"); await writeFile(sourcePath, "one snapshot\n");
  const manager = SessionManager.create(root, path.join(root, "sessions")); await manager.ensureOnDisk();
  try {
    const authoredText = "again", attachments = [
      { id: "first", textOffset: 0, source: { kind: "file" as const, hostId: "owner", path: sourcePath } },
      { id: "second", textOffset: 5, source: { kind: "file" as const, hostId: "owner", path: sourcePath } },
    ];
    const nativeText = serializeRepeatedWholeFilePrompt(authoredText, attachments);
    const agent = { prompt: async (payload: unknown) => { for (const message of Array.isArray(payload) ? payload : [payload]) manager.appendMessage(message as never); } };
    const session = { agent, sessionManager: manager, settings: { get: () => false } } as unknown as AgentSession;
    const whole = NativeWholeFilePrompt.fromInput(session, { submissionId: "repeat-submit", attachments }, authoredText)!;
    const run = beginNativePrompt(manager, async () => { await whole.prepare(session); await session.agent.prompt({ role: "user", content: nativeText, timestamp: 1 }); return { agentInvoked: true }; }, async () => {}, undefined, undefined, undefined, whole);
    expect((await run.accepted)?.kind).toBe("user-message"); await run.completion; whole.close();
    const entries = manager.getEntries(), nativeFiles = entries.filter(entry => entry.type === "message" && entry.message.role === "fileMention");
    expect(nativeFiles).toHaveLength(1);
    expect(nativeFiles[0]).toMatchObject({ message: { files: [{ path: sourcePath }] } });
    expect(entries.find(entry => entry.type === "custom" && entry.customType === WHOLE_FILE_BINDING_TYPE)).toMatchObject({ data: { version: 3, authoredText, attachments, fileEntryIds: [nativeFiles[0]!.id] } });
  } finally { await manager.close(); }
});

test("repeated native input rejects mixed owning hosts before reading files", () => {
  const source = "/tmp/repeated-owner.txt";
  expect(() => copyNativeWholeFileInput({ submissionId: "mixed-owner", attachments: [
    { id: "first", textOffset: 0, source: { kind: "file", hostId: "owner-a", path: source } },
    { id: "second", textOffset: 0, source: { kind: "file", hostId: "owner-b", path: source } },
    { id: "third", textOffset: 0, source: { kind: "file", hostId: "owner-a", path: source } },
  ] }, 0)).toThrow("one owning host");
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
    const mixedText = "with excerpt", mixedFiles = [{ ...wholeFiles.attachments[0]!, textOffset: 4 }];
    const mixed = session.startPrompt(mixedText, { model, wholeFiles: { submissionId: "native-whole-mixed", attachments: mixedFiles }, selectedText: { submissionId: "native-selected-mixed", attachments: [{ id: "excerpt", text: "excerpt", source: { kind: "file" as const, hostId: "owner", path: sourcePath, range: { start: { line: 1, column: 1 }, end: { line: 1, column: 8 } } } }] } });
    expect((await mixed.accepted)?.kind).toBe("user-message"); await expect(mixed.completion).resolves.toBe(true);
    expect((await session.getMessages()).find(message => message.role === "user" && message.text === serializeWholeFilePrompt(mixedText, mixedFiles))).toMatchObject({ selectedText: { submissionId: "native-selected-mixed" }, wholeFiles: { submissionId: "native-whole-mixed", authoredText: mixedText } });
    const authoredText = "open this", inlineAttachments = [{ ...wholeFiles.attachments[0]!, textOffset: 5 }];
    const inline = session.startPrompt(authoredText, { model, wholeFiles: { submissionId: "native-whole-inline", attachments: inlineAttachments } });
    expect((await inline.accepted)?.kind).toBe("user-message"); await expect(inline.completion).resolves.toBe(true);
    const projected = await session.getMessages(), serialized = serializeWholeFilePrompt(authoredText, inlineAttachments);
    expect(projected.find(message => message.role === "user" && message.text === serialized)?.wholeFiles).toMatchObject({ submissionId: "native-whole-inline", authoredText, attachments: inlineAttachments });
    // The legacy v7 file row remains visible; exact verified v8 rows are folded into their user messages.
    expect(projected.filter(message => message.role === "fileMention")).toHaveLength(1);
    const sessionFile = session.sessionFile; await session.dispose();
    const reopened = await runtime.open({ sessionFile });
    try {
      const restored = await reopened.getMessages();
      expect(restored.filter(message => message.role === "fileMention")).toHaveLength(1);
      expect(restored.find(message => message.role === "user" && message.text === serialized)?.wholeFiles).toMatchObject({ submissionId: "native-whole-inline", authoredText, attachments: inlineAttachments });
    }
    finally { await reopened.dispose(); }
  } finally { await runtime.dispose(); }
}, 30_000);
