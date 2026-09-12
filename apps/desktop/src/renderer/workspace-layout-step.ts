import { activateDockTab, closeDockTab, dockTabId, draftBrowserIdFromDock, hideDock, insertDockTab, setRightDockFullWidth, type DockTab } from "./dock-state";
import type { DockSnapshot } from "./use-workbench-dock";
import type { MainChatTarget } from "./main-task-targets";

export type WorkspaceLayoutOwner = MainChatTarget & { draftId?: string };

function activeContent(snapshot: DockSnapshot) {
  const id = snapshot.state.right.activeTabId;
  return snapshot.state.right.tabIds.includes(id ?? "")
    ? snapshot.tabs.find(tab => tab.id === id && tab.id === dockTabId(tab)) : undefined;
}

/** A local launcher has no native page/history/media/adoption to discard. Never
 * infer this from about:blank on an OMP target. The title guard protects our sole
 * persisted title copy; it is an app adaptation, not the pinned disposal rule. */
export function isPristineLocalBrowserLauncher(tab: DockTab, chat: WorkspaceLayoutOwner): boolean {
  return tab.kind === "browser" && Boolean(tab.browserInstanceId) && tab.id === dockTabId(tab)
    && tab.hostId === chat.hostId && (chat.sessionId !== null ? tab.target === `session:${chat.sessionId}`
      : chat.draftId !== undefined && draftBrowserIdFromDock(tab.target) === chat.draftId)
    && !tab.browserTarget && tab.title === "New tab" && tab.browserNewTab?.status === "idle"
    && tab.browserNewTab.draft === undefined && tab.browserNewTab.request === undefined;
}

export function workspaceLayoutStepAvailable(snapshot: DockSnapshot, canOpenBrowser: boolean): boolean {
  return Boolean(activeContent(snapshot) || canOpenBrowser);
}

/** Pinned stepWorkspaceLayout's unified-controller path. Bottom is independent;
 * an idle launcher is removed only from an exact right singleton. Call with the
 * latest dock snapshot so queued draft/creation changes protect their descriptor. */
export function stepWorkspaceLayout(snapshot: DockSnapshot, chat: WorkspaceLayoutOwner, newTab?: DockTab, canDispose: (tab: DockTab) => boolean = () => true): DockSnapshot {
  const active = activeContent(snapshot);
  if (!active) {
    if (!newTab || !isPristineLocalBrowserLauncher(newTab, chat) || snapshot.tabs.some(tab => tab.id === newTab.id)) return snapshot;
    const { rightLayout: _layout, ...state } = snapshot.state;
    return { tabs: [...snapshot.tabs, newTab], state: insertDockTab(state, newTab, "right") };
  }
  if (!snapshot.state.right.open || snapshot.state.rightLayout === "full") {
    return { ...snapshot, state: setRightDockFullWidth(activateDockTab(snapshot.state, "right", active.id), false) };
  }
  if (snapshot.state.right.tabIds.length === 1 && !snapshot.state.bottom.tabIds.includes(active.id) && isPristineLocalBrowserLauncher(active, chat) && canDispose(active)) {
    return { tabs: snapshot.tabs.filter(tab => tab.id !== active.id), state: closeDockTab(snapshot.state, "right", active.id) };
  }
  return { ...snapshot, state: hideDock(snapshot.state, "right") };
}
