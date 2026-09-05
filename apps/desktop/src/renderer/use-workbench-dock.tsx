import { useEffect, useRef, useState } from "react";
import type { DesktopBridge, WorkspaceTarget } from "../../../../packages/shared/src/protocol";
import type { WindowViewState, WorkspaceTab } from "../window-state";
import { createDockState, dockTabId, insertDockTab, type DockDestination, type DockState, type DockTab, type DockTarget } from "./dock-state";
import { hasNativeTerminalBridge } from "./native-terminal-state";
import { nativeTerminalClient } from "./native-terminal-bridge";
import { workspaceKey } from "./workspace-state";

export type DockSnapshot = NonNullable<WindowViewState["dock"]>;
export function targetFromDock(target: DockTarget): WorkspaceTarget {
  return target.startsWith("session:") ? { sessionId: target.slice(8) } : { projectId: target.slice(8) };
}
export function useWorkbenchDock(bridge: DesktopBridge, initial: WindowViewState, hostId: string, target: WorkspaceTarget | undefined, connected: boolean, onError: (message: string) => void) {
  const [snapshot, setSnapshot] = useState<DockSnapshot>(() => initial.dock ?? { state: createDockState(), tabs: [] });
  const [ready, setReady] = useState(Boolean(initial.dock) || !initial.workspaceOpen && !initial.terminalOpen);
  const pending = useRef(new Set<string>());
  const add = (tab: DockTab, destination: DockDestination) => {
    setReady(true);
    setSnapshot(previous => ({ tabs: previous.tabs.some(value => value.id === tab.id) ? previous.tabs : [...previous.tabs, tab], state: insertDockTab(previous.state, tab, destination) }));
  };
  function open(kind: Exclude<DockTab["kind"], "terminal">, destination: DockDestination = "right", owner = hostId, workspace = target) {
    if (!workspace) return;
    const descriptor = { kind, hostId: owner, target: workspaceKey(workspace) as DockTarget, title: kind === "review" ? "Review" : kind === "worktrees" ? "Worktrees" : "Files" };
    add({ ...descriptor, id: dockTabId(descriptor) }, destination);
  }
  const bindTerminal = (id: string, owner: string, workspace: WorkspaceTarget, destination: DockDestination, title = "Terminal") => {
    const descriptor = { kind: "terminal" as const, hostId: owner, target: workspaceKey(workspace) as DockTarget, terminalId: id, title };
    add({ ...descriptor, id: dockTabId(descriptor) }, destination);
  };
  async function terminal(destination: DockDestination = "bottom", create = false) {
    if (!target) return;
    const owner = hostId, workspace = target, key = `${owner}:${workspaceKey(workspace)}`;
    if (pending.current.has(key)) return;
    if (!connected) { onError("Reconnect to the owning host to open its terminals."); return; }
    if (!hasNativeTerminalBridge(bridge)) { onError("Update this desktop to open native terminal tabs."); return; }
    pending.current.add(key);
    try {
      const client = nativeTerminalClient(bridge);
      // Always refresh before a possible creation, including after an uncertain prior result.
      const catalog = await client.nativeTerminalQuery({ type: "list", target: workspace }, owner);
      if (catalog.type !== "list") throw new Error("The host returned an invalid terminal catalog.");
      const available = catalog.terminals.filter(value => workspaceKey(value.target) === workspaceKey(workspace));
      let selected: string | null = null;
      try { selected = localStorage.getItem(`terminal.native.selected.${owner}.${workspaceKey(workspace)}`); } catch { /* In-memory selection is sufficient. */ }
      let pane = create ? undefined : available.find(value => value.id === selected) ?? available[0];
      if (!pane) {
        const result = await client.nativeTerminalAction({ type: "create", options: { target: workspace, cols: 120, rows: 30 } }, owner);
        pane = result.terminal;
        if (!pane || workspaceKey(pane.target) !== workspaceKey(workspace)) throw new Error("Terminal creation was not confirmed. Refresh the catalog before starting another shell.");
      }
      bindTerminal(pane.id, owner, workspace, destination, pane.cwd.split("/").filter(Boolean).at(-1) ?? "Terminal");
      try { localStorage.setItem(`terminal.native.selected.${owner}.${workspaceKey(workspace)}`, pane.id); } catch { /* Window state still persists the identity. */ }
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current.delete(key); }
  }
  useEffect(() => {
    if (ready || !target || hostId === "unconnected") return;
    let next = createDockState(); const tabs: DockTab[] = [];
    const insert = (kind: DockTab["kind"], destination: DockDestination, terminalId?: string) => {
      const descriptor = { kind, hostId, target: workspaceKey(target) as DockTarget, terminalId, title: kind === "review" ? "Review" : kind === "worktrees" ? "Worktrees" : kind === "files" ? "Files" : "Terminal" };
      const tab = { ...descriptor, id: dockTabId(descriptor) }; tabs.push(tab); next = insertDockTab(next, tab, destination);
    };
    if (initial.workspaceOpen) insert(initial.workspaceTab === "changes" ? "review" : initial.workspaceTab, "right");
    if (initial.terminalOpen) {
      let id: string | null = null;
      try { id = localStorage.getItem(`terminal.native.selected.${hostId}.${workspaceKey(target)}`); } catch { /* Empty dock offers an explicit open action. */ }
      if (id && /^[a-zA-Z0-9_-]{1,200}$/.test(id)) insert("terminal", "bottom", id);
      else next.bottom.open = true;
    }
    setSnapshot({ state: next, tabs }); setReady(true);
  }, [ready, hostId, target && workspaceKey(target)]);
  function change(state: DockState) {
    setReady(true);
    const used = new Set([...state.right.tabIds, ...state.bottom.tabIds]);
    setSnapshot(previous => ({ state, tabs: previous.tabs.filter(tab => used.has(tab.id)) }));
  }
  function toggle(destination: DockDestination) {
    setReady(true); setSnapshot(previous => ({ ...previous, state: { ...previous.state, [destination]: { ...previous.state[destination], open: !previous.state[destination].open } } }));
  }
  const workspaceTab: WorkspaceTab = initial.workspaceTab;
  return { snapshot, persisted: ready ? snapshot : undefined, change, toggle, open, terminal, workspaceTab };
}
