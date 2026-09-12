import { dockTabId, draftBrowserDockTarget, type DockTab } from "./dock-state";
import { parseBrowserNewTabState } from "./browser-new-tab";

/** Local only: opening or restoring this descriptor does not prepare an owner,
 * acquire a page, invent a session or assert that a saved native target is live. */
export function createDraftBrowserDockTab(hostId: string, draftId: string, instanceId: string = crypto.randomUUID(), draft?: string): DockTab {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(hostId) || !/^[A-Za-z0-9-]{1,100}$/.test(instanceId)) throw new Error("Invalid draft browser dock identity.");
  const descriptor: Omit<DockTab, "id"> = { kind: "browser", hostId, target: draftBrowserDockTarget(draftId), title: "New tab",
    browserInstanceId: instanceId, browserNewTab: parseBrowserNewTabState({ status: "idle", ...(draft === undefined ? {} : { draft }) }) };
  return { ...descriptor, id: dockTabId(descriptor) };
}
