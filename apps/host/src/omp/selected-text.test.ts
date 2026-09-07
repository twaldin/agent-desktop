import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { beginNativePrompt } from "./prompt";
import { copyNativeSelectedTextInput, NativeSelectedTextPrompt, SELECTED_TEXT_CUSTOM_TYPE } from "./selected-text";
import { WorkerRuntime } from "../omp-workers/runtime";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function managerFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-desktop-selected-text-"));
  directories.push(directory);
  const manager = SessionManager.create(directory, path.join(directory, "sessions"));
  await manager.ensureOnDisk();
  const session = {
    sessionManager: manager,
    async sendCustomMessage(message: { customType?: string; content?: string; display?: boolean; details?: unknown; attribution?: "user" | "agent" }) {
      manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details, message.attribution);
      return false;
    },
  } as unknown as Pick<AgentSession, "sessionManager" | "sendCustomMessage">;
  return { manager, session };
}

const input = {
  submissionId: "submission-1",
  attachments: [{
    id: "excerpt-1",
    text: "const value = 1;",
    source: { kind: "file" as const, hostId: "another-host", path: "/outside/current/workspace.ts",
      range: { start: { line: 4, column: 1 }, end: { line: 4, column: 17 } } },
  }],
};

test("persists selected snapshots before the unchanged ordinary user message", async () => {
  const { manager, session } = await managerFixture();
  try {
    const selected = NativeSelectedTextPrompt.fromInput(session, input)!;
    const userMessage = { role: "user" as const, content: "Please explain this.", timestamp: 1 };
    const run = beginNativePrompt(manager, async () => {
      await selected.append();
      manager.appendMessage(userMessage);
      return { agentInvoked: true };
    }, async () => {}, undefined, undefined, { get attempted() { return selected.attempted; }, matches: message => message === userMessage });
    expect((await run.accepted)?.kind).toBe("user-message");
    expect(await run.completion).toBe(true);
    const entries = manager.getEntries();
    expect(entries.map(entry => entry.type)).toEqual(["custom_message", "message"]);
    const context = entries.find(entry => entry.type === "custom_message");
    if (!context || context.type !== "custom_message") throw new Error("Missing selected-text custom entry");
    expect(context.customType).toBe(SELECTED_TEXT_CUSTOM_TYPE);
    expect(context.details).toEqual({ version: 1, submissionId: input.submissionId, attachments: input.attachments });
    expect(context.content).toContain('"submissionId":"submission-1"');
    const user = entries.find(entry => entry.type === "message");
    if (!user || user.type !== "message" || user.message.role !== "user") throw new Error("Missing ordinary user entry");
    expect(user.message.content).toBe("Please explain this.");
    const persisted = await readFile(manager.getSessionFile()!, "utf8");
    expect(persisted).toContain('"customType":"agent-desktop.selected-text"');
    expect(persisted).toContain('"hostId":"another-host"');
    expect(persisted).toContain('"content":"Please explain this."');
  } finally { await manager.close(); }
});

test("a failure after context append stays outcome-unknown and rejects duplicate submission identity", async () => {
  const { manager, session } = await managerFixture();
  try {
    const selected = NativeSelectedTextPrompt.fromInput(session, input)!;
    const run = beginNativePrompt(manager, async () => {
      await selected.append();
      throw new Error("ordinary prompt transport stopped");
    }, async () => {}, undefined, undefined, { get attempted() { return selected.attempted; }, matches: () => false });
    await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(run.completion).rejects.toThrow("ordinary prompt transport stopped");
    expect(manager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === SELECTED_TEXT_CUSTOM_TYPE)).toBe(true);
    expect(() => NativeSelectedTextPrompt.fromInput(session, input)).toThrow("may already be recorded");
  } finally { await manager.close(); }
});

test("a no-op or altered custom append never dispatches the ordinary prompt", async () => {
  for (const mode of ["no-op", "altered", "mutated-details", "duplicate"] as const) {
    const { manager } = await managerFixture();
    try {
      const session = {
        sessionManager: manager,
        async sendCustomMessage(message: { customType?: string; content?: string; display?: boolean; details?: unknown; attribution?: "user" | "agent" }) {
          if (mode === "mutated-details") {
            (message.details as typeof input).attachments[0]!.source.path = "/changed-source";
            manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details, message.attribution);
          } else if (mode === "duplicate") {
            manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details, message.attribution);
            manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details, message.attribution);
          } else if (mode === "altered") manager.appendCustomMessageEntry(message.customType, "altered selected context", message.display, message.details, message.attribution);
          return false;
        },
      } as unknown as Pick<AgentSession, "sessionManager" | "sendCustomMessage">;
      const selected = NativeSelectedTextPrompt.fromInput(session, { ...input, submissionId: `append-${mode}` })!;
      let ordinaryDispatch = false;
      const run = beginNativePrompt(manager, async () => {
        await selected.append();
        ordinaryDispatch = true;
        manager.appendMessage({ role: "user", content: "must not be appended", timestamp: 1 });
        return { agentInvoked: true };
      }, async () => {}, undefined, undefined, { get attempted() { return selected.attempted; }, matches: () => false });
      await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      await expect(run.completion).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(ordinaryDispatch).toBe(false);
      expect(manager.getEntries().some(entry => entry.type === "message" && entry.message.role === "user")).toBe(false);
    } finally { await manager.close(); }
  }
});

test("captured native user attribution rejects later content mutation and restores the prompt method", async () => {
  const { manager, session } = await managerFixture();
  try {
    const selected = NativeSelectedTextPrompt.fromInput(session, input)!;
    const original = async () => {};
    const agent = { prompt: original };
    selected.prepare({ agent } as unknown as AgentSession, "authored text");
    const user = { role: "user", content: [{ type: "text", text: "authored text" }], timestamp: 1 };
    await (agent.prompt as Function)(user);
    expect(selected.matches(user)).toBe(true);
    expect(selected.matches(structuredClone(user))).toBe(false);
    user.content[0]!.text = "extension rewrite";
    expect(selected.matches(user)).toBe(false);
    selected.close();
    expect(agent.prompt).toBe(original);
    await selected.append();
    await expect(selected.append()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  } finally { await manager.close(); }
});

test("context flush failure prevents ordinary dispatch and retains an uncertain admission", async () => {
  const { manager, session } = await managerFixture();
  const flush = manager.flush;
  try {
    manager.flush = async () => { throw new Error("selected context disk failure"); };
    const selected = NativeSelectedTextPrompt.fromInput(session, input)!;
    let ordinaryDispatch = false;
    const run = beginNativePrompt(manager, async () => {
      await selected.append();
      ordinaryDispatch = true;
      return { agentInvoked: true };
    }, async () => {}, undefined, undefined, selected);
    await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(run.completion).rejects.toThrow("selected context disk failure");
    expect(ordinaryDispatch).toBe(false);
  } finally { manager.flush = flush; await manager.close(); }
});

test("a submission recorded during startup is never appended again, even at an unknown metadata version", async () => {
  const { manager, session } = await managerFixture();
  try {
    const selected = NativeSelectedTextPrompt.fromInput(session, input)!;
    manager.appendCustomMessageEntry(SELECTED_TEXT_CUSTOM_TYPE, "prior context", true, { version: 99, submissionId: input.submissionId });
    await expect(selected.append()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(manager.getEntries()).toHaveLength(1);
  } finally { await manager.close(); }
});

test("invalid snapshots fail before a custom entry is appended", async () => {
  const { manager, session } = await managerFixture();
  try {
    expect(() => NativeSelectedTextPrompt.fromInput(session, { ...input, attachments: [{ ...input.attachments[0]!, text: " " }] })).toThrow("Select some text");
    expect(manager.getEntries().some(entry => entry.type === "custom_message")).toBe(false);
  } finally { await manager.close(); }
});

test("copies every wire input shape before it becomes a no-op", () => {
  const empty = copyNativeSelectedTextInput({ submissionId: "empty-submission", attachments: [] });
  expect(empty).toEqual({ submissionId: "empty-submission", attachments: [] });
  expect(() => copyNativeSelectedTextInput({ submissionId: "", attachments: [] } as never)).toThrow("identity");
  expect(() => copyNativeSelectedTextInput({ submissionId: "extra", attachments: [], unexpected: true } as never)).toThrow("Invalid selected-text input");
  const inherited = Object.assign(Object.create({ submissionId: "inherited", attachments: [] }), { left: true, right: true });
  expect(() => copyNativeSelectedTextInput(inherited)).toThrow("Invalid selected-text input");
});

test("real native session sends persisted selected context before unchanged user text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-selected-text-native-"));
  directories.push(root);
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates");
  const runtime = new WorkerRuntime({ agentDir,
    workerPath: fileURLToPath(new URL("../omp-workers/fixtures/no-provider-worker.ts", import.meta.url)),
    environment: {
      HOME: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: tmpdir(), TERM: "dumb",
      PI_CODING_AGENT_DIR: agentDir, PI_DISABLE_DOTENV: "1", SELECTED_TEXT_CONTRACT_GATES: gates,
    },
  });
  try {
    await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(gates)]);
    await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("../omp-workers/fixtures/selected-text-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
    const session = await runtime.create({ cwd });
    const model = { provider: "selected-text-contract", id: "controlled" };
    const run = session.startPrompt("Explain the captured value.", { model, selectedText: input });
    expect((await run.accepted)?.kind).toBe("user-message");
    await expect(run.completion).resolves.toBe(true);
    const modelContext = (await session.getMessages()).find(message => message.role === "assistant")?.text;
    expect(modelContext).toContain("another-host");
    expect(modelContext).toContain("const value = 1;");
    expect(modelContext).toContain("Explain the captured value.");
    const sessionFile = session.sessionFile;
    await session.dispose();
    const reopened = await runtime.open({ sessionFile });
    try {
      const persisted = await readFile(sessionFile, "utf8");
      expect(persisted).toContain('"customType":"agent-desktop.selected-text"');
      expect(persisted).toContain('"submissionId":"submission-1"');
      expect(persisted).toContain('"text":"Explain the captured value."');
      expect((await reopened.getMessages()).some(message => message.role === "user" && message.text === "Explain the captured value.")).toBe(true);
    } finally { await reopened.dispose(); }
    // The pinned SDK permits an excerpt-only ordinary turn. It still creates a
    // durable empty user message after the selected context, rather than
    // treating the context record as an executable prompt by itself.
    const excerptOnly = await runtime.create({ cwd });
    try {
      const run = excerptOnly.startPrompt("", { model, selectedText: { ...input, submissionId: "excerpt-only" } });
      expect((await run.accepted)?.kind).toBe("user-message");
      await expect(run.completion).resolves.toBe(true);
      expect((await excerptOnly.getMessages()).some(message => message.role === "user" && message.text === "")).toBe(true);
    } finally { await excerptOnly.dispose(); }
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test("selected admission flushes an exact native user binding before acknowledging", async () => {
  const { manager, session } = await managerFixture();
  try {
    const agent = { prompt: async (message: unknown) => { manager.appendMessage(message as never); } };
    const native = { ...session, agent } as unknown as AgentSession;
    const selected = NativeSelectedTextPrompt.fromInput(native, { ...input, submissionId: "bound-submit" })!;
    selected.prepare(native, "Exact authored text");
    const run = beginNativePrompt(manager, async () => {
      await selected.append();
      await native.agent.prompt({ role: "user", content: "Exact authored text", timestamp: 1 });
      return { agentInvoked: true };
    }, async () => {}, undefined, undefined, selected);
    const receipt = await run.accepted; await run.completion; selected.close();
    const entries = manager.getEntries(), binding = entries.find(entry => entry.type === "custom" && entry.customType === "agent-desktop.selected-text-binding");
    expect(binding).toMatchObject({ data: { version: 1, submissionId: "bound-submit", userEntryId: receipt?.entryId, contextEntryId: entries[0]?.id } });
    expect(await readFile(manager.getSessionFile()!, "utf8")).toContain('"customType":"agent-desktop.selected-text-binding"');
  } finally { await manager.close(); }
});

test("missing binding append never acknowledges or consumes the selected prompt", async () => {
  const { manager, session } = await managerFixture();
  try {
    const native = { ...session, agent: { prompt: async (message: unknown) => { manager.appendMessage(message as never); } } } as unknown as AgentSession;
    const selected = NativeSelectedTextPrompt.fromInput(native, { ...input, submissionId: "binding-failure" })!;
    selected.prepare(native, "Exact authored text");
    const original = manager.appendCustomEntry.bind(manager);
    manager.appendCustomEntry = ((type, data) => type === "agent-desktop.selected-text-binding" ? "not-appended" : original(type, data)) as typeof original;
    const run = beginNativePrompt(manager, async () => {
      await selected.append(); await native.agent.prompt({ role: "user", content: "Exact authored text", timestamp: 1 }); return { agentInvoked: true };
    }, async () => {}, undefined, undefined, selected);
    await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await run.completion; selected.close();
    expect(manager.getEntries().filter(entry => entry.type === "message")).toHaveLength(1);
    expect(manager.getEntries().some(entry => entry.type === "custom" && entry.customType === "agent-desktop.selected-text-binding")).toBe(false);
  } finally { await manager.close(); }
});
