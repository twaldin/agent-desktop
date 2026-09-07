import { parseNativeSkillFileRef } from "@agent-desktop/shared";
import { dockTabId, type DockState, type DockTab } from "./renderer/dock-state";
/** Device/profile-local presentation only. Never sent to a host or shared preferences. */
export interface WindowNavigation {
  hostId?: string;
  sessionId: string | null;
}
export type SettingsPage = "accounts" | "omp" | "appearance" | "git" | "environments" | "plugins" | "mcp";
export type WorkspaceTab = "files" | "changes" | "worktrees";
export interface WindowViewState {
  route: WindowNavigation;
  dock?: { state: DockState; tabs: DockTab[] };
  environmentOpen?: boolean;
  pluginDirectoryOpen?: boolean;
  pluginDirectoryTab?: "plugins" | "skills";
  sidebarOpen: boolean;
  workspaceOpen: boolean;
  workspaceTab: WorkspaceTab;
  terminalOpen: boolean;
  showArchived: boolean;
  expandedProjects: string[];
  settingsOpen: boolean;
  settingsPage: SettingsPage;
}
export interface WindowStateBootstrap {
  state?: WindowViewState;
  error?: string;
}
export interface LocalWindowBridge {
  initial: WindowStateBootstrap;
  save(state: WindowViewState): { error?: string };
  subscribe?(listener: (status: { error?: string }) => void): () => void;
}
export const defaultWindowView = (): WindowViewState => ({
  route: { sessionId: null },
  sidebarOpen: true,
  workspaceOpen: false,
  workspaceTab: "files",
  terminalOpen: false,
  showArchived: false,
  expandedProjects: [],
  settingsOpen: false,
  settingsPage: "accounts",
});
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const browserIdentity = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  !value.includes("\0");
/** Explicit projection prevents arbitrary draft, credential or editor data being stored. */
export function parseWindowView(value: unknown): WindowViewState | undefined {
  if (!record(value) || !record(value.route)) return;
  const route = value.route;
  if (
    !(route.sessionId === null || id(route.sessionId)) ||
    !(route.hostId === undefined || id(route.hostId))
  )
    return;
  for (const key of [
    "sidebarOpen",
    "workspaceOpen",
    "terminalOpen",
    "showArchived",
    "settingsOpen",
  ])
    if (typeof value[key] !== "boolean") return;
  if (
    !["files", "changes", "worktrees"].includes(String(value.workspaceTab)) ||
    !["accounts", "omp", "appearance", "git", "environments", "plugins", "mcp"].includes(String(value.settingsPage))
  )
    return;
  if (
    !Array.isArray(value.expandedProjects) ||
    value.expandedProjects.length > 1000 ||
    value.expandedProjects.some(
      (key) =>
        typeof key !== "string" ||
        !/^[A-Za-z0-9_-]{1,200}:[A-Za-z0-9_-]{1,200}$/.test(key),
    )
  )
    return;
  if (
    value.environmentOpen !== undefined &&
    typeof value.environmentOpen !== "boolean"
  )
    return;
  if (value.pluginDirectoryOpen !== undefined && typeof value.pluginDirectoryOpen !== "boolean") return;
  if (value.pluginDirectoryTab !== undefined && value.pluginDirectoryTab !== "plugins" && value.pluginDirectoryTab !== "skills") return;
  const dock = parseDockSnapshot(value.dock);
  return {
    route: {
      sessionId: route.sessionId as string | null,
      ...(route.hostId === undefined ? {} : { hostId: route.hostId as string }),
    },
    ...(dock ? { dock } : {}),
    ...(typeof value.environmentOpen === "boolean"
      ? { environmentOpen: value.environmentOpen }
      : {}),
    ...(typeof value.pluginDirectoryOpen === "boolean" ? {pluginDirectoryOpen:value.pluginDirectoryOpen} : {}),
    ...(value.pluginDirectoryTab === undefined ? {} : {pluginDirectoryTab:value.pluginDirectoryTab as "plugins"|"skills"}),
    sidebarOpen: value.sidebarOpen as boolean,
    workspaceOpen: value.workspaceOpen as boolean,
    workspaceTab: value.workspaceTab as WorkspaceTab,
    terminalOpen: value.terminalOpen as boolean,
    showArchived: value.showArchived as boolean,
    expandedProjects: [...new Set(value.expandedProjects as string[])],
    settingsOpen: value.settingsOpen as boolean,
    settingsPage: value.settingsPage as WindowViewState["settingsPage"],
  };
}
declare global {
  interface Window {
    agentDesktopWindow?: LocalWindowBridge;
  }
}

/** Only presentation descriptors are durable. Unknown/offline owners are retained;
 * authority is rechecked by each content query. Corrupt dock data never replaces
 * a valid selected conversation with a local/default route. */
export function parseDockSnapshot(value: unknown): WindowViewState["dock"] {
  if (
    !record(value) ||
    !Array.isArray(value.tabs) ||
    value.tabs.length > 100 ||
    !record(value.state)
  )
    return;
  const tabs: DockTab[] = [],
    seen = new Set<string>();
  for (const item of value.tabs) {
    if (
      !record(item) ||
      !id(item.hostId) ||
      typeof item.target !== "string" ||
      !(item.target === "host" || /^(session|project):[A-Za-z0-9_-]{1,200}$/.test(item.target)) ||
      typeof item.title !== "string" ||
      item.title.length > 1000 ||
      !["review", "files", "worktrees", "terminal", "browser", "goal", "side-chat", "skill-file"].includes(
        String(item.kind),
      ) ||
      (item.terminalId !== undefined && !id(item.terminalId))
    )
      return;
    let skillFile;
    if (item.skillFile !== undefined) {
      try { skillFile = parseNativeSkillFileRef(item.skillFile); } catch { return; }
      const target = skillFile.target;
      const expected = !target ? "host" : "sessionId" in target ? `session:${target.sessionId}` : `project:${target.projectId}`;
      if (item.target !== expected) return;
    }
    if ((item.kind === "skill-file") !== Boolean(skillFile) || (item.target === "host" && item.kind !== "skill-file")) return;
    const browserTarget = item.browserTarget;
    const validBrowserTarget =
      browserTarget &&
      record(browserTarget) &&
      Number.isSafeInteger(browserTarget.workerPid) &&
      (browserTarget.workerPid as number) > 0 &&
      browserIdentity(browserTarget.name) &&
      browserIdentity(browserTarget.targetId);
    if (browserTarget !== undefined && !validBrowserTarget) return;
    const tab: DockTab = {
      id: String(item.id),
      title: item.title,
      ...(item.unread === true ? { unread: true } : {}),
      ...(skillFile ? {skillFile} : {}),
      hostId: item.hostId,
      target: item.target as DockTab["target"],
      kind: item.kind as DockTab["kind"],
      ...(item.terminalId === undefined
        ? {}
        : { terminalId: item.terminalId as string }),
      ...(validBrowserTarget
        ? {
            browserTarget: {
              workerPid: browserTarget.workerPid as number,
              name: browserTarget.name as string,
              targetId: browserTarget.targetId as string,
            },
          }
        : {}),
    };
    if (
      tab.id !== dockTabId(tab) ||
      seen.has(tab.id) ||
      (tab.kind === "terminal") !== Boolean(tab.terminalId) ||
      (tab.kind === "side-chat" && !tab.target.startsWith("session:")) ||
      (tab.browserTarget !== undefined &&
        (tab.kind !== "browser" || !tab.target.startsWith("session:")))
    )
      return;
    tabs.push(tab);
    seen.add(tab.id);
  }
  const used = new Set<string>();
  const region = (raw: unknown): DockState["right"] | undefined => {
    if (
      !record(raw) ||
      typeof raw.open !== "boolean" ||
      !Array.isArray(raw.tabIds) ||
      raw.tabIds.length > 100
    )
      return;
    const ids: string[] = [];
    for (const tabId of raw.tabIds) {
      if (typeof tabId !== "string" || !seen.has(tabId) || used.has(tabId))
        return;
      used.add(tabId);
      ids.push(tabId);
    }
    if (
      raw.activeTabId !== undefined &&
      (typeof raw.activeTabId !== "string" || !ids.includes(raw.activeTabId))
    )
      return;
    return {
      tabIds: ids,
      open: raw.open,
      ...(raw.activeTabId === undefined
        ? {}
        : { activeTabId: raw.activeTabId as string }),
    };
  };
  const right = region(value.state.right),
    bottom = region(value.state.bottom);
  const ratio = value.state.rightWidthRatio,
    height = value.state.bottomHeight;
  if (
    !right ||
    !bottom ||
    typeof ratio !== "number" ||
    !Number.isFinite(ratio) ||
    ratio < 0 ||
    ratio > 1 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height < 0 ||
    height > 4096 ||
    used.size !== tabs.length
  )
    return;
  return {
    tabs,
    state: { right, bottom, rightWidthRatio: ratio, bottomHeight: height },
  };
}
