import { afterEach, expect, test } from "bun:test";
import { closeFixture } from "./fixtures/browser-close";
import { SessionProcessRequests, type SessionProcessesHandle } from "./session-process-requests";
import { NativeProcessesAdmissionError } from "./omp/session-processes";
import type { SessionProcessMutation, SessionProcessRow, SessionProcessesResult } from "../../../packages/shared/src/session-processes";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const f = closeFixture();
  const owner = { nativeSessionId: "session", epoch: "worker", projectDir: f.root };
  const target = { brokerId: "broker", name: "server", id: "original-record", generation: 1 };
  const input: SessionProcessMutation = { action: "input", operationId: "operation-1", owner, target, text: "private\n" };
  const row: SessionProcessRow = { target, state: "ready", createdAt: 1, startedAt: 1, restartCount: 0, outputBytes: 1, readyPending: [], persist: false, detached: false };
  let lookups = 0, current = true, lookup: (() => Promise<SessionProcessesHandle | undefined>) | undefined;
  const calls: unknown[] = [];
  const handle: SessionProcessesHandle = { nativeProcesses: async request => { calls.push(request); return request.action === "read"
    ? { action: "read", snapshot: { owner, brokerId: target.brokerId, rows: [row] } } : { action: "mutation", row }; } };
  const manager = new SessionProcessRequests(f.store.processOperations, {
    getExistingHandle: async () => { lookups++; return lookup ? lookup() : handle; }, isCurrent: (_id, candidate) => current && candidate === handle,
  });
  cleanups.push(async () => { try { await manager.dispose(); } catch { /* Each failure case asserts its retained drain result. */ } f.cleanup(); });
  return { ...f, manager, handle, owner, target, input, row, calls, lookups: () => lookups,
    retire: () => { current = false; }, lookup: (callback: () => Promise<SessionProcessesHandle | undefined>) => { lookup = callback; } };
}
function receipt(result: SessionProcessesResult) {
  if (result.action !== "mutation" && result.action !== "receipt") throw new Error("Expected a durable receipt");
  return result.receipt;
}

test("claim precedes lookup; finish precedes confirmation; duplicates never dispatch and input is copied", async () => {
  const f = fixture(), gate = Promise.withResolvers<SessionProcessesHandle | undefined>();
  f.lookup(() => {
    expect(f.store.processOperations.get("session", "operation-1")?.status).toBe("pending");
    return gate.promise;
  });
  const request = structuredClone(f.input), first = f.manager.request("session", request);
  request.text = "caller changed input"; request.target.id = "caller changed target";
  expect(receipt(await f.manager.request("session", f.input))?.status).toBe("pending");
  gate.resolve(f.handle);
  const result = receipt(await first);
  if (!result) throw new Error("Expected the completed original receipt");
  expect(result?.status).toBe("completed"); expect(f.calls).toEqual([f.input]);
  expect(f.store.processOperations.get("session", "operation-1")).toEqual(result);
  await f.manager.dispose();
  expect(receipt(await f.manager.request("session", f.input))).toEqual(result);
  expect(receipt(await f.manager.request("session", { action: "receipt", operationId: "operation-1" }))).toEqual(result);
  expect(f.lookups()).toBe(1);
  await expect(f.manager.request("session", { ...f.input, text: "different" })).rejects.toThrow("different input");
});

test("missing worker and original-owner loss before dispatch become durable rejection without acquiring", async () => {
  for (const missing of [true, false]) {
    const f = fixture(); if (missing) f.lookup(async () => undefined); else f.retire();
    expect(receipt(await f.manager.request("session", f.input))?.status).toBe("rejected");
    expect(f.calls).toHaveLength(0);
    expect(receipt(await f.manager.request("session", f.input))?.status).toBe("rejected");
    expect(f.lookups()).toBe(1);
  }
});

test("initial reads bind the returned native session, and invalid route identities never look up a worker", async () => {
  const f = fixture();
  await expect(f.manager.request("bad\0session", { action: "read" })).rejects.toThrow("Invalid process session");
  await expect(f.manager.request("foreign", f.input)).rejects.toThrow("another session");
  expect(f.lookups()).toBe(0);
  f.handle.nativeProcesses = async () => ({ action: "read", snapshot: { owner: { ...f.owner, nativeSessionId: "other" }, brokerId: f.target.brokerId, rows: [] } });
  await expect(f.manager.request("session", { action: "read" })).rejects.toThrow("another session");
});

test("worker pre-dispatch refusal is rejected but retirement after actual result is unknown", async () => {
  const f = fixture(); f.handle.nativeProcesses = async () => { throw new NativeProcessesAdmissionError("Retired before native dispatch"); };
  expect(receipt(await f.manager.request("session", f.input))?.status).toBe("rejected");
  const next = fixture(); next.handle.nativeProcesses = async () => { next.retire(); return { action: "mutation", row: next.row }; };
  expect(receipt(await next.manager.request("session", next.input))?.status).toBe("unknown");
  expect(next.store.processOperations.get("session", next.input.operationId)?.status).toBe("unknown");
});

test("dispatched malformed results during retirement remain unknown and fail the joining drain", async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), answer = Promise.withResolvers<unknown>();
  f.handle.nativeProcesses = async () => { entered.resolve(); return answer.promise; };
  const result = f.manager.request("session", f.input); await entered.promise;
  let drained = false;
  const drain = f.manager.dispose().then(() => { drained = true; return undefined; }, error => { drained = true; return error as AggregateError; });
  expect(drained).toBe(false);
  answer.resolve({ action: "mutation", row: { ...f.row, target: { ...f.target, id: "replacement" } } });
  expect(receipt(await result)?.status).toBe("unknown");
  expect((await drain)?.errors.map((error: Error) => error.message)).toEqual(["Invalid native processes completed target."]);
  await expect(f.manager.dispose()).rejects.toThrow("durable receipts failed");
});

test("a dispatched read is parsed before shutdown invalidation and all concurrent reads drain", async () => {
  const f = fixture(), gate = Promise.withResolvers<unknown>(), entered = Promise.withResolvers<void>();
  let calls = 0;
  f.handle.nativeProcesses = async () => { if (++calls === 2) entered.resolve(); return gate.promise; };
  const reads = [f.manager.request("session", { action: "read" }), f.manager.request("session", { action: "read" })];
  const results = Promise.allSettled(reads); await entered.promise;
  const drain = f.manager.dispose().catch(error => error as AggregateError);
  gate.resolve({ action: "read", snapshot: { owner: f.owner, brokerId: f.target.brokerId, rows: [null] } });
  expect((await results).every(result => result.status === "rejected")).toBe(true);
  const error = await drain; expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error("Expected retained parse failures");
  expect(error.errors).toHaveLength(2);
});

test("finish failure never returns completion, orphaned pending projects unknown and duplicate never repeats", async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  f.handle.nativeProcesses = async () => { f.calls.push("effect"); entered.resolve(); await gate.promise; return { action: "mutation", row: f.row }; };
  f.db.exec("CREATE TRIGGER process_finish_failure BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'session-process.v1:%' BEGIN SELECT RAISE(ABORT,'finish failed'); END");
  const result = f.manager.request("session", f.input), caught = result.catch(error => error);
  await entered.promise;
  const drain = f.manager.dispose().catch(error => error);
  gate.resolve();
  expect((await caught).message).toContain("finish failed");
  expect((await drain).errors.map((error: Error) => error.message)).toEqual(["finish failed"]);
  expect(receipt(await f.manager.request("session", { action: "receipt", operationId: "operation-1" }))?.status).toBe("unknown");
  expect(receipt(await f.manager.request("session", f.input))?.status).toBe("unknown");
  expect(f.calls).toEqual(["effect"]); expect(f.lookups()).toBe(1);
});

test("operational failure and failed receipt persistence are independently retained in shutdown", async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  f.handle.nativeProcesses = async () => { entered.resolve(); await gate.promise; throw new Error("native operation failed"); };
  f.db.exec("CREATE TRIGGER process_finish_failure BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'session-process.v1:%' BEGIN SELECT RAISE(ABORT,'finish failed'); END");
  const result = f.manager.request("session", f.input).catch(error => error); await entered.promise;
  const drain = f.manager.dispose().catch(error => error); gate.resolve();
  expect((await result).message).toContain("finish failed");
  expect((await drain).errors.map((error: Error) => error.message)).toEqual(["native operation failed", "finish failed"]);
});

test("reentrant shutdown joins reserved dispatch and does not close a worker or start new requests", async () => {
  const f = fixture(); let drain: Promise<void> | undefined;
  f.handle.nativeProcesses = async () => { drain = f.manager.dispose(); return { action: "mutation", row: f.row }; };
  expect(receipt(await f.manager.request("session", f.input))?.status).toBe("unknown");
  await drain;
  await expect(f.manager.request("session", { action: "read" })).rejects.toThrow("stopping");
  expect(f.lookups()).toBe(1);
});

test("the global request bound includes held reads; refusal neither claims nor dispatches a mutation", async () => {
  const f = fixture(), gate = Promise.withResolvers<unknown>(), entered = Promise.withResolvers<void>(); let count = 0;
  f.handle.nativeProcesses = async () => { if (++count === 16) entered.resolve(); return gate.promise; };
  const reads = Array.from({ length: 16 }, () => f.manager.request("session", { action: "read" }));
  await entered.promise;
  await expect(f.manager.request("session", f.input)).rejects.toThrow("Too many");
  expect(f.store.processOperations.get("session", f.input.operationId)).toBeUndefined();
  gate.resolve({ action: "read", snapshot: { owner: f.owner, brokerId: f.target.brokerId, rows: [] } });
  expect(await Promise.all(reads)).toHaveLength(16);
});
