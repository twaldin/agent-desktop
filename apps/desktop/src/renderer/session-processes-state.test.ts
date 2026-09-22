import { expect, test } from "bun:test";
import { SESSION_PROCESSES_MAX_LOG_CHARS, type SessionProcessesEnvelope, type SessionProcessesOwner, type SessionProcessesRequest,
  type SessionProcessesResult, type SessionProcessesSnapshot, type SessionProcessRow, type SessionProcessTarget } from "../../../../packages/shared/src/session-processes";
import { findProcessRow, processMutationRefusal, processRowKey, SESSION_PROCESSES_COALESCE_MS, SESSION_PROCESSES_POLL_MS,
  SessionProcessesState, type SessionProcessesBridge, type SessionProcessesJournal, type SessionProcessesTimers,
  type SessionProcessOperationMetadata } from "./session-processes-state";

const ownerA: SessionProcessesOwner = { nativeSessionId: "session-1", epoch: "epoch-1", projectDir: "/work/project" };
const ownerB: SessionProcessesOwner = { nativeSessionId: "session-1", epoch: "epoch-2", projectDir: "/work/project" };
const target = (name: string, patch: Partial<SessionProcessTarget> = {}): SessionProcessTarget =>
  ({ brokerId: "broker-1", name, id: `proc_${name}`, generation: 0, ...patch });
const row = (name: string, patch: Partial<SessionProcessRow> = {}): SessionProcessRow =>
  ({ target: target(name), state: "running", pid: 4242, createdAt: 10, startedAt: 11, restartCount: 0, outputBytes: 2048,
    readyPending: [], persist: false, detached: false, ...patch });
const snap = (owner: SessionProcessesOwner, rows: SessionProcessRow[], brokerId = "broker-1"): SessionProcessesSnapshot => ({ owner, brokerId, rows });
const scope = (patch: Partial<{ hostId: string; sessionId: string; connected: boolean; visible: boolean }> = {}) =>
  ({ hostId: "host-1", sessionId: "session-1", connected: true, visible: true, ...patch });
const recorded = (operationId: string, action: "stop" | "restart" | "input", name = "web"): SessionProcessOperationMetadata =>
  ({ operationId, action, owner: ownerA, target: target(name) });

interface Call {
  sessionId: string; hostId: string; request: SessionProcessesRequest;
  resolve(result: SessionProcessesResult, envelope?: Partial<SessionProcessesEnvelope>): void;
  resolveRaw(value: unknown): void;
  reject(error: Error): void;
}

/** The real state machine over a bridge and a durable record that settle only when the
 * test says so. Nothing about the protocol or the record is stubbed out. */
function fixture(options: { supported?: boolean; journal?: boolean; store?: unknown } = {}) {
  const calls: Call[] = [], saves: SessionProcessOperationMetadata[][] = [], journalCalls: string[] = [];
  const timeouts = new Map<number, { handler: () => void; at: number }>();
  const intervals = new Map<number, { handler: () => void; every: number; next: number }>();
  let now = 0, handle = 0;
  const timers: SessionProcessesTimers = {
    setTimeout: (handler, ms) => { timeouts.set(++handle, { handler, at: now + ms }); return handle; },
    clearTimeout: id => { timeouts.delete(id as number); },
    setInterval: (handler, every) => { intervals.set(++handle, { handler, every, next: now + every }); return handle; },
    clearInterval: id => { intervals.delete(id as number); },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      let soonest: { at: number; fire(): void } | undefined;
      for (const [id, timeout] of timeouts) if (!soonest || timeout.at < soonest.at) soonest = { at: timeout.at, fire: () => { timeouts.delete(id); timeout.handler(); } };
      for (const interval of intervals.values()) if (!soonest || interval.next < soonest.at) soonest = { at: interval.next, fire: () => { interval.next += interval.every; interval.handler(); } };
      if (!soonest || soonest.at > until) break;
      now = soonest.at; soonest.fire();
    }
    now = until;
  };
  const gates: (() => void)[] = [];
  const control = { holdSave: false, loadError: undefined as Error | undefined, saveError: undefined as Error | undefined };
  let store: unknown = options.store ?? [];
  const journal: SessionProcessesJournal = {
    load: async () => {
      journalCalls.push("load");
      if (control.loadError) throw control.loadError;
      return structuredClone(store);
    },
    save: async (_journalScope, entries) => {
      journalCalls.push("save");
      if (control.holdSave) await new Promise<void>(resolve => gates.push(resolve));
      if (control.saveError) throw control.saveError;
      store = structuredClone(entries);
      saves.push(structuredClone(entries) as SessionProcessOperationMetadata[]);
    },
  };
  const bridge: SessionProcessesBridge = options.supported === false ? {} : {
    sessionProcesses: (sessionId, request, hostId) => new Promise<SessionProcessesEnvelope>((resolve, reject) => {
      calls.push({ sessionId, hostId, request, reject,
        resolve: (result, envelope) => resolve({ protocolVersion: 1, hostId, sessionId, result, ...envelope }),
        resolveRaw: value => resolve(value as SessionProcessesEnvelope) });
    }),
  };
  const state = new SessionProcessesState(bridge, options.journal === false ? undefined : journal, timers);
  return { state, bridge, journal, timers, calls, saves, journalCalls, control, advance,
    release: () => { while (gates.length) gates.shift()!(); },
    settle: async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); },
    get store() { return store; },
    get view() { return state.getSnapshot(); },
    get operations() { return state.getSnapshot().operations; } };
}

test("the first reading pins its native owner and broker; another owner, broker or failure keeps the pinned rows and marks them stale", async () => {
  const f = fixture(); f.state.configure(scope());
  expect(f.calls[0]!.request).toEqual({ action: "read" });
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  expect(f.view).toMatchObject({ loading: false, stale: false, reading: false, snapshot: { owner: ownerA, brokerId: "broker-1" } });

  f.advance(SESSION_PROCESSES_POLL_MS);
  expect(f.calls[1]!.request).toEqual({ action: "read", owner: ownerA });
  f.calls[1]!.resolve({ action: "read", snapshot: snap(ownerB, []) }); await f.settle();
  expect(f.view.snapshot!.rows.map(item => item.target.name)).toEqual(["web"]);
  expect(f.view.stale).toBe(true);
  expect(f.view.error).toContain("native session");

  // A restarted broker is a different incarnation: the pinned rows stay, nothing rebinds.
  f.advance(SESSION_PROCESSES_POLL_MS);
  expect(f.calls[2]!.request).toEqual({ action: "read", owner: ownerA });
  f.calls[2]!.resolve({ action: "read", snapshot: snap(ownerA, [], "broker-2") }); await f.settle();
  expect(f.view.snapshot).toMatchObject({ brokerId: "broker-1", rows: [{ target: { name: "web" } }] });
  expect(f.view.error).toContain("broker restarted");

  // Explicit refreshes coalesce into a single follow-up reading rather than queueing.
  void f.state.refresh(); void f.state.refresh(); void f.state.refresh();
  expect(f.calls).toHaveLength(4);
  f.calls[3]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web", { state: "ready", readyAt: 20 })]) }); await f.settle();
  expect(f.view).toMatchObject({ stale: false, error: undefined, snapshot: { rows: [{ state: "ready" }] } });
  f.advance(SESSION_PROCESSES_COALESCE_MS);
  expect(f.calls).toHaveLength(5);
});

test("a malformed answer, a wrong action and another process's log reply never replace trustworthy state", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();

  void f.state.refresh();
  f.calls[1]!.resolveRaw({ protocolVersion: 1, hostId: "host-1", sessionId: "session-1",
    result: { action: "read", snapshot: { owner: ownerA, brokerId: "broker-1", rows: [{ ...row("web"), state: "sleeping" }] } } });
  await f.settle();
  expect(f.view).toMatchObject({ stale: true, snapshot: { rows: [{ state: "running" }] } });
  expect(f.view.error).toContain("Invalid native processes");

  void f.state.refresh();
  f.calls[2]!.resolve({ action: "mutation", receipt: { operationId: "op-elsewhere-1", action: "stop", owner: ownerA, target: target("web"), status: "pending" } });
  await f.settle();
  expect(f.view.snapshot!.rows).toEqual([row("web")]);
  expect(f.view.stale).toBe(true);
  expect(f.operations).toEqual([]);

  void f.state.refresh();
  f.calls[3]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web"), row("api")]) }); await f.settle();
  const logs = f.state.inspect(target("web"));
  expect(f.calls[4]!.request).toEqual({ action: "logs", owner: ownerA, target: target("web") });
  f.calls[4]!.resolve({ action: "logs", owner: ownerA, target: target("api"), text: "another process", truncated: false });
  await logs;
  expect(f.view.logs).toMatchObject({ target: { name: "web" }, state: "failed" });
  expect(f.view.logs!.text).toBeUndefined();
});

test("a change is recorded before it is sent, carries the identity copied before the write, and never records or retains stdin", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  f.control.holdSave = true;
  const caller = target("web");
  const sending = f.state.mutate(caller, "input", "deploy --now");
  await f.settle();
  expect(f.calls).toHaveLength(1);
  expect(f.operations).toHaveLength(1);
  expect(f.operations[0]).toMatchObject({ action: "input", status: "saving", lookupPending: false, target: target("web") });
  expect(f.view.busy).toBe(true);
  expect(JSON.stringify(f.operations)).not.toContain("deploy --now");
  // The caller's object changes while the record is being written; the copy taken
  // before the await is what is recorded and what is sent.
  caller.generation = 99; caller.id = "hijacked";
  f.control.holdSave = false; f.release(); await f.settle();

  const operationId = f.operations[0]!.operationId;
  expect(f.saves[0]).toEqual([{ operationId, action: "input", owner: ownerA, target: target("web") }]);
  expect(Object.keys(f.saves[0]![0]!).sort()).toEqual(["action", "operationId", "owner", "target"]);
  expect(JSON.stringify(f.store)).not.toContain("deploy --now");
  expect(f.calls[1]!.request).toEqual({ action: "input", operationId, owner: ownerA, target: target("web"), text: "deploy --now" });
  expect(f.operations[0]!.status).toBe("pending");

  f.calls[1]!.resolve({ action: "mutation", receipt: { operationId, action: "input", owner: ownerA, target: target("web"),
    status: "completed", row: row("web", { outputBytes: 4096 }) } });
  await sending; await f.settle();
  expect(f.operations[0]).toMatchObject({ status: "completed", row: { outputBytes: 4096 } });
  expect(f.operations[0]!.error).toBeUndefined();
  expect(JSON.stringify(f.operations)).not.toContain("deploy --now");
  // The durable receipt retires the record and updates the pinned reading.
  expect(f.store).toEqual([]);
  expect(f.view).toMatchObject({ busy: false, journalState: "ready", snapshot: { rows: [{ outputBytes: 4096 }] } });
  f.state.dismissOperation(operationId);
  expect(f.operations).toEqual([]);
});

test("a failed record write sends nothing, keeps the operation known not-sent and bars every effect until the record is retried", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  f.control.saveError = new Error("The record device is full.");
  await f.state.mutate(target("web"), "stop"); await f.settle();
  expect(f.calls).toHaveLength(1);
  expect(f.operations[0]).toMatchObject({ status: "not-sent", action: "stop" });
  expect(f.operations[0]!.error).toContain("Nothing was sent");
  expect(f.view).toMatchObject({ busy: false, journalState: "failed" });
  expect(f.view.journalError).toContain("record device is full");

  const current = findProcessRow(f.view.snapshot, target("web"))!;
  expect(processMutationRefusal(f.view, current, "restart")).toContain("operation record");
  await f.state.mutate(target("web"), "restart"); await f.settle();
  expect(f.calls).toHaveLength(1);
  expect(f.operations).toHaveLength(1);

  f.control.saveError = undefined;
  await f.state.retryJournal(); await f.settle();
  expect(f.view).toMatchObject({ journalState: "ready", journalError: undefined });
  expect(f.calls).toHaveLength(1);
  expect(f.operations[0]!.status).toBe("not-sent");
  f.state.dismissOperation(f.operations[0]!.operationId);
  expect(f.operations).toEqual([]);
  // Effects are possible again once the record is writable.
  void f.state.mutate(target("web"), "stop"); await f.settle();
  expect(f.calls[1]!.request).toMatchObject({ action: "stop", target: target("web") });
});

test("an operation recorded by an earlier mount reappears as unknown, blocks another operation for that process and resolves only on a fully matching durable receipt", async () => {
  const f = fixture({ store: [recorded("op-original-restart-1", "restart")] });
  f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web"), row("api")]) }); await f.settle();
  expect(f.operations).toHaveLength(1);
  expect(f.operations[0]).toMatchObject({ operationId: "op-original-restart-1", action: "restart", status: "unknown", lookupPending: false });
  const web = findProcessRow(f.view.snapshot, target("web"))!;
  expect(processMutationRefusal(f.view, web, "stop")).toContain("unresolved");
  await f.state.mutate(target("web"), "stop"); await f.settle();
  expect(f.calls).toHaveLength(1);

  // No receipt yet: still unknown, still not repeatable.
  const first = f.state.lookupReceipt("op-original-restart-1");
  expect(f.calls[1]!.request).toEqual({ action: "receipt", operationId: "op-original-restart-1" });
  expect(f.operations[0]!.lookupPending).toBe(true);
  f.calls[1]!.resolve({ action: "receipt", receipt: null }); await first;
  expect(f.operations[0]).toMatchObject({ status: "unknown", lookupPending: false });
  expect(f.operations[0]!.error).toContain("no receipt");

  // A receipt for another process is refused even though the operation id matches.
  const second = f.state.lookupReceipt("op-original-restart-1");
  f.calls[2]!.resolve({ action: "receipt", receipt: { operationId: "op-original-restart-1", action: "restart", owner: ownerA,
    target: target("api"), status: "completed", row: row("api", { target: target("api", { generation: 1 }) }) } });
  await second;
  expect(f.operations[0]!.status).toBe("unknown");
  expect(f.operations[0]!.error).toContain("another process operation");
  expect(f.store).toEqual([recorded("op-original-restart-1", "restart")]);

  // The matching receipt is durable: the record is retired and the restarted generation adopted.
  const third = f.state.lookupReceipt("op-original-restart-1");
  f.calls[3]!.resolve({ action: "receipt", receipt: { operationId: "op-original-restart-1", action: "restart", owner: ownerA,
    target: target("web"), status: "completed", row: row("web", { target: target("web", { generation: 1 }), restartCount: 1 }) } });
  await third; await f.settle();
  expect(f.operations[0]).toMatchObject({ status: "completed", lookupPending: false, row: { target: { generation: 1 }, restartCount: 1 } });
  expect(f.store).toEqual([]);
  expect(f.view.snapshot!.rows[0]).toMatchObject({ target: { generation: 1 }, restartCount: 1 });
  expect(processRowKey(f.view.snapshot!.rows[0]!.target)).not.toBe(processRowKey(target("web")));
  const restarted = findProcessRow(f.view.snapshot, target("web", { generation: 1 }))!;
  expect(processMutationRefusal(f.view, restarted, "stop")).toBeUndefined();
});

test("a pending or unknown operation is never repeated, not by a second call, not by a lookup and not by dismissal", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  f.control.holdSave = true;
  const sending = f.state.mutate(target("web"), "stop");
  await f.settle();
  await f.state.mutate(target("web"), "stop"); await f.settle();
  expect(f.operations).toHaveLength(1);
  f.control.holdSave = false; f.release(); await f.settle();
  const operationId = f.operations[0]!.operationId;
  expect(f.calls).toHaveLength(2);

  f.calls[1]!.resolve({ action: "mutation", receipt: { operationId, action: "stop", owner: ownerA, target: target("web"), status: "pending" } });
  await sending; await f.settle();
  expect(f.operations[0]).toMatchObject({ status: "pending", lookupPending: false });
  expect(f.operations[0]!.error).toBeUndefined();
  expect(f.store).toEqual([{ operationId, action: "stop", owner: ownerA, target: target("web") }]);

  await f.state.mutate(target("web"), "stop"); await f.settle();
  f.state.dismissOperation(operationId);
  expect(f.operations).toHaveLength(1);
  expect(f.calls).toHaveLength(2);

  const lookup = f.state.lookupReceipt(operationId);
  expect(f.calls[2]!.request).toEqual({ action: "receipt", operationId });
  f.calls[2]!.reject(new Error("host unreachable")); await lookup;
  expect(f.operations[0]).toMatchObject({ status: "pending", lookupPending: false, error: "host unreachable" });
  expect(f.calls).toHaveLength(3);

  const rejected = f.state.lookupReceipt(operationId);
  f.calls[3]!.resolve({ action: "receipt", receipt: { operationId, action: "stop", owner: ownerA, target: target("web"),
    status: "rejected", message: "The process had already exited." } });
  await rejected; await f.settle();
  expect(f.operations[0]).toMatchObject({ status: "rejected", error: "The process had already exited." });
  expect(f.store).toEqual([]);
  f.state.dismissOperation(operationId);
  expect(f.operations).toEqual([]);
});

test("a reading begun before a completed receipt never restores the retired row, and a late receipt never downgrades a newer generation", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  void f.state.mutate(target("web"), "restart"); await f.settle();
  const restart = f.calls[1]!, restartId = f.operations[0]!.operationId;
  expect(restart.request).toMatchObject({ action: "restart", target: target("web") });

  // A reading of the pre-restart rows is already outstanding when the receipt lands.
  void f.state.refresh();
  const older = f.calls[2]!;
  restart.resolve({ action: "mutation", receipt: { operationId: restartId, action: "restart", owner: ownerA, target: target("web"),
    status: "completed", row: row("web", { target: target("web", { generation: 1 }), restartCount: 1, state: "starting", readyPending: ["log"] }) } });
  await f.settle();
  expect(f.view.snapshot!.rows[0]).toMatchObject({ target: { generation: 1 }, state: "starting" });
  older.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  expect(f.view.snapshot!.rows[0]).toMatchObject({ target: { generation: 1 }, state: "starting" });

  // A stop of that generation is dispatched, then a newer reading observes a further restart.
  void f.state.mutate(target("web", { generation: 1 }), "stop"); await f.settle();
  const stop = f.calls[3]!, stopId = f.operations.find(operation => operation.action === "stop")!.operationId;
  expect(stop.request).toMatchObject({ action: "stop", target: target("web", { generation: 1 }) });
  void f.state.refresh();
  f.calls[4]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web", { target: target("web", { generation: 2 }), restartCount: 2 })]) });
  await f.settle();
  expect(f.view.snapshot!.rows[0]).toMatchObject({ target: { generation: 2 }, restartCount: 2 });

  stop.resolve({ action: "mutation", receipt: { operationId: stopId, action: "stop", owner: ownerA, target: target("web", { generation: 1 }),
    status: "completed", row: row("web", { target: target("web", { generation: 1 }), state: "exited", exitCode: 0, exitedAt: 44, restartCount: 1 }) } });
  await f.settle();
  expect(f.operations.find(operation => operation.action === "stop")).toMatchObject({ status: "completed", row: { state: "exited", target: { generation: 1 } } });
  expect(f.view.snapshot!.rows).toHaveLength(1);
  expect(f.view.snapshot!.rows[0]).toMatchObject({ target: { generation: 2 }, restartCount: 2, state: "running" });
});

test("bridge calls stay bounded while a dispatch hangs, a receipt lookup is still possible, and hiding or stopping sends nothing native", async () => {
  const f = fixture({ store: [recorded("op-original-input-1", "input")] });
  f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web"), row("api")]) }); await f.settle();
  void f.state.mutate(target("api"), "restart"); await f.settle();
  expect(f.calls[1]!.request).toMatchObject({ action: "restart", target: target("api") });

  // One hung dispatch plus one explicit lookup fill the budget; readings are skipped, never queued.
  void f.state.lookupReceipt("op-original-input-1");
  await f.settle();
  expect(f.calls[2]!.request).toEqual({ action: "receipt", operationId: "op-original-input-1" });
  void f.state.refresh(); void f.state.refresh();
  f.advance(SESSION_PROCESSES_POLL_MS * 3);
  await f.settle();
  expect(f.calls).toHaveLength(3);

  // Hiding stops readings; the outstanding native work is left alone.
  f.state.configure(scope({ visible: false }));
  f.advance(SESSION_PROCESSES_POLL_MS * 3);
  expect(f.calls).toHaveLength(3);
  expect(f.view).toMatchObject({ visible: false, snapshot: { rows: [{ target: { name: "web" } }, { target: { name: "api" } }] } });

  f.calls[2]!.resolve({ action: "receipt", receipt: null }); await f.settle();
  expect(f.operations.find(operation => operation.operationId === "op-original-input-1")!.status).toBe("unknown");

  const dispatched = f.calls[1]!, restartId = f.operations.find(operation => operation.action === "restart")!.operationId;
  f.state.stop();
  f.advance(SESSION_PROCESSES_POLL_MS * 3);
  dispatched.resolve({ action: "mutation", receipt: { operationId: restartId, action: "restart", owner: ownerA, target: target("api"),
    status: "completed", row: row("api", { target: target("api", { generation: 1 }) }) } });
  await f.settle();
  expect(f.calls).toHaveLength(3);
  expect(f.calls.map(call => call.request.action)).toEqual(["read", "restart", "receipt"]);
});

test("logs are the exact bounded reply, keep their truncation flag, survive going offline and close only once settled", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  const pending = f.state.inspect(target("web"));
  expect(f.view.logs).toMatchObject({ state: "pending", target: target("web") });
  f.state.closeLogs();
  expect(f.view.logs!.state).toBe("pending");
  const text = `warn: port busy\n${"log line\n".repeat(64)}`;
  f.calls[1]!.resolve({ action: "logs", owner: ownerA, target: target("web"), text, truncated: true });
  await pending;
  expect(f.view.logs).toEqual({ target: target("web"), state: "ready", text, truncated: true });

  // Offline keeps the cached reading and the cached output, and stops every request.
  f.state.configure(scope({ connected: false }));
  f.advance(SESSION_PROCESSES_POLL_MS * 2);
  expect(f.calls).toHaveLength(2);
  expect(f.view).toMatchObject({ connected: false, stale: true, logs: { state: "ready", truncated: true } });
  expect(processMutationRefusal(f.view, row("web"), "stop")).toContain("Offline");

  f.state.configure(scope());
  const oversized = f.state.inspect(target("web"));
  f.calls[2]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  f.calls[3]!.resolve({ action: "logs", owner: ownerA, target: target("web"), text: "x".repeat(SESSION_PROCESSES_MAX_LOG_CHARS + 1), truncated: true });
  await oversized;
  expect(f.view.logs).toMatchObject({ state: "failed" });
  expect(f.view.logs!.text).toBeUndefined();
  f.state.closeLogs();
  expect(f.view.logs).toBeUndefined();
});

test("a recorded operation that is no longer allowed when the write returns is reported as never sent and its record is retired", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();

  // The row is replaced by a newer generation while the record is being written.
  f.control.holdSave = true;
  const replaced = f.state.mutate(target("web"), "stop");
  await f.settle();
  void f.state.refresh();
  f.calls[1]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web", { target: target("web", { generation: 1 }), restartCount: 1 })]) });
  await f.settle();
  f.control.holdSave = false; f.release(); await replaced; await f.settle();
  expect(f.calls).toHaveLength(2);
  expect(f.operations[0]).toMatchObject({ status: "not-sent", target: { generation: 0 } });
  expect(f.operations[0]!.error).toContain("nothing reached the host");
  expect(f.store).toEqual([]);
  f.state.dismissOperation(f.operations[0]!.operationId);

  // Hiding the list between the write and the dispatch has the same honest outcome.
  f.control.holdSave = true;
  const hidden = f.state.mutate(target("web", { generation: 1 }), "stop");
  await f.settle();
  expect(f.operations[0]!.status).toBe("saving");
  f.state.configure(scope({ visible: false }));
  f.control.holdSave = false; f.release(); await hidden; await f.settle();
  expect(f.calls).toHaveLength(2);
  expect(f.operations[0]!.status).toBe("not-sent");
  expect(f.store).toEqual([]);
  expect(f.view.busy).toBe(false);
});

test("refusals follow the process state machine and a bridge without native processes never reads or records", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [
    row("web"), row("boot", { state: "starting", readyPending: ["port"] }), row("gone", { state: "exited", exitCode: 0, exitedAt: 30 }),
    row("cycling", { state: "restarting" }), row("closing", { state: "stopping" })]) });
  await f.settle();
  const view = f.view, find = (name: string) => findProcessRow(view.snapshot, target(name))!;
  expect(processMutationRefusal(view, find("web"), "stop")).toBeUndefined();
  expect(processMutationRefusal(view, find("boot"), "input")).toBeUndefined();
  expect(processMutationRefusal(view, find("gone"), "restart")).toBeUndefined();
  expect(processMutationRefusal(view, find("gone"), "stop")).toContain("not running");
  expect(processMutationRefusal(view, find("gone"), "input")).toContain("not running");
  expect(processMutationRefusal(view, find("cycling"), "restart")).toContain("already restarting");
  expect(processMutationRefusal(view, find("closing"), "stop")).toContain("already stopping");
  expect(processMutationRefusal(view, row("absent"), "stop")).toContain("not part of the current reading");
  await f.state.mutate(target("gone"), "stop"); await f.settle();
  expect(f.calls).toHaveLength(1);

  const bare = fixture({ supported: false, journal: false });
  bare.state.configure(scope());
  bare.advance(SESSION_PROCESSES_POLL_MS * 2);
  expect(bare.calls).toHaveLength(0);
  expect(bare.view).toMatchObject({ supported: false, loading: false, journalState: "unavailable" });
  expect(processMutationRefusal(bare.view, row("web"), "stop")).toContain("unavailable through this desktop bridge");
  await bare.state.mutate(target("web"), "stop");
  expect(bare.calls).toHaveLength(0);
});

test("remounting cannot escape the outstanding bridge request bound", async () => {
  const f = fixture();
  f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  void f.state.inspect(target("web"));
  void f.state.refresh();
  f.state.stop();
  const reopened = new SessionProcessesState(f.bridge, f.journal, f.timers);
  reopened.configure(scope());
  await f.settle();
  expect(f.calls).toHaveLength(3); // initial settled read plus two still outstanding
  f.calls[1]!.resolve({ action: "logs", owner: ownerA, target: target("web"), text: "old", truncated: false });
  f.calls[2]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  f.advance(SESSION_PROCESSES_COALESCE_MS); await f.settle();
  expect(f.calls).toHaveLength(4);
  reopened.stop();
});

test("a second controller cannot duplicate an operation while the first journal save is held", async () => {
  const f = fixture();
  const other = new SessionProcessesState(f.bridge, f.journal, f.timers);
  f.state.configure(scope()); other.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) });
  f.calls[1]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  f.control.holdSave = true;
  void f.state.mutate(target("web"), "input", "only once");
  await f.settle();
  void other.mutate(target("web"), "input", "only once");
  await f.settle();
  f.control.holdSave = false; f.release(); await f.settle();
  expect(f.calls.filter(call => call.request.action === "input")).toHaveLength(1);
  expect((f.store as SessionProcessOperationMetadata[])).toHaveLength(1);
  f.state.stop(); other.stop();
});

test("restored metadata pins the original owner before a replacement epoch can be accepted", async () => {
  const f = fixture({ store: [recorded("op-original-epoch", "input")] });
  f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerB, [row("web")]) }); await f.settle();
  expect(f.view.snapshot).toBeUndefined();
  expect(f.view.error).toContain("changed");
  expect(f.operations[0]!.owner).toEqual(ownerA);
  void f.state.refresh();
  expect(f.calls[1]!.request).toEqual({ action: "read", owner: ownerA });
  f.state.stop();
});

test("a terminal receipt cannot regress to an older pending dispatch response", async () => {
  const f = fixture();
  f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  const sending = f.state.mutate(target("web"), "input", "once");
  await f.settle();
  const metadata = f.operations[0]!;
  const lookup = f.state.lookupReceipt(metadata.operationId);
  f.calls[2]!.resolve({ action: "receipt", receipt: { operationId: metadata.operationId, action: "input",
    owner: ownerA, target: target("web"), status: "completed", row: row("web") } });
  await lookup;
  expect(f.view.busy).toBe(false);
  f.calls[1]!.resolve({ action: "mutation", receipt: { operationId: metadata.operationId, action: "input",
    owner: ownerA, target: target("web"), status: "pending" } });
  await sending;
  expect(f.operations[0]!.status).toBe("completed");
  expect(f.store).toEqual([]);
  f.state.stop();
});

test("an old held save cannot copy a newly selected session's operations into its original journal", async () => {
  const f = fixture(), otherOwner = { ...ownerA, nativeSessionId: "session-2" };
  const prior = { ...recorded("op-other-session", "input", "api"), owner: otherOwner };
  const stores = new Map<string, SessionProcessOperationMetadata[]>([["session-2", [prior]]]);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let hold = true;
  const journal: SessionProcessesJournal = {
    load: async key => structuredClone(stores.get(key.sessionId) ?? []),
    save: async (key, entries) => {
      if (key.sessionId === "session-1" && hold) await held;
      stores.set(key.sessionId, structuredClone([...entries]));
    },
  };
  const state = new SessionProcessesState(f.bridge, journal, f.timers);
  state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  const saving = state.mutate(target("web"), "stop"); await f.settle();
  state.configure(scope({ sessionId: "session-2" }));
  f.calls[1]!.resolve({ action: "read", snapshot: snap(otherOwner, [row("api")]) }); await f.settle();
  hold = false; release(); await saving; await f.settle();
  expect(stores.get("session-1")).toEqual([]);
  expect(stores.get("session-2")).toEqual([prior]);
  expect(state.getSnapshot().operations.map(operation => operation.operationId)).toEqual([prior.operationId]);
  expect(f.calls.map(call => call.request.action)).toEqual(["read", "read"]);
  state.stop();
});

test("corrupt, over-limit and foreign-scope journals never dispatch or erase their contents", async () => {
  const tooMany = Array.from({ length: 33 }, (_, index) => recorded(`op-limit-${index}`, "stop", `web${index}`));
  const foreign = { ...recorded("op-foreign-session", "stop"), owner: { ...ownerA, nativeSessionId: "other" } };
  for (const invalid of [null, undefined, [{ ...recorded("op-extra-field", "input"), text: "must not persist" }], tooMany, [foreign]]) {
    const f = fixture();
    f.journal.load = async () => structuredClone(invalid);
    f.state.configure(scope());
    f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
    expect(f.view.journalState).toBe("failed");
    await f.state.mutate(target("web"), "stop");
    expect(f.calls.map(call => call.request.action)).toEqual(["read"]);
    expect(f.saves).toEqual([]);
    f.state.stop();
  }
});

test("terminal journal pruning failure bars effects until explicit storage recovery succeeds", async () => {
  const f = fixture();
  f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  const sending = f.state.mutate(target("web"), "input", "once"); await f.settle();
  const operationId = f.operations[0]!.operationId;
  f.control.saveError = new Error("directory fsync failed");
  f.calls[1]!.resolve({ action: "mutation", receipt: { operationId, action: "input", owner: ownerA,
    target: target("web"), status: "completed", row: row("web") } });
  await sending;
  expect(f.operations[0]!.status).toBe("completed");
  expect(f.view.journalState).toBe("failed");
  expect((f.store as SessionProcessOperationMetadata[])[0]!.operationId).toBe(operationId);
  await f.state.retryJournal();
  expect(f.view.journalState).toBe("failed");
  await f.state.mutate(target("web"), "input", "do not send");
  expect(f.calls).toHaveLength(2);
  f.control.saveError = undefined;
  await f.state.retryJournal();
  expect(f.store).toEqual([]);
  expect(f.view.journalState).toBe("ready");
  expect(f.calls).toHaveLength(2);
  f.state.stop();
});

test("a row that settles during journal persistence cannot receive the captured input", async () => {
  const f = fixture();
  f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web")]) }); await f.settle();
  f.control.holdSave = true;
  const sending = f.state.mutate(target("web"), "input", "must not send"); await f.settle();
  void f.state.refresh();
  f.calls[1]!.resolve({ action: "read", snapshot: snap(ownerA, [row("web", { state: "exited", exitCode: 0 })]) });
  await f.settle();
  f.control.holdSave = false; f.release(); await sending;
  expect(f.calls.map(call => call.request.action)).toEqual(["read", "read"]);
  expect(f.operations[0]!.status).toBe("not-sent");
  expect(f.store).toEqual([]);
  f.state.stop();
});
