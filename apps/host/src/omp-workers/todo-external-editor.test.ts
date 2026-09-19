import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TodoExternalEditorRequest } from "../../../../packages/shared/src/todo-external-editor";

import { WorkerRuntime, type WorkerSession } from "./runtime";

const workerPath = fileURLToPath(new URL("./fixtures/todo-external-editor-worker.ts", import.meta.url));

async function fixture(scenario = "normal", configured = true, actualEditor = false) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-todo-external-editor-worker-"));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), temporary = path.join(root, "tmp");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(temporary)]);
  await writeFile(path.join(agentDir, "config.yml"), ["extensions: []", "plan:", "  enabled: true",
    "  defaultOnStartup: false", "defaultThinkingLevel: low", "modelRoles:",
    "  default: [plan-editor-runtime/controlled]", "  plan: [plan-editor-runtime/controlled:low]", ""].join("\n"));
  await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "plan-editor-runtime": {
    api: "openai-completions", baseUrl: "https://plan-editor-runtime.invalid/v1", auth: "none", models: [{
      id: "controlled", name: "Controlled native Plan editor runtime", reasoning: false, input: ["text"], contextWindow: 128000,
      maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } }));
  const runtime = new WorkerRuntime({ agentDir, workerPath, environment: {
    HOME: root, PATH: process.env.PATH, TMPDIR: temporary, TERM: "dumb", PI_DISABLE_DOTENV: "1", PI_CODING_AGENT_DIR: agentDir,
    VISUAL: actualEditor ? "'" + path.join(root, "controlled-editor.sh").replaceAll("'", "'\"'\"'") + "'" : configured ? "fixture-editor --wait" : undefined, EDITOR: configured ? "fixture-fallback-editor" : undefined, TODO_EDITOR_ENV_MARKER: "private-ipc-only",
    TODO_EDITOR_REPLY_SCENARIO: scenario,
  }, startupTimeoutMs: 30_000, shutdownTimeoutMs: 10_000 });
  return { root, agentDir, cwd, runtime };
}

async function request(session: WorkerSession): Promise<TodoExternalEditorRequest> {
  return { requestId: randomUUID(), controlEpoch: randomUUID(), sessionId: session.id, ticket: (await session.getTodos()).ticket };
}

test("actual worker selects the original Todo editor owner and keeps command/environment private to IPC", async () => {
  const { root, cwd, runtime } = await fixture();
  let session: WorkerSession | undefined;
  try {
    session = await runtime.create({ cwd, model: { provider: "plan-editor-runtime", id: "controlled" } });
    expect(await session.getTodoExternalEditorAvailable()).toBe(true);
    const input = await request(session);
    const prepared = await session.prepareTodoExternalEditor(input);
    expect(prepared).toMatchObject({ request: input, nativeSessionId: session.id, sessionFile: session.sessionFile, cwd: await realpath(cwd),
      content: "# Todos\n- [ ] (replace this with your tasks)\n", extension: ".todo.md",
      trimTrailingNewline: true, editorCommand: "fixture-editor --wait" });
    expect(prepared.environment).toMatchObject({ HOME: root, TMPDIR: path.join(root, "tmp"),
      TODO_EDITOR_ENV_MARKER: "private-ipc-only" });
    expect(JSON.stringify(await session.getTodos())).not.toContain("fixture-editor --wait");
    expect(JSON.stringify(await session.getTodos())).not.toContain("private-ipc-only");

    const retired = session;
    const retiredId = retired.id;
    await retired.dispose(); session = undefined;
    const retiredAt = performance.now();
    await expect(retired.prepareTodoExternalEditor(input)).rejects.toThrow(/stopp|disposed|closed|worker/i);
    await expect(retired.getTodoExternalEditorAvailable()).rejects.toThrow(/stopp|disposed|closed|worker/i);
    expect(performance.now() - retiredAt).toBeLessThan(500);
    session = await runtime.create({ cwd, model: { provider: "plan-editor-runtime", id: "controlled" } });
    expect(session.id).not.toBe(retiredId);
    await expect(session.prepareTodoExternalEditor(input)).rejects.toThrow(/target changed|owner|session/i);
  } finally {
    await session?.dispose().catch(() => {}); await runtime.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 90_000);

test.each([
  ["wrong-cwd", /worker changed during preparation/i],
  ["oversized-environment", /environment exceeds its bound/i],
  ["invalid-availability", /capability could not be confirmed/i],
] as const)("actual worker rejects %s external-editor replies", async (scenario, expected) => {
  const { root, cwd, runtime } = await fixture(scenario);
  let session: WorkerSession | undefined;
  try {
    session = await runtime.create({ cwd, model: { provider: "plan-editor-runtime", id: "controlled" } });
    if (scenario === "invalid-availability") {
      await expect(session.getTodoExternalEditorAvailable()).rejects.toThrow(expected);
      return;
    }
    await expect(session.prepareTodoExternalEditor(await request(session))).rejects.toThrow(expected);
  } finally {
    await session?.dispose().catch(() => {}); await runtime.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 90_000);

 test("actual original worker without VISUAL or EDITOR reports unavailable and refuses preparation", async () => {
  const f = await fixture("normal", false); let session: WorkerSession | undefined;
  try {
    session = await f.runtime.create({ cwd: f.cwd, model: { provider: "plan-editor-runtime", id: "controlled" } });
    expect(await session.getTodoExternalEditorAvailable()).toBe(false);
    await expect(session.prepareTodoExternalEditor(await request(session))).rejects.toThrow("No editor configured");
  } finally { await session?.dispose().catch(() => {}); await f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); }
 }, 90_000);

// Real private tmux + fixed helper + production worker/native Todo commit. No GUI or provider request.
const bundle = process.env.AGENT_TEST_TMUX_BUNDLE;
test.skipIf(!bundle)("configured editor runs in original private terminal, saves native Todos, retains conflicts and joins cancellation", async () => {
  const { Database } = await import("bun:sqlite");
  const { readFile, chmod, access } = await import("node:fs/promises");
  const { TodoExternalEditors } = await import("../todo-external-editors");
  const { TodoExternalEditorRecords } = await import("../todo-external-editor-records");
  const { PlanEditorTerminals } = await import("../plan-editor-terminal");
  const { TmuxTerminalManager } = await import("../terminals/native-manager");
  const { verifyTmuxBundle } = await import("../terminals/bundle");
  verifyTmuxBundle(bundle!);
  const f = await fixture("normal", true, true), db = new Database(":memory:");
  let session: WorkerSession | undefined, terminals: Awaited<ReturnType<typeof TmuxTerminalManager.open>> | undefined,
    service: InstanceType<typeof TodoExternalEditors> | undefined;
  const exists = async (file: string) => access(file).then(() => true, () => false);
  const until = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 20_000;
    while (!await predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for original editor lifecycle"); await Bun.sleep(25); }
  };
  try {
    session = await f.runtime.create({ cwd: f.cwd, model: { provider: "plan-editor-runtime", id: "controlled" } });
    const editor = path.join(f.root, "controlled-editor.sh"), marker = path.join(f.root, "editor-started"), release = path.join(f.root, "editor-release");
    await writeFile(editor, '#!/bin/sh\ncase "$1" in *.todo.md) ;; *) exit 9;; esac\npwd > "$HOME/editor-started"\nwhile [ ! -f "$HOME/editor-release" ]; do sleep 0.05; done\nprintf "# External\\n- [x] From native editor\\n" > "$1"\n'); await chmod(editor, 0o700);
    const hostId = randomUUID();
    const data = path.join(f.root, "editor-data"); await mkdir(data);
    terminals = await TmuxTerminalManager.open({ dataDirectory: data, hostId, bundleDirectory: bundle!, pollIntervalMs: 100 });
    db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,data TEXT NOT NULL)");
    const records = new TodoExternalEditorRecords(db, hostId, () => {}), epoch = randomUUID();
    const handle = session; let sourceExists = true;
    service = new TodoExternalEditors({ hostId, controlEpoch: epoch, records,
      terminals: new PlanEditorTerminals(data, terminals, "todo"),
      capture: async () => sourceExists ? { handle, assertCurrent() { if (!sourceExists) throw new Error("Original source retired"); } } : undefined });
    const input = { ...await request(session), controlEpoch: epoch };
    service.start(input); service.start(structuredClone(input));
    await until(() => exists(marker));
    expect((await readFile(marker, "utf8")).trim()).toBe(await realpath(f.cwd));
    const terminalId = service.observe(input).terminalId!;
    expect(terminals.get(terminalId).target).toEqual({ sessionId: session.id });
    await writeFile(release, "release");
    await until(async () => service!.observe(input).state === "settled");
    expect(service.observe(input).result?.outcome).toBe("applied");
    expect((await session.getTodos()).phases).toEqual([{ name: "External", tasks: [{ content: "From native editor", status: "completed" }] }]);
    const journal = await readFile(session.sessionFile, "utf8");
    expect(journal).toContain('"customType":"user_todo_edit"'); expect(journal).toContain('"attribution":"user"');
    expect(JSON.stringify(service.observe(input))).not.toContain("private-ipc-only");
    expect(JSON.stringify(service.observe(input))).not.toContain(editor);
    await rm(marker); await rm(release);
    const conflict = { ...await request(session), controlEpoch: epoch };
    service.start(conflict); await until(() => exists(marker));
    await session.mutateTodos("concurrent-native-edit", { sessionId: session.id, ticket: conflict.ticket,
      mutation: { action: "edit", markdown: "# Concurrent\n- [ ] Newer truth\n" } });
    await writeFile(release, "release"); await until(async () => service!.observe(conflict).state === "settled");
    expect(service.observe(conflict).result?.outcome).toBe("unknown");
    expect((await session.getTodos()).phases[0]?.name).toBe("Concurrent");
    sourceExists = false;
    expect(service.recovery(conflict)).toEqual({ content: "# External\n- [x] From native editor", source: "completed-output" });
    expect(service.list(session.id).items.some(item => item.request.requestId === conflict.requestId)).toBe(true);
    sourceExists = true;
    await rm(marker); await rm(release);
    const cancelled = { ...await request(session), controlEpoch: epoch };
    service.start(cancelled); await until(() => exists(marker));
    const cancelTerminal = service.observe(cancelled).terminalId!;
    expect((await service.cancel(cancelled)).result?.outcome).toBe("cancelled");
    expect(terminals.get(cancelTerminal).status).toBe("exited");
    expect((await session.getTodos()).ticket).toEqual(cancelled.ticket);
    await rm(marker);
    const initialMarkdown = (await session.getTodos()).markdown;
    const lost = { ...await request(session), controlEpoch: epoch };
    service.start(lost); await until(() => exists(marker));
    process.kill(session.workerPid, "SIGKILL");
    await until(async () => service!.observe(lost).state === "settled");
    expect(service.observe(lost).result?.outcome).toBe("unknown");
    expect(service.recovery(lost)).toEqual({ content: initialMarkdown, source: "original-input" });
    sourceExists = false;
    const reopened = new TodoExternalEditors({ hostId, controlEpoch: randomUUID(), records,
      terminals: new PlanEditorTerminals(data, terminals, "todo"), capture: async () => undefined });
    expect(reopened.start(lost).result?.outcome).toBe("unknown");
    expect(reopened.recovery(lost)).toEqual({ content: initialMarkdown, source: "original-input" });
    await reopened.dispose();
  } finally {
    await service?.dispose().catch(() => {}); await terminals?.shutdown().catch(() => {}); db.close();
    await session?.dispose().catch(() => {}); await f.runtime.dispose(); await rm(f.root, { recursive: true, force: true });
  }
}, 90_000);
