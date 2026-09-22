import { afterEach, expect, test } from "bun:test";
import { HostStore } from "./store";
import { closeFixture } from "./fixtures/browser-close";
import type { SessionProcessMutation, SessionProcessReceipt, SessionProcessRow } from "../../../packages/shared/src/session-processes";
import { checkHostStateCompatibility } from "../../../scripts/host-state-compatibility";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const f = closeFixture(); cleanups.push(f.cleanup);
  const owner = { nativeSessionId: "session", epoch: "worker", projectDir: f.root };
  const target = { brokerId: "broker", name: "server", id: "record", generation: 1 };
  const input: SessionProcessMutation = { action: "input", owner, target, operationId: "operation-1", text: "private input\n" };
  const row: SessionProcessRow = { target, state: "ready", pid: 42, createdAt: 1, startedAt: 2, restartCount: 0, outputBytes: 30, readyPending: [], persist: false, detached: false };
  const receipt: SessionProcessReceipt = { action: input.action, owner, target, operationId: input.operationId, status: "completed", row };
  return { ...f, owner, target, input, receipt };
}

test("process reads preserve schema; claim atomically fences schema28 and omits submitted stdin", () => {
  const f = fixture(), before = f.metadata(), policy = f.store.getDeviceAccessPolicy();
  expect(f.store.processOperations.get("session", f.input.operationId)).toBeUndefined();
  expect(f.metadata()).toEqual(before); expect(f.schema()).toBe(1);
  expect(f.store.processOperations.claim(f.input).fresh).toBe(true);
  expect(f.schema()).toBe(28); expect(f.store.getDeviceAccessPolicy()).toEqual(policy);
  expect(JSON.stringify(f.metadata())).not.toContain("private input");
  expect(() => checkHostStateCompatibility({ stateSchemaVersions: [27] }, f.root)).toThrow("schema 28");
  expect(checkHostStateCompatibility({ stateSchemaVersions: [28] }, f.root).checkedSchemaVersion).toBe(28);
});
test("duplicate IDs never acquire new authority and changed input/project/generation is rejected", () => {
  const f = fixture();
  const initial = f.store.processOperations.claim(f.input);
  initial.receipt.target.id = "caller mutation";
  expect(f.store.processOperations.claim(f.input)).toMatchObject({ fresh: false, receipt: { target: f.target, status: "pending" } });
  for (const changed of [{ text: "different" }, { target: { ...f.target, generation: 2 } }, { owner: { ...f.owner, projectDir: "/other" } }]) {
    expect(() => f.store.processOperations.claim({ ...f.input, ...changed })).toThrow("different input");
  }
  expect(() => f.store.processOperations.claim({ ...f.input, owner: { ...f.owner, nativeSessionId: "missing" } })).toThrow("no longer exists");
});
test("another store and real reopen project unfinished claims as unknown without replay or metadata writes", () => {
  const f = fixture(); f.store.processOperations.claim(f.input);
  const before = f.metadata(), other = new HostStore(f.root);
  try {
    expect(other.processOperations.get("session", f.input.operationId)?.status).toBe("unknown");
    expect(other.processOperations.claim(f.input)).toMatchObject({ fresh: false, receipt: { status: "unknown" } });
    expect(() => other.processOperations.finish(f.input, f.receipt)).toThrow("original process dispatcher");
    expect(f.metadata()).toEqual(before);
    f.store.processOperations.finish(f.input, f.receipt);
    expect(other.processOperations.get("session", f.input.operationId)).toEqual(f.receipt);
  } finally { other.close(); }
  const reopened = new HostStore(f.root);
  try { expect(reopened.processOperations.claim(f.input)).toEqual({ fresh: false, receipt: f.receipt }); }
  finally { reopened.close(); }
});
test("failed claim rolls back schema/policy and failed finish retains permanent non-replay admission", () => {
  const f = fixture(), before = f.metadata();
  f.db.exec("CREATE TRIGGER process_claim_failure BEFORE INSERT ON metadata WHEN NEW.key LIKE 'session-process.v1:%' BEGIN SELECT RAISE(ABORT,'claim failed'); END");
  expect(() => f.store.processOperations.claim(f.input)).toThrow("claim failed");
  expect(f.schema()).toBe(1); expect(f.metadata()).toEqual(before);
  f.db.exec("DROP TRIGGER process_claim_failure");
  f.store.processOperations.claim(f.input);
  f.db.exec("CREATE TRIGGER process_finish_failure BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'session-process.v1:%' BEGIN SELECT RAISE(ABORT,'finish failed'); END");
  expect(() => f.store.processOperations.finish(f.input, f.receipt)).toThrow("finish failed");
  expect(f.store.processOperations.claim(f.input).fresh).toBe(false);
  expect(f.store.processOperations.get("session", f.input.operationId)?.status).toBe("pending");
});
test("finish confirms only original immutable receipts; unknown does not become completed later", () => {
  const f = fixture(); f.store.processOperations.claim(f.input);
  expect(() => f.store.processOperations.finish(f.input, { ...f.receipt, owner: { ...f.owner, epoch: "replacement" } })).toThrow();
  const unknown: SessionProcessReceipt = { action: f.input.action, operationId: f.input.operationId, owner: f.owner, target: f.target, status: "unknown" };
  expect(f.store.processOperations.finish(f.input, unknown)).toEqual(unknown);
  expect(() => f.store.processOperations.finish(f.input, f.receipt)).toThrow("settled differently");
  const result = f.store.processOperations.get("session", f.input.operationId)!; result.owner.epoch = "caller-mutated";
  expect(f.store.processOperations.get("session", f.input.operationId)).toEqual(unknown);
});
