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

declare global { interface Window { fixtureApi:{call(method:string,args:unknown[]):Promise<any>} } }
const questionFixture=false;
const fixtureParams=new URLSearchParams(location.search);
const owner=fixtureParams.get("hostId")!, foreignOwner="33333333-3333-4333-8333-333333333333", projectId="dock-project", sessionId=fixtureParams.get("sessionId")!, pageOrigin=fixtureParams.get("origin")!;
const checks: string[] = [], activityCalls: { sessionId: string; hostId?: string }[] = [], workspaceCalls: { target: unknown; query: WorkspaceQuery; hostId?: string }[] = [];
let browserReads = 0, browserCreates = 0, browserBridgeConnected = true;
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
let foreignState: HostState | undefined;
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
  subscribeWindowClose: () => () => {}, subscribeWindowTheme: () => () => {}, subscribeNotificationStatus: () => () => {}, subscribeNotificationNavigation: () => () => {},
  getDetachedQuestions: async () => questionFixture ? { protocolVersion:1, hostId:owner, sessionId, questions:[{questionId:"question-a",questionEntryId:"opened-a",originRunId:"run-a",openedAt:1,status:"open",delivery:{status:"waiting"},questions:[{id:"density",question:"Which sample density?",multi:false,options:[{label:"Comfortable"},{label:"Compact"}]}]}] } : null,
  getState: async requested => structuredClone(requested === "foreign-host" && foreignState ? foreignState : state), getHosts: async () => ({ status: "connected", ownNodeId: "controlled", checkedAt: 1, hosts: [] }),
  getPreferences: async () => ({ version: 1, records: structuredClone(preferenceRecords) }), getTheme: async () => ({ document: { ...DEFAULT_THEME, mode: "dark" }, revision: "theme", filePath: "/controlled/theme.json" }),
  getLocalFonts: async () => [], applyWindowTheme: async () => {}, getMessages: async () => [], getInteractions: async () => [],
  getComposerCatalog: async () => catalog, getSessionControls: async () => ({ sessionId, revision: "controls", model, capabilities: { ...model, api: "controlled", thinkingSelectors: ["off", "low", "high"], serviceTierOptions: {}, supportsTools: false, capabilities: {}, compatibility: {}, settingsPaths: [], excludedSensitiveFields: [], unmappedCapabilityFields: [] }, settings: [], overrides: [], serviceTiers: {}, runtimeMutablePaths: [], persistence: "native-session-model-thinking-tiers; runtime-settings-until-dispose" }),
  getNativeTerminalCapabilities: async () => ({ ok: true as const, value: { protocol: "tmux-v1" as const, tmuxVersion: "3.7c" as const, inputEpoch: nativeTerminal.inputEpoch, dimensions: TERMINAL_DIMENSIONS } }),
  nativeTerminalQuery: async query => ({ ok: true as const, value: query.type === "list" ? { type: "list" as const, terminals: [nativeTerminal] } : query.type === "replay" ? { type: "replay" as const, replay: { attachment: nativeAttachment, terminal: nativeTerminal, chunks: query.afterSequence ? [] : [{ sequence: 1, data: nativeOutput }], firstSequence: 1, lastSequence: 1, resetRequired: false } } : { type: "history" as const, history: { terminalId: nativeTerminal.id, serverGeneration: nativeTerminal.serverGeneration, revision: "controlled-history", capturedAt: 1, cols: nativeTerminal.cols, rows: nativeTerminal.rows, live: true, history: nativeOutput, truncated: false } } }),
  nativeTerminalAction: async action => ({ ok: true as const, value: action.type === "attach" || action.type === "heartbeat" ? { terminal: nativeTerminal, attachment: nativeAttachment } : action.type === "reply" ? { accepted: true } : { terminal: nativeTerminal } }),
  writeNativeTerminal: async input => ({ ok: true as const, value: { sequence: input.sequence, duplicate: false, outcome: "accepted" as const } }),
  subscribeNativeTerminals: listener => { nativeTerminalListeners.add(listener); return () => nativeTerminalListeners.delete(listener); },
  getBrowserMetadata: async (...args:any[])=>browserBridgeConnected?window.fixtureApi.call("getBrowserMetadata",args):Promise.reject(new Error("Controlled host offline")),
  createBrowserTab: async (...args:any[])=>browserBridgeConnected?window.fixtureApi.call("createBrowserTab",args):Promise.reject(new Error("Controlled host offline")),
  getBrowserFrame: async (...args:any[])=>browserBridgeConnected?window.fixtureApi.call("getBrowserFrame",args):Promise.reject(new Error("Controlled host offline")),
  getBrowserHistory: async (...args:any[])=>browserBridgeConnected?window.fixtureApi.call("getBrowserHistory",args):Promise.reject(new Error("Controlled host offline")),
  browserAutocomplete: async (...args:any[])=>browserBridgeConnected?window.fixtureApi.call("browserAutocomplete",args):Promise.reject(new Error("Controlled host offline")),
  controlBrowser: async (...args:any[])=>browserBridgeConnected?window.fixtureApi.call("controlBrowser",args):Promise.reject(new Error("Controlled host offline")),
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

function assertApp(value:unknown,message:string):asserts value{if(!value)throw new Error(message)}
const waitApp=async(read:()=>unknown,label:string,timeout=20_000)=>{const start=performance.now();while(performance.now()-start<timeout){if(read())return;await new Promise(resolve=>setTimeout(resolve,25))}throw new Error(`Timed out: ${label}`)};
const waitAsync=async(read:()=>Promise<boolean>,label:string,timeout=20_000)=>{const start=performance.now();while(performance.now()-start<timeout){if(await read())return;await new Promise(resolve=>setTimeout(resolve,25))}throw new Error(`Timed out: ${label}`)};
const dockToggle=(region:"bottom"|"side",checked:boolean)=>document.querySelector<HTMLButtonElement>(`[role="checkbox"][aria-label="Toggle ${region} panel"][aria-checked="${checked}"]`);
const field=()=>document.querySelector<HTMLInputElement>('[aria-label="Page address"]')!;
async function editAddress(value:string){const input=field();input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,0))}
async function suggestions(){await waitApp(()=>document.querySelector('[role="listbox"][aria-label="Address suggestions"]'),"address suggestions");return [...document.querySelectorAll<HTMLElement>('[role="option"]')]}
Object.assign(window,{runBrowserAutocompleteAppAcceptance:async()=>{
  await waitApp(()=>document.querySelector('.main-header'),"production App ready");
  const side=dockToggle("side",false);assertApp(side,"Side dock toggle missing");side.click();
  await waitApp(()=>document.querySelector('.dock-slot-right .dock-empty-panel-actions'),"empty side dock");
  const right=document.querySelector<HTMLElement>('.dock-slot-right')!;
  const browser=[...right.querySelectorAll<HTMLButtonElement>('.dock-empty-panel-actions button')].find(item=>item.textContent?.includes("Browser"));assertApp(browser,"Browser dock action missing");browser.click();
  await waitApp(()=>right.querySelector('.browser-panel')&&field(),"browser launcher");
  await editAddress(`${pageOrigin}/one`);field().form!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
  await waitApp(()=>right.querySelector<HTMLImageElement>('.browser-viewport img')?.naturalWidth&&field().value.endsWith('/one'),"actual native page in App",35_000);
  field().blur();await new Promise(resolve=>setTimeout(resolve,25));field().focus();field().dispatchEvent(new FocusEvent('focusin',{bubbles:true}));
  let rows=await suggestions();assertApp(rows.some(row=>row.textContent?.includes('one')&&row.querySelector('[aria-label^="Remove suggestion"]')),"App omitted native history row");
  const remove=rows.map(row=>row.querySelector<HTMLButtonElement>('[aria-label^="Remove suggestion"]')).find(Boolean);assertApp(remove,"Delete suggestion action missing");remove.click();
  await waitApp(()=>![...document.querySelectorAll('[role="option"]')].some(row=>row.querySelector('[aria-label^="Remove suggestion"]')),"deleted row hidden");
  await window.fixtureApi.call('restartAutocomplete',[]);field().blur();await new Promise(resolve=>setTimeout(resolve,25));await editAddress('one');rows=await suggestions();
  assertApp(!rows.some(row=>row.querySelector('[aria-label^="Remove suggestion"]')),"Deleted history returned after host record restart");
  field().blur();await new Promise(resolve=>setTimeout(resolve,25));await editAddress(`${pageOrigin}/two`);field().form!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  await waitApp(()=>field().value.endsWith('/two')&&!document.querySelector('[aria-label="Stop loading"]'),"fast Enter navigation");
  await waitApp(()=>!document.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.disabled,"Back availability");
  document.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click();await waitApp(()=>field().value.endsWith('/one'),"App Back");
  await waitApp(()=>!document.querySelector<HTMLButtonElement>('[aria-label="Forward"]')?.disabled,"Forward availability");
  document.querySelector<HTMLButtonElement>('[aria-label="Forward"]')!.click();await waitApp(()=>field().value.endsWith('/two'),"App Forward");
  await editAddress(`${pageOrigin}/slow`);field().form!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await waitApp(()=>document.querySelector('[aria-label="Stop loading"]'),"Stop loading");
  document.querySelector<HTMLButtonElement>('[aria-label="Stop loading"]')!.click();
  await waitApp(()=>!document.querySelector('[aria-label="Stop loading"]')||Boolean(document.body.textContent?.includes('may have reached the page')),"Stop settled or uncertain outcome surfaced");
  browserBridgeConnected=false;for(const listener of listeners)listener({type:'connection',hostId:owner,sequence:20,connected:false,error:'Controlled host offline'});
  await waitApp(()=>document.body.textContent?.includes('Controlled host offline')||document.body.textContent?.includes('disconnected'),"offline owner state");await new Promise(resolve=>setTimeout(resolve,300));
  const callsBeforeOffline=await window.fixtureApi.call('browserCallCount',[]);await new Promise(resolve=>setTimeout(resolve,800));
  assertApp((await window.fixtureApi.call('browserCallCount',[]))===callsBeforeOffline,"Offline App kept polling browser owner");
  browserBridgeConnected=true;for(const listener of listeners)listener({type:'connection',hostId:owner,sequence:21,connected:true});
  await waitAsync(async()=>await window.fixtureApi.call('browserCallCount',[])>callsBeforeOffline,"reconnected owner browser refresh");
  foreignState={...structuredClone(state),host:{...state.host,id:foreignOwner,name:'Foreign host'},projects:[],sessions:[{...structuredClone(session),id:'44444444-4444-4444-8444-444444444444',hostId:foreignOwner,title:'Foreign session'}],lastEventSequence:1};
  for(const listener of listeners)listener({type:'state',hostId:foreignOwner,sequence:1,state:foreignState});
  const recents=[...document.querySelectorAll<HTMLButtonElement>('.conversation-heading .sidebar-section-toggle')].find(button=>button.textContent?.includes('Recents'));if(recents?.getAttribute('aria-expanded')==='false')recents.click();
  await waitApp(()=>[...document.querySelectorAll<HTMLElement>('[data-session-id],button')].some(item=>item.textContent?.includes('Foreign session')),"foreign session row");
  const foreign=[...document.querySelectorAll<HTMLElement>('[data-session-id],button')].find(item=>item.textContent?.includes('Foreign session'));assertApp(foreign,"Foreign session row missing after readiness");foreign.click();
  await waitApp(()=>windowState.route.hostId===foreignOwner,"foreign host route");const callsAtForeign=await window.fixtureApi.call('browserCallCount',[]);await new Promise(resolve=>setTimeout(resolve,600));assertApp((await window.fixtureApi.call('browserCallCount',[]))===callsAtForeign,"Original browser polled after host switch");
  const originalProject=document.querySelector<HTMLButtonElement>(`.project-group[data-host-id="${owner}"] .project-label`);if(originalProject?.getAttribute('aria-expanded')==='false')originalProject.click();
  await waitApp(()=>[...document.querySelectorAll<HTMLElement>('[data-session-id]')].some(item=>item.getAttribute('data-host-id')===owner&&item.textContent?.includes('Dock acceptance conversation')),"original session row");
  const original=[...document.querySelectorAll<HTMLElement>('[data-session-id]')].find(item=>item.getAttribute('data-host-id')===owner&&item.textContent?.includes('Dock acceptance conversation'));assertApp(original,"Original session row missing after readiness");original.click();await waitApp(()=>windowState.route.hostId===owner,"original host restored");
  await waitApp(()=>document.querySelector('.browser-panel'),"original browser dock restored");
  return{passed:true,route:windowState.route,checks:['dock open','fast Enter','history delete/restart','Back/Forward/Stop','offline/reconnect','foreign/original host switch'],scope:'Production App with controlled catalog/dock state and actual authenticated OMP CDP browser transports. Host connection and second-host events are controlled; native page/navigation/history are real. No provider, personal Chrome history, physical focus, native search-engine autocomplete, or cmux proof.'};
}});
