import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CommandEnvelope, DesktopBridge, DesktopEvent, WorkspaceQuery, WorkspaceTarget } from "@agent-desktop/shared";
import { DockPanel } from "../../apps/desktop/src/renderer/DockPanel";
import { moveDockTab, type DockDestination, type DockTab } from "../../apps/desktop/src/renderer/dock-state";
import { offlineCache } from "../../apps/desktop/src/renderer/offline-cache";
import { useWorkbenchDock } from "../../apps/desktop/src/renderer/use-workbench-dock";
import { WorkspacePanel } from "../../apps/desktop/src/renderer/WorkspacePanel";
import { WorkspaceState } from "../../apps/desktop/src/renderer/workspace-state";
import { defaultFileTreeView, defaultWindowView, type FileTreeView } from "../../apps/desktop/src/window-state";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";
import "../../apps/desktop/src/renderer/dock-panel.css";

const params = new URLSearchParams(location.search);
const endpoint = params.get("endpoint")!;
const target = JSON.parse(params.get("target")!) as WorkspaceTarget;
const hostId = params.get("hostId")!;
const request = async (route: string, body: unknown) => {
  const response = await fetch(endpoint + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error((value as any).error?.message ?? `Workspace request failed (${response.status})`);
  return value as any;
};
const listeners = new Set<(event: DesktopEvent) => void>();
setInterval(() => void request("/test/events", {}).then(events => { for (const event of events) for (const listener of listeners) listener(event); }).catch(() => {}), 100);
const runtimeErrors: string[] = [], dockErrors: string[] = [];
const pointerEvents: Array<{ type: string; x: number; buttons: number; pointerId: number; target: string; path: string }> = [];
const dragProbes: Array<{ rect: Record<string, number>; start: { x: number; y: number }; target: string }> = [];
let treePointerActive = false;
for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const) addEventListener(type, event => {
  const target = event.target instanceof Element ? event.target : undefined;
  if (type === "pointerdown" && target?.closest(".workspace-file-tree-resize")) treePointerActive = true;
  if (treePointerActive) { const first = event.composedPath()[0]; pointerEvents.push({ type, x: event.clientX, buttons: event.buttons, pointerId: event.pointerId, target: target?.className?.toString() ?? target?.tagName ?? "", path: first instanceof Element ? first.className?.toString() || first.tagName : String(first) }); }
  if (type === "pointerup" || type === "pointercancel") treePointerActive = false;
}, true);
addEventListener("error", event => runtimeErrors.push(`${event.message}\n${event.error?.stack ?? ""}`));
addEventListener("unhandledrejection", event => runtimeErrors.push(String(event.reason?.stack ?? event.reason)));
const bridge = {
  workspaceQuery: (owner: WorkspaceTarget, query: WorkspaceQuery, selectedHost?: string) => request("/v1/workspace/query", { target: owner, query, owner: selectedHost }),
  command: (envelope: CommandEnvelope, selectedHost?: string) => request("/v1/commands", { ...envelope, owner: selectedHost }),
  subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
} as DesktopBridge;

let dock: ReturnType<typeof useWorkbenchDock>;
let workspace: WorkspaceState;
let currentFileTree: FileTreeView = defaultFileTreeView();
function Fixture() {
  const [connected] = useState(true);
  const [fileTree, setFileTree] = useState(defaultFileTreeView);
  currentFileTree = fileTree;
  workspace = useMemo(() => new WorkspaceState(bridge, hostId, target, offlineCache, hostId), []);
  useEffect(() => () => workspace.stop(), []);
  dock = useWorkbenchDock(bridge, defaultWindowView(), hostId, target, connected, message => dockErrors.push(message));
  const viewport = { width: innerWidth, height: innerHeight };
  const openFile = (path: string, destination: DockDestination = "right") => dock.openFile(path, hostId, target, destination);
  const renderTab = (tab: DockTab, active: boolean) => tab.kind === "file" && tab.filePath
    ? <WorkspacePanel embedded active={active} data={workspace} connected={connected} filePath={tab.filePath} onOpenFile={path => openFile(path)}
        fileTree={fileTree} onFileTreeChange={setFileTree}
        tab="files" name="Workspace fixture" path="/isolated/project" onClose={() => {}} onOpenProject={async () => {}}/>
    : <p>Unexpected dock tab.</p>;
  return <main className="workspace-file-dock-fixture">
    <div className="fixture-actions"><button onClick={() => dock.toggle("right")}>Show right dock</button><button onClick={() => dock.toggle("bottom")}>Show bottom dock</button></div>
    {(["right", "bottom"] as const).map(destination => <div className={`dock-slot dock-slot-${destination}`} key={destination}
      style={{ display: dock.snapshot.state[destination].open ? undefined : "none" }} inert={!dock.snapshot.state[destination].open || undefined}>
      <DockPanel destination={destination} state={dock.snapshot.state} tabs={dock.snapshot.tabs} viewport={viewport} onChange={dock.change}
        onTabDrop={(id, _from, to, index) => dock.change(moveDockTab(dock.snapshot.state, id, to, index))}
        renderTab={(tab, active) => renderTab(tab, active && dock.snapshot.state[destination].open)}/>
    </div>)}
  </main>;
}

document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture/>);
Object.assign(window, {
  request,
  openFile: (path: string, destination?: DockDestination) => dock.openFile(path, hostId, target, destination),
  editor(label?: string) {
    return [...document.querySelectorAll("diffs-container")].flatMap(node => [...(node.shadowRoot?.querySelectorAll<HTMLElement>('[contenteditable="true"]') ?? [])])
      .find(node => node.getClientRects().length && (!label || node.getAttribute("aria-label") === label));
  },
  target(selector: string, label?: string) {
    const node = [...document.querySelectorAll<HTMLElement>(selector)].filter(item => item.getClientRects().length)
      .find(item => label === undefined || item.textContent?.trim() === label || [...item.children].some(child => child.textContent?.trim() === label));
    if (!node) throw new Error(`Missing ${selector} ${label ?? ""}`);
    node.scrollIntoView({ block: "center" }); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  },
  treeDragPoints(requestedWidth: number) {
    const handle = [...document.querySelectorAll<HTMLElement>('.workspace-file-tree-resize')].find(node => node.getClientRects().length), body = [...document.querySelectorAll<HTMLElement>('.workspace-file-body')].find(node => node.getClientRects().length);
    if (!handle || !body) throw new Error('Visible tree resize geometry missing');
    const rect = handle.getBoundingClientRect(), bounds = body.getBoundingClientRect(), y = Math.round(rect.y + rect.height / 2);
    const x = [Math.ceil(rect.left + 1), Math.round(rect.left + rect.width / 2), Math.floor(rect.right - 1)].find(candidate => document.elementFromPoint(candidate, y)?.closest('.workspace-file-tree-resize') === handle);
    if (x === undefined) throw new Error(`Tree handle is not hit-testable at ${JSON.stringify(rect.toJSON())}`);
    const start = { x, y }, end = { x: Math.round(bounds.right - requestedWidth), y }, target = (document.elementFromPoint(x, y) as HTMLElement)?.className?.toString() ?? '';
    dragProbes.push({ rect: rect.toJSON(), start, target }); treePointerActive = true;
    return { start, end, mid: { x: Math.round((start.x + end.x) / 2), y } };
  },
  state() {
    const visible = <T extends HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)].find(node => node.getClientRects().length);
    const visibleInputs = [...document.querySelectorAll("diffs-container")].flatMap(node => [...(node.shadowRoot?.querySelectorAll<HTMLElement>('[contenteditable="true"]') ?? [])]).filter(node => node.getClientRects().length);
    const rootStyle = getComputedStyle(document.documentElement), bodyStyle = getComputedStyle(document.body);
    const breadcrumb = [...document.querySelectorAll<HTMLElement>(".workspace-file-breadcrumbs button")].find(node => node.getClientRects().length), breadcrumbStyle = breadcrumb ? getComputedStyle(breadcrumb) : undefined;
    const header = visible<HTMLElement>(".workspace-file-toolbar"), body = visible<HTMLElement>(".workspace-file-body"), main = visible<HTMLElement>(".workspace-file-main");
    const treePane = visible<HTMLElement>(".workspace-file-tree-pane"), treeFilter = visible<HTMLInputElement>('.workspace-file-tree-filter input'), treeShell = visible<HTMLElement>('.workspace-file-tree-shell'), treeStyle = treeShell ? getComputedStyle(treeShell) : undefined;
    return {
      ready: workspace?.restored, busy: workspace?.busy, pending: workspace?.pending, errors: workspace?.errors, notice: workspace?.notice, directory: workspace?.directory,
      documents: workspace ? Object.fromEntries([...workspace.documents].map(([path, value]) => [path, { text: value.text, dirty: value.dirty, conflict: value.conflict }])) : {},
      dock: dock?.snapshot, tabs: dock?.snapshot.tabs.map(tab => ({ id: tab.id, kind: tab.kind, path: tab.filePath, title: tab.title })),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visualViewportScale: visualViewport?.scale },
      rootFont: { family: rootStyle.fontFamily, size: rootStyle.fontSize, lineHeight: rootStyle.lineHeight, uiFamily: rootStyle.getPropertyValue("--ui-font").trim() },
      bodyFont: { family: bodyStyle.fontFamily, size: bodyStyle.fontSize, lineHeight: bodyStyle.lineHeight },
      breadcrumbFont: breadcrumbStyle && { family: breadcrumbStyle.fontFamily, size: breadcrumbStyle.fontSize, lineHeight: breadcrumbStyle.lineHeight },
      headerRect: header?.getBoundingClientRect().toJSON(),
      bodyRect: body?.getBoundingClientRect().toJSON(), mainRect: main?.getBoundingClientRect().toJSON(), treePaneRect: treePane?.getBoundingClientRect().toJSON(),
      fileTree: currentFileTree, treeTogglePressed: visible<HTMLElement>('.file-tree-toggle')?.getAttribute('aria-pressed'),
      treeFilter: treeFilter && { value: treeFilter.value, rect: treeFilter.getBoundingClientRect().toJSON() },
      treeFont: treeStyle && { family: treeStyle.fontFamily, size: treeStyle.fontSize, lineHeight: treeStyle.lineHeight },
      treeResizeRect: visible<HTMLElement>('.workspace-file-tree-resize')?.getBoundingClientRect().toJSON(),
      treeRows: [...document.querySelectorAll<HTMLElement>('.workspace-file-tree-pane [role="treeitem"]')].filter(node => node.getClientRects().length).map(node => ({
        text: node.textContent?.trim(), title: node.getAttribute('title'), expanded: node.getAttribute('aria-expanded'), selected: node.getAttribute('aria-selected'), rect: node.getBoundingClientRect().toJSON(),
      })),
      pickerRect: document.querySelector<HTMLElement>(".workspace-file-picker")?.getBoundingClientRect().toJSON(),
      visibleEditors: visibleInputs.map(node => { const style = getComputedStyle(node); return { label: node.getAttribute("aria-label"), text: node.textContent,
        font: { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight }, bounds: node.getBoundingClientRect().toJSON() }; }),
      editorFocused: visibleInputs.some(node => node.getRootNode().activeElement === node),
      picker: document.querySelector(".workspace-file-picker")?.textContent?.trim(),
      runtimeErrors: [...runtimeErrors], dockErrors: [...dockErrors], pointerEvents: [...pointerEvents], dragProbes: [...dragProbes],
    };
  },
});
