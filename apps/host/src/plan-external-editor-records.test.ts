import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanExternalEditorRequest } from "../../../packages/shared/src/plan-external-editor";
import { PlanExternalEditorRecords } from "./plan-external-editor-records";

const directories: string[] = [], databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const hostId = "host", epoch = "a0000000-0000-4000-8000-000000000001";
const request = (): PlanExternalEditorRequest => ({ requestId: crypto.randomUUID(), controlEpoch: epoch,
  sessionId: "session", ticket: { epoch: "worker", nativeSessionId: "native", revision: "a".repeat(64) },
  reviewId: "review", reviewRevision: "b".repeat(64), documentRevision: "document", edit: { kind: "plan" } });
function fixture(requireSchema = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "plan-editor-records-")); directories.push(directory);
  const file = join(directory, "state.sqlite");
  const open = () => { const db = new Database(file); databases.push(db); return db; };
  const db = open(); db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY, data TEXT NOT NULL)");
  return { db, open, records: new PlanExternalEditorRecords(db, hostId, requireSchema) };
}

test("one durable editor claim survives reopen without replay or changed-input reuse", () => {
  const f = fixture(), input = request();
  const first = f.records.claim(input);
  expect(first.fresh).toBe(true);
  f.records.markDispatched(input);
  const reopened = new PlanExternalEditorRecords(f.open(), hostId, () => { throw new Error("Repeat must not migrate"); });
  expect(reopened.claim(input)).toMatchObject({ fresh: false, record: { terminalId: first.record.terminalId, launched: true } });
  expect(() => reopened.claim({ ...input, documentRevision: "replacement" })).toThrow("different input");
  input.ticket.revision = "c".repeat(64);
  expect(first.record.request.ticket.revision).toBe("a".repeat(64));
  first.record.request.edit = { kind: "annotation", target: { kind: "section", sectionId: "section" }, note: "changed", renderColumns: 120 };
  expect(reopened.get({ ...input, ticket: { ...input.ticket, revision: "a".repeat(64) } })?.request.edit).toEqual({ kind: "plan" });
});

test("prior-epoch observation is read-only unknown and keeps the original terminal identity", () => {
  const f = fixture(), input = request(), record = f.records.claim(input).record;
  f.records.markDispatched(input);
  const before = f.db.query("SELECT data FROM metadata").get();
  const nextEpoch = crypto.randomUUID();
  expect(f.records.observe(input, nextEpoch)).toMatchObject({ state: "settled", terminalId: record.terminalId, result: { outcome: "unknown" } });
  expect(f.db.query("SELECT data FROM metadata").get()).toEqual(before);
  expect(f.records.claim(input).fresh).toBe(false);
  expect(f.records.observe(input, epoch)).toMatchObject({ state: "pending", terminalId: record.terminalId });
});

test("schema refusal and failed completion writes retain honest claim state", () => {
  const f = fixture(() => { throw new Error("Schema cannot advance"); }), input = request();
  expect(() => f.records.claim(input)).toThrow("Schema cannot advance");
  expect(f.records.observe(input, epoch).state).toBe("absent");
  const records = new PlanExternalEditorRecords(f.db, hostId, () => {});
  records.claim(input); records.markDispatched(input);
  f.db.exec("CREATE TRIGGER reject_editor_finish BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT, 'disk refused'); END");
  expect(() => records.finish(input, { outcome: "cancelled" })).toThrow("disk refused");
  expect(records.observe(input, epoch).state).toBe("pending");
  f.db.exec("DROP TRIGGER reject_editor_finish");
  records.finish(input, { outcome: "cancelled" });
  records.finish(input, { outcome: "cancelled" });
  expect(() => records.finish(input, { outcome: "unknown", message: "replacement" })).toThrow("already settled differently");
  expect(() => records.markDispatched(input)).toThrow("not pending");
});

test("only the original applied Plan receipt can settle an editor", () => {
  const f = fixture(), input = request(); f.records.claim(input); f.records.markDispatched(input);
  const receipt = { commandId: input.requestId, reviewId: input.reviewId, reviewRevision: input.reviewRevision,
    action: "edit" as const, outcome: "applied" as const, artifact: "written" as const,
    transition: "unchanged" as const, execution: "not-requested" as const };
  expect(() => f.records.finish(input, { outcome: "applied", receipt: { ...receipt, reviewId: "replacement" } })).toThrow();
  expect(f.records.observe(input, epoch).state).toBe("pending");
  f.records.finish(input, { outcome: "applied", receipt });
  const observed = f.records.observe(input, epoch); observed.result!.receipt!.reviewId = "mutated";
  expect(f.records.observe(input, epoch).result?.receipt?.reviewId).toBe(input.reviewId);
  expect(() => new PlanExternalEditorRecords(f.db, "other-host", () => {}).observe(input, epoch)).toThrow("record identity");
});
