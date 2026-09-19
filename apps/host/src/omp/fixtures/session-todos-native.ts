// Controlled public-native Todos owner fixture. No provider request; HOME,
// agent directory, journal and workspace are disposable. Every mutation goes
// through the real native session, SessionManager and journal file.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentSession, ExtensionAPI, SessionManager as NativeSessionManager } from "@oh-my-pi/pi-coding-agent";

let blockedFetches = 0;
globalThis.fetch = Object.assign(async () => {
  blockedFetches++; throw new Error("Network is disabled in the native Todos fixture");
}, { preconnect: () => { throw new Error("Preconnect is disabled in the native Todos fixture"); } }) as typeof fetch;

const directory = process.argv[2]!, scenario = process.argv[3]!;
assert.equal(process.env.HOME, directory);
const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
const config = "extensions: []\ndefaultThinkingLevel: low\n";
const configPath = path.join(agentDir, "config.yml"); await writeFile(configPath, config);
await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "todo-fixture": {
  api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", auth: "none",
  models: [{ id: "base", name: "Local non-executing base", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
// Deferred on purpose: the native package reads HOME/agent configuration at import time,
// so it must load only after the controlled directories above exist.
const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
const { FileSessionStorage } = await import("@oh-my-pi/pi-coding-agent/session/session-storage");
const { USER_TODO_EDIT_CUSTOM_TYPE } = await import("@oh-my-pi/pi-coding-agent/tools/todo");
const { handleTodoAcp } = await import("@oh-my-pi/pi-coding-agent/slash-commands/helpers/todo");
const { NativeSessionTodos, NativeTodosError } = await import("../session-todos");
const { TranscriptMirror } = await import("../transcript");
const { MAX_TODO_BYTES } = await import("@agent-desktop/shared");

/** Controlled storage-drain boundary: the journal writer has already flushed when drain runs. */
class GatedStorage extends FileSessionStorage {
  failDrain?: Error;
  onDrain?: () => void;
  override drain(): Promise<void> {
    this.onDrain?.();
    return this.failDrain ? Promise.reject(this.failDrain) : super.drain();
  }
}

interface Native { session: AgentSession; manager: NativeSessionManager; storage: GatedStorage; close(): Promise<void> }
async function nativeSession(options?: { file?: string; storage?: GatedStorage; extension?: (pi: ExtensionAPI) => void }): Promise<Native> {
  const auth = await discoverAuthStorage(agentDir), settings = await Settings.loadReadOnly({ agentDir, cwd });
  const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
  const storage = options?.storage ?? new GatedStorage();
  const manager = options?.file ? await SessionManager.open(options.file, undefined, storage) : SessionManager.create(cwd, path.join(agentDir, "sessions"), storage);
  const result = await createAgentSession({ agentDir, cwd, settings, authStorage: auth, modelRegistry: registry,
    agentRegistry: new AgentRegistry(), sessionManager: manager, model: options?.file ? undefined : registry.find("todo-fixture", "base"),
    extensions: options?.extension ? [options.extension] : [], hasUI: false, interactivePrompts: false, deferUsageReserveConfirmation: true });
  return { session: result.session, manager, storage, close: async () => { try { await result.session.dispose(); } finally { auth.close(); } } };
}

function owner(native: Native) {
  const state = { busyReason: undefined as string | undefined, retired: false, changes: 0 };
  const todos = new NativeSessionTodos(native.session, native.manager, {
    assertOwner() { if (state.retired) throw new Error("The original native session owner has retired."); },
    getBusyReason: () => state.busyReason, onChanged: () => { state.changes++; },
  });
  return { todos, state };
}
const command = (todos: InstanceType<typeof NativeSessionTodos>, text: string, ticket = todos.read().ticket) =>
  todos.mutate(`cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`, { sessionId: ticket.nativeSessionId, ticket, mutation: { action: "command", text } });
const rejects = async (work: Promise<unknown>, code: "TODOS_REJECTED" | "OUTCOME_UNKNOWN", pattern: RegExp) => {
  await assert.rejects(work, (error: unknown) => error instanceof NativeTodosError && error.code === code && pattern.test(error.message)
    || (() => { throw error; })());
};
const branchOf = (native: Native) => native.manager.getBranch();
const todoEntries = (native: Native) => branchOf(native).filter(entry => entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE);
const reminders = (native: Native) => branchOf(native).flatMap(entry => {
  const message = entry.type === "message" ? entry.message as { role?: string; attribution?: string; content?: { text?: string }[] } : undefined;
  return message?.role === "developer" ? [{ id: entry.id, attribution: message.attribution, text: message.content?.[0]?.text ?? "" }] : [];
});
/** Persist an agent-created todo update exactly as a native turn does: the real tool executes, its result becomes a branch entry. */
async function agentTodoUpdate(native: Native, todos: InstanceType<typeof NativeSessionTodos>, callId: string, args: Record<string, unknown>) {
  const tool = native.session.getToolByName("todo"); assert.ok(tool, "native todo tool must be registered");
  const outcome = await tool.execute(callId, args);
  assert.notEqual(outcome.isError, true, `native todo tool refused: ${JSON.stringify(outcome.content)}`);
  const message = { role: "toolResult" as const, toolCallId: callId, toolName: "todo", content: outcome.content, details: outcome.details, isError: false, timestamp: Date.now() };
  const entryId = native.manager.appendMessage(message as never);
  await native.manager.flush();
  todos.observeEvent({ type: "message_end", message } as never);
  return entryId;
}

const result: Record<string, unknown> = {};
const native = await nativeSession();
await native.manager.ensureOnDisk();
const sessionFile = native.manager.getSessionFile()!;
try {
  if (scenario === "external-editor") {
    const { todos } = owner(native);
    const { TodoCommandController } = await import("@oh-my-pi/pi-coding-agent/modes/controllers/todo-command-controller");
    const { openInEditor } = await import("@oh-my-pi/pi-coding-agent/utils/external-editor");
    const { chmod } = await import("node:fs/promises");
    const editor = path.join(directory, "controlled-editor.sh");
    const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    process.env.VISUAL = quote(editor);
    const statuses: string[] = [], warnings: string[] = [], errors: string[] = [];
    let stops = 0, starts = 0, projections = 0;
    const controller = new TodoCommandController({ session: native.session, sessionManager: native.manager,
      showStatus: (value: string) => statuses.push(value), showWarning: (value: string) => warnings.push(value),
      showError: (value: string) => errors.push(value), setTodos: () => { projections++; },
      ui: { stop: () => { stops++; }, start: () => { starts++; }, requestRender: () => {} },
    } as unknown as ConstructorParameters<typeof TodoCommandController>[0]);
    const setScript = async (body: string) => { await writeFile(editor, `#!/bin/sh\ncase "$1" in *.todo.md) ;; *) exit 9;; esac\n${body}\n`); await chmod(editor, 0o700); };
    const empty = todos.prepareExternalEditor(todos.read().ticket);
    assert.deepEqual(empty, { content: "# Todos\n- [ ] (replace this with your tasks)\n", extension: ".todo.md", trimTrailingNewline: true });
    await setScript("exit 0");
    await controller.handleTodoCommand("edit");
    assert.equal(todoEntries(native).length, 1); assert.equal(projections, 1);
    assert.equal(todos.read().phases[0].tasks[0].content, "(replace this with your tasks)");
    const initial = todos.read(), prepared = todos.prepareExternalEditor(initial.ticket);
    const unchanged = await openInEditor(process.env.VISUAL!, prepared.content, prepared);
    assert.equal(unchanged, prepared.content.replace(/\n$/, ""));
    await todos.mutate("external-unchanged", { sessionId: initial.ticket.nativeSessionId, ticket: initial.ticket,
      mutation: { action: "edit", markdown: unchanged! } });
    assert.equal(todoEntries(native).length, 2, "native unchanged successful saves still commit");
    const beforeCancelled = todos.read().ticket;
    await setScript("exit 3"); await controller.handleTodoCommand("edit");
    assert.equal(todoEntries(native).length, 2); assert.equal(warnings.length, 1);
    assert.deepEqual(todos.read().ticket, beforeCancelled);
    await setScript("printf '# New phase\\n- [x] Saved externally\\n' > \"$1\"");
    const original = todos.read();
    const output = await openInEditor(process.env.VISUAL!, todos.prepareExternalEditor(original.ticket).content, { extension: ".todo.md" });
    await todos.mutate("external-edit", { sessionId: original.ticket.nativeSessionId, ticket: original.ticket,
      mutation: { action: "edit", markdown: output! } });
    assert.deepEqual(todos.read().phases, [{ name: "New phase", tasks: [{ content: "Saved externally", status: "completed" }] }]);
    assert.equal(todoEntries(native).length, 3); assert.equal(reminders(native).length, 3);
    assert.ok(reminders(native).every(item => item.attribution === "user"));
    await rejects(todos.mutate("external-stale", { sessionId: original.ticket.nativeSessionId, ticket: original.ticket,
      mutation: { action: "edit", markdown: output! } }), "TODOS_REJECTED", /changed/);
    assert.equal(stops, starts); assert.equal(errors.length, 0);
    result.externalEditor = { nativeControllerCommits: 1, sharedCommits: 2, cancelled: 1, sameReminder: true, staleRefused: true };
  } else if (scenario === "lifecycle") {
    const { todos, state } = owner(native);
    const entriesBefore = branchOf(native).length;
    const empty = todos.read();
    assert.deepEqual(empty.phases, []); assert.equal(empty.markdown, "# Todos\n");
    assert.equal(empty.nativeCommandAvailable, true); assert.equal(empty.reconciliationRequired, false); assert.equal(empty.busyReason, undefined);
    assert.equal(todos.read().ticket.revision, empty.ticket.revision, "reads are deterministic");
    assert.equal(branchOf(native).length, entriesBefore, "reading must not append history");
    const shown = await command(todos, "/todo");
    assert.equal(shown.desktopAction, "show"); assert.equal(shown.output, "No todos. Use /todo append <task> to start one.");
    assert.equal(branchOf(native).length, entriesBefore, "showing must not append history");

    // User commands: native grammar, custom entry, user-attributed developer reminder.
    const appended = await command(todos, '/todo append Auth "wire OAuth providers"');
    assert.equal(appended.output, "Appended to Auth: Wire OAuth providers");
    assert.deepEqual(appended.state.phases, [{ name: "Auth", tasks: [{ content: "Wire OAuth providers", status: "pending" }] }]);
    assert.notEqual(appended.state.ticket.revision, empty.ticket.revision);
    assert.equal(todoEntries(native).length, 1);
    assert.deepEqual((todoEntries(native)[0] as { data: unknown }).data, { phases: appended.state.phases });
    const [reminder] = reminders(native);
    assert.equal(reminder.attribution, "user");
    assert.equal(reminder.text, ["<system-reminder>", "The user manually modified the todo list (/todo append → Auth).", "Current todo list:", "",
      "# Auth", "- [ ] Wire OAuth providers", "</system-reminder>"].join("\n"));
    assert.deepEqual(native.session.getTodoPhases(), appended.state.phases, "live native state follows the commit");
    assert.equal(native.session.agent.state.messages.at(-1)?.role, "developer", "the live agent context received the reminder");
    assert.equal(state.changes, 1);
    const persisted = await readFile(sessionFile, "utf8");
    assert.ok(persisted.includes(`"customType":"${USER_TODO_EDIT_CUSTOM_TYPE}"`), "the user edit is on disk before any turn");
    const transcript = new TranscriptMirror().snapshot(
      native.session.buildTranscriptSessionContext({ collapseCompactedHistory: false, keepDanglingToolCalls: true }).messages,
      branchOf(native).flatMap(entry => entry.type === "message" ? [{ id: entry.id, message: entry.message as unknown }] : []));
    const projected = transcript.find(message => message.nativeId === reminder.id);
    assert.ok(projected, "the persisted reminder must project into the transcript");
    assert.equal(projected.role, "developer"); assert.equal(projected.lifecycle, "complete"); assert.equal(projected.text, reminder.text);

    await command(todos, "/todo append Auth Port credential store");
    const started = await command(todos, "/todo start credential");
    assert.deepEqual(started.state.phases[0].tasks.map(task => task.status), ["pending", "in_progress"]);
    const done = await command(todos, "/todo done credential");
    assert.deepEqual(done.state.phases[0].tasks.map(task => task.status), ["in_progress", "completed"], "native normalization promotes the first pending task");
    assert.match(reminders(native).at(-1)!.text, /\(\/todo done Port credential store\)/);

    // Structured desktop actions carry the exact native Markdown and never claim a TUI ran.
    const copy = await command(todos, "/todo copy");
    assert.equal(copy.desktopAction, "copy"); assert.equal(copy.output, "# Auth\n- [/] Wire OAuth providers\n- [x] Port credential store\n");
    assert.equal(copy.output, copy.state.markdown);
    for (const verb of ["edit", "expand", "collapse"] as const) {
      const action = await command(todos, `/todo ${verb}`); assert.equal(action.desktopAction, verb); assert.equal(action.output, copy.state.markdown);
    }
    const listed = await command(todos, "/todo");
    assert.equal(listed.desktopAction, "show"); assert.equal(listed.output, copy.state.markdown.trimEnd());
    assert.equal(todoEntries(native).length, 4, "read-only verbs never commit");
    const help = await command(todos, "/todo help"); assert.match(help.output, /^Usage: \/todo <verb>/); assert.equal(help.desktopAction, undefined);
    await rejects(command(todos, "/todo bogus"), "TODOS_REJECTED", /Unknown \/todo subcommand "bogus"/);
    await rejects(command(todos, "/todo start nothing-like-this"), "TODOS_REJECTED", /No task matched/);
    assert.equal(todoEntries(native).length, 4, "diagnostics never commit");

    // Structured edit: every native status and the blocker note survive without client normalization.
    const markdown = "# Auth\n- [x] Wire OAuth providers\n- [-] Port credential store\n- [!] Ship keys <!-- blocker: waiting on ops -->\n\n# Verification\n- [/] Run cargo test\n- [ ] Tag release\n";
    const editTicket = todos.read().ticket;
    const edited = await todos.mutate("edit-1", { sessionId: editTicket.nativeSessionId, ticket: editTicket, mutation: { action: "edit", markdown } });
    assert.equal(edited.output, "Todos updated from editor: 2 phase(s), 5 task(s).");
    assert.equal(edited.state.markdown, markdown);
    assert.deepEqual(edited.state.phases[0].tasks[2], { content: "Ship keys", status: "blocked", blocker: "waiting on ops" });
    assert.deepEqual(edited.state.phases.flatMap(phase => phase.tasks.map(task => task.status)), ["completed", "abandoned", "blocked", "in_progress", "pending"]);
    assert.match(reminders(native).at(-1)!.text, /\(\/todo edit\)/);
    await rejects(todos.mutate("edit-2", { sessionId: editTicket.nativeSessionId, ticket: edited.state.ticket, mutation: { action: "edit", markdown: "# X\n- [?] bad\n" } }),
      "TODOS_REJECTED", /unknown status marker/);

    // Agent-created update persisted through the actual native manager result entry.
    const before = todos.read();
    const changesBefore = state.changes;
    await agentTodoUpdate(native, todos, "todo-call-1", { op: "append", phase: "Verification", items: ["Update changelog"] });
    assert.equal(state.changes, changesBefore + 1, "a persisted native todo result notifies the owner");
    const after = todos.read();
    assert.notEqual(after.ticket.revision, before.ticket.revision);
    assert.deepEqual(after.phases[1].tasks.map(task => task.content), ["Run cargo test", "Tag release", "Update changelog"]);
    assert.equal(after.phases[0].tasks[2].blocker, "waiting on ops", "the native tool result keeps the blocker");
    await rejects(command(todos, "/todo done changelog", before.ticket), "TODOS_REJECTED", /todo list changed/);
    assert.equal(todoEntries(native).length, 5, "a stale ticket never commits");

    // Export/import use the native path resolution; output never carries an owner-host absolute path.
    const exported = await command(todos, "/todo export");
    assert.equal(exported.output, "Wrote todos to TODO.md");
    assert.equal(await readFile(path.join(cwd, "TODO.md"), "utf8"), after.markdown);
    const outside = path.join(directory, "outside.md");
    assert.equal((await command(todos, `/todo export ${outside}`)).output, `Wrote todos to ${outside}`, "an argument the user typed is echoed as typed");
    await writeFile(path.join(cwd, "imported.md"), "# Imported\n- [ ] From file\n");
    const imported = await command(todos, "/todo import imported.md");
    assert.equal(imported.output, "Imported 1 phase(s), 1 task(s) from imported.md.");
    assert.deepEqual(imported.state.phases, [{ name: "Imported", tasks: [{ content: "From file", status: "in_progress" }] }]);
    await writeFile(path.join(cwd, "huge.md"), `# Huge\n- [ ] ${"x".repeat(MAX_TODO_BYTES)}\n`);
    await rejects(command(todos, "/todo import huge.md"), "TODOS_REJECTED", /todo import limit/);
    await rejects(command(todos, "/todo import missing.md"), "TODOS_REJECTED", /Failed to read todos/);
    assert.equal(todoEntries(native).length, 6);

    // The native headless dispatcher itself now commits through the same seam: reminder included.
    const acpOutput: string[] = [];
    const acp = await handleTodoAcp({ name: "todo", args: 'append "Via native ACP"', text: '/todo append "Via native ACP"' }, {
      session: native.session, sessionManager: native.manager, settings: native.session.settings, cwd, output: text => { acpOutput.push(text); },
      refreshCommands() {}, reloadPlugins: () => Promise.reject(new Error("unused")) });
    assert.deepEqual(acp, { consumed: true }); assert.deepEqual(acpOutput, ["Appended to Imported: Via native ACP"]);
    assert.equal(reminders(native).at(-1)!.attribution, "user"); assert.match(reminders(native).at(-1)!.text, /\(\/todo append → Imported\)/);
    assert.deepEqual(todos.read().phases[0].tasks.map(task => task.content), ["From file", "Via native ACP"]);

    // Removal reminder and an authoritative empty branch state (no live fallback).
    const cleared = await command(todos, "/todo rm");
    assert.deepEqual(cleared.state.phases, []); assert.equal(cleared.state.markdown, "# Todos\n");
    assert.match(reminders(native).at(-1)!.text, /The user intentionally cleared the todo list/);
    native.session.setTodoPhases([{ name: "Stale", tasks: [{ content: "Only in memory", status: "pending" }] }]);
    assert.deepEqual(todos.read().phases, [], "empty branch state wins over stale live memory");
    await rejects(command(todos, "/todo copy"), "TODOS_REJECTED", /No todos to copy/);
    const reopened = await command(todos, "/todo append Reopen survives restart");
    await todos.settle();
    result.lifecycle = { entries: todoEntries(native).length, reminders: reminders(native).length, changes: state.changes,
      finalRevision: reopened.state.ticket.revision, finalPhases: reopened.state.phases };
    await native.close();

    // Restart: a fresh native session over the same file recovers the branch state.
    const again = await nativeSession({ file: sessionFile });
    try {
      const { todos: reopenedOwner } = owner(again);
      const recovered = reopenedOwner.read();
      assert.deepEqual(recovered.phases, reopened.state.phases);
      assert.equal(recovered.ticket.revision, reopened.state.ticket.revision, "the revision is a branch fact, not an owner fact");
      assert.notEqual(recovered.ticket.epoch, reopened.state.ticket.epoch);
      assert.deepEqual(again.session.getTodoPhases(), reopened.state.phases, "native restore rehydrates from the branch");
      await rejects(command(reopenedOwner, "/todo done restart", reopened.state.ticket), "TODOS_REJECTED", /another native owner/);
      result.reopen = { phases: recovered.phases, sameRevision: recovered.ticket.revision === reopened.state.ticket.revision };
    } finally { await again.close(); }
  } else if (scenario === "guards") {
    const { todos, state } = owner(native);
    await command(todos, "/todo append \"Guard one\"");
    const baseline = todos.read();

    // Busy runtime work refuses before any side effect; the owner reserves busy synchronously.
    state.busyReason = "Resolve current native work first.";
    await rejects(command(todos, "/todo append \"Guard two\""), "TODOS_REJECTED", /Resolve current native work first/);
    assert.equal(todos.read().busyReason, state.busyReason);
    state.busyReason = undefined;
    const first = command(todos, "/todo append \"Guard two\"");
    assert.equal(todos.busy, true, "busy is reserved synchronously");
    await rejects(command(todos, "/todo append \"Guard three\""), "TODOS_REJECTED", /still settling/);
    const firstResult = await first; assert.equal(todos.busy, false);
    assert.deepEqual(firstResult.state.phases[0].tasks.map(task => task.content), ["Guard one", "Guard two"]);
    assert.equal(firstResult.state.busyReason, undefined, "a completed mutation must not strand clients in the owner's transient busy state");
    const sameTodos = todos.read();
    native.manager.appendCustomEntry("controlled-branch-change", {});
    await rejects(command(todos, "/todo rm", sameTodos.ticket), "TODOS_REJECTED", /todo list changed/);

    // Malformed and oversized requests are refused before touching native state.
    const ticket = todos.read().ticket;
    await rejects(todos.mutate("bad id!", { sessionId: ticket.nativeSessionId, ticket, mutation: { action: "command", text: "/todo" } }), "TODOS_REJECTED", /command identity/);
    await rejects(todos.mutate("m-1", { sessionId: ticket.nativeSessionId, ticket, mutation: { action: "command", text: "/plan" } }), "TODOS_REJECTED", /Invalid native Todos command/);
    await rejects(todos.mutate("m-2", { sessionId: ticket.nativeSessionId, ticket, mutation: { action: "edit", markdown: "x".repeat(MAX_TODO_BYTES + 1) } }), "TODOS_REJECTED", /Markdown size|text/);
    await rejects(todos.mutate("m-3", { sessionId: "other-session", ticket, mutation: { action: "command", text: "/todo" } }), "TODOS_REJECTED", /mutation owner/);
    await rejects(todos.mutate("m-4", { sessionId: ticket.nativeSessionId, ticket: { ...ticket, epoch: "stale-epoch" }, mutation: { action: "command", text: "/todo" } }), "TODOS_REJECTED", /another native owner/);
    await rejects(todos.mutate("m-5", { sessionId: ticket.nativeSessionId, ticket: { ...ticket, revision: baseline.ticket.revision }, mutation: { action: "command", text: "/todo" } }), "TODOS_REJECTED", /todo list changed/);
    assert.equal(todoEntries(native).length, 2);

    // Asynchronous import preparation re-guards owner, busy and revision before committing.
    await writeFile(path.join(cwd, "TODO.md"), "# Imported\n- [ ] Late\n");
    const busyRace = command(todos, "/todo import"); state.busyReason = "A prompt started meanwhile.";
    await rejects(busyRace, "TODOS_REJECTED", /A prompt started meanwhile/); state.busyReason = undefined;
    const revisionRace = command(todos, "/todo import");
    await agentTodoUpdate(native, todos, "todo-race", { op: "append", phase: "Todos", items: ["Agent raced"] });
    await rejects(revisionRace, "TODOS_REJECTED", /todo list changed/);
    const retireRace = command(todos, "/todo import"); state.retired = true;
    await rejects(retireRace, "TODOS_REJECTED", /retired/); state.retired = false;
    assert.equal(todoEntries(native).length, 2, "no raced import committed");
    assert.deepEqual(todos.read().phases[0].tasks.map(task => task.content), ["Guard one", "Guard two", "Agent raced"]);
    const settled = await command(todos, "/todo import");
    assert.deepEqual(settled.state.phases, [{ name: "Imported", tasks: [{ content: "Late", status: "in_progress" }] }]);

    // A malformed or oversized latest native entry rejects reads instead of showing an older state.
    native.manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [{ name: "Broken", tasks: [{ content: "x", status: "not-a-status" }] }] });
    assert.throws(() => todos.read(), (error: unknown) => error instanceof NativeTodosError && error.code === "TODOS_REJECTED" && /not readable.*status/.test(error.message));
    await rejects(command(todos, "/todo", settled.state.ticket), "TODOS_REJECTED", /not readable/);
    native.manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [{ name: "Huge", tasks: [{ content: "y".repeat(MAX_TODO_BYTES + 1), status: "pending" }] }] });
    assert.throws(() => todos.read(), (error: unknown) => error instanceof NativeTodosError && /not readable/.test(error.message));
    native.manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: null });
    assert.throws(() => todos.read(), (error: unknown) => error instanceof NativeTodosError && /not readable/.test(error.message));
    await command(todos, "/todo", settled.state.ticket).catch(() => {});
    assert.equal(todoEntries(native).length, 6, "malformed reads never repair by writing");
    result.guards = { entries: todoEntries(native).length, changes: state.changes };
  } else if (scenario === "shadowed") {
    await native.close();
    const shadowed = await nativeSession({ extension: pi => pi.registerCommand("todo", { description: "extension todo", handler: async () => {} }) });
    try {
      const { todos } = owner(shadowed);
      const snapshot = todos.read();
      assert.equal(snapshot.nativeCommandAvailable, false);
      await rejects(command(todos, "/todo append Shadowed"), "TODOS_REJECTED", /extension or custom command owns \/todo/);
      assert.equal(todoEntries(shadowed).length, 0);
      const edited = await todos.mutate("edit-shadow", { sessionId: snapshot.ticket.nativeSessionId, ticket: snapshot.ticket, mutation: { action: "edit", markdown: "# Todos\n- [ ] Structured edit\n" } });
      assert.equal(edited.state.nativeCommandAvailable, false); assert.equal(todoEntries(shadowed).length, 1);
      result.shadowed = { nativeCommandAvailable: snapshot.nativeCommandAvailable, structuredEditCommitted: todoEntries(shadowed).length === 1 };
      const colon = await command(todos, '/todo:append "Native colon grammar"');
      assert.equal(colon.state.phases[0].tasks.at(-1)?.content, "Native colon grammar",
        "the native literal extension token is todo:append, not todo");
    } finally { await shadowed.close(); }
  } else if (scenario === "flush-failed" || scenario === "retired-after-commit") {
    const { todos, state } = owner(native);
    await command(todos, "/todo append \"Durable before failure\"");
    if (scenario === "flush-failed") native.storage.failDrain = new Error("controlled journal drain failure");
    else native.storage.onDrain = () => { state.retired = true; };
    const changes = state.changes;
    await rejects(command(todos, "/todo append \"Uncertain outcome\""), "OUTCOME_UNKNOWN", scenario === "flush-failed" ? /controlled journal drain failure/ : /retired/);
    native.storage.failDrain = undefined; native.storage.onDrain = undefined; state.retired = false;
    assert.equal(state.changes, changes + 1, "an uncertain commit notifies observers");
    const latched = todos.read();
    assert.equal(latched.reconciliationRequired, true);
    assert.equal(todoEntries(native).length, 2, "the commit landed exactly once");
    await rejects(command(todos, "/todo append \"Never replayed\""), "OUTCOME_UNKNOWN", /reconciliation/);
    assert.equal(todoEntries(native).length, 2, "no replay after an unknown outcome");
    await todos.settle();
    await native.manager.flush();
    await native.close();
    const again = await nativeSession({ file: sessionFile });
    try {
      const recovered = owner(again).todos.read();
      assert.equal(recovered.reconciliationRequired, false, "a replacement owner starts clean");
      assert.deepEqual(recovered.phases[0].tasks.map(task => task.content), ["Durable before failure", "Uncertain outcome"]);
      result.unknown = { scenario, reconciliationRequired: latched.reconciliationRequired, entries: todoEntries(again).length, recovered: recovered.phases[0].tasks.map(task => task.content) };
    } finally { await again.close(); }
  } else throw new Error(`Unknown scenario ${scenario}`);
  assert.equal(blockedFetches, 0);
  assert.equal(await readFile(configPath, "utf8"), config);
  result.blockedFetches = blockedFetches; result.configUnchanged = true;
  console.log(JSON.stringify(result));
} finally { await native.close().catch(() => {}); }
