import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { HostStore } from "../store";
import { PreferencesStore } from "./store";
import { checkHostStateCompatibility } from "../../../../scripts/host-state-compatibility";

const definitions = [{ id: "search", defaults: ["CmdOrCtrl+K"] }];
test("keymap migration commits its downgrade fence, survives reopen and rejects a stale second connection", () => {
  const root = mkdtempSync(join(tmpdir(), "keymap-store-")), hosts: HostStore[] = [];
  const open = () => { const host = new HostStore(root); hosts.push(host); return new PreferencesStore(host); };
  try {
    const first = open(), second = open();
    first.put({ key: "theme.mode", value: "dark" });
    const oldManifest = { stateSchemaVersions: Array.from({ length: 13 }, (_, i) => i + 1) };
    expect(checkHostStateCompatibility(oldManifest, root).checkedSchemaVersion).toBe(1);
    const record = first.mutateCommandKeymap({ expectedRevision: null, edit: { type: "command", commandId: "search", update: { type: "clear" } } }, definitions);
    expect(() => checkHostStateCompatibility(oldManifest, root)).toThrow("schema 14 is incompatible");
    expect(checkHostStateCompatibility({ stateSchemaVersions: [...oldManifest.stateSchemaVersions, 14] }, root).checkedSchemaVersion).toBe(14);
    expect(() => second.mutateCommandKeymap({ expectedRevision: null, edit: { type: "reset-all" } }, definitions)).toThrow("changed");
    expect(second.snapshotV2().records).toContainEqual(record);
    hosts.splice(0).forEach(host => host.close());
    const reopened = open(); expect(reopened.snapshotV2().records).toContainEqual(record);
    reopened.mutateCommandKeymap({ expectedRevision: record.revision, edit: { type: "reset-all" } }, definitions);
    expect(reopened.snapshot().records).toHaveLength(1);
    expect(() => checkHostStateCompatibility(oldManifest, root)).toThrow("schema 14 is incompatible");
  } finally { hosts.splice(0).forEach(host => host.close()); rmSync(root, { recursive: true, force: true }); }
});

test("failed durable writes roll back the preference value and schema fence together", () => {
  const root = mkdtempSync(join(tmpdir(), "keymap-rollback-")), host = new HostStore(root);
  const db = new Database(join(root, "state.sqlite"), { strict: true });
  try {
    const preferences = new PreferencesStore(host);
    db.exec("CREATE TRIGGER fail_keymap_insert BEFORE INSERT ON metadata WHEN NEW.key = 'preferences.v1' BEGIN SELECT RAISE(ABORT, 'keymap-write-blocked'); END");
    expect(() => preferences.mutateCommandKeymap({ expectedRevision: null, edit: { type: "reset-all" } }, definitions)).toThrow("keymap-write-blocked");
    expect(host.readPreferencesState()).toBeUndefined();
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(1);
  } finally { db.close(); host.close(); rmSync(root, { recursive: true, force: true }); }
});
