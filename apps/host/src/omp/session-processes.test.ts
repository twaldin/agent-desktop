import { describe, expect, test } from "bun:test";
import { NativeProcessesAdmissionError, NativeSessionProcesses, NativeSessionProcessScope, type ProcessBrokerClient, type ProcessBrokerOperation } from "./session-processes";
import { SESSION_PROCESSES_MAX_LOG_CHARS } from "../../../../packages/shared/src/session-processes";

const owner = { nativeSessionId: "session", epoch: "worker", projectDir: "/project" };
const target = { brokerId: "broker", name: "server", id: "record", generation: 1 };
const daemon = { name: target.name, id: target.id, state: "ready", pid: 42, createdAt: 1, startedAt: 2, readyAt: 3,
  restartCount: 0, outputBytes: 20, owner: "another-native-session", persist: false, detached: false };
const read = { op: "observe", brokerId: target.brokerId, daemons: [{ target, daemon }] };
const input = { action: "input" as const, operationId: "operation-1", owner, target, text: "hello\n" };
const sent = { op: "guarded", target, result: { op: "send", daemon } };
function rig(reply: (operation: ProcessBrokerOperation) => Promise<unknown> = async () => read) {
  const operations: ProcessBrokerOperation[] = [];
  let closes = 0, creates = 0, active = true;
  const client: ProcessBrokerClient = { projectDir: owner.projectDir,
    request: operation => { operations.push(structuredClone(operation)); return reply(operation); }, close: () => { closes++; } };
  const adapter = new NativeSessionProcesses(owner, () => { if (!active) throw new Error("Session changed."); }, async () => { creates++; return client; });
  return { adapter, client, operations, loseOwner: () => { active = false; }, closes: () => closes, creates: () => creates };
}

describe("native process session adapter", () => {
  test("projects original project rows without specs/environment or completion subscription access", async () => {
    const native = structuredClone(read);
    Object.assign(native.daemons[0]!.daemon, { env: { SECRET: "not-for-renderer" }, spec: { args: ["--password=private"] } });
    const r = rig(async () => native);
    const result = await r.adapter.request({ action: "read" });
    expect(result.action).toBe("read");
    if (result.action !== "read") throw new Error("Expected read");
    expect(result.snapshot.rows[0]!.nativeOwner).toBe("another-native-session");
    expect(JSON.stringify(result)).not.toMatch(/SECRET|password|not-for-renderer/);
    native.daemons[0]!.target.generation = 500;
    expect(result.snapshot.rows[0]!.target.generation).toBe(1);
    await r.adapter.dispose();
    expect(r.operations).toEqual([{ op: "observe" }]);
    expect(r.closes()).toBe(1);
  });
  test("copies queued target and stdin before async admission and never turns input into a start or global operation", async () => {
    const gate = Promise.withResolvers<ProcessBrokerClient>();
    const r = rig(async () => sent);
    const adapter = new NativeSessionProcesses(owner, () => {}, () => gate.promise);
    const request = structuredClone(input), pending = adapter.request(request);
    request.text = "replacement\n"; request.target.id = "replacement"; request.owner.epoch = "replacement";
    gate.resolve(r.client);
    expect((await pending).action).toBe("mutation");
    expect(r.operations).toEqual([{ op: "guarded", target, operation: { op: "send", name: target.name, data: "hello\n" } }]);
    await adapter.dispose();
  });
  test("retirement before the scheduled factory never creates a client", async () => {
    const r = rig();
    const pending = r.adapter.request({ action: "read" }).catch(error => error);
    await r.adapter.dispose();
    expect(await pending).toBeInstanceOf(NativeProcessesAdmissionError);
    expect(r.creates()).toBe(0); expect(r.closes()).toBe(0);
  });
  test("retirement during factory I/O waits for and closes only that client without dispatch", async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<ProcessBrokerClient>();
    const r = rig();
    const adapter = new NativeSessionProcesses(owner, () => {}, () => { entered.resolve(); return gate.promise; });
    const pending = adapter.request(input).catch(error => error);
    await entered.promise;
    let settled = false;
    const disposal = adapter.dispose().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    gate.resolve(r.client); await disposal;
    expect(await pending).toBeInstanceOf(NativeProcessesAdmissionError);
    expect(r.operations).toEqual([]); expect(r.closes()).toBe(1);
  });
  test("failed client creation can be retried explicitly and an incorrect project client is closed before any dispatch", async () => {
    const r = rig();
    let calls = 0, foreignClosed = 0;
    const adapter = new NativeSessionProcesses(owner, () => {}, async () => {
      calls++;
      if (calls === 1) throw new Error("Project runtime is unavailable");
      if (calls === 2) return { ...r.client, projectDir: "/foreign", close: () => { foreignClosed++; } };
      return r.client;
    });
    await expect(adapter.request({ action: "read" })).rejects.toBeInstanceOf(NativeProcessesAdmissionError);
    await expect(adapter.request({ action: "read" })).rejects.toBeInstanceOf(NativeProcessesAdmissionError);
    expect(r.operations).toEqual([]); expect(foreignClosed).toBe(1);
    expect((await adapter.request({ action: "read" })).action).toBe("read");
    expect(calls).toBe(3); expect(r.operations).toEqual([{ op: "observe" }]);
    await adapter.dispose(); expect(r.closes()).toBe(1);
  });
  test("joins a malformed dispatched reply after retirement and retains client cleanup failure independently", async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<unknown>();
    const r = rig(() => { entered.resolve(); return gate.promise; });
    const close = r.client.close; r.client.close = () => { close(); throw new Error("close failed"); };
    const pending = r.adapter.request(input).catch(error => error);
    await entered.promise;
    const disposal = r.adapter.dispose().catch(error => error);
    expect(r.closes()).toBe(0);
    gate.resolve({ op: "guarded", target, result: { op: "send", daemon: null } });
    const error = await disposal;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(2);
    expect(String(error.errors[1])).toContain("close failed");
    expect(await pending).not.toBeInstanceOf(NativeProcessesAdmissionError);
    expect(r.closes()).toBe(1);
    const again = await r.adapter.dispose().catch(error => error);
    expect(again.errors.map(String)).toEqual(error.errors.map(String));
  });
  test("a valid late mutation is unknown after owner loss, not a zero-effect rejection", async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<unknown>();
    const r = rig(() => { entered.resolve(); return gate.promise; });
    const pending = r.adapter.request(input).catch(error => error);
    await entered.promise; r.loseOwner(); gate.resolve(sent);
    const error = await pending;
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(NativeProcessesAdmissionError);
    expect(r.operations).toHaveLength(1);
    await r.adapter.dispose();
  });
  test("an old broker's unsupported reply never causes a name-only fallback; stale owner fails before dispatch", async () => {
    const r = rig(async () => { throw new Error("Unknown operation observe"); });
    await expect(r.adapter.request({ action: "read" })).rejects.toThrow("Unknown operation observe");
    await expect(r.adapter.request({ ...input, owner: { ...owner, epoch: "old-worker" } })).rejects.toBeInstanceOf(NativeProcessesAdmissionError);
    expect(r.operations).toEqual([{ op: "observe" }]);
    await r.adapter.dispose();
  });
  test("bounds held operations until settlement and keeps log output bounded and original", async () => {
    const gate = Promise.withResolvers<unknown>();
    const r = rig(() => gate.promise);
    const reads = Array.from({ length: 16 }, () => r.adapter.request({ action: "read" }));
    await expect(r.adapter.request({ action: "read" })).rejects.toThrow("Too many");
    gate.resolve(read); await Promise.all(reads);
    expect(r.operations).toHaveLength(16);
    await r.adapter.request({ action: "read" });
    await r.adapter.dispose();
    const logs = rig(async () => ({ op: "guarded", target, result: { op: "logs", name: target.name, text: "x".repeat(SESSION_PROCESSES_MAX_LOG_CHARS) + "TAIL" } }));
    const result = await logs.adapter.request({ action: "logs", owner, target });
    if (result.action !== "logs") throw new Error("Expected logs");
    expect(result.truncated).toBe(true); expect(result.text).toHaveLength(SESSION_PROCESSES_MAX_LOG_CHARS); expect(result.text.endsWith("TAIL")).toBe(true);
    await logs.adapter.dispose();
  });
});


describe("process scope across native task moves", () => {
  test("joins old requests before moving, refuses concurrent admission, and never rebinds an old target", async () => {
    let cwd = "/project", moved = false;
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<unknown>();
    let reads = 0, closes = 0;
    const scope = new NativeSessionProcessScope("session", () => cwd, () => {}, async projectDir => ({ projectDir,
      request: async () => { if (++reads === 2) { entered.resolve(); return gate.promise; } return read; }, close: () => { closes++; } }));
    const initial = await scope.request({ action: "read" });
    if (initial.action !== "read") throw new Error("Expected read");
    const pending = scope.request({ action: "read", owner: initial.snapshot.owner }).catch(error => error);
    await entered.promise;
    const moving = scope.move(async () => { moved = true; cwd = "/destination"; });
    await expect(scope.request({ action: "read" })).rejects.toBeInstanceOf(NativeProcessesAdmissionError);
    expect(moved).toBe(false);
    gate.resolve(read); await moving;
    expect(await pending).toBeInstanceOf(Error); expect(closes).toBe(1);
    const next = await scope.request({ action: "read" });
    if (next.action !== "read") throw new Error("Expected read");
    expect(next.snapshot.owner.projectDir).toBe("/destination");
    expect(next.snapshot.owner.epoch).not.toBe(initial.snapshot.owner.epoch);
    await expect(scope.request({ ...input, owner: initial.snapshot.owner })).rejects.toBeInstanceOf(NativeProcessesAdmissionError);
    expect(reads).toBe(3);
    await scope.dispose(); expect(closes).toBe(2);
  });
  test("failed verified move permits an explicit fresh read, unverified rollback stays closed", async () => {
    const scope = new NativeSessionProcessScope("session", () => "/project", () => {}, async projectDir => ({ projectDir, request: async () => read, close() {} }));
    const first = await scope.request({ action: "read" });
    await expect(scope.move(async () => { throw new Error("Move refused, rollback verified"); })).rejects.toThrow("rollback verified");
    const second = await scope.request({ action: "read" });
    expect(second).not.toEqual(first);
    await expect(scope.move(async () => { throw Object.assign(new Error("Unverified rollback"), { code: "OUTCOME_UNKNOWN" }); })).rejects.toThrow("Unverified rollback");
    await expect(scope.request({ action: "read" })).rejects.toBeInstanceOf(NativeProcessesAdmissionError);
    await expect(scope.dispose()).rejects.toThrow("cleanup failed");
  });
  test("retirement during the old-client drain cancels relocation and keeps malformed read errors", async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<unknown>();
    let moved = false, closes = 0;
    const scope = new NativeSessionProcessScope("session", () => "/project", () => {}, async projectDir => ({ projectDir,
      request: () => { entered.resolve(); return gate.promise; }, close: () => { closes++; } }));
    const readResult = scope.request({ action: "read" }).catch(error => error);
    await entered.promise;
    const move = scope.move(async () => { moved = true; }).catch(error => error);
    const close = scope.dispose().catch(error => error);
    gate.resolve({ broken: true });
    expect(await readResult).toBeInstanceOf(Error);
    expect(await move).toBeInstanceOf(AggregateError);
    expect(await close).toBeInstanceOf(AggregateError);
    expect(moved).toBe(false); expect(closes).toBe(1);
  });
});


test("a delivered verified relocation failure is not re-reported by later process cleanup", async () => {
  const scope = new NativeSessionProcessScope("session", () => "/project", () => {}, async projectDir => ({ projectDir, request: async () => read, close() {} }));
  await scope.request({ action: "read" });
  await expect(scope.move(async () => { throw new Error("Rolled back"); })).rejects.toThrow("Rolled back");
  await scope.request({ action: "read" });
  await scope.dispose();
});


test("a falsy socket-close failure still latches the retired process scope", async () => {
  let creates = 0;
  const scope = new NativeSessionProcessScope("session", () => "/project", () => {}, async projectDir => {
    creates++; return { projectDir, request: async () => read, close() { throw undefined; } };
  });
  await scope.request({ action: "read" });
  await expect(scope.move(async () => {})).rejects.toBeInstanceOf(AggregateError);
  await expect(scope.request({ action: "read" })).rejects.toBeInstanceOf(NativeProcessesAdmissionError);
  expect(creates).toBe(1);
  await expect(scope.dispose()).rejects.toBeInstanceOf(AggregateError);
});
