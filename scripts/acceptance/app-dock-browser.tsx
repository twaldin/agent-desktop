import { createRoot } from "react-dom/client";
import { App } from "../../apps/desktop/src/renderer/App";
import { defaultWindowView, type WindowViewState } from "../../apps/desktop/src/window-state";
import { createDockState, dockTabId, insertDockTab, type DockTab } from "../../apps/desktop/src/renderer/dock-state";
import { DEFAULT_THEME } from "../../packages/shared/src/theme";
import type { CommandEnvelope, CommandResult, DesktopBridge, DesktopEvent, HostState, OmpComposerCatalog, SessionActivitySnapshot, SessionSummary, WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const owner = "app-dock-owner", projectId = "dock-project", sessionId = "dock-session";
const checks: string[] = [], activityCalls: { sessionId: string; hostId?: string }[] = [], workspaceCalls: { query: WorkspaceQuery; hostId?: string }[] = [];
const menuDismissal = { add: false, move: false };
const listeners = new Set<(event: DesktopEvent) => void>();
const model = { provider: "controlled", id: "text", name: "Controlled", input: ["text"], contextWindow: 1000, maxTokens: 1000, reasoning: false, authenticated: true, available: true };
const session: SessionSummary = { id: sessionId, hostId: owner, projectId, cwd: "/controlled/project", title: "Dock acceptance conversation", sessionFile: "/controlled/session.jsonl", status: "idle", model, archived: false, createdAt: 1, updatedAt: 2 };
const state: HostState = { protocolVersion: 1, host: { id: owner, name: "Controlled workstation", platform: "darwin", architecture: "arm64" }, projects: [{ id: projectId, hostId: owner, name: "Dock project", path: "/controlled/project", createdAt: 1 }], sessions: [session], models: [model], drafts: [], lastEventSequence: 1 };
const gitStatus = { revision: "git-revision-1", branch: "feature/dock", head: "abc123", upstream: "origin/feature/dock", ahead: 2, behind: 1, entries: [
  { path: "src/dock.tsx", indexStatus: ".", worktreeStatus: "M", kind: "tracked" as const, submodule: false },
  { path: "notes.txt", indexStatus: "?", worktreeStatus: "?", kind: "untracked" as const, submodule: false },
] };
const activity: SessionActivitySnapshot = { protocolVersion: 1, hostId: owner, sessionId,
  goal: { availability: "available", value: { id: "goal-1", objective: "Ship the integrated dock", status: "active", enabled: true, mode: "active", tokensUsed: 240, timeUsedSeconds: 18, createdAt: 1, updatedAt: 2 } },
  jobs: { availability: "available", value: { running: [{ id: "job-1", type: "task", status: "running", label: "Run dock acceptance", startTime: 1 }], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } } },
  agents: { availability: "available", value: [{ id: "agent-1", displayName: "Dock verifier", status: "running", running: true, createdAt: 1, lastActivity: 2, activity: "Checking layout" }] },
  sources: { availability: "unsupported", reason: "No stable native source registry" } };
const restoredDescriptor = { kind: "worktrees" as const, hostId: owner, target: `session:${sessionId}` as const, title: "Worktrees" };
const restoredTab: DockTab = { ...restoredDescriptor, id: dockTabId(restoredDescriptor) };
const restoredState = insertDockTab(createDockState(), restoredTab, "bottom"); restoredState.bottom.open = false;
let windowState: WindowViewState = { ...defaultWindowView(), route: { hostId: owner, sessionId }, dock: { tabs: [restoredTab], state: restoredState } };
window.agentDesktopWindow = { initial: { state: structuredClone(windowState) }, save: next => { windowState = structuredClone(next); return {}; } };

const workspaceQuery = async (_target: unknown, query: WorkspaceQuery, hostId?: string): Promise<WorkspaceQueryResult> => {
  workspaceCalls.push({ query: structuredClone(query), hostId });
  switch (query.type) {
    case "files.list": return { type: query.type, entries: [{ path: "src", name: "src", kind: "directory", size: 0, modifiedAt: 1, mode: 0o755 }, { path: "README.md", name: "README.md", kind: "file", size: 42, modifiedAt: 1, mode: 0o644 }] };
    case "file.stat": return { type: query.type, entry: { path: query.path, name: query.path.split("/").at(-1)!, kind: "file", size: 42, modifiedAt: 1, mode: 0o644 } };
    case "file.read": return { type: query.type, content: { kind: "text", path: query.path, text: "controlled file\n", size: 16, modifiedAt: 1, mode: 0o644, revision: "file-revision", bom: false, encoding: "utf8" } };
    case "git.status": return { type: query.type, status: structuredClone(gitStatus) };
    case "git.diff": return { type: query.type, diff: { patch: "", binary: false, staged: Boolean(query.staged), ...(query.path ? { path: query.path } : {}) } };
    case "git.branches": return { type: query.type, branches: [] };
    case "git.worktrees": return { type: query.type, worktrees: [{ path: "/controlled/project", head: "abc123", branch: "feature/dock", detached: false, bare: false, locked: false, managed: false }] };
  }
};
const catalog: OmpComposerCatalog = { models: [model], cwd: "/controlled/project", default: { model, approvalMode: "always-ask", source: "configured-role" }, resolution: "native-registry-preview" };
const methods: Partial<DesktopBridge> = {
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getState: async () => structuredClone(state), getHosts: async () => ({ status: "connected", ownNodeId: "controlled", checkedAt: 1, hosts: [] }),
  getPreferences: async () => ({ version: 1, records: [] }), getTheme: async () => ({ document: { ...DEFAULT_THEME, mode: "dark" }, revision: "theme", filePath: "/controlled/theme.json" }),
  getLocalFonts: async () => [], applyWindowTheme: async () => {}, getMessages: async () => [], getInteractions: async () => [],
  getComposerCatalog: async () => catalog, getSessionControls: async () => ({ sessionId, revision: "controls", model, capabilities: { ...model, api: "controlled", thinkingSelectors: [], serviceTierOptions: {}, supportsTools: false, capabilities: {}, compatibility: {}, settingsPaths: [], excludedSensitiveFields: [], unmappedCapabilityFields: [] }, settings: [], overrides: [], serviceTiers: {}, runtimeMutablePaths: [], persistence: "native-session-model-thinking-tiers; runtime-settings-until-dispose" }),
  getSessionActivity: async (requestedSession, hostId) => { activityCalls.push({ sessionId: requestedSession, hostId }); return structuredClone(activity); }, workspaceQuery,
  command: async (envelope: CommandEnvelope): Promise<CommandResult> => {
    if (envelope.command.type === "draft.put") return { ok: true, commandId: envelope.id, value: { ...envelope.command.draft, revision: envelope.command.expectedRevision + 1, updatedAt: Date.now() } };
    throw new Error(`Unexpected controlled command: ${envelope.command.type}`);
  },
};
window.agentDesktop = new Proxy(methods as DesktopBridge, { get(target, key) { if (key in target) return target[key as keyof DesktopBridge]; return async () => { throw new Error(`Unexpected controlled bridge call: ${String(key)}`); }; } });
createRoot(document.getElementById("root")!).render(<App/>);

const assert = (value: unknown, message: string): asserts value => { if (!value) throw new Error(message); };
const wait = async (read: () => unknown, label: string, timeout = 8000) => { const start = performance.now(); while (performance.now() - start < timeout) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out: ${label}`); };
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
const route = () => `${windowState.route.hostId}:${windowState.route.sessionId}`;

Object.assign(window, {
  appDockProgress: () => ({ checks, route: route(), activityCalls, workspaceCalls: workspaceCalls.map(call => call.query.type), dock: windowState.dock }),
  runAppDockAcceptance: async () => {
    const expectedRoute = `${owner}:${sessionId}`;
    await wait(() => document.querySelector("#prompt") && windowState.dock, "production App restore");
    assert(route() === expectedRoute && windowState.dock!.tabs.some(tab => tab.id === restoredTab.id), "restored pane changed the selected route");
    checks.push("restored pane identity preserves the selected owner and conversation route");

    const sideToggle = document.querySelector<HTMLButtonElement>('[aria-label="Show side panel"]'); assert(sideToggle, "accessible side panel toggle"); sideToggle.click();
    await wait(() => getComputedStyle(document.querySelector<HTMLElement>(".dock-slot-right")!).display !== "none" && document.querySelector(".dock-slot-right .dock-empty-actions"), "empty side chooser");
    const right = document.querySelector<HTMLElement>(".dock-slot-right")!; assert(right.getAttribute("inert") === null, "open side dock remained inert");
    assert(button(right, "Review") && button(right, "Files"), "empty chooser lacks workspace actions");
    button(right, "Review")!.click(); await wait(() => right.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes("Review") && right.querySelector(".review-panel"), "real review tab");
    const add = right.querySelector<HTMLDetailsElement>(".dock-add")!; add.open = true; button(add, "Files")!.click();
    await wait(() => right.querySelectorAll('[role="tab"]').length === 2 && right.querySelector(".file-entries"), "real files tab");
    menuDismissal.add = !add.open; add.open = false;
    assert(workspaceCalls.some(call => call.query.type === "git.status") && workspaceCalls.some(call => call.query.type === "files.list"), "workspace tabs did not query controlled Git/files surfaces");
    checks.push("header opens an accessible empty chooser and real Review and Files workspace tabs");

    const rightMenu = right.querySelector<HTMLDetailsElement>(".dock-menu")!; rightMenu.open = true; button(rightMenu, "Move to bottom dock")!.click();
    const bottom = document.querySelector<HTMLElement>(".dock-slot-bottom")!; await wait(() => bottom.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes("Files"), "move Files to bottom");
    const bottomPanel = bottom.querySelector<HTMLElement>(".dock-panel")!;
    assert(Math.abs(bottomPanel.getBoundingClientRect().height - bottom.clientHeight) <= 1, "bottom panel does not fill its resizable dock");
    menuDismissal.move = !rightMenu.open; rightMenu.open = false;
    assert(route() === expectedRoute, "dock movement changed route");
    button(bottom, "Close Files tab")!.click(); await wait(() => !bottom.querySelector('[data-dock-tab-id$=":files"]'), "close moved Files tab");
    const bottomMenu = bottom.querySelector<HTMLDetailsElement>(".dock-menu")!; bottomMenu.open = true; button(bottomMenu, "Hide panel")!.click(); await wait(() => getComputedStyle(bottom).display === "none", "hide bottom panel");
    assert(windowState.dock!.tabs.some(tab => tab.id === restoredTab.id), "closing another tab removed restored pane identity");
    checks.push("menu movement, close, and hide update dock layout without changing navigation or unrelated panes");

    const environment = document.querySelector<HTMLButtonElement>('[aria-label="Environment"]'); assert(environment, "accessible Environment control"); environment.click();
    await wait(() => document.querySelector(".environment-card") && activityCalls.length > 0, "Environment activity");
    const card = document.querySelector<HTMLElement>(".environment-card")!; await wait(() => card.textContent?.includes("feature/dock"), "Environment Git state");
    assert(activityCalls.some(call => call.sessionId === sessionId && call.hostId === owner), "activity query lost owner/session identity");
    assert(card.textContent?.includes("Dock verifier") && card.textContent?.includes("Run dock acceptance"), "native activity response is absent from Environment card");
    assert(button(card, "Close environment summary"), "Environment close action has no accessible name");
    checks.push("Environment card renders actual controlled Git status and owner-bound native activity");

    assert(route() === expectedRoute && document.querySelectorAll('[role="tab"]').length >= 1, "pane activity changed selected route or removed all tabs");
    return { passed: menuDismissal.add && menuDismissal.move, checks, menuDismissal, providerRequests: 0, route: route(), activityCalls, workspaceQueryKinds: [...new Set(workspaceCalls.map(call => call.query.type))] };
  },
  appDockGeometry: async () => {
    await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const app = document.querySelector<HTMLElement>(".app-shell")!.getBoundingClientRect(), workbench = document.querySelector<HTMLElement>(".workbench")!.getBoundingClientRect(), main = document.querySelector<HTMLElement>(".main-panel")!.getBoundingClientRect();
    const side = document.querySelector<HTMLElement>(".dock-slot-right")!.getBoundingClientRect(), card = document.querySelector<HTMLElement>(".environment-card")!.getBoundingClientRect();
    const namedControls = ["Environment", "Hide side panel"].every(name => document.querySelector(`[aria-label="${name}"]`));
    const headerControlsClickable = ["Environment", "Hide side panel"].every(name => {
      const control = document.querySelector<HTMLElement>(`[aria-label="${name}"]`);
      if (!control) return false;
      const bounds = control.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return bounds.width > 0 && bounds.height > 0 && Boolean(hit && control.contains(hit));
    });
    const inside = (box: DOMRect) => box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
    const hit = document.elementFromPoint(card.left + card.width / 2, card.top + Math.min(card.height / 2, 120)); const cardVisible = Boolean(hit && (hit === document.querySelector(".environment-card") || document.querySelector(".environment-card")!.contains(hit)));
    return { viewport: { width: innerWidth, height: innerHeight }, app: { width: app.width, height: app.height }, workbench: { width: workbench.width, height: workbench.height }, main: { width: main.width, height: main.height }, side: { width: side.width, height: side.height }, card: { x: card.x, y: card.y, width: card.width, height: card.height }, namedControls, headerControlsClickable, cardVisible,
      fitting: app.width > 0 && workbench.width > 0 && main.width > 0 && side.width > 0 && card.width > 0 && namedControls && headerControlsClickable && cardVisible && inside(app) && inside(workbench) && inside(side) && inside(card) && document.documentElement.scrollWidth <= innerWidth + 1 && document.documentElement.scrollHeight <= innerHeight + 1 };
  },
});
