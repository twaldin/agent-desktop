import { closeDockTab, type DockTab } from "./dock-state";
import { isPristineLocalBrowserLauncher } from "./workspace-layout-step";
import type { DockSnapshot } from "./use-workbench-dock";
import type { MainChatTarget } from "./main-task-targets";

/** Unlike a layout step, route cleanup requires a committed local presentation
 * observation. A WEB blank page or unobserved launcher never supplies that proof. */
export function cleanupPreviousBrowserConversation(snapshot: DockSnapshot, previous: MainChatTarget, current: MainChatTarget, observed: ReadonlySet<string>, canDispose: (tab: DockTab) => boolean = () => true): DockSnapshot {
  if (previous.sessionId === null || previous.hostId === current.hostId && previous.sessionId === current.sessionId) return snapshot;
  const removed = new Set(snapshot.tabs.filter(tab => observed.has(tab.id) && isPristineLocalBrowserLauncher(tab, previous) && canDispose(tab)
    && (snapshot.state.right.tabIds.includes(tab.id) || snapshot.state.bottom.tabIds.includes(tab.id))).map(tab => tab.id));
  if (!removed.size) return snapshot;
  let state = snapshot.state;
  for (const destination of ["right", "bottom"] as const) {
    for (const id of removed) if (state[destination].tabIds.includes(id)) state = closeDockTab(state, destination, id);
  }
  return { state, tabs: snapshot.tabs.filter(tab => !removed.has(tab.id)) };
}
