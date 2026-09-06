import { offlineCache } from "../../apps/desktop/src/renderer/offline-cache";
import { createRoot } from "react-dom/client";
import { App } from "../../apps/desktop/src/renderer/App";
import { defaultWindowView, type WindowViewState } from "../../apps/desktop/src/window-state";
import { createDockState, dockTabId, insertDockTab, type DockTab } from "../../apps/desktop/src/renderer/dock-state";
import { DEFAULT_THEME } from "../../packages/shared/src/theme";
import { TERMINAL_DIMENSIONS, type NativeTerminalInfo } from "../../packages/shared/src/terminals";
import type { CommandEnvelope, CommandResult, DesktopBridge, DesktopEvent, HostState, OmpComposerCatalog, SessionActivitySnapshot, SessionSummary, WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const questionFixture = new URLSearchParams(location.search).has("question");
const owner = "app-dock-owner", projectId = "dock-project", sessionId = "dock-session";
const checks: string[] = [], activityCalls: { sessionId: string; hostId?: string }[] = [], workspaceCalls: { target: unknown; query: WorkspaceQuery; hostId?: string }[] = [];
let browserReads = 0, browserCreates = 0;
const draftWrites: Extract<CommandEnvelope["command"],{type:"draft.put"}>[] = [];
const branchWrites: CommandEnvelope[] = [];
const preferenceWrites: CommandEnvelope[] = [];
let preferenceCounter = 0;
const preferenceRecords: any[] = [];
const preferenceActor = crypto.randomUUID();
let checkoutGate: Promise<void> | undefined;
let checkoutUnknownOnce = false;
let browserTab: import("../../packages/shared/src/protocol").NativeBrowserTabMetadata | undefined;
const menuDismissal = { add: false, move: false };
const listeners = new Set<(event: DesktopEvent) => void>();
const nativeTerminalListeners = new Set<(event: any) => void>();
const model = { provider: "controlled", id: "text", name: "Controlled", input: ["text"], contextWindow: 1000, maxTokens: 1000, reasoning: true, thinkingLevels: ["off", "low", "high"], authenticated: true, available: true };
const session: SessionSummary = { id: sessionId, hostId: owner, projectId, cwd: "/controlled/project", title: "Dock acceptance conversation", sessionFile: "/controlled/session.jsonl", status: questionFixture ? "running" : "idle", model, archived: false, createdAt: 1, updatedAt: 2 };
const state: HostState = { protocolVersion: 1, host: { id: owner, name: "Controlled workstation", platform: "darwin", architecture: "arm64" }, projects: [{ id: projectId, hostId: owner, name: "Dock project", path: "/controlled/project", createdAt: 1 }], sessions: [session], models: [model], drafts: [], lastEventSequence: 1, imageAttachments: { protocolVersion:1, commandVersion:3, maxImages:4, maxImageBytes:20*1024*1024, maxBatchBytes:20*1024*1024, maxImagePixels:16_777_216, mimeTypes:["image/png","image/jpeg","image/gif","image/webp"] } };
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
if (questionFixture) { restoredState.right.visible = false; restoredState.bottom.visible = false; }
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
    case "git.branches": return { type: query.type, branches: ["feature/dock","context-fixture"].map(name=>({name,ref:`refs/heads/${name}`,current:name===gitStatus.branch,remote:false,commit:"abc123"})) };
    case "git.worktrees": return { type: query.type, worktrees: [{ path: "/controlled/project", head: "abc123", branch: "feature/dock", detached: false, bare: false, locked: false, managed: false }] };
  }
};
const catalog: OmpComposerCatalog = { models: [model], cwd: "/controlled/project", default: { model, approvalMode: "always-ask", source: "configured-role" }, resolution: "native-registry-preview" };
const methods: Partial<DesktopBridge> = {
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
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
    browserCreates++; browserTab = { name: `desktop-${request.requestId}`, targetId: "cmux-fixture", backend: "cmux", kindTag: "cmux", state: "alive", title: "Browser", url: "about:blank", viewport: {width: 800, height: 600} };
    return {protocolVersion: 1, hostId: owner, sessionId, requestId: request.requestId, outcome: "completed", workerPid: 42, tab: browserTab, targetDisposition: "created-surface"};
  },
  getBrowserFrame: async () => { throw new Error("Unsupported CMUX preview must not request pixels"); },
  getSessionActivity: async (requestedSession, hostId) => { activityCalls.push({ sessionId: requestedSession, hostId }); return structuredClone(activity); }, workspaceQuery,
  command: async (envelope: CommandEnvelope): Promise<CommandResult> => {
    if (envelope.command.type === "draft.put") {
      draftWrites.push(structuredClone(envelope.command));
      return { ok: true, commandId: envelope.id, value: { ...envelope.command.draft, revision: envelope.command.expectedRevision + 1, updatedAt: Date.now() } };
    }
    if (envelope.command.type === "workspace.mutate" && envelope.command.action.type === "git.checkout") {
      branchWrites.push(structuredClone(envelope));
      if (envelope.command.action.expectedRevision !== gitStatus.revision) throw new Error("Wrong reviewed Git revision");
      await checkoutGate;
      if (checkoutUnknownOnce) { checkoutUnknownOnce = false; throw new Error("Controlled checkout outcome is unknown"); }
      gitStatus.branch = envelope.command.action.branch; gitStatus.revision += "-next";
      return {ok:true,commandId:envelope.id,value:{type:"git.checkout",status:structuredClone(gitStatus)}};
    }
    if (envelope.command.type === "preferences.put") {
      preferenceWrites.push(structuredClone(envelope)); const change = envelope.command.change;
      preferenceCounter += 1;
      const preference = { key: change.key, ...(change.deleted ? { deleted: true } : { value: change.value, deleted: false }), revision: { counter: preferenceCounter, actor: preferenceActor, opId: crypto.randomUUID() } };
      const index = preferenceRecords.findIndex(record => record.key === change.key); if (index >= 0) preferenceRecords[index] = preference; else preferenceRecords.push(preference);
      return {ok:true,commandId:envelope.id,value:{type:"preferences.put",preference}};
    }
    throw new Error(`Unexpected controlled command: ${envelope.command.type}`);
  },
};
window.agentDesktop = new Proxy(methods as DesktopBridge, { get(target, key) { if (key in target) return target[key as keyof DesktopBridge]; return async () => { throw new Error(`Unexpected controlled bridge call: ${String(key)}`); }; } });
createRoot(document.getElementById("root")!).render(<App/>);

const assert = (value: unknown, message: string): asserts value => { if (!value) throw new Error(message); };
const wait = async (read: () => unknown, label: string, timeout = 8000) => { const start = performance.now(); while (performance.now() - start < timeout) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out: ${label}`); };
const button = (scope: ParentNode | null, label: string) => [...(scope?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
const route = () => `${windowState.route.hostId}:${windowState.route.sessionId}`;

Object.assign(window, {
  measureQuestionComposer: async (focus = false, edited = false) => {
    await wait(() => document.querySelector(".detached-question-card"), "production async question");
    const prompt = document.querySelector<HTMLTextAreaElement>("#prompt")!;
    if (focus) prompt.focus(); else prompt.blur();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const composer = document.querySelector(".composer")!.getBoundingClientRect(), card = document.querySelector(".detached-question-card")!.getBoundingClientRect();
    const stop = document.querySelector('[aria-label="Stop response"]')!, bounds = stop.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    assert(stop.contains(hit) && card.bottom <= composer.top && composer.bottom <= innerHeight, "Question composer hides stop or overlaps the card");
    assert(focus || edited ? composer.height > 60 : composer.height <= 48, `Question composer did not collapse when empty or expand for typing: focus=${focus}, height=${composer.height}, active=${document.activeElement?.id}, matches=${prompt.matches(":focus")}`);
    if (edited) assert(prompt.value === "Keep this ordinary draft", "Question composer lost the ordinary draft");
    return { fitting:true, focused:focus, edited, composer:composer.toJSON(), card:card.toJSON(), stop:bounds.toJSON(), viewport:{width:innerWidth,height:innerHeight,devicePixelRatio} };
  },
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
    const prompt=document.querySelector<HTMLTextAreaElement>("#prompt")!; prompt.focus();
  },
  exerciseWelcomeProjectHeading: async () => {
    const prompt=document.querySelector<HTMLTextAreaElement>("#prompt")!;
    await wait(()=>document.querySelector<HTMLButtonElement>('.welcome h1 button[aria-label="Dock project?"]') && document.querySelector(".welcome h1")?.textContent==="What should we build in Dock project?","project-aware welcome heading");
    const heading=document.querySelector<HTMLButtonElement>('.welcome h1 button[aria-label="Dock project?"]')!, anchor=heading.getBoundingClientRect();
    assert(prompt.value==="Keep context draft","Draft was absent before opening the welcome project menu");
    heading.click();
    await wait(()=>document.querySelector('.composer-context-menu[aria-label="Select project"]'),"welcome project popup");
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const popup=document.querySelector<HTMLElement>('.composer-context-menu[aria-label="Select project"]')!, bounds=popup.getBoundingClientRect();
    assert(prompt.value==="Keep context draft","Welcome project popup cleared the unsent draft");
    assert(bounds.bottom<=anchor.top+1 || bounds.top>=anchor.bottom-1,"Welcome project popup is not anchored to the heading trigger");
    assert(Math.abs((bounds.left+bounds.width/2)-(anchor.left+anchor.width/2))<=1,"Welcome project popup is not centered on its heading trigger");
    assert(document.activeElement?.getAttribute("aria-label")==="Search projects","Welcome project popup did not move keyboard focus into its search");
    checks.push("project-aware welcome heading opens the existing project menu at its own anchor without clearing the unsent draft");
    return {fitting:bounds.top>=0&&bounds.bottom<=innerHeight&&bounds.left>=0&&bounds.right<=innerWidth,anchor:anchor.toJSON(),popup:bounds.toJSON(),text:prompt.value};
  },
  closeWelcomeProjectHeading: async () => {
    const heading=document.querySelector<HTMLButtonElement>('.welcome h1 button[aria-label="Dock project?"]')!, prompt=document.querySelector<HTMLTextAreaElement>("#prompt")!;
    document.querySelector<HTMLElement>('.composer-context-menu[aria-label="Select project"]')!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
    await wait(()=>!document.querySelector('.composer-context-menu'),"welcome project popup Escape");
    assert(document.activeElement===heading,"Welcome project popup Escape did not restore heading focus");
    assert(prompt.value==="Keep context draft","Welcome project popup Escape changed the unsent draft");
    checks.push("welcome project popup Escape restores focus to the heading trigger and preserves the draft");
  },
  exerciseComposerBranches: async () => {
    const prompt=document.querySelector<HTMLTextAreaElement>("#prompt")!;
    assert(prompt.value==="Keep context draft", "Native composer text was not inserted");
    document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]')!.click();
    await wait(()=>button(document.querySelector(".composer-context-menu")!,"context-fixture"),"branch catalog");
    button(document.querySelector('.composer-context-menu'),"feature/dock")!.click();
    await wait(()=>!document.querySelector('.composer-context-menu'),"current branch dismisses without mutation");
    assert(branchWrites.length===0,"Choosing current branch sent a mutation");
    document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]')!.click();
    await wait(()=>button(document.querySelector('.composer-context-menu'),"context-fixture"),"reopened branch menu");
    const popup=document.querySelector<HTMLElement>(".composer-context-menu")!, bounds=popup.getBoundingClientRect();
    const branch=button(popup,"context-fixture")!, target=branch.getBoundingClientRect();
    assert(bounds.top>=0 && bounds.bottom<=innerHeight && branch.contains(document.elementFromPoint(target.x+target.width/2,target.y+target.height/2)),"Branch menu is clipped");
    branch.click(); await wait(()=>!document.querySelector(".composer-context-menu"),"checkout receipt closes menu");
    assert(branchWrites.length===1 && gitStatus.branch==="context-fixture" && prompt.value==="Keep context draft","Branch checkout lost draft or repeated command");
    assert(branchWrites[0]!.command.type==="workspace.mutate" && "projectId" in branchWrites[0]!.command.target && branchWrites[0]!.command.target.projectId===projectId,"Wrong project checkout target");
    document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]')!.click();
    await wait(()=>button(document.querySelector('.composer-context-menu'),"Create and checkout new branch…"),"branch creation action");
    button(document.querySelector('.composer-context-menu'),"Create and checkout new branch…")!.click();
    await wait(()=>document.activeElement?.getAttribute("aria-label")==="Branch name","new branch field focus");
    const dialog=document.querySelector<HTMLDialogElement>('.composer-branch-dialog')!, dialogBounds=dialog.getBoundingClientRect();
    assert(dialog.open && dialog.matches(":modal") && !document.querySelector('.composer-context-menu'),"Branch creation remained an anchored menu instead of a modal dialog");
    assert(Math.abs(dialogBounds.left+dialogBounds.width/2-innerWidth/2)<=1 && Math.abs(dialogBounds.top+dialogBounds.height/2-innerHeight/2)<=1,"Branch creation dialog is not centered in the viewport");
    assert(dialogBounds.width>=360 && dialogBounds.width<=420 && dialogBounds.top>=0 && dialogBounds.bottom<=innerHeight,"Branch creation dialog geometry is clipped or outside the native feature-dialog width");
    assert(document.querySelector<HTMLInputElement>('[aria-label="Branch name"]')!.value==="codex/" && prompt.value==="Keep context draft","Branch modal did not retain its native prefix or the unsent draft");
    return {fitting:true,dialog:dialogBounds.toJSON(),viewport:{width:innerWidth,height:innerHeight,devicePixelRatio}};
  },
  checkBranchModalTrap: async () => {
    const dialog=document.querySelector<HTMLDialogElement>('.composer-branch-dialog')!;
    assert(dialog.open && dialog.contains(document.activeElement),"Keyboard navigation escaped the modal dialog");
  },
  checkBranchModalEscape: async () => {
    await wait(()=>!document.querySelector('.composer-branch-dialog'),"branch modal Escape");
    assert(document.activeElement===document.querySelector('[aria-label="Switch branch"]'),"Branch modal Escape did not restore the branch trigger");
    assert(document.querySelector<HTMLTextAreaElement>("#prompt")!.value==="Keep context draft","Branch modal Escape changed the unsent draft");
  },
  reopenBranchModal: async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]')!.click();
    await wait(()=>button(document.querySelector('.composer-context-menu'),"Create and checkout new branch…"),"reopened branch creation action");
    button(document.querySelector('.composer-context-menu'),"Create and checkout new branch…")!.click();
    await wait(()=>document.activeElement?.getAttribute("aria-label")==="Branch name","reopened branch field focus");
  },
  branchModalBackdropPoint: () => {
    const bounds=document.querySelector<HTMLDialogElement>('.composer-branch-dialog')!.getBoundingClientRect();
    return {x:Math.max(4,Math.floor(bounds.left/2)),y:Math.floor(innerHeight/2)};
  },
  checkBranchModalBackdrop: async () => {
    await wait(()=>!document.querySelector('.composer-branch-dialog'),"branch modal backdrop dismissal");
    assert(document.activeElement===document.querySelector('[aria-label="Switch branch"]'),"Branch modal backdrop dismissal did not restore the branch trigger");
    assert(document.querySelector<HTMLTextAreaElement>("#prompt")!.value==="Keep context draft","Branch modal backdrop dismissal changed the unsent draft");
  },
  finishComposerContext: async () => {
    const prompt=document.querySelector<HTMLTextAreaElement>("#prompt")!;
    const dialog=document.querySelector<HTMLDialogElement>('.composer-branch-dialog')!;
    button(dialog,"Set prefix")!.click(); await wait(()=>document.querySelector<HTMLInputElement>('[aria-label="New branch prefix"]'),"Git settings navigation");
    const prefix=document.querySelector<HTMLInputElement>('[aria-label="New branch prefix"]')!;
    prefix.focus(); prefix.select(); document.execCommand("insertText",false,"team/");
    button(document.querySelector<HTMLElement>('[aria-label="Git settings"]'),"Save")!.click(); await wait(()=>preferenceWrites.length===1,"saved branch prefix");
    assert(preferenceWrites[0]!.command.type==="preferences.put" && preferenceWrites[0]!.command.change.key==="git.branchPrefix" && (preferenceWrites[0]!.command.change as any).value==="team/","Set prefix did not persist through shared preferences");
    button(document.querySelector<HTMLElement>('[aria-label="Git settings"]'),"Close Git settings")!.click();
    await wait(()=>document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]'),"return from Git settings");
    document.querySelector<HTMLButtonElement>('[aria-label="Switch branch"]')!.click(); await wait(()=>button(document.querySelector('.composer-context-menu'),"Create and checkout new branch…"),"reopen branch modal after settings"); button(document.querySelector('.composer-context-menu'),"Create and checkout new branch…")!.click(); await wait(()=>document.querySelector<HTMLInputElement>('[aria-label="Branch name"]'),"reopened branch field");
    const createDialog=document.querySelector<HTMLDialogElement>('.composer-branch-dialog')!, create=button(createDialog,"Create and checkout")!;
    assert(document.querySelector<HTMLInputElement>('[aria-label="Branch name"]')!.value==="team/" && prompt.value==="Keep context draft","Saved prefix or ordinary draft was lost when returning from Git settings");
    document.querySelector<HTMLInputElement>('[aria-label="Branch name"]')!.focus(); document.execCommand("insertText",false,"new-context-branch");
    const deliveriesBeforeCreate=branchWrites.length; checkoutUnknownOnce=true;
    assert(!create.disabled,"Named new branch remains disabled"); create.click();
    await wait(()=>button(document.querySelector('.composer-branch-dialog'),"Retry original workspace command"),"uncertain create receipt");
    assert(branchWrites.length===deliveriesBeforeCreate+1 && document.querySelector<HTMLInputElement>('[aria-label="Branch name"]')?.value==="team/new-context-branch","Uncertain creation lost its modal input or original delivery");
    await new Promise(resolve=>setTimeout(resolve,100));
    assert(branchWrites.length===deliveriesBeforeCreate+1,"Uncertain branch creation replayed without an explicit retry");
    button(document.querySelector('.composer-branch-dialog'),"Retry original workspace command")!.click();
    await wait(()=>!document.querySelector('.composer-branch-dialog'),"branch creation receipt");
    assert(gitStatus.branch==="team/new-context-branch" && branchWrites.length===deliveriesBeforeCreate+2 && branchWrites.at(-1)!.id===branchWrites.at(-2)!.id && prompt.value==="Keep context draft","Creation retry changed command identity, branch text, or unsent draft");
    const command=branchWrites.at(-1)!.command;
    assert(command.type==="workspace.mutate" && command.action.type==="git.checkout" && command.action.create===true,"Create action omitted native creation intent");
    document.querySelector<HTMLButtonElement>('[aria-label="Select project"]')!.click();
    await wait(()=>document.querySelector('.composer-context-menu'),"clear project menu");
    button(document.querySelector(".composer-context-menu")!,"Don’t work in a project")!.click();
    await wait(()=>!document.querySelector('[aria-label="Switch branch"]'),"cleared project context");
    assert(prompt.value==="Keep context draft","Changing project cleared typed text");
    await wait(()=>draftWrites.some(write=>write.draft.id==="new-conversation" && write.draft.projectId===null && write.draft.text==="Keep context draft"),"durable text after project removal");
    document.querySelector<HTMLButtonElement>('[aria-label="Select where to run the chat"]')!.click();
    await wait(()=>document.querySelector('.composer-context-menu[aria-label="Select where to run the chat"]'),"host menu");
    const hostMenu=document.querySelector<HTMLElement>('.composer-context-menu')!;
    assert(hostMenu.textContent?.includes("Controlled workstation"),"Host menu hides actual owning host");
    hostMenu.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
    await wait(()=>!document.querySelector('.composer-context-menu'),"host popup dismissed");
    assert(document.activeElement?.getAttribute("aria-label")==="Select where to run the chat","Context Escape lost focus");
    checks.push("new-chat context menus route reviewed branch commands and the centered create modal traps focus, accepts native text input, restores its trigger and preserves durable draft text");
    return {fitting:true,branchWrites,projectId:null,text:prompt.value,context:document.querySelector('.composer-context')!.getBoundingClientRect().toJSON()};
  },
  checkDisposedComposerContext: async () => {
    const delayedProject={id:"delayed-project",hostId:owner,name:"Delayed project",path:"/controlled/delayed",createdAt:1};
    state.projects.push(delayedProject);
    for(const listener of listeners) listener({type:"state",hostId:owner,state:structuredClone(state)});
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
      await wait(()=>button(document.querySelector('.composer-context-menu'),"feature/dock"),"pending checkout menu");
      button(document.querySelector('.composer-context-menu'),"feature/dock")!.click();
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
