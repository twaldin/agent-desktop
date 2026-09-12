import { closeDockTab, dockTabId, isWorkspaceFilePath, insertDockTab, type DockDestination, type DockState, type DockTab } from "./dock-state";
import type { WorkspaceState } from "./workspace-state";

export interface FileDockSnapshot { state: DockState; tabs: DockTab[] }
/** Preview content is window-local and transient, even though the panel's visibility is durable. */
export function persistentFileTabs(snapshot: FileDockSnapshot): FileDockSnapshot {
  let state = snapshot.state;
  const previews = new Set(snapshot.tabs.filter(tab => tab.preview).map(tab => tab.id));
  if (!previews.size) return snapshot;
  for (const destination of ["right","bottom"] as const) {
    for (const id of snapshot.state[destination].tabIds) if (previews.has(id)) state = closeDockTab(state,destination,id);
    state = {...state,[destination]:{...state[destination],open:snapshot.state[destination].open}};
  }
  // Dropping transient descriptors must not change this window’s chosen layout.
  if (snapshot.state.rightLayout) state = {...state,rightLayout:snapshot.state.rightLayout};
  return {state,tabs:snapshot.tabs.filter(tab => !previews.has(tab.id))};
}
export function pinFileTab(snapshot: FileDockSnapshot, id: string): FileDockSnapshot {
  const tab = snapshot.tabs.find(tab => tab.id === id && tab.kind === "file" && tab.preview);
  if (!tab) return snapshot;
  const {preview: _preview, ...pinned} = tab;
  return {...snapshot,tabs:snapshot.tabs.map(item => item === tab ? pinned : item)};
}

/** Moving a preview carries its replaceable status and consumes the destination's preview slot. */
export function changeFileDock(snapshot: FileDockSnapshot, state: DockState, replaceable: (tab: DockTab) => boolean): FileDockSnapshot {
  const used = new Set([...state.right.tabIds,...state.bottom.tabIds]);
  let next = {state,tabs:snapshot.tabs.filter(tab => used.has(tab.id))};
  for (const destination of ["right","bottom"] as const) {
    const incoming = next.tabs.find(tab => tab.preview && state[destination].tabIds.includes(tab.id) && !snapshot.state[destination].tabIds.includes(tab.id));
    if (!incoming) continue;
    for (const id of state[destination].tabIds) {
      const old = next.tabs.find(tab => tab.id === id && tab.id !== incoming.id && tab.preview);
      if (!old) continue;
      if (!replaceable(old)) next = pinFileTab(next,old.id);
      else next = {state:closeDockTab(next.state,destination,id),tabs:next.tabs.filter(tab => tab.id !== id)};
    }
  }
  return next;
}

/** Unknown/recovering buffers are protected too; preview replacement is never a save/discard action. */
export function canReplaceFilePreview(data: WorkspaceState | undefined, path: string): boolean {
  if (!data?.restored || data.cacheWarning) return false;
  const document = data.documents.get(path), action = data.pending?.envelope.command.action;
  return !document?.dirty && document?.conflict === undefined && document?.recoveredText === undefined && !document?.saveError && !(action?.type === "file.write" && action.path === path);
}

/** Mirrors the reference panel's single preview slot. Existing pinned tabs are never demoted. */
export function openFileTab(snapshot: FileDockSnapshot, tab: DockTab, destination: DockDestination, preview: boolean, replaceable: (tab: DockTab) => boolean): FileDockSnapshot {
  const existing = snapshot.tabs.find(item => item.id === tab.id);
  if (existing) {
    const current = preview ? snapshot : pinFileTab(snapshot, existing.id);
    return {...current,state:insertDockTab(current.state,existing,destination)};
  }
  let next = snapshot;
  if (preview) {
    for (const id of snapshot.state[destination].tabIds) {
      const old = next.tabs.find(item => item.id === id && item.kind === "file" && item.preview);
      if (!old) continue;
      if (!replaceable(old)) { next = pinFileTab(next,old.id); continue; }
      next = {state:closeDockTab(next.state,destination,old.id),tabs:next.tabs.filter(item => item.id !== old.id)};
    }
  }
  const value = preview ? {...tab,preview:true as const} : tab;
  return {state:insertDockTab(next.state,value,destination),tabs:[...next.tabs,value]};
}

/** A null-path browser selection replaces that browser in its current panel.
 * Resolve the owner and destination from current state, including after a drag. */
export function selectBrowserFile(snapshot: FileDockSnapshot, browserId: string, path: string): FileDockSnapshot {
  if (!isWorkspaceFilePath(path)) return snapshot;
  const browser = snapshot.tabs.find(tab => tab.id === browserId && tab.kind === "files");
  const destination = (["right", "bottom"] as const).find(panel => snapshot.state[panel].tabIds.includes(browserId));
  if (!browser || !destination || !(browser.target.startsWith("project:") || browser.target.startsWith("session:"))) return snapshot;
  const descriptor = { kind: "file" as const, hostId: browser.hostId, target: browser.target, filePath: path, title: path.split("/").at(-1)!.slice(0,1000) };
  const next = openFileTab(snapshot, { ...descriptor, id: dockTabId(descriptor) }, destination, false, () => false);
  return { state: closeDockTab(next.state, destination, browserId), tabs: next.tabs.filter(tab => tab.id !== browserId) };
}
