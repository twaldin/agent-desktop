import { expect, test } from "bun:test";
import type { TodoExternalEditorCapabilities, TodoExternalEditorObservation, TodoExternalEditorRequest } from "../../../../packages/shared/src/todo-external-editor";
import type { SessionTodos } from "../../../../packages/shared/src/session-todos";
import { TodoExternalEditorState, type TodoEditorInput, type TodoEditorPorts } from "./todo-external-editor-state";

const ids = {
  epoch: "10000000-0000-4000-8000-000000000001",
  request: "20000000-0000-4000-8000-000000000002",
  terminal: "30000000-0000-4000-8000-000000000003",
};
const reviewRevision = "a".repeat(64), ticketRevision = "b".repeat(64);
const todos = (): SessionTodos => ({ ticket: { epoch: "worker", nativeSessionId: "session-one", revision: ticketRevision },
  phases: [], markdown: "# Todos\n", nativeCommandAvailable: true, reconciliationRequired: false });
const input = (hostId = "host-one", sessionId = "session-one", connected = true): TodoEditorInput =>
  ({ hostId, sessionId, connected, fresh: true, open: true, todos: { ...todos(), ticket: { ...todos().ticket, nativeSessionId: sessionId } }, dirty: false });
const request = (): TodoExternalEditorRequest => ({ requestId: ids.request, controlEpoch: ids.epoch,
  sessionId: "session-one", ticket: todos().ticket });
const capability = (hostId = "host-one"): TodoExternalEditorCapabilities =>
  ({ protocolVersion: 1, hostId, controlEpoch: ids.epoch, available: true });
const pending = (owner = request(), terminal = ids.terminal): TodoExternalEditorObservation =>
  ({ protocolVersion: 1, hostId: "host-one", request: owner, state: "pending", ...(terminal ? { terminalId: terminal } : {}) });
const applied = (owner = request()): TodoExternalEditorObservation => ({ protocolVersion: 1, hostId: "host-one", request: owner,
  state: "settled", terminalId: ids.terminal, result: { outcome: "applied", receipt: {
    commandId: owner.requestId, state: todos(), output: "Saved",
  } } });
const unknown = (owner = request()): TodoExternalEditorObservation => ({ protocolVersion: 1, hostId: "host-one", request: owner,
  state: "settled", terminalId: ids.terminal, result: { outcome: "unknown", message: "Inspect the original editor." } });
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture(overrides: Partial<TodoEditorPorts["bridge"]> = {}) {
  const values = new Map<string, string>(), starts: TodoExternalEditorRequest[] = [], statuses: TodoExternalEditorRequest[] = [],
    cancels: TodoExternalEditorRequest[] = [], recovers: TodoExternalEditorRequest[] = [], terminals: string[] = [], copies: string[] = [];
  let refreshes = 0;
  const bridge: TodoEditorPorts["bridge"] = {
    getTodoEditorCapabilities: async (_sessionId, hostId) => capability(hostId),
    listTodoEditors: async (sessionId, hostId) => ({ protocolVersion: 1, hostId, sessionId, items: [] }),
    startTodoEditor: async value => { starts.push(value); return pending(value); },
    getTodoEditorStatus: async value => { statuses.push(value); return unknown(value); },
    cancelTodoEditor: async value => { cancels.push(value); return { ...pending(value), state: "settled", result: { outcome: "cancelled" } }; },
    recoverTodoEditor: async value => { recovers.push(value); return { observation: unknown(value), content: "recovered text", source: "completed-output" }; },
    ...overrides,
  };
  const storage: TodoEditorPorts["storage"] = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  const ports: TodoEditorPorts = { bridge, storage, openTerminal: (_host, _session, terminalId) => { terminals.push(terminalId); },
    refreshTodos: async () => { refreshes++; }, copy: async text => { copies.push(text); } };
  return { values, starts, statuses, cancels, recovers, terminals, copies, ports, refreshes: () => refreshes };
}
async function ready(state: TodoExternalEditorState) { await state.refresh(); expect(state.getSnapshot().available).toBe(true); }

test("a failed durable save prevents dispatch and records only a local not-submitted outcome", async () => {
  const f = fixture(); f.ports.storage.setItem = () => { throw new Error("disk refused"); };
  const state = new TodoExternalEditorState(input(), f.ports); await ready(state); await state.start();
  expect(f.starts).toHaveLength(0);
  expect(state.getSnapshot()).toMatchObject({ busy: false, error: "disk refused", jobs: [{ state: "settled", result: { outcome: "not-submitted" } }] });
  expect(f.terminals).toEqual([]); expect(f.refreshes()).toBe(0);
});

test("busy and host-pending ownership block duplicate starts", async () => {
  const held = deferred<TodoExternalEditorObservation>(), f = fixture({ startTodoEditor: async value => { f.starts.push(value); return held.promise; } });
  const state = new TodoExternalEditorState(input(), f.ports); await ready(state);
  const first = state.start();
  expect(state.getSnapshot().busy).toBe(true);
  await state.start(); expect(f.starts).toHaveLength(1);
  held.resolve(pending(f.starts[0]!)); await first;
  expect(state.getSnapshot()).toMatchObject({ available: false, jobs: [{ state: "pending" }] });
  await state.start(); expect(f.starts).toHaveLength(1);
});

test("a lost start stays unknown across refresh and reconstruction without replay", async () => {
  const f = fixture({ startTodoEditor: async value => { f.starts.push(value); throw new Error("reply lost"); } });
  const state = new TodoExternalEditorState(input(), f.ports); await ready(state); await state.start();
  expect(f.starts).toHaveLength(1); expect(state.getSnapshot().jobs[0]?.result?.outcome).toBe("unknown");
  await state.refresh();
  expect(f.starts).toHaveLength(1); expect(f.statuses).toHaveLength(1); expect(state.getSnapshot().jobs[0]?.result?.outcome).toBe("unknown");

  const restored = new TodoExternalEditorState(input(), f.ports);
  expect(restored.getSnapshot().jobs[0]?.result?.outcome).toBe("unknown");
  await restored.refresh();
  expect(f.starts).toHaveLength(1); expect(f.statuses).toHaveLength(2);
});

test("a response owned by the original route cannot open its terminal after navigation", async () => {
  const held = deferred<TodoExternalEditorObservation>(), f = fixture({ startTodoEditor: async value => { f.starts.push(value); return held.promise; } });
  const state = new TodoExternalEditorState(input(), f.ports); await ready(state);
  const operation = state.start();
  const other = fixture(); state.configure(input("host-two", "session-two"), other.ports);
  held.resolve(pending(f.starts[0]!)); await operation;
  expect(f.terminals).toEqual([]); expect(other.terminals).toEqual([]);
  state.configure(input(), f.ports);
  expect(state.getSnapshot().jobs[0]).toMatchObject({ state: "pending", terminalId: ids.terminal });
});

test("host-listed cross-client jobs recover exact content and permit offline clipboard copy", async () => {
  const remote = unknown(), f = fixture({ listTodoEditors: async () => ({ protocolVersion: 1, hostId: "host-one", sessionId: "session-one", items: [remote] }) });
  const state = new TodoExternalEditorState(input(), f.ports); await state.refresh();
  expect(state.getSnapshot().jobs).toEqual([remote]);
  await state.act(ids.request, "recover");
  expect(f.recovers).toEqual([remote.request]);
  expect(state.getSnapshot().recovery).toEqual({ requestId: ids.request, content: "recovered text", source: "completed-output" });
  state.configure(input("host-one", "session-one", false), f.ports);
  await state.act(ids.request, "copy");
  expect(f.copies).toEqual(["recovered text"]);
});

test("offline cancel has no effect and a late applied cancellation cannot refresh another route", async () => {
  const job = pending(), held = deferred<TodoExternalEditorObservation>(), f = fixture({
    listTodoEditors: async () => ({ protocolVersion: 1, hostId: "host-one", sessionId: "session-one", items: [job] }),
    cancelTodoEditor: async value => { f.cancels.push(value); return held.promise; },
  });
  const state = new TodoExternalEditorState(input(), f.ports); await state.refresh();
  state.configure(input("host-one", "session-one", false), f.ports);
  await state.act(ids.request, "cancel"); expect(f.cancels).toEqual([]);
  state.configure(input(), f.ports);
  const cancellation = state.act(ids.request, "cancel");
  expect(f.cancels).toEqual([job.request]);
  const other = fixture(); state.configure(input("host-two", "session-two"), other.ports);
  held.resolve(applied(job.request)); await cancellation;
  expect(f.refreshes()).toBe(0); expect(other.refreshes()).toBe(0);
  state.configure(input(), f.ports);
  expect(state.getSnapshot().jobs[0]?.result?.outcome).toBe("applied");
});

test("a later host-list terminal opens once for the original pending start", async () => {
  const f = fixture({
    startTodoEditor: async value => { f.starts.push(value); return pending(value, ""); },
    listTodoEditors: async () => ({ protocolVersion: 1, hostId: "host-one", sessionId: "session-one",
      items: f.starts.length ? [pending(f.starts[0]!)] : [] }),
  });
  const state = new TodoExternalEditorState(input(), f.ports); await ready(state);
  await state.start();
  expect(state.getSnapshot().jobs[0]?.state).toBe("pending");
  expect(state.getSnapshot().jobs[0]?.terminalId).toBeUndefined();
  expect(f.terminals).toEqual([]);
  await state.refresh(); expect(f.terminals).toEqual([ids.terminal]);
  await state.refresh(); expect(f.terminals).toEqual([ids.terminal]);
});

test("hiding or changing the owner before a held host list prevents automatic terminal opening", async () => {
  for (const change of ["hide", "owner"] as const) {
    const listing = deferred<{ protocolVersion: 1; hostId: string; sessionId: string; items: TodoExternalEditorObservation[] }>();
    let listCount = 0;
    const f = fixture({
      startTodoEditor: async value => { f.starts.push(value); return pending(value, ""); },
      listTodoEditors: async () => ++listCount === 1
        ? { protocolVersion: 1, hostId: "host-one", sessionId: "session-one", items: [] }
        : listing.promise,
    });
    const state = new TodoExternalEditorState(input(), f.ports); await ready(state); await state.start();
    const refresh = state.refresh();
    if (change === "hide") state.configure({ ...input(), open: false }, f.ports);
    else state.configure(input("host-two", "session-two"), fixture().ports);
    listing.resolve({ protocolVersion: 1, hostId: "host-one", sessionId: "session-one", items: [pending(f.starts[0]!)] });
    await refresh;
    expect(f.terminals).toEqual([]);
    state.configure(input(), f.ports); await state.refresh();
    expect(f.terminals).toEqual([]);
  }
});

test("a confirmed applied reply survives failure to remove its local saved request", async () => {
  const f = fixture({ startTodoEditor: async value => { f.starts.push(value); return applied(value); } });
  const state = new TodoExternalEditorState(input(), f.ports); await ready(state);
  const save = f.ports.storage.setItem; let writes = 0;
  f.ports.storage.setItem = (key, value) => { writes++; if (writes === 2) throw new Error("local cleanup refused"); save(key, value); };
  await state.start();
  expect(f.starts).toHaveLength(1);
  expect(state.getSnapshot()).toMatchObject({ error: "local cleanup refused", jobs: [{ state: "settled", result: {
    outcome: "applied", receipt: { commandId: f.starts[0]!.requestId, output: "Saved" },
  } }] });
  expect(f.refreshes()).toBe(0);
});

test("a failed terminal callback reports its own error without demoting the host receipt", async () => {
  const f = fixture({ startTodoEditor: async value => { f.starts.push(value); return applied(value); } });
  f.ports.openTerminal = () => { throw new Error("terminal panel refused"); };
  const state = new TodoExternalEditorState(input(), f.ports); await ready(state); await state.start();
  expect(state.getSnapshot()).toMatchObject({ error: "terminal panel refused", jobs: [{ state: "settled", result: {
    outcome: "applied", receipt: { commandId: f.starts[0]!.requestId, output: "Saved" },
  } }] });
});

 test("unmount hides only the view: late start cannot attach a terminal or cancel the original process", async () => {
  const held = deferred<TodoExternalEditorObservation>();
  const f = fixture({ startTodoEditor: async value => { f.starts.push(value); return held.promise; } });
  const state = new TodoExternalEditorState(input(), f.ports); await ready(state);
  const pendingStart = state.start(); state.hide(); held.resolve(pending(f.starts[0]!)); await pendingStart;
  expect(f.terminals).toEqual([]); expect(f.cancels).toEqual([]);
  state.configure(input(), f.ports); await state.act(f.starts[0]!.requestId, "terminal");
  expect(f.terminals).toEqual([ids.terminal]);
 });
 test("changed native ticket refuses late automatic terminal attachment", async () => {
  for (const field of ["epoch", "nativeSessionId", "revision"] as const) {
    const held = deferred<TodoExternalEditorObservation>();
    const f = fixture({ startTodoEditor: async value => { f.starts.push(value); return held.promise; } });
    const state = new TodoExternalEditorState(input(), f.ports); await ready(state);
    const pendingStart = state.start(), changed = input();
    changed.todos = { ...changed.todos!, ticket: { ...changed.todos!.ticket, [field]: "replacement" } };
    state.configure(changed, f.ports); held.resolve(pending(f.starts[0]!)); await pendingStart;
    expect(f.terminals).toEqual([]); expect(f.cancels).toEqual([]);
  }
 });
