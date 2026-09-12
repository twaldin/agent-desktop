import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftBrowserPageIntent } from "../draft-browser-page-intent";
import { WindowStateStore } from "../main/window-state";
import { defaultWindowView, parseDockSnapshot, parseWindowView } from "../window-state";
import { createDockState, dockTabId, insertDockTab, type DockTab } from "./dock-state";
import { createDraftBrowserDockTab } from "./draft-browser-dock";
import { createBrowserNewTab } from "./browser-new-tab";

const owner = { version: 1 as const, hostId: "host_name", reference: { ownerId: "owner", draftId: "original", draftRevision: 1 } };
const snapshot = (tab: DockTab) => ({ tabs: [tab], state: insertDockTab(createDockState(), tab, "right") });
const raw = (instanceId: string): DockTab => {
  const tab = { ...createDraftBrowserDockTab(owner.hostId, owner.reference.draftId, "valid"), browserInstanceId: instanceId };
  return { ...tab, id: dockTabId(tab) };
};

test("factory rejects explicit draft instance IDs that the existing page intent cannot accept", () => {
  for (const instanceId of ["a_b", "_", "a b", "a/b", "é", "a".repeat(101), ""]) {
    expect(() => createDraftBrowserPageIntent(owner, instanceId)).toThrow("page identity");
    expect(() => createDraftBrowserDockTab(owner.hostId, owner.reference.draftId, instanceId)).toThrow("dock identity");
  }
});

test("saved draft parser independently rejects incompatible IDs without allocating replacement identity", () => {
  for (const instanceId of ["a_b", "_", "a".repeat(101)]) {
    const dock = snapshot(raw(instanceId));
    expect(parseDockSnapshot(dock)).toBeUndefined();
    expect(parseWindowView({ ...defaultWindowView(), dock })).toBeUndefined();
    expect(dock.tabs[0]?.browserInstanceId).toBe(instanceId);
  }
});

test("compatible explicit IDs survive actual save/reopen and bind unchanged to the page intent", () => {
  const dir = mkdtempSync(join(tmpdir(), "draft-instance-alphabet-"));
  try {
    const store = new WindowStateStore(dir, "primary");
    for (const instanceId of ["a", "Z", "0", "-", "Az09-", "a".repeat(100)]) {
      const tab = createDraftBrowserDockTab(owner.hostId, owner.reference.draftId, instanceId);
      expect(store.saveView({ ...defaultWindowView(), dock: snapshot(tab) })).toEqual({});
      const restored = new WindowStateStore(dir, "primary").bootstrap().state!.dock!.tabs[0]!;
      expect(restored.browserInstanceId).toBe(instanceId); expect(restored.id).toBe(tab.id);
      expect(createDraftBrowserPageIntent(owner, restored.browserInstanceId).instanceId).toBe(instanceId);
    }
    const before = store.bootstrap().state!;
    expect(store.saveView({ ...before, dock: snapshot(raw("a_b")) }).error).toBeDefined();
    expect(new WindowStateStore(dir, "primary").bootstrap().state).toEqual(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("draft correction preserves host and session underscore rules", () => {
  expect(createDraftBrowserDockTab("host_name", "original", "valid").hostId).toBe("host_name");
  const session = createBrowserNewTab("host_name", "session_name", "a_b");
  const parsed = parseDockSnapshot(snapshot(session));
  expect(parsed?.tabs[0]?.hostId).toBe("host_name"); expect(parsed?.tabs[0]?.target).toBe("session:session_name");
  expect(parsed?.tabs[0]?.browserInstanceId).toBe("a_b"); expect(parsed?.tabs[0]?.id).toBe(session.id);
});
