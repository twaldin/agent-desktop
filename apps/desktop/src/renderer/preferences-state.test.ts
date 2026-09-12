import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../../../host/src/store";
import { PreferencesStore } from "../../../host/src/preferences/store";
import type { CommandEnvelope, CommandResult, DesktopEvent } from "../../../../packages/shared/src/protocol";
import { PreferencesState } from "./preferences-state";
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "agent-renderer-preferences-")); const host = new HostStore(directory); const native = new PreferencesStore(host);
  cleanup.push(() => { host.close(); rmSync(directory, { recursive: true, force: true }); });
  const values = new Map<string, string>(); const receipts = { read: (key: string) => values.get(key) ?? null, write: (key: string, value: string) => { values.set(key, value); } }; const cache = { read: async (key: string) => receipts.read(key), write: async (key: string, value: string) => receipts.write(key, value) };
  const listeners = new Set<(event: DesktopEvent) => void>(); const deliveries: CommandEnvelope[] = []; const applied = new Map<string, CommandResult>(); let drop = false; let reads = 0;
  const bridge = { getPreferences: async () => { reads++; return native.snapshot(); }, subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, command: async (envelope: CommandEnvelope, owner?: string): Promise<CommandResult> => {
    expect(owner).toBe(host.host.id); deliveries.push(envelope); if (applied.has(envelope.id)) return applied.get(envelope.id)!;
    if (envelope.command.type !== "preferences.put") throw new Error("Unexpected command");
    const result: CommandResult = { ok: true, commandId: envelope.id, value: { type: "preferences.put", preference: native.put(envelope.command.change) } }; applied.set(envelope.id, result); if (drop) { drop = false; throw new Error("Lost native preference receipt"); } return result;
  } };
  const data = new PreferencesState(bridge, cache, receipts); data.setConnection(host.host.id, true);
  return { host, native, bridge, data, cache, receipts, deliveries, listeners, drop: () => { drop = true; }, reads: () => reads };
}
describe("replicated sidebar renderer", () => {
  test("section deletion returns its items to default without deleting or transferring entities", async () => {
    const f = fixture(); const section = crypto.randomUUID(); const project = crypto.randomUUID(); await f.data.refresh();
    await f.data.put({ key: `sidebar.section.${section}`, value: { name: "Focus", position: 0 } });
    await f.data.put({ key: `sidebar.project.${project}`, value: { hostId: f.host.host.id, sectionId: section, position: 0 } });
    expect(f.data.sectionFor("project", project, f.host.host.id)).toBe(section); expect(f.data.sectionFor("project", project, crypto.randomUUID())).toBeNull();
    await f.data.put({ key: `sidebar.section.${section}`, deleted: true });
    expect(f.data.sections()).toEqual([]); expect(f.data.sectionFor("project", project, f.host.host.id)).toBeNull(); expect(f.data.entity("project", project, f.host.host.id)?.hostId).toBe(f.host.host.id);
  });
  test("project appearance round-trips through shared preferences without crossing host identity", async () => {
    const f = fixture(); const project = crypto.randomUUID(); const otherHost = crypto.randomUUID(); await f.data.refresh();
    const appearance = { marker: { kind: "icon" as const, icon: "desk-globe" as const }, color: "#3B82F6" as const };
    await f.data.put({ key: `sidebar.project.${project}`, value: { hostId: f.host.host.id, sectionId: "pinned", position: 2_048, appearance } });
    expect(f.data.entity("project", project, f.host.host.id)).toEqual({ hostId: f.host.host.id, sectionId: "pinned", position: 2_048, appearance });
    expect(f.data.entity("project", project, otherHost)).toBeUndefined();
    const reopened = new PreferencesState(f.bridge, f.cache, f.receipts); reopened.setConnection(f.host.host.id, true); await reopened.refresh();
    expect(reopened.entity("project", project, f.host.host.id)).toEqual(expect.objectContaining({ appearance }));
  });
  test("an older snapshot cannot undo current sidebar deletion or a newer cached preference", async () => {
    const f = fixture(); const section = crypto.randomUUID(); const original = f.native.put({ key: `sidebar.section.${section}`, value: { name: "Old", position: 0 } }); const deleted = f.native.put({ key: `sidebar.section.${section}`, deleted: true });
    f.data.ingest({ version: 1, records: [deleted] }); f.data.ingest({ version: 1, records: [original] }); expect(f.data.sections()).toEqual([]);
    const pending = f.data.restore(); f.data.ingest({ version: 1, records: [f.native.put({ key: "general.sendBehavior", value: "mod-enter" })] }); await pending; expect(f.data.get("general.sendBehavior")).toBe("mod-enter");
  });
  test("a lost receipt preserves a reorder batch across restart and retries the same command IDs", async () => {
    const f = fixture(); await f.data.refresh(); const one = crypto.randomUUID(); const two = crypto.randomUUID(); f.drop();
    await f.data.putMany([{ key: `sidebar.section.${one}`, value: { name: "One", position: 1024 } }, { key: `sidebar.section.${two}`, value: { name: "Two", position: 0 } }]);
    expect(f.data.pending.map(envelope => envelope.command.type === "preferences.put" && envelope.command.change.key)).toEqual(["sidebar.organization", `sidebar.section.${one}`, `sidebar.section.${two}`]); const original = f.deliveries[0]!.id;
    const next = new PreferencesState(f.bridge, f.cache, f.receipts); next.setConnection(f.host.host.id, true); await next.refresh(); expect(f.deliveries).toHaveLength(1); await next.retry();
    expect(f.deliveries[1]!.id).toBe(original); expect(next.pending).toHaveLength(0); expect(next.sections().map(section => section.name)).toEqual(["Two", "One"]); expect(f.native.snapshot().records.map(record => record.revision.counter)).toEqual(expect.arrayContaining([1, 2]));
  });
  test("pending receipts are saved before delivery and offline changes never send automatically", async () => {
    const f = fixture(); await f.data.refresh(); f.receipts.write = () => { throw new Error("Receipt storage full"); }; await f.data.put({ key: "general.reduceMotion", value: true }); expect(f.deliveries).toHaveLength(0); expect(f.data.error).toContain("Receipt storage full");
    const another = fixture(); another.data.setConnection(another.host.host.id, false); await another.data.put({ key: "general.reduceMotion", value: true }); another.data.setConnection(another.host.host.id, true); await another.data.refresh(); expect(another.deliveries).toHaveLength(0);
  });
  test("only the local replica's preference invalidation triggers a read", async () => {
    const f = fixture(); f.data.start(); for (const listener of f.listeners) listener({ type: "preferences", sequence: 1, hostId: crypto.randomUUID() }); expect(f.reads()).toBe(0);
    for (const listener of f.listeners) listener({ type: "preferences", sequence: 2, hostId: f.host.host.id }); await f.data.refresh(); expect(f.reads()).toBeGreaterThan(0); f.data.stop();
  });
  test("unreadable recovery receipts cannot be overwritten by a new preference change", async () => {
    const f = fixture(); const malformed = "{unreadable saved command"; f.receipts.write(f.data.pendingKey, malformed);
    const next = new PreferencesState(f.bridge, f.cache, f.receipts); next.setConnection(f.host.host.id, true); await next.refresh();
    await next.put({ key: "general.reduceMotion", value: true });
    expect(f.deliveries).toHaveLength(0); expect(f.receipts.read(next.pendingKey)).toBe(malformed); expect(next.error).toContain("Saved command receipts have been retained");
  });
});

test("sidebar grouping and sort modes survive the real replicated store and reject unsupported values", async () => {
  const f = fixture(); await f.data.refresh();
  const value = { grouping: "list", projectSort: "priority", chatSort: "updated_at" } as const;
  await f.data.put({ key: "sidebar.organization", value });
  const reopened = new PreferencesState(f.bridge, f.cache, f.receipts); reopened.setConnection(f.host.host.id, true); await reopened.refresh();
  expect(reopened.get("sidebar.organization")).toEqual(value);
  for (const invalid of [{ ...value, grouping: "unknown" }, { ...value, chatSort: "created_at" }, { ...value, path: "/private" }]) {
    expect(() => f.native.put({ key: "sidebar.organization", value: invalid } as never)).toThrow();
    expect(f.native.get("sidebar.organization")).toMatchObject({ value });
  }
});

test("pinned sorting restores through the v2 snapshot without changing Recents organization", async () => {
  const f = fixture(); await f.data.refresh();
  await f.data.put({ key: "sidebar.organization", value: { grouping: "connection", projectSort: "manual", chatSort: "updated_at" } });
  await f.data.put({ key: "sidebar.pinnedSort", value: "priority" });
  expect(f.data.sidebarOrganization()).toEqual({ grouping: "connection", projectSort: "manual", chatSort: "updated_at" });
  expect(f.data.pinnedSort()).toBe("priority");
  const v2Bridge = { ...f.bridge, getPreferencesV2: async () => f.native.snapshotV2() };
  const reopened = new PreferencesState(v2Bridge, f.cache, f.receipts); reopened.setConnection(f.host.host.id, true); await reopened.refresh();
  expect(reopened.pinnedSort()).toBe("priority");
  expect(reopened.sidebarOrganization().chatSort).toBe("updated_at");
});

test("a host without the v2 endpoint falls back to its legacy projection", async () => {
  const f = fixture();
  const bridge = { ...f.bridge, getPreferencesV2: async () => { throw new Error("HTTP 404"); } };
  const data = new PreferencesState(bridge, f.cache, f.receipts); data.setConnection(f.host.host.id, true); await data.refresh();
  expect(data.error).toBeUndefined();
  expect(data.sidebarOrganization()).toEqual(expect.objectContaining({ grouping: "project" }));
});


test("a malformed or unavailable v2 response is not silently replaced with v1 data", async () => {
  const f = fixture();
  for (const failure of [new Error("Invalid preference snapshot"), new Error("Request timed out")]) {
    const bridge = { ...f.bridge, getPreferencesV2: async () => { throw failure; } };
    const data = new PreferencesState(bridge, f.cache, f.receipts); data.setConnection(f.host.host.id, true); await data.refresh();
    expect(data.error).toContain(failure.message);
  }
});
