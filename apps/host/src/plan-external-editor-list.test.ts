import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { parsePlanExternalEditorList, type PlanExternalEditorRequest } from "../../../packages/shared/src/plan-external-editor";
import { PlanExternalEditorRecords } from "./plan-external-editor-records";
import { PlanExternalEditors } from "./plan-external-editors";

const databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
const hostId = "host", oldEpoch = "10000000-0000-0000-0000-000000000001";
const currentEpoch = "20000000-0000-0000-0000-000000000002";
const id = (value: number) => `30000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
function input(value: number, sessionId = "session"): PlanExternalEditorRequest {
  return { requestId: id(value), controlEpoch: oldEpoch, sessionId,
    ticket: { epoch: "worker", nativeSessionId: "native", revision: "a".repeat(64) }, reviewId: "review",
    reviewRevision: "b".repeat(64), documentRevision: "document", edit: { kind: "plan" } };
}
function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,data TEXT NOT NULL)");
  const records = new PlanExternalEditorRecords(db, hostId, () => {});
  const service = new PlanExternalEditors({ hostId, controlEpoch: currentEpoch, records,
    terminals: { start: async () => { throw new Error("Listing must not start a terminal."); }, recovery: () => undefined,
      cancelOriginal: async () => { throw new Error("Listing must not cancel a terminal."); } },
    capture: async () => { throw new Error("Listing must not acquire a worker."); } });
  return { db, records, service };
}

test("durable records page newest-first with a stable exact-session cursor and no writes", () => {
  const f = fixture(), originalNow = Date.now;
  try {
    Date.now = () => 1_000;
    for (let value = 1; value <= 18; value++) { const request = input(value); f.records.claim(request); f.records.markDispatched(request); }
    f.records.claim(input(99, "other"));
  } finally { Date.now = originalNow; }
  const before = f.db.query("SELECT key,data FROM metadata ORDER BY key").all();
  const first = f.records.list("session");
  expect(first.items.map(item => item.requestId)).toEqual(Array.from({ length: 16 }, (_, index) => id(18 - index)));
  expect(first.nextCursor).toBe(id(3));
  expect(f.records.list("session", first.nextCursor)).toEqual({ items: [input(2), input(1)] });
  expect(f.records.list("missing")).toEqual({ items: [] });
  expect(() => f.records.list("session", id(99))).toThrow("does not belong");
  expect(() => f.records.list("session", id(98))).toThrow("does not belong");
  expect(f.db.query("SELECT key,data FROM metadata ORDER BY key").all()).toEqual(before);
});

test("service list projects old-epoch durable jobs as unknown without worker acquisition or replay", () => {
  const f = fixture(), originalNow = Date.now;
  try {
    Date.now = () => 1_000;
    for (let value = 1; value <= 18; value++) { const request = input(value); f.records.claim(request); f.records.markDispatched(request); }
  } finally { Date.now = originalNow; }
  const first = f.service.list("session");
  expect(first.items).toHaveLength(16);
  expect(first.items.every(item => item.state === "settled" && item.result?.outcome === "unknown")).toBe(true);
  expect(parsePlanExternalEditorList(first, hostId, "session")).toEqual(first);
  expect(f.service.list("session", first.nextCursor).items.map(item => item.request.requestId)).toEqual([id(2), id(1)]);
});

test("shared list parser rejects cross-owner, cross-session, duplicate, oversized, and detached cursors", () => {
  const observation = { protocolVersion: 1 as const, hostId, request: input(1), state: "absent" as const };
  const value = { protocolVersion: 1 as const, hostId, sessionId: "session", items: [observation] };
  expect(parsePlanExternalEditorList(value, hostId, "session")).toEqual(value);
  expect(() => parsePlanExternalEditorList({ ...value, hostId: "other" }, hostId, "session")).toThrow("owner");
  expect(() => parsePlanExternalEditorList({ ...value, items: [{ ...observation, request: input(1, "other") }] }, hostId, "session")).toThrow("session");
  expect(() => parsePlanExternalEditorList({ ...value, items: [observation, observation] }, hostId, "session")).toThrow("duplicate");
  expect(() => parsePlanExternalEditorList({ ...value, items: Array(17).fill(observation) }, hostId, "session")).toThrow("page");
  expect(() => parsePlanExternalEditorList({ ...value, nextCursor: input(1).requestId }, hostId, "session")).toThrow("cursor");
});
