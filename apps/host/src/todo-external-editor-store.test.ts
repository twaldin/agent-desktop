import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TodoExternalEditorRequest } from "../../../packages/shared/src/todo-external-editor";
import { checkHostStateCompatibility } from "../../../scripts/host-state-compatibility";
import { HostStore } from "./store";

const roots: string[] = [], stores = new Set<HostStore>(), databases = new Set<Database>();
afterEach(() => {
  for (const store of stores) store.close();
  for (const database of databases) database.close();
  stores.clear(); databases.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "todo-external-editor-store-")); roots.push(root);
  const store = new HostStore(root); stores.add(store);
  const database = new Database(join(root, "state.sqlite")); databases.add(database);
  return { root, store, database };
}
function request(): TodoExternalEditorRequest {
  return { requestId: crypto.randomUUID(), controlEpoch: crypto.randomUUID(), sessionId: "session",
    ticket: { epoch: "worker", nativeSessionId: "session", revision: "a".repeat(64) } };
}

test("HostStore claims Plan external editors behind an atomic schema-26 and policy fence", () => {
  const f = fixture(), input = request();
  const version = () => f.database.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  expect(version()).toBe(1);
  expect(f.database.query("SELECT data FROM metadata WHERE key = 'device-access.v1'").get()).toBeNull();
  f.database.exec(`CREATE TRIGGER reject_plan_editor BEFORE INSERT ON metadata
    WHEN NEW.key LIKE 'todo-external-editor:v1:%' BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END`);
  expect(() => f.store.todoExternalEditors.claim(input)).toThrow("fixture refusal");
  expect(version()).toBe(1);
  expect(f.database.query("SELECT data FROM metadata WHERE key = 'device-access.v1'").get()).toBeNull();

  f.database.exec("DROP TRIGGER reject_plan_editor");
  const claimed = f.store.todoExternalEditors.claim(input);
  expect(claimed).toMatchObject({ fresh: true, record: { hostId: f.store.host.id, request: input, launched: false } });
  expect(version()).toBe(26);
  expect(f.database.query("SELECT data FROM metadata WHERE key = 'device-access.v1'").get()).not.toBeNull();
  expect(() => checkHostStateCompatibility({ stateSchemaVersions: [25] }, f.root)).toThrow("schema 26");
  expect(checkHostStateCompatibility({ stateSchemaVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26] }, f.root).checkedSchemaVersion).toBe(26);

  f.store.close(); stores.delete(f.store);
  const reopened = new HostStore(f.root); stores.add(reopened);
  expect(reopened.todoExternalEditors.claim(input)).toMatchObject({ fresh: false, record: { hostId: reopened.host.id, terminalId: claimed.record.terminalId } });
});

 test("same UUID Plan and Todo jobs stay isolated and Plan serialized records remain unchanged", () => {
  const f = fixture(), todo = request();
  const plan = { ...todo, reviewId: "review", reviewRevision: "b".repeat(64), documentRevision: "document", edit: { kind: "plan" as const } };
  f.store.planExternalEditors.claim(plan);
  const before = f.database.query<{data:string},[string]>("SELECT data FROM metadata WHERE key=?").get(`plan-external-editor:v1:${todo.requestId}`)!.data;
  const claimed = f.store.todoExternalEditors.claim(todo);
  expect(claimed.record.terminalId).not.toBe(f.store.planExternalEditors.get(plan)!.terminalId);
  f.store.todoExternalEditors.finish(todo, { outcome: "cancelled" });
  expect(f.store.planExternalEditors.observe(plan, plan.controlEpoch).state).toBe("pending");
  expect(f.database.query<{data:string},[string]>("SELECT data FROM metadata WHERE key=?").get(`plan-external-editor:v1:${todo.requestId}`)!.data).toBe(before);
  expect(() => f.store.todoExternalEditors.claim(plan)).toThrow("keys");
  expect(() => f.store.planExternalEditors.claim(todo as never)).toThrow();
 });
