/** Device/profile-local presentation only. Never sent to a host or shared preferences. */
export interface WindowNavigation { hostId?: string; sessionId: string | null }
export type WorkspaceTab = "files" | "changes" | "worktrees";
export interface WindowViewState {
  route: WindowNavigation;
  sidebarOpen: boolean;
  workspaceOpen: boolean;
  workspaceTab: WorkspaceTab;
  terminalOpen: boolean;
  showArchived: boolean;
  expandedProjects: string[];
  settingsOpen: boolean;
  settingsPage: "accounts" | "omp" | "appearance";
}
export interface WindowStateBootstrap { state?: WindowViewState; error?: string }
export interface LocalWindowBridge {
  initial: WindowStateBootstrap;
  save(state: WindowViewState): { error?: string };
  subscribe?(listener: (status: { error?: string }) => void): () => void;
}
export const defaultWindowView = (): WindowViewState => ({ route: { sessionId: null }, sidebarOpen: true, workspaceOpen: false,
  workspaceTab: "files", terminalOpen: false, showArchived: false, expandedProjects: [], settingsOpen: false, settingsPage: "accounts" });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
/** Explicit projection prevents arbitrary draft, credential or editor data being stored. */
export function parseWindowView(value: unknown): WindowViewState | undefined {
  if (!record(value) || !record(value.route)) return;
  const route = value.route;
  if (!(route.sessionId === null || id(route.sessionId)) || !(route.hostId === undefined || id(route.hostId))) return;
  for (const key of ["sidebarOpen", "workspaceOpen", "terminalOpen", "showArchived", "settingsOpen"]) if (typeof value[key] !== "boolean") return;
  if (!["files", "changes", "worktrees"].includes(String(value.workspaceTab)) || !["accounts", "omp", "appearance"].includes(String(value.settingsPage))) return;
  if (!Array.isArray(value.expandedProjects) || value.expandedProjects.length > 1000 || value.expandedProjects.some(key => typeof key !== "string" || !/^[A-Za-z0-9_-]{1,200}:[A-Za-z0-9_-]{1,200}$/.test(key))) return;
  return { route: { sessionId: route.sessionId as string | null, ...(route.hostId === undefined ? {} : { hostId: route.hostId as string }) },
    sidebarOpen: value.sidebarOpen as boolean, workspaceOpen: value.workspaceOpen as boolean, workspaceTab: value.workspaceTab as WorkspaceTab,
    terminalOpen: value.terminalOpen as boolean, showArchived: value.showArchived as boolean, expandedProjects: [...new Set(value.expandedProjects as string[])],
    settingsOpen: value.settingsOpen as boolean, settingsPage: value.settingsPage as WindowViewState["settingsPage"] };
}
declare global { interface Window { agentDesktopWindow?: LocalWindowBridge } }
