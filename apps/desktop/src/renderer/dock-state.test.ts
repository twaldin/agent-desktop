import { describe, expect, test } from "bun:test";
import { activateDockTab, closeDockTab, createDockState, dockTabId, hideDock, insertDockTab, moveDockTab, reorderDockTab, resizeDock, validateDockState, type DockTab } from "./dock-state";

const viewport = { width: 1200, height: 800 };
const tabs: DockTab[] = ["files", "review", "terminal"].map(kind => ({ id: `home:project:demo:${kind}`, title: kind, kind: kind as DockTab["kind"], hostId: "home", target: "project:demo" }));

describe("dock state", () => {
  test("owner-qualified IDs and insertion dedupe across destinations", () => {
    expect(dockTabId({ hostId: "home", target: "project:demo", kind: "files" })).toBe("home:project:demo:files");
    let state = insertDockTab(createDockState(), tabs[0]!, "right"); state = insertDockTab(state, tabs[1]!, "bottom"); state = insertDockTab(state, tabs[0]!, "bottom");
    expect(state.right).toMatchObject({ tabIds: [tabs[0]!.id], activeTabId: tabs[0]!.id, open: true }); expect(state.bottom.tabIds).toEqual([tabs[1]!.id]);
  });
  test("hide differs from close and closing selects the nearest neighbor", () => {
    let state = tabs.reduce((current, tab) => insertDockTab(current, tab, "right"), createDockState()); state = activateDockTab(state, "right", tabs[1]!.id);
    expect(hideDock(state, "right").right).toMatchObject({ open: false, activeTabId: tabs[1]!.id });
    state = closeDockTab(state, "right", tabs[1]!.id); expect(state.right).toMatchObject({ tabIds: [tabs[0]!.id, tabs[2]!.id], activeTabId: tabs[2]!.id });
  });
  test("moves and reorders tabs while retaining their active identity", () => {
    let state = tabs.reduce((current, tab) => insertDockTab(current, tab, "right"), createDockState()); state = moveDockTab(state, tabs[1]!.id, "bottom"); state = reorderDockTab(state, "right", tabs[2]!.id, 0);
    expect(state.bottom).toMatchObject({ tabIds: [tabs[1]!.id], activeTabId: tabs[1]!.id, open: true }); expect(state.right.tabIds).toEqual([tabs[2]!.id, tabs[0]!.id]);
  });
  test("validates stale tabs and bounds persisted geometry", () => {
    const state = validateDockState({ right: { tabIds: [tabs[0]!.id, tabs[0]!.id, "stale"], activeTabId: "stale", open: true }, bottom: { tabIds: [tabs[0]!.id], activeTabId: tabs[0]!.id, open: true }, rightWidthRatio: 9, bottomHeight: 4 }, tabs, viewport);
    expect(state.right).toMatchObject({ tabIds: [tabs[0]!.id], activeTabId: tabs[0]!.id, open: true }); expect(state.bottom.tabIds).toEqual([]); expect(state.rightWidthRatio).toBeLessThan(1); expect(state.bottomHeight).toBe(160);
    expect(resizeDock(state, "bottom", 9_999, viewport).bottomHeight).toBe(400);
    expect(resizeDock(state, "bottom", Number.NaN, { width: 100, height: 100 }).bottomHeight).toBe(50);
  });
});
