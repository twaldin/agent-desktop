import { parsePullRequestComposers, type PullRequestComposer } from "./pull-request-composer-state";
import { parsePullRequestWindowViews, type PullRequestWindowView } from './pull-request-window-state';
import { parseMcpDockApp } from "./renderer/mcp-app-dock";
import { isPreferenceId } from "../../../packages/shared/src/preferences";
import { parseAutomationWindowRequests, type AutomationWindowRequest } from './automation-window-state';
import { parseBrowserCloseWindowIntents, type BrowserCloseWindowIntent } from "./browser-close-window-intent";
import { parseSessionBrowserObservations, matchesSessionBrowserObservation, type SessionBrowserObservation } from "./session-browser-observation";
import { parseDraftBrowserPageIntents, type DraftBrowserPageIntent } from "./draft-browser-page-intent";
import { parseDraftBrowserWindowIntents, type DraftBrowserWindowIntent } from "./draft-browser-window-intent";
import { parseNativeSkillFileRef } from "@agent-desktop/shared";
import { dockTabId, draftBrowserIdFromDock, isWorkspaceFilePath, standaloneFilePathFromDock, type DockState, type DockTab } from "./renderer/dock-state";
import { parseBrowserNewTabState, type BrowserNewTabState } from "./renderer/browser-new-tab";
import { parseTerminalWindowIntents, type TerminalWindowIntent } from "./terminal-window-intent";
/** Device/profile-local presentation only. Never sent to a host or shared preferences. */
export interface WindowNavigation {
  hostId?: string;
  sessionId: string | null;
}
export type SettingsPage = "keyboard-shortcuts" | "general" | "accounts" | "omp" | "appearance" | "git" | "environments" | "plugins" | "mcp" | "connections";
export type WorkspaceTab = "files" | "changes" | "worktrees";
export interface FileTreeView { open: boolean; width: number }
export const defaultFileTreeView = (): FileTreeView => ({ open: false, width: 250 });
export const environmentSectionKeys = ["environment", "side-chats", "subagents", "jobs", "sources"] as const;
export type EnvironmentSectionKey = typeof environmentSectionKeys[number];
export type SidebarSectionKey = "pinned" | "projects" | "recents" | `custom:${string}`;
export const defaultCollapsedSidebarSections = (): SidebarSectionKey[] => ["recents"];
export const maximumCollapsedSidebarSections = 1003;
export interface WindowViewState {
  /** Window-local disclosure state; custom section membership remains shared. */
  collapsedSidebarSections?: SidebarSectionKey[];
  browserCloses?: BrowserCloseWindowIntent[];
  sessionBrowserObservations?: SessionBrowserObservation[];
  draftBrowserOwners?: DraftBrowserWindowIntent[];
  draftBrowserPages?: DraftBrowserPageIntent[];
  terminalCreations?: TerminalWindowIntent[];
  fileTreeOpen?: boolean;
  route: WindowNavigation;
  dock?: { state: DockState; tabs: DockTab[] };
  environmentOpen?: boolean;
  environmentCollapsed?: EnvironmentSectionKey[];
  pluginDirectoryOpen?: boolean;
  pullRequestsOpen?: boolean;
  pullRequestViews?: PullRequestWindowView[];
  pullRequestComposers?: PullRequestComposer[];
  automationsOpen?: boolean;
  automationRequests?: AutomationWindowRequest[];
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
  /** Main-process local slot, independent of the selected host and renderer lifetime. */
  ownerSlot?: string;
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
  collapsedSidebarSections: defaultCollapsedSidebarSections(),
  settingsOpen: false,
  settingsPage: "general",
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
/** Explicit projection permits only known presentation fields and bounded browser drafts. */
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
    !["general", "accounts", "omp", "appearance", "git", "environments", "plugins", "mcp", "connections", "keyboard-shortcuts"].includes(String(value.settingsPage))
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
  let collapsedSidebarSections: SidebarSectionKey[] | undefined;
  if (value.collapsedSidebarSections !== undefined) {
    const saved = value.collapsedSidebarSections;
    if (!Array.isArray(saved) || saved.length > maximumCollapsedSidebarSections) return;
    collapsedSidebarSections = [];
    const seen = new Set<string>();
    for (let index = 0; index < saved.length; index++) {
      if (!Object.hasOwn(saved, index)) return;
      const key = saved[index];
      if (typeof key !== "string" || seen.has(key) ||
        !(key === "pinned" || key === "projects" || key === "recents" || key.startsWith("custom:") && isPreferenceId(key.slice(7)))) return;
      seen.add(key); collapsedSidebarSections.push(key as SidebarSectionKey);
    }
  }
  if (
    value.environmentOpen !== undefined &&
    typeof value.environmentOpen !== "boolean"
  )
    return;
  if (value.pluginDirectoryOpen !== undefined && typeof value.pluginDirectoryOpen !== "boolean") return;
  if (value.pullRequestsOpen !== undefined && typeof value.pullRequestsOpen !== 'boolean') return;
  let pullRequestComposers: PullRequestComposer[] | undefined;
  if (value.pullRequestComposers !== undefined) { try { pullRequestComposers = parsePullRequestComposers(value.pullRequestComposers); } catch { return; } }
  let pullRequestViews: PullRequestWindowView[] | undefined;
  if (value.pullRequestViews !== undefined) { try { pullRequestViews = parsePullRequestWindowViews(value.pullRequestViews); } catch { return; } }
  if (value.automationsOpen !== undefined && typeof value.automationsOpen !== 'boolean') return;
  let automationRequests: AutomationWindowRequest[] | undefined;
  if (value.automationRequests !== undefined) {
    try { automationRequests = parseAutomationWindowRequests(value.automationRequests); } catch { return; }
  }
  if (value.environmentCollapsed !== undefined && (!Array.isArray(value.environmentCollapsed) || value.environmentCollapsed.length > environmentSectionKeys.length || value.environmentCollapsed.some(key => !environmentSectionKeys.includes(key)))) return;
  if (value.pluginDirectoryTab !== undefined && value.pluginDirectoryTab !== "plugins" && value.pluginDirectoryTab !== "skills") return;
  const dock = parseDockSnapshot(value.dock);
  // New draft identities must not be acknowledged after legacy dock fallback
  // drops their local address. Existing non-draft fallback remains unchanged.
  if (!dock && record(value.dock) && Array.isArray(value.dock.tabs) && value.dock.tabs.some(tab =>
    record(tab) && typeof tab.target === "string" && tab.target.startsWith("draft:"))) return;
  let browserCloses: BrowserCloseWindowIntent[] | undefined;
  if (value.browserCloses !== undefined) {
    try { browserCloses = parseBrowserCloseWindowIntents(value.browserCloses); } catch { return; }
  }
  let sessionBrowserObservations: SessionBrowserObservation[] | undefined;
  if (value.sessionBrowserObservations !== undefined) {
    try {
      sessionBrowserObservations = parseSessionBrowserObservations(value.sessionBrowserObservations);
      const attached = new Set([...(dock?.state.right.tabIds ?? []), ...(dock?.state.bottom.tabIds ?? [])]);
      if (sessionBrowserObservations.some(observed => !dock?.tabs.some(tab => attached.has(tab.id) && matchesSessionBrowserObservation(observed, tab)))) return;
    } catch { return; }
  }
  let draftBrowserOwners: DraftBrowserWindowIntent[] | undefined;
  if (value.draftBrowserOwners !== undefined) {
    try { draftBrowserOwners = parseDraftBrowserWindowIntents(value.draftBrowserOwners); } catch { return; }
  }
  let draftBrowserPages: DraftBrowserPageIntent[] | undefined;
  if (value.draftBrowserPages !== undefined) {
    try { draftBrowserPages = parseDraftBrowserPageIntents(value.draftBrowserPages, draftBrowserOwners ?? []); } catch { return; }
  }
  let terminalCreations: TerminalWindowIntent[] | undefined;
  if (value.terminalCreations !== undefined) {
    try { terminalCreations = parseTerminalWindowIntents(value.terminalCreations); } catch { return; }
  }

  return {
    route: {
      sessionId: route.sessionId as string | null,
      ...(route.hostId === undefined ? {} : { hostId: route.hostId as string }),
    },
    ...(dock ? { dock } : {}),
    ...(browserCloses === undefined ? {} : { browserCloses }),
    ...(sessionBrowserObservations === undefined ? {} : { sessionBrowserObservations }),
    ...(terminalCreations === undefined ? {} : { terminalCreations }),
    ...(draftBrowserOwners === undefined ? {} : { draftBrowserOwners }),
    ...(draftBrowserPages === undefined ? {} : { draftBrowserPages }),
    ...(typeof value.fileTreeOpen === "boolean" ? { fileTreeOpen: value.fileTreeOpen } : {}),
    ...(typeof value.environmentOpen === "boolean"
      ? { environmentOpen: value.environmentOpen }
      : {}),
    ...(value.environmentCollapsed === undefined ? {} : { environmentCollapsed: [...new Set(value.environmentCollapsed as EnvironmentSectionKey[])] }),
    ...(typeof value.pluginDirectoryOpen === "boolean" ? {pluginDirectoryOpen:value.pluginDirectoryOpen} : {}),
    ...(typeof value.pullRequestsOpen === 'boolean' ? { pullRequestsOpen: value.pullRequestsOpen } : {}),
    ...(pullRequestComposers === undefined ? {} : { pullRequestComposers }),
    ...(pullRequestViews === undefined ? {} : { pullRequestViews }),
    ...(typeof value.automationsOpen === 'boolean' ? { automationsOpen: value.automationsOpen } : {}),
    ...(automationRequests === undefined ? {} : { automationRequests }),
    ...(value.pluginDirectoryTab === undefined ? {} : {pluginDirectoryTab:value.pluginDirectoryTab as "plugins"|"skills"}),
    sidebarOpen: value.sidebarOpen as boolean,
    workspaceOpen: value.workspaceOpen as boolean,
    workspaceTab: value.workspaceTab as WorkspaceTab,
    terminalOpen: value.terminalOpen as boolean,
    showArchived: value.showArchived as boolean,
    expandedProjects: [...new Set(value.expandedProjects as string[])],
    ...(collapsedSidebarSections === undefined ? {} : { collapsedSidebarSections }),
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
    if (record(item) && item.preview === true) return; // Live snapshots must strip transient previews before saving.
    const draftId = record(item) ? draftBrowserIdFromDock(item.target) : undefined;
    const standalonePath = record(item) ? standaloneFilePathFromDock(item.target) : undefined;
    if (
      !record(item) ||
      !id(item.hostId) ||
      typeof item.target !== "string" ||
      !(item.target === "host" || /^(session|project):[A-Za-z0-9_-]{1,200}$/.test(item.target) || standalonePath !== undefined || draftId !== undefined) ||
      typeof item.title !== "string" ||
      item.title.length > 1000 ||
      !["review", "file", "files", "worktrees", "terminal", "browser", "goal", "side-chat", "skill-file", "mcp-app"].includes(
        String(item.kind),
      ) ||
      (item.terminalId !== undefined && !id(item.terminalId))
    )
      return;
    if (draftId !== undefined && item.kind !== "browser") return;
    let mcpApp;
    if (item.mcpApp !== undefined) { try { mcpApp = parseMcpDockApp(item.mcpApp); } catch { return; } }
    if ((item.kind === "mcp-app") !== Boolean(mcpApp) || mcpApp && (mcpApp.directory ? item.target !== (mcpApp.directory.projectId === null ? "host" : `project:${mcpApp.directory.projectId}`) : !item.target.startsWith("session:"))) return;
    let skillFile;
    if (item.skillFile !== undefined) {
      try { skillFile = parseNativeSkillFileRef(item.skillFile); } catch { return; }
      const target = skillFile.target;
      if (target && "filePath" in target) return;
      const expected = !target ? "host" : "sessionId" in target ? `session:${target.sessionId}` : `project:${target.projectId}`;
      if (item.target !== expected) return;
    }
    if ((item.kind === "skill-file") !== Boolean(skillFile) || (item.target === "host" && item.kind !== "skill-file" && item.kind !== "mcp-app")) return;
    let filePath: string | undefined;
    if (item.kind === "file") {
      if (standalonePath !== undefined) {
        if (typeof item.filePath !== "string" || item.filePath !== standalonePath.split("/").at(-1)) return;
      } else if (!isWorkspaceFilePath(item.filePath)) return;
      filePath = item.filePath;
    } else if (item.filePath !== undefined || standalonePath !== undefined) return;
    let fileScroll: DockTab["fileScroll"];
    if (item.fileScroll !== undefined) {
      if ((!filePath && !skillFile) || !record(item.fileScroll)) return;
      fileScroll = {};
      for (const mode of ["markdown", "source"] as const) {
        const top = item.fileScroll[mode];
        if (top === undefined) continue;
        if (typeof top !== "number" || !Number.isFinite(top) || top < 0 || top > 100_000_000) return;
        fileScroll[mode] = top;
      }
    }
    const browserTarget = item.browserTarget;
    const validBrowserTarget =
      browserTarget &&
      record(browserTarget) &&
      Number.isSafeInteger(browserTarget.workerPid) &&
      (browserTarget.workerPid as number) > 0 &&
      browserIdentity(browserTarget.name) &&
      browserIdentity(browserTarget.targetId);
    if (browserTarget !== undefined && !validBrowserTarget) return;
    const browserInstanceId = item.browserInstanceId;
    if (browserInstanceId !== undefined && (!id(browserInstanceId) || item.kind !== "browser" || !(item.target.startsWith("session:") || draftId !== undefined))) return;
    let browserNewTab: BrowserNewTabState | undefined;
    if (item.browserNewTab !== undefined) {
      if (!browserInstanceId || browserTarget !== undefined) return;
      try { browserNewTab = parseBrowserNewTabState(item.browserNewTab); } catch { return; }
    }
    if (browserInstanceId && !browserNewTab && !validBrowserTarget) return;
    // A draft dock descriptor remains a local launcher. Native requests and
    // targets live in the separately guarded draft page/owner records.
    if (draftId !== undefined && (typeof browserInstanceId !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(browserInstanceId) || !browserNewTab || browserNewTab.status !== "idle"
      || browserNewTab.request !== undefined || browserTarget !== undefined || (item.browserNewTab as BrowserNewTabState).status !== "idle")) return;
    const tab: DockTab = {
      id: String(item.id),
      title: item.title,
      ...(item.unread === true ? { unread: true } : {}),
      ...(skillFile ? {skillFile} : {}),
      ...(mcpApp ? {mcpApp} : {}),
      ...(fileScroll ? {fileScroll} : {}),
      ...(filePath === undefined ? {} : { filePath }),
      ...((filePath !== undefined || skillFile !== undefined) && (item.fileMode === "markdown" || item.fileMode === "source") ? { fileMode: item.fileMode } : {}),
      hostId: item.hostId,
      target: item.target as DockTab["target"],
      kind: item.kind as DockTab["kind"],
      ...(browserInstanceId === undefined ? {} : { browserInstanceId: browserInstanceId as string }),
      ...(browserNewTab ? { browserNewTab } : {}),
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
  const layout = value.state.rightLayout;
  const contentSide = value.state.contentSide;
  if (
    !right ||
    !bottom ||
    (contentSide !== undefined && contentSide !== "left" && contentSide !== "right") ||
    (layout !== undefined && layout !== "full" && layout !== "restore-full") ||
    (layout === "full" && !right?.open) ||
    (layout === "restore-full" && right?.open) ||
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
    state: { right, bottom, ...(contentSide === undefined ? {} : { contentSide }), rightWidthRatio: ratio, bottomHeight: height, ...(layout === undefined ? {} : { rightLayout: layout }) },
  };
}
