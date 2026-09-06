import { createRoot } from "react-dom/client";
import { App } from "../../apps/desktop/src/renderer/App";
import { defaultWindowView, type WindowViewState } from "../../apps/desktop/src/window-state";
import { createDockState, dockTabId, insertDockTab, type DockTab } from "../../apps/desktop/src/renderer/dock-state";
import { DEFAULT_THEME } from "../../packages/shared/src/theme";
import { TERMINAL_DIMENSIONS, type NativeTerminalInfo } from "../../packages/shared/src/terminals";
import type { CommandEnvelope, CommandResult, DesktopBridge, DesktopEvent, HostState, OmpComposerCatalog, SessionActivitySnapshot, SessionSummary, WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const owner = "app-dock-owner", projectId = "dock-project", sessionId = "dock-session";
const checks: string[] = [], activityCalls: { sessionId: string; hostId?: string }[] = [], workspaceCalls: { query: WorkspaceQuery; hostId?: string }[] = [];
let browserReads = 0, browserCreates = 0;
let browserTab: import("../../packages/shared/src/protocol").NativeBrowserTabMetadata | undefined;
const menuDismissal = { add: false, move: false };
const listeners = new Set<(event: DesktopEvent) => void>();
const nativeTerminalListeners = new Set<(event: any) => void>();
const model = { provider: "controlled", id: "text", name: "Controlled", input: ["text"], contextWindow: 1000, maxTokens: 1000, reasoning: true, thinkingLevels: ["off", "low", "high"], authenticated: true, available: true };
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
const nativeTerminal: NativeTerminalInfo = { id: "controlled-native-terminal", target: { sessionId }, cwd: "/controlled/project", shell: "/bin/zsh", pid: 42, cols: 80, rows: 24, status: "running", createdAt: 1, protocol: "tmux-v1", serverGeneration: "controlled-server", geometryRevision: 1, inputEpoch: "controlled-input", attachable: true };
const nativeAttachment = { id: "controlled-attachment", terminalId: nativeTerminal.id, viewerId: "controlled-viewer", inputEpoch: nativeTerminal.inputEpoch, geometryRevision: nativeTerminal.geometryRevision, cols: nativeTerminal.cols, rows: nativeTerminal.rows, expiresAt: Date.now() + 60_000 };
const nativeOutput = "printf 'controlled terminal output\n'\r\ncontrolled terminal output\r\n";
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
  getComposerCatalog: async () => catalog, getSessionControls: async () => ({ sessionId, revision: "controls", model, capabilities: { ...model, api: "controlled", thinkingSelectors: ["off", "low", "high"], serviceTierOptions: {}, supportsTools: false, capabilities: {}, compatibility: {}, settingsPaths: [], excludedSensitiveFields: [], unmappedCapabilityFields: [] }, settings: [], overrides: [], serviceTiers: {}, runtimeMutablePaths: [], persistence: "native-session-model-thinking-tiers; runtime-settings-until-dispose" }),
  getNativeTerminalCapabilities: async () => ({ ok: true as const, value: { protocol: "tmux-v1" as const, tmuxVersion: "3.7c" as const, inputEpoch: nativeTerminal.inputEpoch, dimensions: TERMINAL_DIMENSIONS } }),
  nativeTerminalQuery: async query => ({ ok: true as const, value: query.type === "list" ? { type: "list" as const, terminals: [nativeTerminal] } : query.type === "replay" ? { type: "replay" as const, replay: { attachment: nativeAttachment, terminal: nativeTerminal, chunks: query.afterSequence ? [] : [{ sequence: 1, data: nativeOutput }], firstSequence: 1, lastSequence: 1, resetRequired: false } } : { type: "history" as const, history: { terminalId: nativeTerminal.id, serverGeneration: nativeTerminal.serverGeneration, revision: "controlled-history", capturedAt: 1, cols: nativeTerminal.cols, rows: nativeTerminal.rows, live: true, history: nativeOutput, truncated: false } } }),
  nativeTerminalAction: async action => ({ ok: true as const, value: action.type === "attach" || action.type === "heartbeat" ? { terminal: nativeTerminal, attachment: nativeAttachment } : action.type === "reply" ? { accepted: true } : { terminal: nativeTerminal } }),
  writeNativeTerminal: async input => ({ ok: true as const, value: { sequence: input.sequence, duplicate: false, outcome: "accepted" as const } }),
  subscribeNativeTerminals: listener => { nativeTerminalListeners.add(listener); return () => nativeTerminalListeners.delete(listener); },
  getBrowserMetadata: async (requestedSession, requestedOwner) => { if (requestedSession !== sessionId || requestedOwner !== owner) throw new Error("Browser owner changed"); browserReads++; return { protocolVersion: 1, hostId: owner, sessionId, availability: "running", workerPid: 42, tabs: browserTab ? [browserTab] : [], creationTicket: { controlEpoch: "fixture-epoch", observedAt: Date.now() } }; },
  createBrowserTab: async (requestedSession, request, requestedOwner) => {
    if (requestedSession !== sessionId || requestedOwner !== owner) throw new Error("Browser creation owner changed");
    browserCreates++; browserTab = { name: `desktop-${request.requestId}`, targetId: "cmux-fixture", backend: "cmux", kindTag: "cmux", state: "alive", title: "Browser", url: "about:blank", viewport: {width: 800, height: 600} };
    return {protocolVersion: 1, hostId: owner, sessionId, requestId: request.requestId, outcome: "completed", workerPid: 42, tab: browserTab, targetDisposition: "created-surface"};
  },
  getBrowserFrame: async () => { throw new Error("Unsupported CMUX preview must not request pixels"); },
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
  prepareFreshComposer: async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Hide terminal panel"]')?.click();
    document.querySelector<HTMLButtonElement>('[aria-label="Hide side panel"]')?.click();
    document.querySelector<HTMLButtonElement>(".nav-action")!.click();
    await wait(() => document.querySelector(".home-composer") && !document.querySelector<HTMLButtonElement>(".composer-selection-trigger")?.disabled, "fresh composer");
    document.querySelector<HTMLButtonElement>(".composer-selection-trigger")!.click();
    await wait(() => document.querySelector(".composer-selection-menu"), "fresh Power popup");
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const composer = document.querySelector(".composer-region")!.getBoundingClientRect();
    const popup = document.querySelector(".composer-selection-menu")!.getBoundingClientRect();
    const control = document.querySelector('[aria-label="Select model"]')!, box = control.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    assert(innerHeight - composer.bottom <= 2 && popup.bottom < document.querySelector(".composer")!.getBoundingClientRect().bottom && control.contains(hit), "Fresh composer is not bottom anchored or model popup is clipped");
    checks.push("fresh-chat composer remains bottom anchored with visible Power/model control");
    return { fitting: true, composer: composer.toJSON(), popup: popup.toJSON(), viewport: { width: innerWidth, height: innerHeight, devicePixelRatio } };
  },
  appDockProgress: () => ({ checks, route: route(), activityCalls, workspaceCalls: workspaceCalls.map(call => call.query.type), dock: windowState.dock }),
  runAppDockAcceptance: async () => {
    const expectedRoute = `${owner}:${sessionId}`;
    await wait(() => document.querySelector("#prompt") && windowState.dock, "production App restore");
    assert(route() === expectedRoute && windowState.dock!.tabs.some(tab => tab.id === restoredTab.id), "restored pane changed the selected route");
    checks.push("restored pane identity preserves the selected owner and conversation route");
    await wait(() => document.querySelector<HTMLButtonElement>(".composer-selection-trigger")?.disabled === false, "composer model catalog");
    const pickerTrigger = document.querySelector<HTMLButtonElement>(".composer-selection-trigger")!;
    pickerTrigger.click(); await wait(() => document.querySelector(".composer-selection-menu"), "composer popup");
    const modelRow = document.querySelector<HTMLButtonElement>('.composer-selection-menu [aria-label="Select model"]')!;
    const bounds = modelRow.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    assert(bounds.height > 0 && hit && modelRow.contains(hit), "Production composer clips the Model menu row");
    modelRow.click(); await wait(() => document.querySelector('.composer-selection-menu input[type="search"]'), "model submenu pointer selection");
    document.querySelector<HTMLElement>(".composer-selection-menu")!.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}));
    await wait(() => !document.querySelector(".composer-selection-menu"), "picker Escape");
    assert(document.activeElement === pickerTrigger, "Picker close lost composer trigger focus");
    checks.push("production composer menu escapes its rounded clip and opens model search with restored Escape focus");


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

    add.open = true; button(add, "Browser")!.click();
    await wait(() => right.querySelector(".browser-panel") && browserReads > 0, "browser dock reads exact owner metadata");
    assert(browserCreates === 1 && right.textContent?.includes("does not support viewport previews"), "Browser creation did not retain the exact unsupported CMUX target");
    document.querySelector<HTMLButtonElement>('[aria-label="Hide side panel"]')!.click();
    await wait(() => getComputedStyle(right).display === "none", "hide actual browser dock");
    const hiddenReads = browserReads; await new Promise(resolve => setTimeout(resolve, 1200));
    assert(browserReads === hiddenReads, "Hidden production App dock kept browser polling active");
    document.querySelector<HTMLButtonElement>('[aria-label="Show side panel"]')!.click();
    await wait(() => browserReads > hiddenReads, "show browser resumes polling");
    button(right, "Close Browser tab")!.click();
    await wait(() => !right.querySelector(".browser-panel"), "browser close unmounts viewer");
    checks.push("browser dock queries its owner and stops polling when the real App hides the dock");

    const environment = document.querySelector<HTMLButtonElement>('[aria-label="Environment"]'); assert(environment, "accessible Environment control"); environment.click();
    await wait(() => document.querySelector(".environment-card") && activityCalls.length > 0, "Environment activity");
    const card = document.querySelector<HTMLElement>(".environment-card")!; await wait(() => card.textContent?.includes("feature/dock"), "Environment Git state");
    assert(activityCalls.some(call => call.sessionId === sessionId && call.hostId === owner), "activity query lost owner/session identity");
    assert(card.textContent?.includes("Dock verifier") && card.textContent?.includes("Run dock acceptance"), "native activity response is absent from Environment card");
    assert(button(card, "Close environment summary"), "Environment close action has no accessible name");
    checks.push("Environment card renders actual controlled Git status and owner-bound native activity");

    const openTerminal = card.querySelector<HTMLButtonElement>('[aria-label="Open terminal"]'); assert(openTerminal, "Environment terminal action is unavailable"); openTerminal.click();
    await wait(() => document.querySelector(".dock-slot-bottom .dock-native-terminal .native-terminal-view"), "production native terminal dock");
    await wait(() => [...document.querySelectorAll(".dock-native-terminal .xterm-rows")].some(row => row.textContent?.includes("controlled terminal output")), "controlled native terminal output");
    const nativePanel = document.querySelector<HTMLElement>(".dock-slot-bottom .dock-native-terminal")!; assert(button(nativePanel, "Refresh output"), "native terminal lost Refresh output control");
    checks.push("Environment opens a real native terminal dock with controlled attached output and refresh controls");

    assert(route() === expectedRoute && document.querySelectorAll('[role="tab"]').length >= 1, "pane activity changed selected route or removed all tabs");
    return { passed: menuDismissal.add && menuDismissal.move, checks, menuDismissal, providerRequests: 0, route: route(), activityCalls, workspaceQueryKinds: [...new Set(workspaceCalls.map(call => call.query.type))] };
  },
  prepareShortDockChooser: async () => {
    const card = document.querySelector<HTMLElement>(".environment-card"); assert(card && button(card, "Close environment summary"), "Environment close before short chooser"); button(card, "Close environment summary")!.click();
    await wait(() => !document.querySelector(".environment-card"), "close Environment before short chooser capture");
    const right = document.querySelector<HTMLElement>(".dock-slot-right")!; button(right, "Close Review tab")!.click(); await wait(() => right.querySelector(".dock-empty-actions"), "empty side chooser after close");
    const side = document.querySelector<HTMLButtonElement>('[aria-label="Show side panel"]'); assert(side, "show side dock control"); side.click(); await wait(() => getComputedStyle(right).display !== "none", "show empty side chooser");
    const terminal = document.querySelector<HTMLButtonElement>('[aria-label="Show terminal panel"]'); if (terminal) terminal.click();
    const bottom = document.querySelector<HTMLElement>(".dock-slot-bottom")!; await wait(() => getComputedStyle(bottom).display !== "none", "open bottom dock beside empty chooser");
    checks.push("short viewport keeps an empty side chooser reachable beside an open bottom dock");
  },
  appDockGeometry: async (expectChooser = false, expectTerminal = false) => {
    await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const app = document.querySelector<HTMLElement>(".app-shell")!.getBoundingClientRect(), workbench = document.querySelector<HTMLElement>(".workbench")!.getBoundingClientRect(), main = document.querySelector<HTMLElement>(".main-panel")!.getBoundingClientRect();
    const side = document.querySelector<HTMLElement>(".dock-slot-right")!.getBoundingClientRect(), cardElement = document.querySelector<HTMLElement>(".environment-card"), card = cardElement?.getBoundingClientRect();
    const chooser = document.querySelector<HTMLElement>(".dock-slot-right .dock-empty-actions"), chooserLast = chooser?.querySelector<HTMLButtonElement>("button:last-child");
    chooserLast?.scrollIntoView({ block: "nearest" });
    const chooserBounds = chooser?.getBoundingClientRect(), lastBounds = chooserLast?.getBoundingClientRect();
    const chooserReachable = Boolean(chooserBounds && lastBounds && lastBounds.top >= chooserBounds.top - 1 && lastBounds.bottom <= chooserBounds.bottom + 1 && document.elementFromPoint(lastBounds.left + lastBounds.width / 2, lastBounds.top + lastBounds.height / 2) === chooserLast);
    const namedControls = ["Environment", "Hide side panel"].every(name => document.querySelector(`[aria-label="${name}"]`));
    const headerControlsClickable = ["Environment", "Hide side panel"].every(name => {
      const control = document.querySelector<HTMLElement>(`[aria-label="${name}"]`);
      if (!control) return false;
      const bounds = control.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return bounds.width > 0 && bounds.height > 0 && Boolean(hit && control.contains(hit));
    });
    const inside = (box: DOMRect) => box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
    const terminalPanel = document.querySelector<HTMLElement>(".dock-slot-bottom .dock-native-terminal"), terminalView = terminalPanel?.querySelector<HTMLElement>(".native-terminal-view"), terminalFooter = terminalPanel?.querySelector<HTMLElement>(".terminal-view-footer"), terminalScrollport = terminalPanel?.querySelector<HTMLElement>(".native-terminal-scrollport"), refreshOutput = button(terminalPanel ?? document, "Refresh output");
    const terminalBounds = terminalPanel?.getBoundingClientRect(), viewBounds = terminalView?.getBoundingClientRect(), footerBounds = terminalFooter?.getBoundingClientRect(), scrollportBounds = terminalScrollport?.getBoundingClientRect(), refreshBounds = refreshOutput?.getBoundingClientRect(), bottomBounds = document.querySelector<HTMLElement>(".dock-slot-bottom")!.getBoundingClientRect();
    const terminalControlsReachable = Boolean(terminalBounds && viewBounds && footerBounds && refreshBounds && viewBounds.height > 0 && footerBounds.height > 0 && refreshBounds.height > 0 && terminalBounds.height >= 160 && terminalBounds.top >= bottomBounds.top - 1 && terminalBounds.bottom <= bottomBounds.bottom + 1 && footerBounds.bottom <= terminalBounds.bottom + 1 && refreshBounds.bottom <= terminalBounds.bottom + 1 && document.elementFromPoint(refreshBounds.left + refreshBounds.width / 2, refreshBounds.top + refreshBounds.height / 2) === refreshOutput);
    const hit = card && document.elementFromPoint(card.left + card.width / 2, card.top + Math.min(card.height / 2, 120)); const cardVisible = expectChooser ? !cardElement || Boolean(hit && (hit === cardElement || cardElement.contains(hit))) : Boolean(cardElement && hit && (hit === cardElement || cardElement.contains(hit)));
    return { viewport: { width: innerWidth, height: innerHeight }, app: { width: app.width, height: app.height }, workbench: { width: workbench.width, height: workbench.height }, main: { width: main.width, height: main.height }, side: { width: side.width, height: side.height }, card: card ? { x: card.x, y: card.y, width: card.width, height: card.height } : null, chooser: chooserBounds ? { x: chooserBounds.x, y: chooserBounds.y, width: chooserBounds.width, height: chooserBounds.height } : null, chooserLast: lastBounds ? { x: lastBounds.x, y: lastBounds.y, width: lastBounds.width, height: lastBounds.height } : null, chooserReachable, terminal: terminalBounds ? { x: terminalBounds.x, y: terminalBounds.y, width: terminalBounds.width, height: terminalBounds.height, viewHeight: viewBounds?.height ?? 0, footerHeight: footerBounds?.height ?? 0, scrollport: scrollportBounds?.toJSON() ?? null, footer: footerBounds?.toJSON() ?? null, refresh: refreshBounds?.toJSON() ?? null, controlsReachable: terminalControlsReachable } : null, namedControls, headerControlsClickable, cardVisible,
      fitting: app.width > 0 && workbench.width > 0 && main.width > 0 && side.width > 0 && namedControls && headerControlsClickable && cardVisible && (!expectChooser || chooserReachable) && (!expectTerminal || terminalControlsReachable) && inside(app) && inside(workbench) && inside(side) && (!card || inside(card)) && document.documentElement.scrollWidth <= innerWidth + 1 && document.documentElement.scrollHeight <= innerHeight + 1 };
  },
});
