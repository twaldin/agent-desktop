import { expect, test } from "bun:test";
import React from "react";
import type { DesktopBridge } from "@agent-desktop/shared";
import { defaultWindowView, parseWindowView } from "../window-state";
import { captureDockPresentation, isCurrentDockPresentation } from "./dock-presentations";
import { closeDockTab, createDockState, dockTabId, insertDockTab, type DockTab } from "./dock-state";
import { mcpFileViewerDockTab } from "./mcp-app-dock";
import { useWorkbenchDock } from "./use-workbench-dock";

/** Runs the actual hook's queued state updates; it is not a mounted React test. */
function owner() {
  const slots: unknown[] = [], queue: Array<() => void> = []; let cursor = 0;
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (next: any) => queue.push(() => { slots[i] = typeof next === "function" ? next(slots[i]) : next; })]; },
    useRef(initial: unknown) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); }, useEffect() {},
  };
  const descriptor = { kind: "files" as const, hostId: "host", target: "session:session" as const, title: "Open file" }, file: DockTab = { ...descriptor, id: dockTabId(descriptor) };
  const initial = { ...defaultWindowView(), dock: { tabs: [file], state: insertDockTab(createDockState(), file, "right") } };
  return { file, flush() { while (queue.length) queue.shift()!(); }, render() { cursor = 0; const previous = internals.H; internals.H = dispatcher;
    try { return useWorkbenchDock({} as DesktopBridge, initial, "host", { sessionId: "session" }, true, message => { throw new Error(message); }); } finally { internals.H = previous; }
  } };
}
const viewer = () => mcpFileViewerDockTab("host", "session", "sample.note", { toolName: "viewer", title: "Viewer", resourceUri: "ui://viewer", extensions: ["note"] }, "server");
test("queued file opening rejects a closed and reopened original Files presentation, then permits a fresh deliberate selection", () => {
  const f = owner(); let dock = f.render(); const original = captureDockPresentation(dock.presentations, f.file.id)!;
  const current = (state = dock.presentations) => isCurrentDockPresentation(state, original);
  dock.change(closeDockTab(dock.snapshot.state, "right", f.file.id)); dock.open("files", "right"); dock.addMcpFileViewer(viewer(), current);
  f.flush(); dock = f.render(); expect(dock.snapshot.tabs.filter(tab => tab.kind === "mcp-app")).toEqual([]);
  const fresh = captureDockPresentation(dock.presentations, f.file.id)!;
  dock.addMcpFileViewer(viewer(), state => isCurrentDockPresentation(state ?? dock.presentations, fresh)); f.flush(); dock = f.render();
  expect(dock.snapshot.tabs.filter(tab => tab.kind === "mcp-app")).toHaveLength(1);
});
test("two queued opens retain one original file panel and the real window parser preserves its source without embedding result bytes", () => {
  const f = owner(); let dock = f.render(); const first = viewer(), second = viewer();
  dock.addMcpFileViewer(first, () => true); dock.addMcpFileViewer(second, () => true); f.flush(); dock = f.render();
  expect(dock.snapshot.tabs.filter(tab => tab.kind === "mcp-app")).toEqual([first]); expect(dock.snapshot.state.right.activeTabId).toBe(first.id);
  const parsed = parseWindowView({ ...defaultWindowView(), dock: dock.snapshot });
  expect(parsed?.dock?.tabs.find(tab => tab.kind === "mcp-app")?.mcpApp?.source).toEqual(first.mcpApp!.source);
});
