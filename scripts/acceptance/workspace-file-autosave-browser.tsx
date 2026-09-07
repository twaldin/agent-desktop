import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CommandEnvelope, DesktopBridge, DesktopEvent, WorkspaceQuery, WorkspaceTarget } from "@agent-desktop/shared";
import { WorkspacePanel } from "../../apps/desktop/src/renderer/WorkspacePanel";
import { WORKSPACE_AUTOSAVE_DELAY_MS, WorkspaceState } from "../../apps/desktop/src/renderer/workspace-state";
import { offlineCache } from "../../apps/desktop/src/renderer/offline-cache";
import type { WorkspaceFileRequest } from "../../apps/desktop/src/renderer/transcript-links";
import { useWorkspaceFileClose } from "../../apps/desktop/src/renderer/WorkspaceFileClose";
import { DockPanel } from "../../apps/desktop/src/renderer/DockPanel";
import { createDockState, insertDockTab, moveDockTab, type DockDestination, type DockState, type DockTab } from "../../apps/desktop/src/renderer/dock-state";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

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
const runtimeErrors: string[] = [];
addEventListener("error", event => runtimeErrors.push(`${event.message}\n${event.error?.stack ?? ""}`));
addEventListener("unhandledrejection", event => runtimeErrors.push(String(event.reason?.stack ?? event.reason)));
const bridge = {
  workspaceQuery: (owner: WorkspaceTarget, query: WorkspaceQuery, selectedHost?: string) => request("/v1/workspace/query", { target: owner, query, owner: selectedHost }),
  command: (envelope: CommandEnvelope, selectedHost?: string) => request("/v1/commands", { ...envelope, owner: selectedHost }),
  subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
} satisfies Pick<DesktopBridge, "workspaceQuery" | "command" | "subscribe">;

let setConnection: (value: boolean) => void;
let setPanelActive: (value: boolean) => void;
let recreateState: () => void;
let issueFileRequest: (path: string, line?: number, column?: number) => void;
let beginClose: (path: string) => void;
let selectFile: (path: string) => void;
let currentFilePath = "first.ts";
let currentDockState: DockState;
let reopenDock: (path: string, destination?: DockDestination) => void;
const closeResults: Array<{ path: string; allowed: boolean }> = [];
let current: WorkspaceState;
function Fixture() {
  const [connected, setConnected] = useState(true);
  const [active, setActive] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [fileRequest, setFileRequest] = useState<WorkspaceFileRequest>();
  const [filePath, setFilePath] = useState("first.ts");
  currentFilePath = filePath; selectFile = setFilePath;
  setConnection = setConnected;
  setPanelActive = setActive;
  recreateState = () => setGeneration(value => value + 1);
  issueFileRequest = (path, line, column) => setFileRequest({ id: crypto.randomUUID(), path, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) });
  const data = useMemo(() => new WorkspaceState(bridge, hostId, target, offlineCache, hostId), [generation]);
  current = data;
  const fileClose = useWorkspaceFileClose(tab => tab.hostId === hostId ? data : undefined);
  const dockTarget = "projectId" in target ? `project:${target.projectId}` as const : `session:${target.sessionId}` as const;
  const dockTabs = useMemo<DockTab[]>(() => ["first.ts", "second.ts"].map(path => ({ id: `autosave:${path}`, title: path, kind: "file", hostId, target: dockTarget, filePath: path })), [dockTarget]);
  const [dockState, setDockState] = useState(() => dockTabs.reduce((state, tab) => insertDockTab(state, tab, "right"), createDockState())); currentDockState = dockState;
  reopenDock = (path, destination = "right") => { const tab = dockTabs.find(value => value.filePath === path)!; setDockState(state => insertDockTab(state, tab, destination)); };
  beginClose = path => {
    const tab: DockTab = { id: `autosave:${path}`, title: path.split("/").at(-1)!, kind: "file", hostId, target: dockTarget, filePath: path };
    void fileClose.onBeforeClose(tab).then(allowed => closeResults.push({ path, allowed }));
  };
  useEffect(() => () => data.stop(), [data]);
  return <main className="workspace-file-fixture"><WorkspacePanel embedded data={data} connected={connected} name="Workspace fixture" path="/isolated/project"
    active={active} filePath={filePath} onOpenFile={setFilePath} fileRequest={fileRequest} onClose={() => {}} onOpenProject={async () => {}}/>
    <div className="autosave-close-docks">{(["right", "bottom"] as const).map(destination => <DockPanel key={destination} destination={destination} state={dockState} tabs={dockTabs} viewport={{ width: 600, height: 500 }} onChange={setDockState} onBeforeClose={fileClose.onBeforeClose}
      onTabDrop={(id, _from, to, index) => setDockState(state => moveDockTab(state, id, to, index))} renderTab={tab => <p>{tab.filePath} close consumer</p>}/>)}</div>{fileClose.dialog}</main>;
}
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture/>);
Object.assign(window, {
  request,
  connection: (value: boolean) => setConnection(value),
  active: (value: boolean) => setPanelActive(value),
  recreateState: () => recreateState(),
  openRequest: (path: string, line?: number, column?: number) => issueFileRequest(path, line, column),
  beginClose: (path: string) => beginClose(path),
  selectFile: (path: string) => selectFile(path),
  reopenDock: (path: string, destination?: DockDestination) => reopenDock(path, destination),
  editor(label?: string) {
    return [...document.querySelectorAll("diffs-container")].flatMap(node => [...(node.shadowRoot?.querySelectorAll<HTMLElement>('[contenteditable="true"]') ?? [])])
      .find(node => !label || node.getAttribute("aria-label") === label);
  },
  search() { return [...document.querySelectorAll("diffs-container")].map(node => node.shadowRoot?.querySelector<HTMLInputElement>('input[placeholder="Search"]')).find(Boolean); },
  target(selector: string, label?: string) {
    const node = [...document.querySelectorAll<HTMLElement>(selector)].filter(item => item.getClientRects().length).find(item => label === undefined || item.textContent?.trim() === label || [...item.children].some(child => child.textContent?.trim() === label));
    if (!node) throw new Error(`Missing ${selector} ${label ?? ""}`);
    node.scrollIntoView({ block: "center" }); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  },
  state() {
    const editorDocument = current.documents.get(currentFilePath);
    const inputs = [...globalThis.document.querySelectorAll("diffs-container")].flatMap(node => [...(node.shadowRoot?.querySelectorAll<HTMLElement>('[contenteditable="true"]') ?? [])]);
    return { body: globalThis.document.body.innerText, opened: currentFilePath, workspaceOpened: current.opened, text: editorDocument?.text, dirty: editorDocument?.dirty, autosave: editorDocument?.autosave, saveError: editorDocument?.saveError, discardedSaveId: editorDocument?.discardedSaveId,
      conflict: editorDocument?.conflict, recoveredText: editorDocument?.recoveredText, connected: current.connected, restored: current.restored,
      pending: current.pending, busy: current.busy, cacheWarning: current.cacheWarning, errors: current.errors, notice: current.notice,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visualViewportScale: visualViewport?.scale }, bodyFont: getComputedStyle(globalThis.document.body).font, theme: globalThis.document.documentElement.dataset.theme,
      editorBackground: getComputedStyle(globalThis.document.querySelector(".pierre-source-editor") ?? globalThis.document.body).backgroundColor,
      editors: [...globalThis.document.querySelectorAll("diffs-container")].map(node => ({ hidden: Boolean(node.closest("[hidden]")), label: node.shadowRoot?.querySelector('[contenteditable="true"]')?.getAttribute("aria-label") })),
      editorGeometry: inputs.filter(node => node.getClientRects().length).map(node => ({ label: node.getAttribute("aria-label"), bounds: node.getBoundingClientRect().toJSON(), font: getComputedStyle(node).font, lineHeight: getComputedStyle(node).lineHeight })),
      active: (globalThis.document.activeElement as HTMLElement | null)?.getAttribute("aria-label"), autosaveDelayMs: WORKSPACE_AUTOSAVE_DELAY_MS, closeResults: [...closeResults], dockState: currentDockState, runtimeErrors: [...runtimeErrors] };
  },
});
