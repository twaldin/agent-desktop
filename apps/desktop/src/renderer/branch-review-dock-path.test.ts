import { expect, test } from "bun:test";
import { parseDockSnapshot } from "../window-state";
import { createDockState, dockTabId, insertDockTab, isWorkspaceFilePath } from "./dock-state";

test("literal POSIX backslash filenames survive owning dock identity and restoration", () => {
  const descriptor = { kind: "file" as const, title: "literal path", hostId: "fixture", target: "project:fixture" as const, filePath: "src\\literal/name\\file.txt" };
  expect(isWorkspaceFilePath(descriptor.filePath)).toBe(true);
  const tab = { ...descriptor, id: dockTabId(descriptor) };
  const restored = parseDockSnapshot(JSON.parse(JSON.stringify({ state: insertDockTab(createDockState(), tab, "right"), tabs: [tab] })));
  expect(restored!.tabs[0]).toMatchObject(tab);
  expect(restored!.state.right.activeTabId).toBe(tab.id);
  for (const path of ["", "/absolute", "a//b", ".", "a/./b", "a/../b", "bad\0name", "line\nname", "tab\tname"])
    expect(isWorkspaceFilePath(path)).toBe(false);
});
