import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { TodoExternalEditorRequest } from "../../../packages/shared/src/todo-external-editor";
import type { PreparedTodoExternalEditor } from "./omp/todo-external-editor";
import type { PlanEditorProcessResult } from "./plan-editor-process";
import { TodoExternalEditorRecords } from "./todo-external-editor-records";
import { TodoExternalEditors, type TodoEditorOwner } from "./todo-external-editors";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const epoch = "a0000000-0000-4000-8000-000000000001";
function request(): TodoExternalEditorRequest { return { requestId: crypto.randomUUID(), controlEpoch: epoch,
  sessionId: "native", ticket: { epoch: "worker", nativeSessionId: "native", revision: "a".repeat(64) } }; }
const completed = (content: string): PlanEditorProcessResult => ({ version: 1, outcome: "completed", content,
  contentSha256: createHash("sha256").update(content).digest("hex") });
function fixture() {
  const input = request(), db = new Database(":memory:"); databases.push(db);
  db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,data TEXT NOT NULL)");
  const records = new TodoExternalEditorRecords(db, "host", () => {});
  const editing = deferred<PlanEditorProcessResult>(), started = deferred<void>(), committing = deferred<void>();
  const calls = { starts: 0, commits: 0, cancels: 0, cleanups: 0, captures: 0 };
  let current = true, failure: (() => void) | undefined;
  let prepareGate: Promise<void> = Promise.resolve(), commitGate: Promise<void> = Promise.resolve();
  let cancelAction = async () => { editing.resolve({ version: 1, outcome: "cancelled" }); };
  const owner: TodoEditorOwner = { assertCurrent: () => { if (!current) throw new Error("Original document changed"); }, handle: {
    getTodoExternalEditorAvailable: async () => true,
    prepareTodoExternalEditor: async raw => {
      await prepareGate;
      return { request: raw, nativeSessionId: "native", sessionFile: "/private/session.jsonl", cwd: "/private/project",
        content: "original", extension: ".todo.md", trimTrailingNewline: true, editorCommand: "private-editor",
        environment: { PRIVATE_VALUE: "never-public" } } satisfies PreparedTodoExternalEditor;
    },
    subscribeWorkerFailure: listener => { failure = () => listener({ type: "worker_failure", pid: 123, message: "worker lost" }); return () => { failure = undefined; }; },
    mutateTodos: async (commandId, value) => {
      calls.commits++; committing.resolve(); await commitGate;
      return { commandId, state: { ticket: { ...value.ticket, revision: "b".repeat(64) }, phases: [], markdown: "",
        nativeCommandAvailable: true, reconciliationRequired: false }, output: "Todos updated from editor." };
    },
  } };
  const terminals = {
    start: async (terminalId: string, _prepared: PreparedTodoExternalEditor, validate: () => void) => {
      validate(); calls.starts++; started.resolve();
      return { terminalId, completion: editing.promise, cancel: async () => { calls.cancels++; await cancelAction(); },
        cleanup: () => { calls.cleanups++; } };
    }, original: () => "original input", recovery: (): PlanEditorProcessResult | undefined => completed("retained conflict text"), cancelOriginal: async () => { calls.cancels++; },
  };
  const options = { hostId: "host", controlEpoch: epoch, records, terminals,
    capture: async () => { calls.captures++; return owner; } };
  const service = new TodoExternalEditors(options);
  return { input, db, records, service, options, calls, editing, started, committing,
    replace: () => { current = false; }, loseWorker: () => failure?.(),
    holdPrepare: (gate: Promise<void>) => { prepareGate = gate; }, holdCommit: (gate: Promise<void>) => { commitGate = gate; },
    cancelWith: (action: () => Promise<void>) => { cancelAction = action; } };
}
async function settled(f: ReturnType<typeof fixture>) {
  // Observe scheduling, not elapsed native time. A missing outcome fails explicitly.
  for (let i = 0; i < 100; i++) {
    const result = f.service.observe(f.input); if (result.state === "settled") return result;
    await Promise.resolve();
  }
  throw new Error("Controlled editor did not settle");
}

test("durable duplicate requests launch once and commit the original edited plan receipt", async () => {
  const f = fixture();
  expect(f.service.start(f.input).state).toBe("pending");
  f.service.start(structuredClone(f.input));
  await f.started.promise;
  expect(() => f.service.start({ ...f.input, ticket: { ...f.input.ticket, revision: "changed" } })).toThrow("different input");
  expect(() => f.service.start({ ...f.input, requestId: crypto.randomUUID() })).toThrow("already owns");
  f.editing.resolve(completed("edited"));
  expect((await settled(f)).result).toMatchObject({ outcome: "applied", receipt: { commandId: f.input.requestId } });
  f.service.start(f.input);
  expect(f.calls).toMatchObject({ starts: 1, commits: 1, cleanups: 1 });
  expect(JSON.stringify(f.service.observe(f.input))).not.toContain("never-public");
  await f.service.dispose();
});

test("cancel during held preparation never dispatches a pane or a write", async () => {
  const f = fixture(), gate = deferred<void>(); f.holdPrepare(gate.promise);
  f.service.start(f.input); await Promise.resolve();
  const cancellation = f.service.cancel(f.input); gate.resolve();
  expect((await cancellation).result?.outcome).toBe("cancelled");
  expect(f.calls).toMatchObject({ starts: 0, commits: 0 });
});

test("original document loss after editing preserves output and refuses native commit", async () => {
  const f = fixture(); f.service.start(f.input); await f.started.promise;
  f.replace(); f.editing.resolve(completed("conflicting edit"));
  expect((await settled(f)).result?.outcome).toBe("unknown");
  expect(f.calls.commits).toBe(0);
  expect(f.service.recovery(f.input)).toEqual({ content: "retained conflict text", source: "completed-output" });
});

test("cancellation joins a held failed close even when the exit receipt arrives first", async () => {
  const f = fixture(), close = deferred<void>();
  f.cancelWith(async () => { f.editing.resolve({ version: 1, outcome: "cancelled" }); await close.promise; });
  f.service.start(f.input); await f.started.promise;
  const cancel = f.service.cancel(f.input); void cancel.catch(() => {});
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(f.service.observe(f.input).state).toBe("pending");
  expect(f.calls.cleanups).toBe(0);
  close.reject(new Error("original close failed"));
  await expect(cancel).rejects.toThrow("did not drain cleanly");
  expect((await settled(f)).result?.outcome).toBe("unknown");
  await expect(f.service.dispose()).rejects.toThrow("shutdown did not complete cleanly");
});

test("worker loss cancels the original pane without converting loss into a clean cancellation", async () => {
  const f = fixture(); f.service.start(f.input); await f.started.promise;
  // Allow start's returned handle to be admitted before the failure callback.
  await Promise.resolve(); f.loseWorker();
  expect((await settled(f)).result?.outcome).toBe("unknown");
  expect(f.calls).toMatchObject({ cancels: 1, commits: 0 });
});

test("cancellation during an admitted write joins its result and preserves applied receipt", async () => {
  const f = fixture(), write = deferred<void>(); f.holdCommit(write.promise);
  f.service.start(f.input); await f.started.promise; f.editing.resolve(completed("edited"));
  await f.committing.promise;
  const cancel = f.service.cancel(f.input); write.resolve();
  expect((await cancel).result?.outcome).toBe("applied");
  expect(f.calls).toMatchObject({ commits: 1, cancels: 0, cleanups: 1 });
});

test("failed durable completion stays unknown and stops new effects without replay", async () => {
  const f = fixture(); f.service.start(f.input); await f.started.promise;
  f.db.exec("CREATE TRIGGER fail_finish BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT,'disk failed'); END");
  f.editing.resolve(completed("edited"));
  expect((await settled(f)).result?.outcome).toBe("unknown");
  expect(f.calls.cleanups).toBe(1);
  expect(f.service.start(f.input).result?.outcome).toBe("unknown");
  expect(() => f.service.start({ ...f.input, requestId: crypto.randomUUID() })).toThrow("stopping");
  expect(f.calls.commits).toBe(1);
  await expect(f.service.dispose()).rejects.toThrow("shutdown did not complete cleanly");
});

test("a fresh host observes old claims as unknown without capture, launch, or replay", async () => {
  const f = fixture(); f.records.claim(f.input); f.records.markDispatched(f.input);
  const next = new TodoExternalEditors({ ...f.options, controlEpoch: crypto.randomUUID() });
  expect(next.start(f.input).result?.outcome).toBe("unknown");
  expect(next.recovery(f.input)).toEqual({ content: "retained conflict text", source: "completed-output" });
  expect(f.calls).toMatchObject({ captures: 0, starts: 0, commits: 0 });
});

test("restart retains unresolved process capacity until explicit original cancellation", async () => {
  const f = fixture(); f.records.claim(f.input); f.records.markDispatched(f.input);
  const nextEpoch = crypto.randomUUID(), next = new TodoExternalEditors({ ...f.options, controlEpoch: nextEpoch });
  const fresh = { ...f.input, requestId: crypto.randomUUID(), controlEpoch: nextEpoch };
  expect(() => next.start(fresh)).toThrow("unresolved original editor process");
  expect((await next.cancel(f.input)).result?.outcome).toBe("unknown");
  expect(f.calls).toMatchObject({ cancels: 1, starts: 0, commits: 0 });
  expect(f.records.unsettledProcesses()).toEqual([]);
  expect(next.start(fresh).state).toBe("pending");
  await next.cancel(fresh);
});

 test("worker loss without completed output retains only labeled original input; normal cancellation has no recovery", async () => {
  const f = fixture(); f.options.terminals.recovery = () => undefined;
  f.service.start(f.input); await f.started.promise; await Promise.resolve(); f.loseWorker();
  expect((await settled(f)).result?.outcome).toBe("unknown");
  expect(f.service.recovery(f.input)).toEqual({ content: "original input", source: "original-input" });
  const next = new TodoExternalEditors({ ...f.options, controlEpoch: crypto.randomUUID() });
  expect(next.recovery(f.input)).toEqual({ content: "original input", source: "original-input" });
  expect(f.calls.commits).toBe(0);
  f.options.terminals.recovery = () => { throw new Error("corrupt completion receipt"); };
  expect(next.recovery(f.input)).toEqual({ content: "original input", source: "original-input" });
  const normal = fixture(); normal.service.start(normal.input); await normal.started.promise;
  await normal.service.cancel(normal.input); expect(normal.service.recovery(normal.input)).toBeUndefined();
 });
