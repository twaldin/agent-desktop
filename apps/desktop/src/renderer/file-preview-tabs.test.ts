import { expect, test } from "bun:test";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import { createDockState, insertDockTab, type DockTab } from "./dock-state";
import { canReplaceFilePreview, changeFileDock, openFileTab, persistentFileTabs, pinFileTab, type FileDockSnapshot } from "./file-preview-tabs";
import { WorkspaceState } from "./workspace-state";

const tab = (id: string, owner = "host", target = "session:one", preview?: true): DockTab => ({ id, title: id, kind: "file", hostId: owner, target: target as DockTab["target"], filePath: `${id}.ts`, ...(preview ? { preview } : {}) });
function snapshot(...entries: Array<{ tab: DockTab; destination?: "right" | "bottom" }>): FileDockSnapshot {
  let state = createDockState(); const tabs: DockTab[] = [];
  for (const entry of entries) { state = insertDockTab(state, entry.tab, entry.destination ?? "right"); tabs.push(entry.tab); }
  return { state, tabs };
}
function workspace(): WorkspaceState {
  const data = new WorkspaceState({ subscribe: () => () => {}, workspaceQuery: async () => { throw new Error("unused"); }, command: async () => { throw new Error("unused"); } } as unknown as DesktopBridge, "host", { sessionId: "one" }, { read: async () => null, write: async () => {} });
  data.restored = true; return data;
}

test("replaces only the active region preview and preserves another owner's region", () => {
  const oldRight = tab("right-old", "host-a", "session:a", true), other = tab("bottom-other", "host-b", "session:b", true);
  const result = openFileTab(snapshot({ tab: oldRight }, { tab: other, destination: "bottom" }), tab("right-new", "host-a", "session:a"), "right", true, () => true);
  expect(result.tabs.map(value => value.id)).toEqual(["bottom-other", "right-new"]);
  expect(result.state.right.tabIds).toEqual(["right-new"]);
  expect(result.state.bottom.tabIds).toEqual(["bottom-other"]);
});

test("existing persistent identity is never demoted or moved, while explicit promotion pins preview", () => {
  const pinned = tab("pinned");
  const existing = openFileTab({ state: insertDockTab(createDockState(), pinned, "right"), tabs: [pinned] }, { ...pinned, preview: true }, "bottom", true, () => true);
  expect(existing.tabs[0]?.preview).toBeUndefined();
  expect(existing.state.right.tabIds).toEqual(["pinned"]);
  expect(existing.state.bottom.tabIds).toEqual([]);
  const preview = tab("preview", "host", "session:one", true);
  const promoted = pinFileTab(snapshot({ tab: preview }), "preview");
  expect(promoted.tabs[0]?.preview).toBeUndefined();
});

test("pins protected preview buffers and opens the next preview", () => {
  const old = tab("old", "host", "session:one", true), next = tab("next");
  const result = openFileTab(snapshot({ tab: old }), next, "right", true, () => false);
  expect(result.tabs.map(value => ({ id: value.id, preview: value.preview }))).toEqual([{ id: "old", preview: undefined }, { id: "next", preview: true }]);
  expect(result.state.right.tabIds).toEqual(["old", "next"]);
});

test("persists pane visibility and pinned file metadata while dropping previews", () => {
  const preview = { ...tab("preview", "host-a", "session:a", true), fileMode: "source" as const, fileScroll: { source: 42 } };
  const pinned = { ...tab("pinned", "host-b", "session:b"), fileMode: "markdown" as const, fileScroll: { markdown: 9 } };
  const source = snapshot({ tab: preview }, { tab: pinned, destination: "bottom" });
  source.state.right.open = true; source.state.bottom.open = true;
  const persisted = persistentFileTabs(source);
  expect(persisted.state.right).toMatchObject({ tabIds: [], open: true });
  expect(persisted.state.bottom).toMatchObject({ tabIds: ["pinned"], open: true });
  expect(persisted.tabs).toEqual([pinned]);
  expect(persisted.tabs[0]).toMatchObject({ id: "pinned", hostId: "host-b", target: "session:b", fileMode: "markdown", fileScroll: { markdown: 9 } });
});

test("moving a preview into an occupied region replaces only a clean destination preview", () => {
  const incoming = tab("incoming", "host-a", "session:a", true), clean = tab("clean", "host-a", "session:a", true);
  const before = snapshot({ tab: incoming }, { tab: clean, destination: "bottom" });
  const moved = { ...before.state, right: { ...before.state.right, tabIds: [] }, bottom: { ...before.state.bottom, tabIds: [clean.id, incoming.id], activeTabId: incoming.id } };
  const result = changeFileDock(before, moved, () => true);
  expect(result.tabs.map(value => value.id)).toEqual(["incoming"]);
  expect(result.tabs[0]?.preview).toBe(true);
  expect(result.state.bottom.tabIds).toEqual(["incoming"]);
});

test("moving a preview into a protected destination pins the old preview and keeps the moved tab preview", () => {
  const incoming = tab("incoming", "host-a", "session:a", true), protectedTab = tab("protected", "host-a", "session:a", true);
  const before = snapshot({ tab: incoming }, { tab: protectedTab, destination: "bottom" });
  const moved = { ...before.state, right: { ...before.state.right, tabIds: [] }, bottom: { ...before.state.bottom, tabIds: [protectedTab.id, incoming.id], activeTabId: incoming.id } };
  const result = changeFileDock(before, moved, () => false);
  expect(result.tabs.map(value => ({ id: value.id, preview: value.preview }))).toEqual([{ id: "incoming", preview: true }, { id: "protected", preview: undefined }]);
  expect(result.state.bottom.tabIds).toEqual(["protected", "incoming"]);
});

test("canReplaceFilePreview protects recovery, edit, conflict, and pending-write states", () => {
  const clean = workspace();
  expect(canReplaceFilePreview(clean, "file.ts")).toBe(true);
  clean.documents.set("file.ts", { content: null, text: "changed", dirty: true });
  expect(canReplaceFilePreview(clean, "file.ts")).toBe(false);
  const protectedStates = [
    { conflict: null },
    { recoveredText: "recovered" },
    { saveError: "write failed" },
  ];
  for (const state of protectedStates) {
    clean.documents.set("file.ts", { content: null, text: "", dirty: false, ...state });
    expect(canReplaceFilePreview(clean, "file.ts")).toBe(false);
  }
  clean.documents.delete("file.ts");
  clean.pending = { envelope: { id: "save", command: { type: "workspace.mutate", target: { sessionId: "one" }, action: { type: "file.write", path: "file.ts", text: "pending", expectedRevision: null, bom: false } } }, uncertain: false };
  expect(canReplaceFilePreview(clean, "file.ts")).toBe(false);
  clean.pending = undefined; clean.restored = false;
  expect(canReplaceFilePreview(clean, "file.ts")).toBe(false);
  clean.restored = true; clean.cacheWarning = "Recovery is loading";
  expect(canReplaceFilePreview(clean, "file.ts")).toBe(false);
});
