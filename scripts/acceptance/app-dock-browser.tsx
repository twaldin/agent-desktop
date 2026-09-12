import { offlineCache } from "../../apps/desktop/src/renderer/offline-cache";
import { createRoot } from "react-dom/client";
import { App } from "../../apps/desktop/src/renderer/App";
import { defaultWindowView, type WindowViewState } from "../../apps/desktop/src/window-state";
import { createDockState, dockTabId, insertDockTab, type DockTab } from "../../apps/desktop/src/renderer/dock-state";
import { DEFAULT_THEME } from "../../packages/shared/src/theme";
import { TERMINAL_DIMENSIONS, type NativeTerminalInfo } from "../../packages/shared/src/terminals";
import type { BranchQueryObserverStatus, BranchQueryRequest, CommandEnvelope, CommandResult, DesktopBridge, DesktopEvent, HostState, LiveBranchQuery, LiveBranchResult, OmpComposerCatalog, SessionActivitySnapshot, SessionSummary, WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import type { PreferenceRecord } from "../../packages/shared/src/preferences";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const questionFixture = new URLSearchParams(location.search).has("question");
const owner = "app-dock-owner", projectId = "dock-project", sessionId = "dock-session";
const checks: string[] = [], activityCalls: { sessionId: string; hostId?: string }[] = [], workspaceCalls: { target: unknown; query: WorkspaceQuery; hostId?: string }[] = [];
let browserReads = 0, browserCreates = 0;
const draftWrites: Extract<CommandEnvelope["command"],{type:"draft.put"}>[] = [];
const branchWrites: CommandEnvelope[] = [];
const sessionCreates: CommandEnvelope[] = [], sessionPrompts: CommandEnvelope[] = [];
const preferenceWrites: CommandEnvelope[] = [];
let preferenceCounter = 0;
const preferenceRecords: any[] = [];
const preferenceActor = crypto.randomUUID();
let checkoutGate: Promise<void> | undefined;
let checkoutUnknownOnce = false;
let modeSaveFailure: "conflict" | "error" | undefined;
let promptGate: { promise: Promise<void>; resolve(): void } | undefined;
let browserTab: import("../../packages/shared/src/protocol").NativeBrowserTabMetadata | undefined;
const menuDismissal = { add: false, move: false };
const listeners = new Set<(event: DesktopEvent) => void>();
const branchQueryListeners = new Set<(status: BranchQueryObserverStatus) => void>();
const nativeTerminalListeners = new Set<(event: any) => void>();
const model = { provider: "controlled", id: "text", name: "Controlled", input: ["text"], contextWindow: 1000, maxTokens: 1000, reasoning: true, thinkingLevels: ["off", "low", "high"], authenticated: true, available: true };
const session: SessionSummary = { id: sessionId, hostId: owner, projectId, cwd: "/controlled/project", title: "Dock acceptance conversation", sessionFile: "/controlled/session.jsonl", status: questionFixture ? "running" : "idle", model, archived: false, createdAt: 1, updatedAt: 2 };
const state: HostState = { protocolVersion: 1, host: { id: owner, name: "Controlled workstation", platform: "darwin", architecture: "arm64" }, projects: [{ id: projectId, hostId: owner, name: "Dock project", path: "/controlled/project", createdAt: 1 }], sessions: [session], models: [model], drafts: [], lastEventSequence: 1, imageAttachments: { protocolVersion:1, commandVersion:3, maxImages:4, maxImageBytes:20*1024*1024, maxBatchBytes:20*1024*1024, maxImagePixels:16_777_216, mimeTypes:["image/png","image/jpeg","image/gif","image/webp"] }, newChatExecution: {commandVersion:4,worktrees:true} };
const gitStatus = { revision: "git-revision-1", branch: "feature/dock" as string | null, head: "a".repeat(40), upstream: "origin/feature/dock", ahead: 2, behind: 1, entries: [
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
if (questionFixture) { restoredState.right.open = false; restoredState.bottom.open = false; }
let windowState: WindowViewState = { ...defaultWindowView(), route: { hostId: owner, sessionId }, dock: { tabs: [restoredTab], state: restoredState } };
window.agentDesktopWindow = { initial: { state: structuredClone(windowState) }, save: next => { windowState = structuredClone(next); return {}; } };

const workspaceQuery = async (_target: unknown, query: WorkspaceQuery, hostId?: string): Promise<WorkspaceQueryResult> => {
  workspaceCalls.push({ target:structuredClone(_target), query: structuredClone(query), hostId });
  switch (query.type) {
    case "files.list": return { type: query.type, entries: [{ path: "src", name: "src", kind: "directory", size: 0, modifiedAt: 1, mode: 0o755 }, { path: "README.md", name: "README.md", kind: "file", size: 42, modifiedAt: 1, mode: 0o644 }] };
    case "file.stat": return { type: query.type, entry: { path: query.path, name: query.path.split("/").at(-1)!, kind: "file", size: 42, modifiedAt: 1, mode: 0o644 } };
    case "file.read": return { type: query.type, content: { kind: "text", path: query.path, text: "controlled file\n", size: 16, modifiedAt: 1, mode: 0o644, revision: "file-revision", bom: false, encoding: "utf8" } };
    case "git.status": return { type: query.type, status: structuredClone(gitStatus) };
    case "git.diff": return { type: query.type, diff: { patch: "", binary: false, staged: Boolean(query.staged), ...(query.path ? { path: query.path } : {}) } };
    case "git.branches": case "git.search-branches": case "git.search-starting-branches": {
      const branches = ["feature/dock", "context-fixture"].map(name => ({ name, ref: `refs/heads/${name}`, current: name === gitStatus.branch, remote: false, commit: "a".repeat(40), upstream: null, symbolicTarget: null }));
      if (query.type === "git.branches") return { type: query.type, branches };
      const needle = query.query.toLowerCase(), found = branches.filter(branch => branch.name.toLowerCase().includes(needle) || branch.ref.toLowerCase().includes(needle));
      return { type: query.type, branches: found.slice(0, query.limit ?? 20), limitReached: found.length >= (query.limit ?? 20) };
    }
    case "git.resolve-checkout": return { type: query.type, target: ["feature/dock", "context-fixture"].includes(query.expression)
      ? { kind: "branch", expression: query.expression, selection: { ref: `refs/heads/${query.expression}`, commit: "a".repeat(40) } }
      : ["HEAD", "a".repeat(40)].includes(query.expression) ? { kind: "revision", expression: query.expression, commit: "a".repeat(40) } : null };
    case "git.resolve-revision": return { type: query.type, revision: ["HEAD", "a".repeat(40)].includes(query.expression)
      ? { expression: query.expression, commit: "a".repeat(40) } : null };
    case "git.worktrees": return { type: query.type, worktrees: [{ path: "/controlled/project", head: "a".repeat(40), branch: "feature/dock", detached: false, bare: false, locked: false, managed: false }] };
  }
  throw new Error(`Unexpected controlled workspace query: ${query.type}`);
};
const liveBranchResult = (query: LiveBranchQuery): LiveBranchResult => query.type === "git.recent-branches"
  ? { type: query.type, branches: ["feature/dock", "context-fixture"] }
  : query.type === "git.base-branch" ? { type: query.type, base: null } : { type: query.type, branch: "feature/dock" };
const branchQuery = async (request: BranchQueryRequest) => {
  const view: BranchQueryObserverStatus["view"] = request.action === "release" ? { phase: "released" } : {
    phase: "ready", update: { generation: 1, requiresRecovery: false, phase: "complete", result: liveBranchResult(request.query) },
  };
  const status: BranchQueryObserverStatus = { hostId: request.hostId, subscriptionId: request.subscriptionId,
    target: structuredClone(request.target), query: structuredClone(request.query), view };
  for (const listener of branchQueryListeners) listener(structuredClone(status));
};
const catalog: OmpComposerCatalog = { models: [model], cwd: "/controlled/project", default: { model, approvalMode: "always-ask", source: "configured-role" }, resolution: "native-registry-preview" };
const methods: Partial<DesktopBridge> = {
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  branchQuery,
  subscribeBranchQuery: listener => { branchQueryListeners.add(listener); return () => { branchQueryListeners.delete(listener); }; },
  // Fixture-only: no native window-close, notification-status or notification-navigation events exist here; the App still needs real unsubscribe functions.
  subscribeWindowClose: () => () => {}, subscribeNotificationStatus: () => () => {}, subscribeNotificationNavigation: () => () => {},
  getDetachedQuestions: async () => questionFixture ? { protocolVersion:1, hostId:owner, sessionId, questions:[{questionId:"question-a",questionEntryId:"opened-a",originRunId:"run-a",openedAt:1,status:"open",delivery:{status:"waiting"},questions:[{id:"density",question:"Which sample density?",multi:false,options:[{label:"Comfortable"},{label:"Compact"}]}]}] } : null,
  getState: async () => structuredClone(state), getHosts: async () => ({ status: "connected", ownNodeId: "controlled", checkedAt: 1, hosts: [] }),
  getPreferences: async () => ({ version: 1, records: structuredClone(preferenceRecords) }), getTheme: async () => ({ document: { ...DEFAULT_THEME, mode: "dark" }, revision: "theme", filePath: "/controlled/theme.json" }),
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
    assert(request.initialUrl === "https://example.invalid/launcher", "New-tab acquisition lost the submitted address");
    browserCreates++; browserTab = { name: `desktop-${request.requestId}`, targetId: "cmux-fixture", backend: "cmux", kindTag: "cmux", state: "alive", title: "Browser", url: request.initialUrl, viewport: {width: 800, height: 600} };
    return {protocolVersion: 1, hostId: owner, sessionId, requestId: request.requestId, outcome: "completed", workerPid: 42, tab: browserTab, targetDisposition: "created-surface"};
  },
  getBrowserFrame: async () => { throw new Error("Unsupported CMUX preview must not request pixels"); },
  getSessionActivity: async (requestedSession, hostId) => { activityCalls.push({ sessionId: requestedSession, hostId }); return structuredClone(activity); }, workspaceQuery,
  command: async (envelope: CommandEnvelope): Promise<CommandResult> => {
    if (envelope.command.type === "draft.put") {
      draftWrites.push(structuredClone(envelope.command));
      if (envelope.command.draft.id.startsWith("new-chat-execution-mode:") && modeSaveFailure) {
        const failure=modeSaveFailure; modeSaveFailure=undefined;
        if (failure==="error") throw new Error("Controlled mode save unavailable");
        const currentDraft={...envelope.command.draft,execution:{type:"worktree" as const,startingState:{type:"working-tree" as const}},revision:envelope.command.expectedRevision+2,updatedAt:Date.now()};
        return {ok:false,commandId:envelope.id,error:{code:"DRAFT_CONFLICT",message:"The project mode changed on the owning host."},currentDraft};
      }
      return { ok: true, commandId: envelope.id, value: { ...envelope.command.draft, revision: envelope.command.expectedRevision + 1, updatedAt: Date.now() } };
    }
    if (envelope.command.type === "workspace.mutate" && (envelope.command.action.type === "git.checkout" || envelope.command.action.type === "git.checkout-ref" || envelope.command.action.type === "git.checkout-revision")) {
      branchWrites.push(structuredClone(envelope));
      if (envelope.command.action.expectedRevision !== gitStatus.revision) throw new Error("Wrong reviewed Git revision");
      await checkoutGate;
      if (checkoutUnknownOnce) { checkoutUnknownOnce = false; throw new Error("Controlled checkout outcome is unknown"); }
      const action = envelope.command.action;
      if (action.type === "git.checkout-ref" && (action.selection.localBranch !== undefined || !action.selection.ref.startsWith("refs/heads/") || action.selection.commit !== "a".repeat(40))) throw new Error("This fixture expects an exact local selection");
      if (action.type === "git.checkout-revision" && (!["HEAD", "a".repeat(40)].includes(action.revision.expression) || action.revision.commit !== "a".repeat(40))) throw new Error("Unresolved fixture revision");
      gitStatus.branch = action.type === "git.checkout-revision" ? null : action.type === "git.checkout-ref" ? action.selection.ref.slice("refs/heads/".length) : action.branch; gitStatus.revision += "-next";
      return {ok:true,commandId:envelope.id,value:{type:action.type,status:structuredClone(gitStatus)}};
    }
    if (envelope.command.type === "preferences.put") {
      preferenceWrites.push(structuredClone(envelope)); const change = envelope.command.change;
      preferenceCounter += 1;
      const preference = { ...change, deleted: change.deleted ?? false, revision: { counter: preferenceCounter, actor: preferenceActor, opId: crypto.randomUUID() } } as PreferenceRecord;
      const index = preferenceRecords.findIndex(record => record.key === change.key); if (index >= 0) preferenceRecords[index] = preference; else preferenceRecords.push(preference);
      return {ok:true,commandId:envelope.id,value:{type:"preferences.put",preference}};
    }
    if (envelope.command.type === "session.create") {
      sessionCreates.push(structuredClone(envelope));
      const created:SessionSummary={...session,id:"worktree-session",cwd:"/controlled/.worktrees/worktree-session",title:"Captured worktree prompt",status:"idle",createdAt:3,updatedAt:3};
      if (!state.sessions.some(item=>item.id===created.id)) state.sessions.push(created);
      return {ok:true,commandId:envelope.id,value:structuredClone(created)};
    }
    if (envelope.command.type === "session.prompt") {
      sessionPrompts.push(structuredClone(envelope)); await promptGate?.promise;
      return {ok:true,commandId:envelope.id};
    }
    throw new Error(`Unexpected controlled command: ${envelope.command.type}`);
  },
};
window.agentDesktop = new Proxy(methods as DesktopBridge, { get(target, key) { if (key in target) return target[key as keyof DesktopBridge]; return async () => { throw new Error(`Unexpected controlled bridge call: ${String(key)}`); }; } });
createRoot(document.getElementById("root")!).render(<App/>);

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const wait = async (read: () => unknown, label: string, timeout = 8000) => { const start = performance.now(); while (performance.now() - start < timeout) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out: ${label}`); };
const localFileState = (scope: ParentNode | null) => [...(scope?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(item => item.querySelector("small")?.textContent === "with local code changes");
const button = (scope: ParentNode | null, label: string) => [...(scope?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
const branchOption = (scope: ParentNode | null, name: string) => [...(scope?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])].find(item => item.querySelector("span")?.firstChild?.textContent === name);
/** Global dock toggles are stable checkboxes: fixed name, aria-checked reports the open state. */
const dockToggle = (region: "bottom" | "side", checked: boolean) => document.querySelector<HTMLButtonElement>(`[role="checkbox"][aria-label="Toggle ${region} panel"][aria-checked="${checked}"]`);
const route = () => `${windowState.route.hostId}:${windowState.route.sessionId}`;
/** The composer is a ProseMirror contenteditable (`div#prompt > p`), remounted across settings navigation: always query the current element. */
const promptElement = () => document.querySelector<HTMLElement>("#prompt")!;
/** Authored text as readComposerDocument derives it: text nodes plus hard breaks (`<br>`); ProseMirror's trailing break and inline file chips are not text. */
const promptText = () => [...(promptElement().querySelector("p")?.childNodes ?? [])].map(node => node.nodeType === Node.TEXT_NODE ? node.textContent ?? "" : node instanceof HTMLBRElement && !node.classList.contains("ProseMirror-trailingBreak") ? "\n" : "").join("");
const selectPrompt = () => { const prompt = promptElement(); prompt.focus(); const range = document.createRange(); range.selectNodeContents(prompt.querySelector("p") ?? prompt); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); };

Object.assign(window, {
  measureQuestionComposer: async (focus = false, edited = false) => {
    await wait(() => document.querySelector(".detached-question-card"), "production async question");
    const prompt = promptElement();
    if (focus) prompt.focus(); else prompt.blur();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const composer = document.querySelector(".composer")!.getBoundingClientRect(), card = document.querySelector(".detached-question-card")!.getBoundingClientRect();
    const stop = document.querySelector('[aria-label="Stop response"]')!, bounds = stop.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    assert(stop.contains(hit) && card.bottom <= composer.top && composer.bottom <= innerHeight, "Question composer hides stop or overlaps the card");
    assert(focus || edited ? composer.height > 60 : composer.height <= 48, `Question composer did not collapse when empty or expand for typing: focus=${focus}, height=${composer.height}, active=${document.activeElement?.id}, matches=${prompt.matches(":focus")}`);
    if (edited) assert(promptText() === "Keep this ordinary draft", "Question composer lost the ordinary draft");
    return { fitting:true, focused:focus, edited, composer:composer.toJSON(), card:card.toJSON(), stop:bounds.toJSON(), viewport:{width:innerWidth,height:innerHeight,devicePixelRatio} };
  },
  prepareFreshComposer: async () => {
    dockToggle("bottom", true)?.click();
    dockToggle("side", true)?.click();
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
  prepareComposerContext: async () => {
    document.querySelector<HTMLElement>(".composer-selection-menu")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
    await wait(()=>document.querySelector(".composer-context"),"fresh context strip");
    const projectButton = document.querySelector<HTMLButtonElement>('[aria-label="Select project"]')!;
    projectButton.click(); await wait(()=>document.querySelector('.composer-context-menu input'),"project search");
    return {focus:document.activeElement?.getAttribute("aria-label")};
  },
  exerciseComposerProject: async () => {
    const popup = document.querySelector<HTMLElement>(".composer-context-menu")!;
    await wait(()=>button(popup,"Dock project"),"filtered owning-host project");
    button(popup,"Dock project")!.click();
    await wait(()=>document.querySelector('[aria-label="Switch branch"]')?.textContent?.includes("feature/dock"),"project native branch");
    promptElement().focus();
  },
  exerciseWelcomeProjectHeading: async () => {
    await wait(()=>document.querySelector<HTMLButtonElement>('.welcome h1 button[aria-label="Dock project?"]') && document.querySelector(".welcome h1")?.textContent==="What should we build in Dock project?","project-aware welcome heading");
    const heading=document.querySelector<HTMLButtonElement>('.welcome h1 button[aria-label="Dock project?"]')!, anchor=heading.getBoundingClientRect();
    assert(promptText()==="Keep context draft","Draft was absent before opening the welcome project menu");
    heading.click();
    await wait(()=>document.querySelector('.composer-context-menu[aria-label="Select project"]'),"welcome project popup");
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const popup=document.querySelector<HTMLElement>('.composer-context-menu[aria-label="Select project"]')!, bounds=popup.getBoundingClientRect();
    assert(promptText()==="Keep context draft","Welcome project popup cleared the unsent draft");
    assert(bounds.bottom<=anchor.top+1 || bounds.top>=anchor.bottom-1,"Welcome project popup is not anchored to the heading trigger");
    assert(Math.abs((bounds.left+bounds.width/2)-(anchor.left+anchor.width/2))<=1,"Welcome project popup is not centered on its heading trigger");
    assert(document.activeElement?.getAttribute("aria-label")==="Search projects","Welcome project popup did not move keyboard focus into its search");
    checks.push("project-aware welcome heading opens the existing project menu at its own anchor without clearing the unsent draft");
    return {fitting:bounds.top>=0&&bounds.bottom<=innerHeight&&bounds.left>=0&&bounds.right<=innerWidth,anchor:anchor.toJSON(),popup:bounds.toJSON(),text:promptText()};
  },
  closeWelcomeProjectHeading: async () => {
    const heading=document.querySelector<HTMLButtonElement>('.welcome h1 button[aria-label="Dock project?"]')!;
    document.querySelector<HTMLElement>('.composer-context-menu[aria-label="Select project"]')!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
    await wait(()=>!document.querySelector('.composer-context-menu'),"welcome project popup Escape");
    assert(document.activeElement===heading,"Welcome project popup Escape did not restore heading focus");
    assert(promptText()==="Keep context draft","Welcome project popup Escape changed the unsent draft");
    checks.push("welcome project popup Escape restores focus to the heading trigger and preserves the draft");
  },
  exerciseComposerBranches: async () => {
    assert(promptText()==="Keep context draft", "Native composer text was not inserted");
    document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]')!.click();
    await wait(()=>branchOption(document.querySelector(".branch-selector-menu"),"context-fixture"),"branch catalog");
    branchOption(document.querySelector('.branch-selector-menu'),"feature/dock")!.click();
    await wait(()=>!document.querySelector('.branch-selector-menu'),"current branch dismisses without mutation");
    assert(branchWrites.length===0,"Choosing current branch sent a mutation");
    document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]')!.click();
    await wait(()=>branchOption(document.querySelector('.branch-selector-menu'),"context-fixture"),"reopened branch menu");
    const popup=document.querySelector<HTMLElement>(".branch-selector-menu")!, bounds=popup.getBoundingClientRect();
    const branch=branchOption(popup,"context-fixture")!, target=branch.getBoundingClientRect();
    assert(bounds.top>=0 && bounds.bottom<=innerHeight && branch.contains(document.elementFromPoint(target.x+target.width/2,target.y+target.height/2)),"Branch menu is clipped");
    branch.click(); await wait(()=>!document.querySelector(".branch-selector-menu"),"checkout receipt closes menu");
    assert(Number(branchWrites.length)===1 && gitStatus.branch==="context-fixture" && promptText()==="Keep context draft","Branch checkout lost draft or repeated command");
    assert(branchWrites[0]!.command.type==="workspace.mutate" && "projectId" in branchWrites[0]!.command.target && branchWrites[0]!.command.target.projectId===projectId,"Wrong project checkout target");
    document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]')!.click();
    await wait(()=>button(document.querySelector('.branch-selector-menu'),"Create and checkout new branch…"),"branch creation action");
    button(document.querySelector('.branch-selector-menu'),"Create and checkout new branch…")!.click();
    await wait(()=>document.activeElement?.getAttribute("aria-label")==="Branch name","new branch field focus");
    const dialog=document.querySelector<HTMLDialogElement>('.branch-selector-dialog')!, dialogBounds=dialog.getBoundingClientRect();
    assert(dialog.open && dialog.matches(":modal") && !document.querySelector('.branch-selector-menu'),"Branch creation remained an anchored menu instead of a modal dialog");
    assert(Math.abs(dialogBounds.left+dialogBounds.width/2-innerWidth/2)<=1 && Math.abs(dialogBounds.top+dialogBounds.height/2-innerHeight/2)<=1,"Branch creation dialog is not centered in the viewport");
    assert(dialogBounds.width>=360 && dialogBounds.width<=420 && dialogBounds.top>=0 && dialogBounds.bottom<=innerHeight,"Branch creation dialog geometry is clipped or outside the native feature-dialog width");
    assert(document.querySelector<HTMLInputElement>('[aria-label="Branch name"]')!.value==="codex/" && promptText()==="Keep context draft","Branch modal did not retain its native prefix or the unsent draft");
    return {fitting:true,dialog:dialogBounds.toJSON(),viewport:{width:innerWidth,height:innerHeight,devicePixelRatio}};
  },
  measureBranchDialog: () => {
    const dialog=document.querySelector<HTMLDialogElement>('.branch-selector-dialog')!, style=getComputedStyle(dialog), backdrop=getComputedStyle(dialog,'::backdrop');
    const bounds=dialog.getBoundingClientRect();
    return {fitting:bounds.width<=innerWidth && bounds.height<=innerHeight,dialog:bounds.toJSON(),style:{background:style.backgroundColor,backdropFilter:style.backdropFilter,radius:style.borderRadius,overlayColor:backdrop.backgroundColor,overlayBlur:backdrop.backdropFilter},viewport:{width:innerWidth,height:innerHeight,devicePixelRatio}};
  },
  checkBranchModalTrap: async () => {
    const dialog=document.querySelector<HTMLDialogElement>('.branch-selector-dialog')!;
    assert(dialog.open && dialog.contains(document.activeElement),"Keyboard navigation escaped the modal dialog");
  },
  checkBranchModalEscape: async () => {
    await wait(()=>!document.querySelector('.branch-selector-dialog'),"branch modal Escape");
    assert(document.activeElement===document.querySelector('[aria-label="Switch branch"]'),"Branch modal Escape did not restore the branch trigger");
    assert(promptText()==="Keep context draft","Branch modal Escape changed the unsent draft");
  },
  reopenBranchModal: async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]')!.click();
    await wait(()=>button(document.querySelector('.branch-selector-menu'),"Create and checkout new branch…"),"reopened branch creation action");
    button(document.querySelector('.branch-selector-menu'),"Create and checkout new branch…")!.click();
    await wait(()=>document.activeElement?.getAttribute("aria-label")==="Branch name","reopened branch field focus");
  },
  branchModalBackdropPoint: () => {
    const bounds=document.querySelector<HTMLDialogElement>('.branch-selector-dialog')!.getBoundingClientRect();
    return {x:Math.max(4,Math.floor(bounds.left/2)),y:Math.floor(innerHeight/2)};
  },
  checkBranchModalBackdrop: async () => {
    await wait(()=>!document.querySelector('.branch-selector-dialog'),"branch modal backdrop dismissal");
    assert(document.activeElement===document.querySelector('[aria-label="Switch branch"]'),"Branch modal backdrop dismissal did not restore the branch trigger");
    assert(promptText()==="Keep context draft","Branch modal backdrop dismissal changed the unsent draft");
  },
  finishComposerContext: async () => {
    const dialog=document.querySelector<HTMLDialogElement>('.branch-selector-dialog')!;
    button(dialog,"Set prefix")!.click(); await wait(()=>document.querySelector<HTMLInputElement>('[aria-label="New branch prefix"]'),"Git settings navigation");
    const prefix=document.querySelector<HTMLInputElement>('[aria-label="New branch prefix"]')!;
    prefix.focus(); prefix.select(); document.execCommand("insertText",false,"team/");
    button(document.querySelector<HTMLElement>('[aria-label="Git settings"]'),"Save")!.click(); await wait(()=>preferenceWrites.length===1,"saved branch prefix");
    assert(preferenceWrites[0]!.command.type==="preferences.put" && preferenceWrites[0]!.command.change.key==="git.branchPrefix" && (preferenceWrites[0]!.command.change as any).value==="team/","Set prefix did not persist through shared preferences");
    button(document.querySelector<HTMLElement>('[aria-label="Git settings"]'),"Close Git settings")!.click();
    await wait(()=>document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]'),"return from Git settings");
    document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]')!.click(); await wait(()=>button(document.querySelector('.branch-selector-menu'),"Create and checkout new branch…"),"reopen branch modal after settings"); button(document.querySelector('.branch-selector-menu'),"Create and checkout new branch…")!.click(); await wait(()=>document.querySelector<HTMLInputElement>('[aria-label="Branch name"]'),"reopened branch field");
    const createDialog=document.querySelector<HTMLDialogElement>('.branch-selector-dialog')!, create=button(createDialog,"Create and checkout")!;
    assert(document.querySelector<HTMLInputElement>('[aria-label="Branch name"]')!.value==="team/" && promptText()==="Keep context draft","Saved prefix or ordinary draft was lost when returning from Git settings");
    document.querySelector<HTMLInputElement>('[aria-label="Branch name"]')!.focus(); document.execCommand("insertText",false,"new-context-branch");
    const deliveriesBeforeCreate=branchWrites.length; checkoutUnknownOnce=true;
    assert(!create.disabled,"Named new branch remains disabled"); create.click();
    await wait(()=>button(document.querySelector('.branch-selector-dialog'),"Retry original workspace command"),"uncertain create receipt");
    assert(branchWrites.length===deliveriesBeforeCreate+1 && document.querySelector<HTMLInputElement>('[aria-label="Branch name"]')?.value==="team/new-context-branch","Uncertain creation lost its modal input or original delivery");
    await new Promise(resolve=>setTimeout(resolve,100));
    assert(branchWrites.length===deliveriesBeforeCreate+1,"Uncertain branch creation replayed without an explicit retry");
    button(document.querySelector('.branch-selector-dialog'),"Retry original workspace command")!.click();
    await wait(()=>!document.querySelector('.branch-selector-dialog'),"branch creation receipt");
    assert(gitStatus.branch==="team/new-context-branch" && branchWrites.length===deliveriesBeforeCreate+2 && branchWrites.at(-1)!.id===branchWrites.at(-2)!.id && promptText()==="Keep context draft","Creation retry changed command identity, branch text, or unsent draft");
    const command=branchWrites.at(-1)!.command;
    assert(command.type==="workspace.mutate" && command.action.type==="git.checkout" && command.action.create===true,"Create action omitted native creation intent");
    document.querySelector<HTMLButtonElement>('[aria-label="Select project"]')!.click();
    await wait(()=>document.querySelector('.composer-context-menu'),"clear project menu");
    button(document.querySelector(".composer-context-menu")!,"Don’t work in a project")!.click();
    await wait(()=>!document.querySelector('[aria-label="Switch branch"]'),"cleared project context");
    assert(promptText()==="Keep context draft","Changing project cleared typed text");
    await wait(()=>draftWrites.some(write=>write.draft.id==="new-conversation" && write.draft.projectId===null && write.draft.text==="Keep context draft"),"durable text after project removal");
    document.querySelector<HTMLButtonElement>('[aria-label="Select where to run the chat"]')!.click();
    await wait(()=>document.querySelector('.composer-context-menu[aria-label="Select where to run the chat"]'),"host menu");
    const hostMenu=document.querySelector<HTMLElement>('.composer-context-menu')!;
    assert(hostMenu.textContent?.includes("Controlled workstation"),"Host menu hides actual owning host");
    hostMenu.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
    await wait(()=>!document.querySelector('.composer-context-menu'),"host popup dismissed");
    assert(document.activeElement?.getAttribute("aria-label")==="Select where to run the chat","Context Escape lost focus");
    checks.push("new-chat context menus route reviewed branch commands and the centered create modal traps focus, accepts native text input, restores its trigger and preserves durable draft text");
    return {fitting:true,branchWrites,projectId:null,text:promptText(),context:document.querySelector('.composer-context')!.getBoundingClientRect().toJSON()};
  },
  checkDisposedComposerContext: async () => {
    const delayedProject={id:"delayed-project",hostId:owner,name:"Delayed project",path:"/controlled/delayed",createdAt:1};
    state.projects.push(delayedProject);
    for(const listener of listeners) listener({type:"state",hostId:owner,sequence:state.lastEventSequence,state:structuredClone(state)});
    const original=offlineCache.read, gate=Promise.withResolvers<string|null>(); let requested=false;
    offlineCache.read=async key=>{if(key.endsWith(":project:delayed-project")){requested=true;return gate.promise;} return original(key);};
    try{
      document.querySelector<HTMLButtonElement>('[aria-label="Select project"]')!.click();
      await wait(()=>button(document.querySelector('.composer-context-menu'),"Delayed project"),"new delayed project catalog");
      button(document.querySelector('.composer-context-menu'),"Delayed project")!.click();
      await wait(()=>requested,"delayed recovery read started");
      document.querySelector<HTMLButtonElement>('[aria-label="Select project"]')!.click();
      await wait(()=>button(document.querySelector('.composer-context-menu'),"Don’t work in a project"),"clear delayed project");
      button(document.querySelector('.composer-context-menu'),"Don’t work in a project")!.click();
      await wait(()=>!document.querySelector('[aria-label="Switch branch"]'),"delayed context unmounted");
      gate.resolve(null); await new Promise(resolve=>setTimeout(resolve,100));
      assert(!workspaceCalls.some(call=>(call.target as {projectId?:string})?.projectId==="delayed-project"),"Disposed context started a stale Git read after recovery");
      checks.push("switching project during delayed recovery cancels the old context read without disconnecting shared panels");
    }finally{offlineCache.read=original;gate.resolve(null);}
  },
  checkCompletedCheckoutContext: async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Select project"]')!.click();
    await wait(()=>button(document.querySelector('.composer-context-menu'),"Dock project"),"restore project for pending command");
    button(document.querySelector('.composer-context-menu'),"Dock project")!.click();
    await wait(()=>document.querySelector('[aria-label="Switch branch"]'),"restored branch context");
    const gate=Promise.withResolvers<void>();checkoutGate=gate.promise;const count=branchWrites.length;
    try{
      document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]')!.click();
      await wait(()=>branchOption(document.querySelector('.branch-selector-menu'),"feature/dock"),"pending checkout menu");
      branchOption(document.querySelector('.branch-selector-menu'),"feature/dock")!.click();
      await wait(()=>branchWrites.length===count+1,"checkout delivered and waiting");
      document.querySelector<HTMLButtonElement>('[aria-label="Select project"]')!.click();
      await wait(()=>button(document.querySelector('.composer-context-menu'),"Don’t work in a project"),"switch context during command");
      button(document.querySelector('.composer-context-menu'),"Don’t work in a project")!.click();
      await wait(()=>!document.querySelector('[aria-label="Switch branch"]'),"changed context while checkout pending");
      document.querySelector<HTMLButtonElement>('[aria-label="Select where to run the chat"]')!.click();
      await wait(()=>document.querySelector('.composer-context-menu[aria-label="Select where to run the chat"]'),"new host menu while old checkout pending");
      gate.resolve();await wait(()=>gitStatus.branch==="feature/dock","old checkout completed");
      await new Promise(resolve=>setTimeout(resolve,100));
      const menu=document.querySelector<HTMLElement>('.composer-context-menu[aria-label="Select where to run the chat"]');
      assert(menu,"Old checkout completion dismissed the new context menu");
      menu.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
      checks.push("old checkout receipt cannot dismiss another project or host menu");
    }finally{gate.resolve();checkoutGate=undefined;}
  },
  beginWorktreeSubmission: async () => {
    gitStatus.branch=null; gitStatus.revision+="-detached";
    const projectButton=document.querySelector<HTMLButtonElement>('[aria-label="Select project"]')!; projectButton.click();
    await wait(()=>button(document.querySelector('.composer-context-menu'),"Dock project"),"worktree project choice"); button(document.querySelector('.composer-context-menu'),"Dock project")!.click();
    await wait(()=>document.querySelector('[aria-label="Switch branch"]'),"detached source branch trigger");
    const sourceBranch=document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]')!; sourceBranch.click();
    await wait(()=>sourceBranch.textContent?.includes("Detached HEAD") && document.querySelector('.branch-selector-menu'),"detached worktree Git context");
    document.querySelector<HTMLElement>('.branch-selector-menu')!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
    await wait(()=>!document.querySelector('.branch-selector-menu') && document.querySelector<HTMLButtonElement>('[aria-label="Select where to run the chat"]'),"detached branch menu close");
    const location=document.querySelector<HTMLButtonElement>('[aria-label="Select where to run the chat"]')!; location.click();
    await wait(()=>button(document.querySelector('.composer-context-menu'),"New local worktree")?.disabled===false,"worktree mode option");
    const beforeMutations=branchWrites.length, beforeCreates=sessionCreates.length;
    button(document.querySelector('.composer-context-menu'),"New local worktree")!.click();
    await wait(()=>document.querySelector<HTMLButtonElement>('[aria-label="What branch should this chat start from?"]'),"worktree starting state control");
    assert(document.querySelector<HTMLButtonElement>('[aria-label="What branch should this chat start from?"]')!.textContent?.includes("(current)"),"Dirty detached HEAD did not fall back to local file state");
    assert(branchWrites.length===beforeMutations && sessionCreates.length===beforeCreates,"Selecting worktree mode mutated the repository or created a session");
    assert(!document.querySelector('[aria-label="Switch branch"]'),"Worktree composer exposes a redundant source-checkout control");
    location.click();
    await wait(()=>button(document.querySelector('.composer-context-menu'),"Local"),"return to Local mode");
    button(document.querySelector('.composer-context-menu'),"Local")!.click();
    await wait(()=>document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]')?.textContent?.includes("Detached HEAD"),"Local mode restores source branch control");
    assert(!document.querySelector('[aria-label="What branch should this chat start from?"]'),"Local mode retains worktree starting-state control");
    location.click();
    await wait(()=>button(document.querySelector('.composer-context-menu'),"New local worktree")?.disabled===false,"return to worktree mode");
    button(document.querySelector('.composer-context-menu'),"New local worktree")!.click();
    await wait(()=>document.querySelector('[aria-label="What branch should this chat start from?"]') && !document.querySelector('[aria-label="Switch branch"]'),"worktree control replaces checkout control");
    assert(branchWrites.length===beforeMutations && sessionCreates.length===beforeCreates,"Toggling execution mode changed source Git or created a session");
    document.querySelector<HTMLButtonElement>('[aria-label="What branch should this chat start from?"]')!.click();
    await wait(()=>localFileState(document.querySelector('.composer-context-menu')),"dirty local file state");
    assert(document.querySelector<HTMLInputElement>('[aria-label="Search Dock project branches"]') && !button(document.querySelector('.composer-context-menu'),"origin/feature/dock"),"Starting-state menu is not the native local branch catalog");
    localFileState(document.querySelector('.composer-context-menu'))!.click();
    await wait(()=>document.querySelector<HTMLButtonElement>('[aria-label="What branch should this chat start from?"]')?.textContent?.includes("(current)"),"working-tree choice");
    assert(branchWrites.length===beforeMutations && sessionCreates.length===beforeCreates,"Selecting local file state mutated the source repository or created a session");
    selectPrompt(); document.execCommand('insertText',false,'Captured worktree prompt');
    document.querySelector<HTMLButtonElement>('[aria-label="Select project"]')!.click();
    await wait(()=>button(document.querySelector('.composer-context-menu'),"Don’t work in a project"),"clear worktree project");
    button(document.querySelector('.composer-context-menu'),"Don’t work in a project")!.click();
    await wait(()=>!document.querySelector('[aria-label="What branch should this chat start from?"]'),"project clear returns to Local");
    assert(promptText()==='Captured worktree prompt',"Project clear lost authored prompt");
    document.querySelector<HTMLButtonElement>('[aria-label="Select project"]')!.click();
    await wait(()=>button(document.querySelector('.composer-context-menu'),"Dock project"),"restore worktree project");
    button(document.querySelector('.composer-context-menu'),"Dock project")!.click();
    await wait(()=>document.querySelector<HTMLButtonElement>('[aria-label="What branch should this chat start from?"]')?.textContent?.includes("(current)"),"project restores remembered worktree mode");
    assert(promptText()==='Captured worktree prompt' && !document.querySelector('[aria-label="Switch branch"]'),"Restored worktree mode lost prompt or retained source checkout control");
    assert(branchWrites.length===beforeMutations && sessionCreates.length===beforeCreates,"Project mode restoration mutated Git or created a session");
    await wait(()=>draftWrites.some(write=>write.draft.id===`new-chat-execution-mode:${projectId}` && write.draft.execution?.type==="worktree"),"initial mode preference reaches transport");
    modeSaveFailure="conflict";
    location.click(); await wait(()=>button(document.querySelector('.composer-context-menu'),"Local"),"mode conflict choice");
    button(document.querySelector('.composer-context-menu'),"Local")!.click();
    await wait(()=>button(document.querySelector('.draft-conflict'),"Keep my mode"),"opposite mode conflict is visible");
    assert(document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled && promptText()==='Captured worktree prompt',"Mode conflict permits new Send or alters prompt");
    button(document.querySelector('.draft-conflict'),"Keep my mode")!.click();
    await wait(()=>!document.querySelector('.draft-conflict') && document.querySelector('[aria-label="Switch branch"]'),"resolve mode conflict with explicit Local choice");
    const resolvedModeWrites=draftWrites.filter(write=>write.draft.id===`new-chat-execution-mode:${projectId}`).length;
    await wait(()=>draftWrites.filter(write=>write.draft.id===`new-chat-execution-mode:${projectId}`).length>resolvedModeWrites,"resolved mode save");
    modeSaveFailure="error";
    location.click(); await wait(()=>button(document.querySelector('.composer-context-menu'),"New local worktree")?.disabled===false,"mode retry choice");
    button(document.querySelector('.composer-context-menu'),"New local worktree")!.click();
    await wait(()=>button(document.querySelector('.inline-error'),"Retry mode save"),"mode save error exposes Retry");
    assert(promptText()==='Captured worktree prompt' && document.querySelector('[aria-label="What branch should this chat start from?"]'),"Failed mode save discarded current draft intent");
    button(document.querySelector('.inline-error'),"Retry mode save")!.click();
    await wait(()=>![...document.querySelectorAll('button')].some(item=>item.textContent==='Retry mode save'),"mode retry succeeds visibly");
    assert(branchWrites.length===beforeMutations && sessionCreates.length===beforeCreates,"Mode conflict or retry mutated Git or created a session");


    await wait(()=>document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled===false,"worktree Send enabled");
    promptGate=Promise.withResolvers<void>(); document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
    await wait(()=>sessionCreates.length===beforeCreates+1 && sessionPrompts.length===1,"captured worktree create and prompt");
    assert(branchWrites.length===beforeMutations,"Send performed a source checkout");
    const create=sessionCreates.at(-1)!;
    assert(create.commandVersion===4 && create.command.type==='session.create' && create.command.projectId===projectId && create.command.worktree?.type==='working-tree',"Send did not capture the owning project and selected local file state");
    const pending=document.querySelector('.subtle-notice details')?.textContent ?? '';
    assert(pending.includes('New local worktree') && pending.includes('Local file state'),"Pending snapshot omitted its captured execution mode or starting state");
    checks.push("dirty detached HEAD selects local file state for a worktree without mutating the source; Send captures the owning project and working-tree state");
    const promptBounds=promptElement().getBoundingClientRect(); return {prompt:{x:promptBounds.x+20,y:promptBounds.y+20}};
  },
  checkWorktreePromptFocus: async () => {
    await wait(()=>document.activeElement===document.querySelector("#prompt"),"native pointer focuses worktree prompt before typing");
  },
  finishWorktreeSubmission: async () => {
    await wait(()=>promptText().includes(" newer edit"),"native newer edit reaches composer before receipt");
    promptGate?.resolve();
    await wait(()=>!document.querySelector('.subtle-notice details') && promptText().includes(' newer edit'),"worktree submission completion with newer edit");
    assert(sessionCreates.length===1 && sessionPrompts.length===1,"Worktree submission created or prompted more than once");
    const sent=sessionPrompts[0]!.command;
    assert(sent.type==='session.prompt' && sent.text==='Captured worktree prompt' && promptText().includes(' newer edit') && promptText()!==sent.text,"Captured prompt or newer draft edit changed during delivery");
    checks.push("one worktree session and one prompt use the captured draft while newer text remains in the composer");
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


    const sideToggle = dockToggle("side", false); assert(sideToggle, "accessible side panel toggle"); sideToggle.click();
    await wait(() => dockToggle("side", true), "side toggle reports checked");
    await wait(() => getComputedStyle(document.querySelector<HTMLElement>(".dock-slot-right")!).display !== "none" && document.querySelector(".dock-slot-right .dock-empty-actions"), "empty side chooser");
    const right = document.querySelector<HTMLElement>(".dock-slot-right")!; assert(right.getAttribute("inert") === null, "open side dock remained inert");
    const chooserAction = (label: string) => [...right.querySelectorAll<HTMLButtonElement>(".dock-empty-actions button")].find(item => item.querySelector("span")?.textContent === label);
    await wait(() => chooserAction("Review") && chooserAction("Files"), "eligible chooser workspace actions");
    chooserAction("Review")!.click(); await wait(() => right.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes("Review") && right.querySelector(".review-panel"), "real review tab");
    const selectPanelAction = async (label: string) => {
      const add = right.querySelector<HTMLButtonElement>('button[aria-label="Open right panel tab"]');
      assert(add, "Panel add trigger missing"); add.focus(); add.dispatchEvent(new KeyboardEvent("keydown", { key:"ArrowDown", bubbles:true, cancelable:true }));
      await wait(() => document.querySelector('[role="menu"][aria-label="Open right panel tab"]'), "portaled panel chooser");
      const item = [...document.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Open right panel tab"] [role="menuitem"]')].find(item => item.querySelector("span")?.textContent === label);
      assert(item, `${label} menu item missing`); item.click();
    };
    await selectPanelAction("Files");
    await wait(() => right.querySelectorAll('[role="tab"]').length === 2 && right.querySelector(".workspace-file-browser") && right.querySelector('[role="tree"][aria-label="Files"]'), "real files tab");
    assert(right.textContent?.includes("Open file") && right.textContent?.includes("Select a file from the workspace tree"), "Files tab did not render the empty Open file tree surface");
    assert(document.activeElement?.getAttribute("placeholder") === "Filter files…", "Open file did not focus the tree filter");
    menuDismissal.add = !document.querySelector('[role="menu"][aria-label="Open right panel tab"]');
    assert(workspaceCalls.some(call => call.query.type === "git.status") && workspaceCalls.some(call => call.query.type === "files.list"), "workspace tabs did not query controlled Git/files surfaces");
    checks.push("header opens an accessible empty chooser and real Review and Files workspace tabs");

    const rightMenu = right.querySelector<HTMLDetailsElement>(".dock-menu")!; rightMenu.open = true; button(rightMenu, "Move to bottom dock")!.click();
    const bottom = document.querySelector<HTMLElement>(".dock-slot-bottom")!; await wait(() => bottom.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes("Open file"), "move Open file to bottom");
    const bottomPanel = bottom.querySelector<HTMLElement>(".dock-panel")!;
    assert(Math.abs(bottomPanel.getBoundingClientRect().height - bottom.clientHeight) <= 1, "bottom panel does not fill its resizable dock");
    menuDismissal.move = !rightMenu.open; rightMenu.open = false;
    assert(route() === expectedRoute, "dock movement changed route");
    button(bottom, "Close Open file tab")!.click(); await wait(() => !bottom.querySelector('[data-dock-tab-id$=":files"]'), "close moved Open file tab");
    assert(button(bottom, "Close"), "bottom dock lacks a direct Close control"); button(bottom, "Close")!.click(); await wait(() => getComputedStyle(bottom).display === "none" && dockToggle("bottom", false), "hide bottom panel");
    assert(windowState.dock!.tabs.some(tab => tab.id === restoredTab.id), "closing another tab removed restored pane identity");
    checks.push("menu movement, close, and hide update dock layout without changing navigation or unrelated panes");

    await selectPanelAction("Browser");
    await wait(() => right.querySelector(".browser-panel"), "local browser launcher");
    assert(Number(browserCreates) === 0 && Number(browserReads) === 0, "Opening a local new tab contacted its native browser");
    const browserAddress = right.querySelector<HTMLInputElement>('[aria-label="Page address"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(browserAddress, "https://example.invalid/launcher");
    browserAddress.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(() => windowState.dock?.tabs.some(tab => tab.browserNewTab?.draft === "https://example.invalid/launcher"), "new-tab draft persisted");
    browserAddress.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await wait(() => right.querySelector(".browser-panel") && browserReads > 0 && browserCreates === 1, "submitted browser dock reads exact owner metadata");
    assert(browserCreates === 1 && right.textContent?.includes("does not support viewport previews"), "Browser creation did not retain the exact unsupported CMUX target");
    dockToggle("side", true)!.click();
    await wait(() => getComputedStyle(right).display === "none", "hide actual browser dock");
    const hiddenReads = browserReads; await new Promise(resolve => setTimeout(resolve, 1200));
    assert(browserReads === hiddenReads, "Hidden production App dock kept browser polling active");
    dockToggle("side", false)!.click();
    await wait(() => browserReads > hiddenReads, "show browser resumes polling");
    button(right, "Close Browser tab")!.click();
    await wait(() => !right.querySelector(".browser-panel"), "browser close unmounts viewer");
    checks.push("browser dock queries its owner and stops polling when the real App hides the dock");

    const environment = document.querySelector<HTMLButtonElement>('[aria-label="Environment"]'); assert(environment, "accessible Environment control"); environment.click();
    await wait(() => document.querySelector(".environment-card") && activityCalls.length > 0, "Environment activity");
    const card = document.querySelector<HTMLElement>(".environment-card")!; await wait(() => card.textContent?.includes("feature/dock"), "Environment Git state");
    assert(activityCalls.some(call => call.sessionId === sessionId && call.hostId === owner), "activity query lost owner/session identity");
    assert(card.textContent?.includes("Dock verifier") && card.textContent?.includes("Run dock acceptance"), "native activity response is absent from Environment card");
    assert(environment.getAttribute("aria-label") === "Environment", "Environment toggle has no accessible name");
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
    const environment = document.querySelector<HTMLButtonElement>('[aria-label="Environment"]'); assert(document.querySelector(".environment-card") && environment, "Environment toggle before short chooser"); environment.click();
    await wait(() => !document.querySelector(".environment-card"), "close Environment before short chooser capture");
    const right = document.querySelector<HTMLElement>(".dock-slot-right")!; button(right, "Close Review tab")!.click(); await wait(() => right.querySelector(".dock-empty-actions"), "empty side chooser after close");
    const side = dockToggle("side", false); assert(side, "show side dock control"); side.click(); await wait(() => getComputedStyle(right).display !== "none", "show empty side chooser");
    dockToggle("bottom", false)?.click();
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
    const chooserHit = lastBounds ? document.elementFromPoint(lastBounds.left + lastBounds.width / 2, lastBounds.top + lastBounds.height / 2) : null;
    const chooserReachable = Boolean(chooserBounds && lastBounds && chooserLast && lastBounds.top >= chooserBounds.top - 1 && lastBounds.bottom <= chooserBounds.bottom + 1 && chooserHit && chooserLast.contains(chooserHit));
    const headerControls = ["Environment", "Toggle bottom panel", "Toggle side panel"];
    const namedControls = headerControls.every(name => document.querySelector(`[role="checkbox"][aria-label="${name}"]`));
    const headerControlsClickable = headerControls.every(name => {
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
