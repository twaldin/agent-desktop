import { expect, test } from "bun:test";
import { createDockState, dockTabId, insertDockTab, moveDockTab, type DockTab } from "./dock-state";
import { selectBrowserFile, type FileDockSnapshot } from "./file-preview-tabs";

function fixture(): { browser: DockTab; other: DockTab; snapshot: FileDockSnapshot } {
  const browser: DockTab = { id: "files:owner-b", kind: "files", hostId: "owner-b", target: "project:project-b", title: "Open file" };
  const other: DockTab = { id: "other", kind: "review", hostId: "owner-a", target: "session:session-a", title: "Review" };
  return { browser, other, snapshot: { state: insertDockTab(insertDockTab(createDockState(), other, "right"), browser, "bottom"), tabs: [browser, other] } };
}
test("browser selection follows current dock and preserves host, other tabs and pinned identity", () => {
  const { browser, other, snapshot } = fixture();
  const result = selectBrowserFile(snapshot, browser.id, "src/main.js");
  const selected = result.tabs.find(tab => tab.kind === "file")!;
  expect(selected).toMatchObject({ hostId: "owner-b", target: "project:project-b", filePath: "src/main.js" });
  expect(selected.preview).toBeUndefined();
  expect(result.state.bottom.activeTabId).toBe(selected.id);
  expect(result.state.bottom.open).toBe(true);
  expect(result.state.right.tabIds).toEqual([other.id]);
  expect(result.tabs.some(tab => tab.id === browser.id)).toBe(false);
  expect(selectBrowserFile(result, browser.id, "src/again.js")).toBe(result);
  const moved = { ...snapshot, state: moveDockTab(snapshot.state, browser.id, "right") };
  expect(selectBrowserFile(moved, browser.id, "src/main.js").state.right.activeTabId).toBe(selected.id);
});
test("invalid paths and closed browser do nothing; existing preview is promoted on explicit browser selection", () => {
  const { browser, other, snapshot } = fixture();
  for (const path of ["../escape", "/outside", "a/../b", ""]) expect(selectBrowserFile(snapshot, browser.id, path)).toBe(snapshot);
  expect(selectBrowserFile(snapshot, "closed", "src/main.js")).toBe(snapshot);
  const descriptor: Omit<DockTab, "id"> = { kind: "file", hostId: browser.hostId, target: browser.target, filePath: "src/main.js", title: "main.js", preview: true };
  const preview = { ...descriptor, id: dockTabId(descriptor) };
  const existing = { state: insertDockTab(snapshot.state, preview, "bottom"), tabs: [...snapshot.tabs, preview] };
  const result = selectBrowserFile(existing, browser.id, "src/main.js");
  expect(result.tabs.filter(tab => tab.filePath === "src/main.js")).toHaveLength(1);
  expect(result.tabs.find(tab => tab.id === preview.id)?.preview).toBeUndefined();
  expect(result.state.bottom.activeTabId).toBe(preview.id);
});

test("browser selection keeps an already-open file in its resolved dock and closes only the null tab", () => {
  const { browser, other, snapshot } = fixture();
  const descriptor: Omit<DockTab, "id"> = { kind: "file", hostId: browser.hostId, target: browser.target, filePath: "src/main.js", title: "main.js" };
  const existing = { ...descriptor, id: dockTabId(descriptor) };
  const withOppositeFile = { state: insertDockTab(snapshot.state, existing, "right"), tabs: [...snapshot.tabs, existing] };
  const result = selectBrowserFile(withOppositeFile, browser.id, "src/main.js");
  expect(result.tabs.filter(tab => tab.id === existing.id)).toHaveLength(1);
  expect(result.tabs.some(tab => tab.id === browser.id)).toBe(false);
  expect(result.state.bottom.tabIds).toEqual([]);
  expect(result.state.right.tabIds).toEqual([other.id, existing.id]);
  expect(result.state.right.activeTabId).toBe(existing.id);
});
