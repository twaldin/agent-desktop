import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { HostStore } from "../store";
import { PreferencesStore } from "./store";

// Exercise the real metadata transaction/schema methods on SQLite :memory:.
// Do not construct a HostStore, create a profile, acquire a lease or launch a host.
function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version=14");
  const owner = Object.create(HostStore.prototype) as HostStore;
  Object.defineProperties(owner, { db: { value: db }, host: { value: { id: crypto.randomUUID() } } });
  // Schema 14 requires a persisted device policy, even in this metadata-only fixture.
  owner.writeMetadata("device-access.v1", { revision: 0, enabled: true, revokedNodeIds: [] });
  return { db, preferences: new PreferencesStore(owner), schema: () => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version };
}

test("target value and schema15 commit atomically and reset/legacy writes never downgrade", () => {
  const f = fixture();
  try {
    expect(f.preferences.snapshotV2().records).toEqual([]); expect(f.schema()).toBe(14);
    const record = f.preferences.mutateCommandKeymap({ expectedRevision: null, edit: { type: "number-target", target: "sidebar" } }, []);
    expect(f.schema()).toBe(15);
    expect(f.preferences.snapshotV2().records).toEqual([record]);
    const reset = f.preferences.mutateCommandKeymap({ expectedRevision: record.revision, edit: { type: "reset-all" } }, []);
    expect(reset).toMatchObject({ deleted: false, value: { primaryNumberShortcutTarget: "sidebar", overrides: [] } });
    f.preferences.put({ key: "theme.mode", value: "dark" });
    expect(f.schema()).toBe(15);
  } finally { f.db.close(); }
});

test("failed metadata commit rolls schema15 and target back together", () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TRIGGER block_target BEFORE INSERT ON metadata BEGIN SELECT RAISE(ABORT,'target-write-blocked'); END");
    expect(() => f.preferences.mutateCommandKeymap({ expectedRevision: null, edit: { type: "number-target", target: "sidebar" } }, [])).toThrow("target-write-blocked");
    expect(f.schema()).toBe(14);
    expect(f.preferences.snapshotV2().records).toEqual([]);
  } finally { f.db.close(); }
});
