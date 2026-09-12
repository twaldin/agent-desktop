import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import { checkHostStateCompatibility } from "../../../scripts/host-state-compatibility";
import { DeviceAccessConflictError } from "../../../packages/shared/src/device-access";
const roots: string[] = [], stores: HostStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "device-access-")); roots.push(root); const store = new HostStore(root); stores.push(store); return { root, store }; }

test("legacy read preserves schema; first explicit policy write fences rollback and survives restart", () => {
  const { root, store } = fixture();
  expect(store.getDeviceAccessPolicy()).toEqual({ revision: 0, enabled: true, revokedNodeIds: [] });
  expect(checkHostStateCompatibility({ stateSchemaVersions: [1] }, root).checkedSchemaVersion).toBe(1);
  expect(store.updateDeviceAccessPolicy({ expectedRevision: 0, change: { type: "device", nodeId: "node-work", allowed: false } })).toEqual({ revision: 1, enabled: true, revokedNodeIds: ["node-work"] });
  expect(() => checkHostStateCompatibility({ stateSchemaVersions: [1,2,3,4,5,6,7,8,9,10,11,12] }, root)).toThrow("schema 13 is incompatible");
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new HostStore(root); stores.push(reopened);
  expect(reopened.getDeviceAccessPolicy()).toEqual({ revision: 1, enabled: true, revokedNodeIds: ["node-work"] });
  reopened.updateDeviceAccessPolicy({ expectedRevision: 1, change: { type: "availability", enabled: false } });
  reopened.updateDeviceAccessPolicy({ expectedRevision: 2, change: { type: "device", nodeId: "node-work", allowed: true } });
  expect(reopened.getDeviceAccessPolicy()).toEqual({ revision: 3, enabled: false, revokedNodeIds: [] });
  reopened.updateDeviceAccessPolicy({ expectedRevision: 3, change: { type: "availability", enabled: true } });
  expect(checkHostStateCompatibility({ stateSchemaVersions: [13] }, root).checkedSchemaVersion).toBe(13);
});

test("two store owners use atomic revision checks without overwriting a revoke", () => {
  const { root, store } = fixture(); const other = new HostStore(root); stores.push(other);
  store.updateDeviceAccessPolicy({ expectedRevision: 0, change: { type: "device", nodeId: "node-work", allowed: false } });
  expect(() => other.updateDeviceAccessPolicy({ expectedRevision: 0, change: { type: "availability", enabled: true } })).toThrow(DeviceAccessConflictError);
  expect(other.getDeviceAccessPolicy()).toEqual(store.getDeviceAccessPolicy());
});

test("malformed updates neither advance revision nor migrate legacy storage", () => {
  const { root, store } = fixture();
  for (const value of [null, { expectedRevision: 0, change: { type: "availability", enabled: "false" } },
    { expectedRevision: -1, change: { type: "availability", enabled: false } },
    { expectedRevision: 0, change: { type: "device", nodeId: "", allowed: true } },
    { expectedRevision: 0, change: { type: "device", nodeId: "n", allowed: true, userId: "someone" } }]) expect(() => store.updateDeviceAccessPolicy(value)).toThrow();
  expect(store.getDeviceAccessPolicy().revision).toBe(0);
  expect(checkHostStateCompatibility({ stateSchemaVersions: [1] }, root).checkedSchemaVersion).toBe(1);
});

test("missing or corrupt durable policy fails closed at startup", () => {
  for (const corruption of ["missing", "invalid"]) {
    const { root, store } = fixture();
    store.updateDeviceAccessPolicy({ expectedRevision: 0, change: { type: "availability", enabled: false } });
    store.close(); stores.splice(stores.indexOf(store), 1);
    const db = new Database(join(root, "state.sqlite"));
    if (corruption === "missing") db.query("DELETE FROM metadata WHERE key = 'device-access.v1'").run();
    else db.query("UPDATE metadata SET data = ? WHERE key = 'device-access.v1'").run('{"enabled":true}');
    db.close();
    expect(() => new HostStore(root)).toThrow(corruption === "missing" ? "policy is missing" : "Invalid device access policy");
  }
});
