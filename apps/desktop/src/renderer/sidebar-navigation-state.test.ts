import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../../../host/src/store";
import { PreferencesStore } from "../../../host/src/preferences/store";
import type { CommandEnvelope, CommandResult, DesktopEvent } from "../../../../packages/shared/src/protocol";
import { DEFAULT_SIDEBAR_NAVIGATION, parseSidebarNavigation, reorderSidebarDestinations, resetSidebarNavigation, setSidebarDestinationHidden, sidebarNavigationLayout } from "../../../../packages/shared/src/sidebar-navigation";
import { SidebarNavigationState } from "./sidebar-navigation-state";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sidebar-navigation-")), host = new HostStore(directory), store = new PreferencesStore(host);
  cleanups.push(() => { host.close(); rmSync(directory, { recursive: true, force: true }); });
  const values = new Map<string, string>(), receipts = { read: (key: string) => values.get(key) ?? null, write: (key: string, value: string) => { values.set(key, value); } };
  const cache = { read: async (key: string) => receipts.read(key), write: async (key: string, value: string) => receipts.write(key, value) };
  const deliveries: { envelope: CommandEnvelope; owner?: string }[] = [], applied = new Map<string, CommandResult>();
  let failure: "lost" | "rejected" | undefined;
  const bridge = {
    getPreferences: async () => store.snapshot(), getPreferencesV2: async () => ({ ok: true as const, value: store.snapshotV2() }),
    subscribe: (_listener: (event: DesktopEvent) => void) => () => {},
    command: async (envelope: CommandEnvelope, owner?: string): Promise<CommandResult> => {
      deliveries.push({ envelope, owner });
      if (applied.has(envelope.id)) return applied.get(envelope.id)!;
      if (envelope.command.type !== "preferences.put") throw new Error("Unexpected fixture command");
      if (failure === "rejected") { failure = undefined; return { commandId: envelope.id, ok: false, error: { code: "DENIED", message: "Fixture preference write rejected" } }; }
      const result: CommandResult = { commandId: envelope.id, ok: true, value: { type: "preferences.put", preference: store.put(envelope.command.change) } };
      applied.set(envelope.id, result);
      if (failure === "lost") { failure = undefined; throw new Error("Fixture lost receipt"); }
      return result;
    },
  };
  const reopen = (owner = host.host.id) => { const data = new SidebarNavigationState(owner, bridge, cache, receipts); data.setConnection(owner, true, true); return data; };
  return { store, host, bridge, cache, receipts, values, deliveries, reopen, fail: (next: typeof failure) => { failure = next; } };
}
test("full saved order survives availability loss, reorder and available-only reset", () => {
  const initial = parseSidebarNavigation({ version: 1, order: ["archive", "scheduled", "plugins", "pull-requests"], hidden: ["scheduled", "plugins"] });
  const unavailable = sidebarNavigationLayout(initial, [{ id: "archive" as const }, { id: "plugins" as const }, { id: "pull-requests" as const }]);
  expect(unavailable.direct.map(item => item.id)).toEqual(["archive", "pull-requests"]);
  const moved = reorderSidebarDestinations(initial, ["pull-requests", "archive", "plugins"]);
  expect(moved.order).toEqual(["pull-requests", "scheduled", "archive", "plugins"]);
  const reset = resetSidebarNavigation(moved, ["pull-requests", "archive", "plugins"]);
  expect(reset).toEqual({ version: 1, order: ["pull-requests", "scheduled", "plugins", "archive"], hidden: ["scheduled", "archive"] });
  expect(sidebarNavigationLayout(reset, reset.order.map(id => ({ id }))).more.map(item => item.id)).toEqual(["scheduled", "archive"]);
  expect(initial.order).toEqual(["archive", "scheduled", "plugins", "pull-requests"]);
});
test("all-hidden recovery promotes only the selected destination without changing saved visibility", () => {
  const value = { ...DEFAULT_SIDEBAR_NAVIGATION, hidden: [...DEFAULT_SIDEBAR_NAVIGATION.order] };
  const layout = sidebarNavigationLayout(value, value.order.map(id => ({ id, current: id === "scheduled" })));
  expect(layout.direct.map(item => item.id)).toEqual(["scheduled"]);
  expect(layout.more.map(item => item.id)).toEqual(["pull-requests", "plugins", "archive"]);
  expect(sidebarNavigationLayout(value, value.order.map(id => ({ id }))).direct).toEqual([]);
});
test("confirmed customization and newer revisions survive reopen without downgrading the v2 store", async () => {
  const f = fixture(), data = f.reopen(); await data.refresh();
  const value = setSidebarDestinationHidden(reorderSidebarDestinations(DEFAULT_SIDEBAR_NAVIGATION, ["plugins", "pull-requests", "scheduled", "archive"]), "pull-requests", true);
  await data.save(value);
  const saved = f.store.get("sidebar.navigation")!;
  const reopened = f.reopen(); await reopened.refresh();
  expect(reopened.value).toEqual(value); expect(reopened.unsaved).toBe(false);
  const next = f.store.put({ key: "sidebar.navigation", value: DEFAULT_SIDEBAR_NAVIGATION });
  reopened.preferences.ingest({ version: 1, records: [next] }); reopened.preferences.ingest({ version: 1, records: [saved] });
  expect(reopened.value).toEqual(DEFAULT_SIDEBAR_NAVIGATION);
  expect(f.deliveries.every(item => item.owner === f.host.host.id)).toBe(true);
  expect(f.store.snapshotV2().version).toBe(2);
});
test("a lost write is retained through capability loss and restart and retried on its original owner and command", async () => {
  const f = fixture(), data = f.reopen(); await data.refresh(); f.fail("lost");
  const value = setSidebarDestinationHidden(DEFAULT_SIDEBAR_NAVIGATION, "plugins", true);
  await data.save(value); expect(data.unsaved).toBe(true);
  await data.save(DEFAULT_SIDEBAR_NAVIGATION); expect(data.value).toEqual(value); expect(f.deliveries).toHaveLength(1);
  const revision = f.store.get("sidebar.navigation")!.revision;
  data.setConnection(crypto.randomUUID(), true, true); await data.retry();
  expect(f.deliveries).toHaveLength(1);
  const reopened = f.reopen(); reopened.setConnection(f.host.host.id, true, false); await reopened.refresh(); await reopened.retry();
  expect(reopened.value).toEqual(value); expect(f.deliveries).toHaveLength(1);
  reopened.setConnection(f.host.host.id, true, true); await reopened.retry();
  expect(f.deliveries[1]!.envelope.id).toBe(f.deliveries[0]!.envelope.id);
  expect(f.store.get("sidebar.navigation")!.revision).toEqual(revision); expect(reopened.unsaved).toBe(false);
});
test("a definitive failure preserves intended visibility across reopen for explicit retry", async () => {
  const f = fixture(), data = f.reopen(); await data.refresh(); f.fail("rejected");
  const value = setSidebarDestinationHidden(DEFAULT_SIDEBAR_NAVIGATION, "scheduled", true);
  await data.save(value); expect(data.error).toContain("rejected"); expect(f.store.get("sidebar.navigation")).toBeUndefined();
  const reopened = f.reopen(); await reopened.refresh(); expect(reopened.value).toEqual(value); expect(reopened.unsaved).toBe(true);
  await reopened.retry(); expect(reopened.unsaved).toBe(false); expect(f.store.get("sidebar.navigation")).toMatchObject({ value });
});
test("a definitively rejected intent can be edited without discarding the remaining choices", async () => {
  const f = fixture(), data = f.reopen(); await data.refresh(); f.fail("rejected");
  await data.save(setSidebarDestinationHidden(DEFAULT_SIDEBAR_NAVIGATION, "scheduled", true));
  const corrected = setSidebarDestinationHidden(data.value, "plugins", true);
  await data.save(corrected);
  expect(f.store.get("sidebar.navigation")).toMatchObject({ value: corrected });
  expect(data.unsaved).toBe(false);
});
test("corrupt intent requires explicit recovery and retains its original bytes even if archival fails", async () => {
  const f = fixture(), data = f.reopen(); await data.refresh();
  const write = f.receipts.write; f.receipts.write = () => { throw new Error("disk full"); };
  await data.save(setSidebarDestinationHidden(DEFAULT_SIDEBAR_NAVIGATION, "plugins", true));
  expect(f.deliveries).toEqual([]); expect(data.error).toContain("disk full");
  f.receipts.write = write;
  const key = `agent-desktop:sidebar-navigation:${encodeURIComponent(f.host.host.id)}:intent:v1`;
  write(key, "{corrupt"); const reopened = f.reopen(); await reopened.refresh(); await reopened.save(DEFAULT_SIDEBAR_NAVIGATION);
  expect(reopened.writable).toBe(false); expect(f.receipts.read(key)).toBe("{corrupt"); expect(f.deliveries).toEqual([]);
  f.receipts.write = () => { throw new Error("disk full"); };
  await reopened.discardUnsaved(); expect(f.receipts.read(key)).toBe("{corrupt"); expect(reopened.writable).toBe(false);
  f.receipts.write = write;
  await reopened.discardUnsaved(); expect(f.receipts.read(key)).toBe("null"); expect([...f.values.values()]).toContain("{corrupt");
  const recovered = f.reopen(); await recovered.refresh(); await recovered.save(setSidebarDestinationHidden(DEFAULT_SIDEBAR_NAVIGATION, "plugins", true));
  expect(f.store.get("sidebar.navigation")).toMatchObject({ value: { hidden: ["plugins", "archive"] } });
});
test("corrupt intent cannot discard an uncertain command and does not prevent its original receipt retry", async () => {
  const f = fixture(), data = f.reopen(); await data.refresh(); f.fail("lost");
  const value = setSidebarDestinationHidden(DEFAULT_SIDEBAR_NAVIGATION, "plugins", true);
  await data.save(value);
  const key = `agent-desktop:sidebar-navigation:${encodeURIComponent(f.host.host.id)}:intent:v1`;
  f.receipts.write(key, "{corrupt");
  const reopened = f.reopen(); await reopened.refresh(); await reopened.discardUnsaved();
  expect(f.receipts.read(key)).toBe("{corrupt"); expect(f.deliveries).toHaveLength(1);
  await reopened.retry(); expect(f.deliveries[1]!.envelope.id).toBe(f.deliveries[0]!.envelope.id);
  await reopened.discardUnsaved();
  expect(reopened.value).toEqual(value); expect([...f.values.values()]).toContain("{corrupt");
  expect(f.deliveries).toHaveLength(2);
});
test("schema rejects incomplete, duplicate and unsupported destinations before persistence", () => {
  const f = fixture();
  for (const value of [{ ...DEFAULT_SIDEBAR_NAVIGATION, order: ["plugins"] }, { ...DEFAULT_SIDEBAR_NAVIGATION, hidden: ["plugins", "plugins"] }, { ...DEFAULT_SIDEBAR_NAVIGATION, hidden: ["sites"] }, { ...DEFAULT_SIDEBAR_NAVIGATION, version: 2 }]) {
    expect(() => f.store.put({ key: "sidebar.navigation", value } as never)).toThrow();
  }
  expect(f.store.get("sidebar.navigation")).toBeUndefined();
});

test("a mismatched successful receipt cannot discard sidebar intent and recovery checks the original command", async () => {
  const f = fixture();
  const data = new SidebarNavigationState(f.host.host.id, { ...f.bridge, command: async (envelope, owner) => {
    await f.bridge.command(envelope, owner);
    return { ok: true, commandId: envelope.id, value: { type: "preferences.put", preference: f.store.put({ key: "general.reduceMotion", value: true }) } };
  } }, f.cache, f.receipts);
  data.setConnection(f.host.host.id, true, true); await data.refresh();
  const value = setSidebarDestinationHidden(DEFAULT_SIDEBAR_NAVIGATION, "plugins", true);
  await data.save(value);
  expect(data.unsaved).toBe(true); expect(data.error).toContain("did not confirm");
  const reopened = f.reopen(); await reopened.refresh(); await reopened.retry();
  expect(reopened.unsaved).toBe(false); expect(reopened.value).toEqual(value);
  expect(f.deliveries[1]!.envelope.id).toBe(f.deliveries[0]!.envelope.id);
});
