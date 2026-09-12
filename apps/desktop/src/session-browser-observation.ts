import { dockTabId, type BrowserFrameTarget, type DockTab } from "./renderer/dock-state";

/** Window-local observed text, never browser readiness or acquisition authority. */
export interface SessionBrowserObservation {
  version: 1;
  tabId: string;
  hostId: string;
  sessionId: string;
  target: BrowserFrameTarget;
  pageTitle: string;
  url: string;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number, empty = false): value is string => typeof value === "string" && (empty || value.length > 0) && value.length <= max && !value.includes("\0");
const owner = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);

export function parseSessionBrowserObservations(value: unknown): SessionBrowserObservation[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid saved browser observations.");
  const ids = new Set<string>();
  return value.map(raw => {
    if (!record(raw) || Object.keys(raw).some(key => !["version", "tabId", "hostId", "sessionId", "target", "pageTitle", "url"].includes(key))
      || raw.version !== 1 || !text(raw.tabId, 8_192) || !owner(raw.hostId) || !owner(raw.sessionId)
      || !text(raw.pageTitle, 1_024, true) || !text(raw.url, 8_192) || !record(raw.target)
      || Object.keys(raw.target).some(key => !["workerPid", "name", "targetId"].includes(key))
      || !Number.isSafeInteger(raw.target.workerPid) || (raw.target.workerPid as number) <= 0
      || !text(raw.target.name, 200) || !text(raw.target.targetId, 200) || ids.has(raw.tabId)) throw new Error("Invalid saved browser observation identity or details.");
    ids.add(raw.tabId);
    return { version: 1, tabId: raw.tabId, hostId: raw.hostId, sessionId: raw.sessionId, pageTitle: raw.pageTitle, url: raw.url,
      target: { workerPid: raw.target.workerPid as number, name: raw.target.name, targetId: raw.target.targetId } };
  });
}

export function matchesSessionBrowserObservation(value: SessionBrowserObservation, tab: DockTab): boolean {
  return tab.kind === "browser" && !tab.browserNewTab && tab.id === dockTabId(tab) && tab.id === value.tabId
    && tab.hostId === value.hostId && tab.target === `session:${value.sessionId}`
    && tab.browserTarget?.workerPid === value.target.workerPid && tab.browserTarget.name === value.target.name
    && tab.browserTarget.targetId === value.target.targetId;
}
