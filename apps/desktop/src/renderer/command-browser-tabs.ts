import { readBrowserMetadataLimited } from "./browser-metadata-admission";
import type { DraftBrowserPageIntent } from "../draft-browser-page-intent";
import { draftBrowserSearchEntries } from "./draft-browser-search";
import { parseNativeBrowserTabMetadata, type BrowserMetadataSnapshot, type DesktopBridge } from "@agent-desktop/shared";
import { activateDockTab, dockTabId, type DockState, type DockTab } from "./dock-state";

import type { DockPresentations } from "./dock-presentations";

export interface CommandBrowserTab {
  id: string;
  hostId: string;
  sessionId: string | null;
  /** Present only for an original draft page; never an invented session. */
  draftId?: string;
  title: string;
  pageTitle: string;
  url: string;
  detailsUnavailable: boolean;
  /** Original runtime presentation and native target, never a restore request. */
  sourceKey?: string;
}
export type BrowserSearchSnapshot = { state: DockState; tabs: readonly DockTab[] };
export const browserSearchOwner = (hostId: string, sessionId: string) => JSON.stringify([hostId, sessionId]);

export function matchingBrowserTabs(entries: readonly CommandBrowserTab[], query: string): CommandBrowserTab[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return entries.filter(entry => {
    const text = `${entry.title}\n${entry.pageTitle}\n${entry.url}`.toLowerCase();
    return words.every(word => text.includes(word));
  }).slice(0, 10);
}

/** Search candidates are existing native-page dock entries, including hidden
 * docks. A local NEW_TAB_PAGE is not WEB; unsent address text cannot promote it.
 * Metadata supplies the observed nonempty URL and cannot introduce another tab. */
export function windowBrowserTabs(snapshot: BrowserSearchSnapshot): DockTab[] {
  const attached = new Set([...snapshot.state.right.tabIds, ...snapshot.state.bottom.tabIds]);
  return snapshot.tabs.filter(tab => tab.kind === "browser" && tab.target.startsWith("session:") && tab.target.length > 8
    && tab.browserTarget && !tab.browserNewTab && tab.id === dockTabId(tab) && attached.has(tab.id));
}

/** Materialization preserves the presentation ID but changes the metadata owner
 * target. Restart observation then, without restarting it for local draft edits. */
export function browserSearchIdentity(tabs: readonly DockTab[]): string {
  return JSON.stringify(tabs.map(tab => [tab.id, tab.hostId, tab.target,
    tab.browserTarget?.workerPid, tab.browserTarget?.name, tab.browserTarget?.targetId]));
}

export function browserSearchPresentationKey(presentations: DockPresentations, tabId: string): string | undefined {
  const instance = presentations.instances.get(tabId), tab = windowBrowserTabs(presentations.snapshot).find(tab => tab.id === tabId);
  return instance && tab ? JSON.stringify([instance, browserSearchIdentity([tab])]) : undefined;
}

export function browserSearchEntries(tabs: readonly DockTab[], metadata: ReadonlyMap<string, BrowserMetadataSnapshot>): CommandBrowserTab[] {
  return tabs.flatMap(tab => {
    if (tab.kind !== "browser" || !tab.target.startsWith("session:") || tab.target.length <= 8
      || tab.id !== dockTabId(tab) || tab.browserNewTab || !tab.browserTarget) return [];
    const sessionId = tab.target.slice(8), target = tab.browserTarget;
    const value = metadata.get(browserSearchOwner(tab.hostId, sessionId));
    let page;
    if (target && value?.protocolVersion === 1 && value.hostId === tab.hostId && value.sessionId === sessionId
      && value.availability === "running" && value.workerPid === target.workerPid) {
      const candidate = value.tabs.find(item => item.name === target.name && item.targetId === target.targetId && item.state === "alive");
      if (candidate) { try { page = parseNativeBrowserTabMetadata(candidate); } catch { /* Do not use malformed page details. */ } }
    }
    // Pinned getOpenTabs requires a WEB snapshot with an observed URL. A saved
    // title or native identity alone does not establish a searchable page.
    if (!page?.url) return [];
    return [{ id: tab.id, hostId: tab.hostId, sessionId, title: tab.title, pageTitle: page.title ?? "", url: page.url, detailsUnavailable: false }];
  });
}

/** Read only owners already represented in this window. The existing host
 * metadata endpoint never creates a native worker or browser. */
export async function readWindowBrowserMetadata(tabs: readonly DockTab[], connected: ReadonlySet<string>,
  bridge: Pick<DesktopBridge, "getBrowserMetadata">, signal: AbortSignal): Promise<Map<string, BrowserMetadataSnapshot>> {
  const owners = new Map<string, { hostId: string; sessionId: string }>();
  for (const tab of tabs) if (tab.browserTarget && connected.has(tab.hostId)) {
    const sessionId = tab.target.slice(8);
    owners.set(browserSearchOwner(tab.hostId, sessionId), { hostId: tab.hostId, sessionId });
  }
  const pending = [...owners], result = new Map<string, BrowserMetadataSnapshot>();
  if (!bridge.getBrowserMetadata) return result;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (!signal.aborted) {
      const item = pending[next++];
      if (!item) return;
      const [key, owner] = item;
      try {
        const read = bridge.getBrowserMetadata!.bind(bridge);
        const value = await readBrowserMetadataLimited(() => read(owner.sessionId, owner.hostId), signal);
        if (!signal.aborted && value?.protocolVersion === 1 && value.hostId === owner.hostId && value.sessionId === owner.sessionId) result.set(key, value);
      } catch { /* A saved tab remains navigable, with unavailable page details. */ }
    }
  }));
  return result;
}

/** Recheck the current window inventory at admission. Never resurrect a closed
 * result or relocate its existing dock destination. */
export function activateBrowserSearchTab(snapshot: BrowserSearchSnapshot, entry: Pick<CommandBrowserTab, "id" | "hostId" | "sessionId" | "sourceKey" | "draftId">, presentations?: DockPresentations, draftPages: readonly DraftBrowserPageIntent[] = []): DockState | undefined {
  if (entry.sessionId === null) {
    if (!presentations || !entry.sourceKey || !draftBrowserSearchEntries({ ...presentations, snapshot: { ...snapshot, tabs: [...snapshot.tabs] } }, draftPages)
      .some(candidate => candidate.id === entry.id && candidate.hostId === entry.hostId && candidate.draftId === entry.draftId && candidate.sourceKey === entry.sourceKey)) return;
  } else {
    if (entry.draftId !== undefined || presentations && (!entry.sourceKey || browserSearchPresentationKey(presentations, entry.id) !== entry.sourceKey)) return;
    if (!windowBrowserTabs(snapshot).some(tab => tab.id === entry.id && tab.hostId === entry.hostId && tab.target === `session:${entry.sessionId}`)) return;
  }
  const destination = snapshot.state.right.tabIds.includes(entry.id) ? "right" : "bottom";
  return activateDockTab(snapshot.state, destination, entry.id);
}

/** Only result sections participate; ordinary command groups are excluded. */
export function nextCommandSearchSection(firstValues: readonly string[], selectedSection: number, repeated: boolean, reverse: boolean): string | undefined {
  if (firstValues.length < 2) return;
  const index = repeated && selectedSection >= 0 && selectedSection < firstValues.length
    ? (selectedSection + (reverse ? -1 : 1) + firstValues.length) % firstValues.length
    : reverse ? firstValues.length - 1 : 0;
  return firstValues[index];
}
