import { expect, test } from "bun:test";
import type { CommandEnvelope, CommandResult, DesktopEvent } from "../../../../packages/shared/src/protocol";
import type { SessionTodos, SessionTodosResponse, TodoJournalReceipt, TodoMutationRequest } from "../../../../packages/shared/src/session-todos";
import { SessionTodosState, TodosNotSubmitted, todosEventMatches, type SessionTodosPorts } from "./use-session-todos";

const owner = { hostId: "controlled-host", sessionId: "original-session" };
const hash = "a".repeat(64);
function todos(revision = hash, content = "Install deps"): SessionTodos {
  return { ticket: { epoch: "worker", nativeSessionId: owner.sessionId, revision }, markdown: `## Setup\n- [ ] ${content}\n`,
    phases: [{ name: "Setup", tasks: [{ content, status: "pending" }] }], nativeCommandAvailable: true, reconciliationRequired: false };
}
function request(value = todos(), text = "/todo start Install deps"): TodoMutationRequest {
  return { sessionId: owner.sessionId, ticket: value.ticket, mutation: { action: "command", text } };
}
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(cause: unknown): void }
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
interface HeldCommand { envelope: CommandEnvelope; hostId?: string; result: Deferred<CommandResult> }
interface Fixture {
  state: SessionTodosState; ports: SessionTodosPorts; reads: Array<Deferred<SessionTodosResponse> & { commandId?: string }>;
  commands: HeldCommand[]; storage: Map<string, string>;
  answer(index: number, value?: SessionTodos | null, receipt?: Omit<TodoJournalReceipt, "commandId">): void;
}
function fixture(storage = new Map<string, string>()): Fixture {
  const reads: Fixture["reads"] = [];
  const commands: HeldCommand[] = [];
  const ports: SessionTodosPorts = { bridge: {
    getSessionTodos: async (sessionId, hostId, commandId) => { expect({ sessionId, hostId }).toEqual(owner); const held = Object.assign(deferred<SessionTodosResponse>(), { commandId }); reads.push(held); return held.promise; },
    command: async (envelope, hostId) => { const result = deferred<CommandResult>(); commands.push({ envelope, hostId, result }); return result.promise; },
    subscribe: () => () => {},
  }, storage: { read: key => storage.get(key) ?? null, write: (key, value) => { storage.set(key, value); }, remove: key => { storage.delete(key); } } };
  const state = new SessionTodosState(owner); state.configure(ports, true);
  const answer = (index: number, value: SessionTodos | null = todos(), receipt?: Omit<TodoJournalReceipt, "commandId">) => {
    const commandId = reads[index]!.commandId;
    reads[index]!.resolve({ ...owner, todos: value, ...(commandId ? { receipt: { commandId, state: "pending", ...receipt } } : {}) });
  };
  return { state, ports, reads, commands, storage, answer };
}
async function ready(f: Fixture, index = 0) { const read = f.state.refresh(); f.answer(index); await read; }
const succeed = (c: HeldCommand, state: SessionTodos, output = "Started: Install deps", desktopAction?: "copy") =>
  c.result.resolve({ ok: true, commandId: c.envelope.id, value: { type: "session.todos.mutate", result: { commandId: c.envelope.id, state, output, ...(desktopAction ? { desktopAction } : {}) } } } as CommandResult);

test("a v22 command carries the exact loaded ticket, and an older held read cannot overwrite its result", async () => {
  const f = fixture(); await ready(f);
  const held = f.state.refresh();
  await expect(f.state.mutate(owner, request())).rejects.toThrow("Refresh");
  f.answer(1); await held;
  const operation = f.state.mutate(owner, request());
  const c = f.commands[0]!;
  expect(c.envelope.commandVersion).toBe(22); expect(c.hostId).toBe(owner.hostId);
  expect(c.envelope.command).toEqual({ type: "session.todos.mutate", ...request() });
  expect(JSON.parse(f.storage.get(`agent-desktop:todos-command:v1:${JSON.stringify(owner)}`)!).id).toBe(c.envelope.id);
  const late = f.state.refresh();
  const next = todos("b".repeat(64));
  succeed(c, next);
  expect(await operation).toMatchObject({ output: "Started: Install deps" });
  expect(f.state.getSnapshot()).toMatchObject({ value: next, fresh: true, uncertain: false, output: "Started: Install deps", original: undefined });
  expect(f.storage.size).toBe(0);
  f.answer(2, todos()); await late;
  expect(f.state.getSnapshot().value).toEqual(next);
  const inspected = f.state.refresh(); expect(f.reads[3]!.commandId).toBeUndefined(); f.answer(3, next); await inspected;
});

test("stale or foreign tickets are refused locally, and a desktop-performed action carries no output text", async () => {
  const f = fixture(); await ready(f);
  await expect(f.state.mutate(owner, request(todos("b".repeat(64))))).rejects.toBeInstanceOf(TodosNotSubmitted);
  await expect(f.state.mutate({ ...owner, sessionId: "other" }, request())).rejects.toBeInstanceOf(TodosNotSubmitted);
  await expect(f.state.mutate(owner, { ...request(), mutation: { action: "command", text: "/plan" } })).rejects.toBeInstanceOf(TodosNotSubmitted);
  expect(f.commands).toHaveLength(0);
  const operation = f.state.mutate(owner, request(todos(), "/todo copy"));
  succeed(f.commands[0]!, todos(), "## Setup\n", "copy");
  expect((await operation).desktopAction).toBe("copy");
  expect(f.state.getSnapshot().output).toBeUndefined();
});

test("a host refusal is a proven no-effect outcome that refreshes without replaying, even at the same revision", async () => {
  const f = fixture(); await ready(f);
  const operation = f.state.mutate(owner, request());
  const c = f.commands[0]!;
  c.result.resolve({ ok: false, commandId: c.envelope.id, error: { code: "TODOS_REJECTED", message: "The native session is busy." } });
  await expect(operation).rejects.toBeInstanceOf(TodosNotSubmitted);
  expect(f.state.getSnapshot()).toMatchObject({ uncertain: false, error: "The native session is busy.", original: undefined });
  expect(f.reads).toHaveLength(2); expect(f.reads[1]!.commandId).toBeUndefined();
  f.answer(1, todos()); await Promise.resolve(); await Promise.resolve();
  expect(f.state.getSnapshot()).toMatchObject({ fresh: true, error: "The native session is busy.", value: todos() });
  expect(f.commands).toHaveLength(1);
  const retry = f.state.mutate(owner, request());
  expect(f.commands).toHaveLength(2); expect(f.commands[1]!.envelope.id).not.toBe(c.envelope.id);
  succeed(f.commands[1]!, todos("c".repeat(64))); await retry;
});

test("a lost response is retained for inspection only: no refresh replays it, and only the journal releases it", async () => {
  const f = fixture(); await ready(f);
  const operation = f.state.mutate(owner, request());
  const c = f.commands[0]!;
  c.result.reject(new Error("controlled connection loss"));
  await expect(operation).rejects.toThrow("connection loss");
  expect(f.state.getSnapshot()).toMatchObject({ uncertain: true, fresh: false, original: { commandId: c.envelope.id, request: request() } });
  await expect(f.state.mutate(owner, request())).rejects.toThrow("Refresh the current Todos");
  for (const [status, guidance] of [["pending", "still pending"], ["unknown", "outcome is unknown"], ["absent", "no record"]] as const) {
    const read = f.state.refresh(); expect(f.reads.at(-1)!.commandId).toBe(c.envelope.id);
    f.answer(f.reads.length - 1, todos(), { state: status }); await read;
    expect(f.state.getSnapshot()).toMatchObject({ uncertain: true, fresh: true, receipt: { commandId: c.envelope.id, state: status } });
    expect(f.state.getSnapshot().error).toContain(guidance);
    await expect(f.state.mutate(owner, request())).rejects.toBeInstanceOf(TodosNotSubmitted);
  }
  expect(f.commands).toHaveLength(1); expect(f.storage.size).toBe(1);
  const confirmed = f.state.refresh();
  const next = todos("b".repeat(64));
  f.answer(f.reads.length - 1, next, { state: "succeeded", result: { commandId: c.envelope.id, state: next, output: "Started: Install deps" } }); await confirmed;
  expect(f.state.getSnapshot()).toMatchObject({ uncertain: false, original: undefined, output: "Started: Install deps", value: next, error: undefined });
  expect(f.storage.size).toBe(0);
  const second = f.state.mutate(owner, request(next));
  succeed(f.commands[1]!, next); await second;
  const plain = f.state.refresh(); expect(f.reads.at(-1)!.commandId).toBeUndefined(); f.answer(f.reads.length - 1, next); await plain;
});

test("a journal refusal is reported distinctly from an unknown outcome and never replayed", async () => {
  const f = fixture(); await ready(f);
  const operation = f.state.mutate(owner, request());
  const c = f.commands[0]!;
  c.result.resolve({ ok: false, commandId: c.envelope.id, error: { code: "OUTCOME_UNKNOWN", message: "The worker was replaced during the command." } });
  await expect(operation).rejects.toThrow("worker was replaced");
  expect(f.state.getSnapshot().uncertain).toBe(true);
  const read = f.state.refresh();
  f.answer(1, todos(), { state: "failed", error: "Revision mismatch." }); await read;
  expect(f.state.getSnapshot()).toMatchObject({ uncertain: false, original: undefined, fresh: true, receipt: { state: "failed" } });
  expect(f.state.getSnapshot().error).toBe("The owning host refused the original Todos command before any change: Revision mismatch.");
  expect(f.commands).toHaveLength(1); expect(f.storage.size).toBe(0);
});

test("a retained command survives remount and navigation, while a corrupt record is discarded without locking the owner", async () => {
  const storage = new Map<string, string>();
  const f = fixture(storage); await ready(f);
  const operation = f.state.mutate(owner, request());
  f.commands[0]!.result.reject(new Error("lost")); await expect(operation).rejects.toThrow("lost");
  const remounted = fixture(storage);
  expect(remounted.state.getSnapshot()).toMatchObject({ uncertain: true, original: { commandId: f.commands[0]!.envelope.id, request: request() } });
  const read = remounted.state.refresh(); expect(remounted.reads[0]!.commandId).toBe(f.commands[0]!.envelope.id);
  remounted.answer(0, todos(), { state: "unknown" }); await read;
  expect(remounted.commands).toHaveLength(0);
  const foreign = new Map([[`agent-desktop:todos-command:v1:${JSON.stringify(owner)}`, JSON.stringify({ id: "x", commandVersion: 22,
    command: { type: "session.todos.mutate", ...request(), sessionId: "other" } })]]);
  const discarded = fixture(foreign); await ready(discarded);
  expect(discarded.state.getSnapshot().uncertain).toBe(false); expect(discarded.state.getSnapshot().error).toContain("discarded");
  expect(foreign.size).toBe(0);
  const allowed = discarded.state.mutate(owner, request()); succeed(discarded.commands[0]!, todos()); await allowed;
});

test("a replacement worker's direct or journal success cannot release the original uncertain command", async () => {
  const f = fixture(); await ready(f);
  const operation = f.state.mutate(owner, request()), original = f.commands[0]!;
  const foreign = { ...todos(), ticket: { ...todos().ticket, epoch: "replacement" } };
  succeed(original, foreign);
  await expect(operation).rejects.toThrow("another native owner");
  const inspect = f.state.refresh();
  f.answer(1, foreign, { state: "succeeded", result: { commandId: original.envelope.id, state: foreign, output: "" } });
  await inspect;
  expect(f.state.getSnapshot()).toMatchObject({ uncertain: true, original: { commandId: original.envelope.id } });
  expect(f.commands).toHaveLength(1); expect(f.storage.size).toBe(1);
});

test("disconnect discards a late read and refuses changes until the owner reconnects", async () => {
  const f = fixture(); const held = f.state.refresh(); f.state.disconnect();
  f.answer(0); await held;
  expect(f.state.getSnapshot()).toMatchObject({ value: null, fresh: false, loading: false });
  await expect(f.state.mutate(owner, request())).rejects.toBeInstanceOf(TodosNotSubmitted);
  f.state.configure(f.ports, true); await ready(f, 1);
  expect(f.state.getSnapshot()).toMatchObject({ value: todos(), fresh: true });
});

test("only owner-bound todo, tool-completion and turn events trigger a live refresh", () => {
  const runtime = (event: unknown, sessionId = owner.sessionId): DesktopEvent => ({ sequence: 1, type: "runtime", sessionId, event, hostId: owner.hostId });
  expect(todosEventMatches(runtime({ type: "todos_changed" }), owner)).toBe(true);
  expect(todosEventMatches(runtime({ type: "tool_execution_end", toolName: "todo", toolCallId: "call" }), owner)).toBe(true);
  expect(todosEventMatches(runtime({ type: "tool_execution_end", toolName: "read", toolCallId: "call" }), owner)).toBe(false);
  expect(todosEventMatches(runtime({ type: "agent_end" }), owner)).toBe(true);
  expect(todosEventMatches(runtime({ type: "todos_changed" }, "other"), owner)).toBe(false);
  expect(todosEventMatches({ sequence: 1, type: "state", state: {} as never }, owner, owner.hostId)).toBe(true);
  expect(todosEventMatches({ sequence: 1, type: "state", state: {} as never, hostId: "elsewhere" }, owner, owner.hostId)).toBe(false);
  expect(todosEventMatches({ sequence: 1, type: "settings", sessionId: owner.sessionId, hostId: owner.hostId }, owner)).toBe(true);
});
