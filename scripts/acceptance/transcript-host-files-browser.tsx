import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CommandEnvelope, DesktopBridge, DesktopEvent, WorkspaceQuery, WorkspaceTarget } from "../../packages/shared/src/protocol";
import { DockPanel } from "../../apps/desktop/src/renderer/DockPanel";
import { MarkdownText, TranscriptMarkdownContext } from "../../apps/desktop/src/renderer/MarkdownText";
import { TranscriptFileReference } from "../../apps/desktop/src/renderer/TranscriptFileReference";
import { WorkspacePanel } from "../../apps/desktop/src/renderer/WorkspacePanel";
import { canReplaceFilePreview } from "../../apps/desktop/src/renderer/file-preview-tabs";
import { offlineCache } from "../../apps/desktop/src/renderer/offline-cache";
import { routedTranscriptHostFileActions } from "../../apps/desktop/src/renderer/transcript-file-actions";
import type { TranscriptLinkActions, WorkspaceFileLink, WorkspaceFileRequest } from "../../apps/desktop/src/renderer/transcript-links";
import { targetFromDock, useWorkbenchDock } from "../../apps/desktop/src/renderer/use-workbench-dock";
import { WorkspaceState, workspaceKey } from "../../apps/desktop/src/renderer/workspace-state";
import { defaultWindowView } from "../../apps/desktop/src/window-state";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";
import "../../apps/desktop/src/renderer/dock-panel.css";
import "../../apps/desktop/src/renderer/dock-layout.css";

const params = new URLSearchParams(location.search);
const endpoint = params.get("endpoint")!, hostId = params.get("hostId")!;
const ordinaryPath = params.get("ordinaryPath")!, literalPath = params.get("literalPath")!, missingPath = params.get("missingPath")!;
const markdown = `[Markdown absolute at line 2 column 7](${encodeURI(ordinaryPath)}#L2C7)\n\n[Missing absolute](${encodeURI(missingPath)})`;
const request = async (route: string, body: unknown) => { const response = await fetch(endpoint + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const value = await response.json(); if (!response.ok) throw new Error(value?.error?.message ?? value?.error ?? `Request failed (${response.status})`); return value as any; };
const listeners = new Set<(event: DesktopEvent) => void>(), runtimeErrors: string[] = [], opened: Array<WorkspaceFileLink & { preview: boolean }> = [];
setInterval(() => void request("/test/events", {}).then(events => { for (const event of events) for (const listener of listeners) listener(event); }).catch(() => {}), 100);
window.addEventListener("error", event => runtimeErrors.push(`${event.message}\n${event.error?.stack ?? ""}`));
window.addEventListener("unhandledrejection", event => runtimeErrors.push(String(event.reason?.stack ?? event.reason)));
const bridge = {
  ...(window as any).agentDesktop,
  workspaceQuery: (target: WorkspaceTarget, query: WorkspaceQuery, owner?: string) => request("/v1/workspace/query", { target, query, owner }),
  command: (envelope: CommandEnvelope, owner?: string) => request("/v1/commands", { ...envelope, owner }),
  subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
} as DesktopBridge;

const states = new Map<string, WorkspaceState>();
let connectedNow = true, current: WorkspaceState | undefined, dock: ReturnType<typeof useWorkbenchDock>;
let setConnection: (value: boolean) => void, recreateCurrent: () => void;
function stateFor(file: WorkspaceFileLink) {
  if (!file.path.startsWith("/")) throw new Error("Fixture accepts exact absolute transcript files only.");
  const target: WorkspaceTarget = { filePath: file.path }, key = `${hostId}:${workspaceKey(target)}`;
  let data = states.get(key);
  if (!data) { data = new WorkspaceState(bridge, hostId, target, offlineCache, hostId); data.setConnected(connectedNow); states.set(key, data); }
  return data;
}
function activeLine() {
  const root = document.querySelector("diffs-container")?.shadowRoot;
  const selection = document.getSelection();
  let selected: Element | null = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement ?? null;
  selected = selected?.closest?.("[data-line]") ?? null;
  return { selectionLine: selected instanceof HTMLElement && selected.dataset.line ? Number(selected.dataset.line) : undefined, anchorOffset: selection?.anchorOffset,
    marked: [...(root?.querySelectorAll<HTMLElement>("[data-line]") ?? [])].filter(node => [...node.attributes].some(attribute => /active|select|cursor/i.test(attribute.name + attribute.value))).map(node => Number(node.dataset.line)) };
}

function Fixture() {
  const [connected, changeConnected] = useState(true), [fileRequest, setFileRequest] = useState<{ owner: string; request: WorkspaceFileRequest }>(), [, redraw] = useState(0);
  connectedNow = connected;
  setConnection = value => { connectedNow = value; for (const data of states.values()) data.setConnected(value); changeConnected(value); };
  dock = useWorkbenchDock(bridge, defaultWindowView(), hostId, undefined, connected, message => runtimeErrors.push(message), tab => tab.kind === "file" && Boolean(tab.filePath) && canReplaceFilePreview(states.get(`${tab.hostId}:${tab.target}`), tab.filePath!));
  const getWorkspace = (file: WorkspaceFileLink) => stateFor(file);
  const routed = useMemo(() => routedTranscriptHostFileActions(getWorkspace), []);
  const openFile: NonNullable<TranscriptLinkActions["openFile"]> = (file, options) => {
    const data = stateFor(file), owner = `${hostId}:${workspaceKey(data.target)}`, preview = options?.preview ?? true;
    opened.push({ ...file, preview });
    setFileRequest({ owner, request: { ...file, path: data.standaloneName!, id: crypto.randomUUID() } });
    dock.openHostFile(file.path, hostId, "right", preview);
  };
  const actions: TranscriptLinkActions = { ownerKey: `${hostId}:transcript-host-files:${connected}`, ...routed, openFile };
  recreateCurrent = () => {
    if (!current) return;
    const key = `${hostId}:${workspaceKey(current.target)}`, target = current.target;
    current.stop();
    const replacement = new WorkspaceState(bridge, hostId, target, offlineCache, hostId); replacement.setConnected(connectedNow); states.set(key, replacement); current = replacement; redraw(value => value + 1);
  };
  useEffect(() => () => { for (const data of states.values()) data.stop(); }, []);
  const rightSize = dock.snapshot.state.right.open ? Math.max(320, Math.min(innerWidth - 352, dock.snapshot.state.rightWidthRatio * innerWidth)) : 0;
  return <div className="workbench transcript-host-files-fixture" style={{ "--right-dock-size": `${rightSize}px`, "--bottom-dock-size": "0px" } as React.CSSProperties}>
    <section className="main-panel fixture-transcript" aria-label="Transcript file references"><TranscriptMarkdownContext value={{ actions }}>
      <MarkdownText text={markdown} blockKey="transcript-host-files"/>
      <p><TranscriptFileReference path={literalPath} label="Native literal special path"/></p>
    </TranscriptMarkdownContext></section>
    <div className="dock-slot dock-slot-right"><DockPanel destination="right" state={dock.snapshot.state} tabs={dock.snapshot.tabs} viewport={{ width: innerWidth, height: innerHeight }} onChange={dock.change} onPinTab={dock.pinFile}
      renderTab={(tab, active) => {
        if (tab.kind !== "file" || !tab.filePath || tab.target === "host") return null;
        const target = targetFromDock(tab.target), absolutePath = "filePath" in target ? target.filePath : "", owner = `${tab.hostId}:${workspaceKey(target)}`;
        const data = stateFor({ path: absolutePath }); current = active ? data : current;
        const parent = absolutePath.slice(0, absolutePath.lastIndexOf("/")) || "/";
        return <WorkspacePanel embedded active={active} data={data} connected={connected} filePath={tab.filePath} fileMode={tab.fileMode} onFileModeChange={mode => dock.setFileMode(tab.id, mode)}
          onFileEdit={() => dock.pinFile(tab.id)} fileRequest={fileRequest?.owner === owner && fileRequest.request.path === tab.filePath ? fileRequest.request : undefined}
          onOpenFile={(path, location, options) => openFile({ path: path.startsWith("/") ? path : `${parent}/${path}`, ...location }, options)} name={tab.title} path={parent} tab="files" onClose={() => {}} onOpenProject={async () => {}}/>;
      }}/></div>
  </div>;
}

document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture/>);
const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter(node => node.getClientRects().length);
Object.assign(window, {
  request,
  connection: (value: boolean) => setConnection(value),
  recreateCurrent: () => recreateCurrent(),
  editor: () => visible("diffs-container").flatMap(node => [...(node.shadowRoot?.querySelectorAll<HTMLElement>('[contenteditable="true"]') ?? [])]).find(node => node.getClientRects().length),
  target(selector: string, label?: string) { const node = visible(selector).find(item => label === undefined || item.textContent?.trim() === label || item.getAttribute("aria-label") === label); if (!node) throw new Error(`Missing ${selector} ${label ?? ""}`); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; },
  state() {
    const tab = dock?.snapshot.tabs.find(item => item.id === dock.snapshot.state.right.activeTabId), data = current;
    const doc = tab?.kind === "file" && tab.filePath ? data?.documents.get(tab.filePath) : undefined;
    return { body: document.body.innerText, connected: data?.connected, restored: data?.restored, mountedTarget: data?.target, standalonePath: data?.standalonePath, text: doc?.text, dirty: doc?.dirty, errors: data?.errors ?? {}, pending: data?.pending, busy: data?.busy,
      tabs: dock?.snapshot.tabs, activeTabId: dock?.snapshot.state.right.activeTabId, opened: [...opened], activeLine: activeLine(), runtimeErrors: [...runtimeErrors], menu: visible('[role="menu"][aria-label="File actions"]').length,
      references: visible("[data-file-reference]").map(node => ({ text: node.textContent, title: node.title })), ui: { fileTree: Boolean(document.querySelector(".workspace-file-tree-pane,.file-tree-toggle")), workspaceTabs: Boolean(document.querySelector(".workspace-tabs")), review: Boolean(document.querySelector(".review-panel")) },
      layout: { workbench: document.querySelector<HTMLElement>(".workbench")?.getBoundingClientRect().toJSON(), dockSlot: document.querySelector<HTMLElement>(".dock-slot-right")?.getBoundingClientRect().toJSON(), panel: document.querySelector<HTMLElement>(".workspace-panel")?.getBoundingClientRect().toJSON(), editor: document.querySelector<HTMLElement>(".pierre-source-editor")?.getBoundingClientRect().toJSON() },
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale } };
  },
});
