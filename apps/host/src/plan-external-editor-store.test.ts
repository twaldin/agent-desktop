import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanExternalEditorRequest } from "../../../packages/shared/src/plan-external-editor";
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
  const root = mkdtempSync(join(tmpdir(), "plan-external-editor-store-")); roots.push(root);
  const store = new HostStore(root); stores.add(store);
  const database = new Database(join(root, "state.sqlite")); databases.add(database);
  return { root, store, database };
}
function request(): PlanExternalEditorRequest {
  return { requestId: crypto.randomUUID(), controlEpoch: crypto.randomUUID(), sessionId: "session",
    ticket: { epoch: "worker", nativeSessionId: "native", revision: "a".repeat(64) }, reviewId: "review",
    reviewRevision: "b".repeat(64), documentRevision: "document", edit: { kind: "plan" } };
}

test("HostStore claims Plan external editors behind an atomic schema-26 and policy fence", () => {
  const f = fixture(), input = request();
  const version = () => f.database.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  expect(version()).toBe(1);
  expect(f.database.query("SELECT data FROM metadata WHERE key = 'device-access.v1'").get()).toBeNull();
  f.database.exec(`CREATE TRIGGER reject_plan_editor BEFORE INSERT ON metadata
    WHEN NEW.key LIKE 'plan-external-editor:v1:%' BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END`);
  expect(() => f.store.planExternalEditors.claim(input)).toThrow("fixture refusal");
  expect(version()).toBe(1);
  expect(f.database.query("SELECT data FROM metadata WHERE key = 'device-access.v1'").get()).toBeNull();

  f.database.exec("DROP TRIGGER reject_plan_editor");
  const claimed = f.store.planExternalEditors.claim(input);
  expect(claimed).toMatchObject({ fresh: true, record: { hostId: f.store.host.id, request: input, launched: false } });
  expect(version()).toBe(26);
  expect(f.database.query("SELECT data FROM metadata WHERE key = 'device-access.v1'").get()).not.toBeNull();
  expect(() => checkHostStateCompatibility({ stateSchemaVersions: [25] }, f.root)).toThrow("schema 26");
  expect(checkHostStateCompatibility({ stateSchemaVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26] }, f.root).checkedSchemaVersion).toBe(26);

  f.store.close(); stores.delete(f.store);
  const reopened = new HostStore(f.root); stores.add(reopened);
  expect(reopened.planExternalEditors.claim(input)).toMatchObject({ fresh: false, record: { hostId: reopened.host.id, terminalId: claimed.record.terminalId } });
});
