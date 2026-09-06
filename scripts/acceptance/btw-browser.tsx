import { createRoot } from "react-dom/client";
import { App } from "../../apps/desktop/src/renderer/App";
import { createDockState, dockTabId, insertDockTab, type DockTab } from "../../apps/desktop/src/renderer/dock-state";
import { defaultWindowView, type WindowViewState } from "../../apps/desktop/src/window-state";
import type { CommandEnvelope, CommandResult, DesktopBridge, DesktopEvent, HostState, NetworkState, WorkspaceQueryResult } from "@agent-desktop/shared";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const params = new URLSearchParams(location.search);
const endpoint = params.get("endpoint")!, owner = params.get("owner")!, sessionId = params.get("session")!;
const tabDescriptor = { kind: "side-chat" as const, hostId: owner, target: `session:${sessionId}` as const, title: "Side chat" };
const tab: DockTab = { ...tabDescriptor, id: dockTabId(tabDescriptor) };
let windowState: WindowViewState = { ...defaultWindowView(), route: { sessionId }, workspaceOpen: true,
  dock: { tabs: [tab], state: insertDockTab(createDockState(), tab, "right") } };
window.agentDesktopWindow = { initial: { state: structuredClone(windowState) }, save: value => { windowState = structuredClone(value); return {}; }, subscribe: () => () => {} };
const checks: string[] = [];
const request = async <T,>(route: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${endpoint}${route}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`Fixture route ${route} failed with ${response.status}: ${await response.text()}`);
  return response.json();
};
// The scoped bridge delivers authoritative host snapshots after commands, as
// production's state events do. It never synthesizes draft revisions/content.
const listeners = new Set<(event: DesktopEvent) => void>();
const bridge: Partial<DesktopBridge> = {
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getState: () => request("/v1/state"),
  getHosts: async (): Promise<NetworkState> => ({ status: "connected", ownNodeId: "fixture-node", checkedAt: Date.now(), hosts: [] }),
  getPreferences: () => request("/v1/preferences"), getTheme: () => request("/v1/theme"), getLocalFonts: async () => [], applyWindowTheme: async () => {}, getThemeBackground: async () => null,
  getMessages: id => request(`/v1/sessions/${encodeURIComponent(id)}/messages`), getInteractions: id => request(`/v1/sessions/${encodeURIComponent(id)}/interactions`),
  getDetachedQuestions: id => request(`/v1/sessions/${encodeURIComponent(id)}/questions`), getSessionControls: id => request(`/v1/sessions/${encodeURIComponent(id)}/controls`),
  getComposerCatalog: (target, refresh) => request("/v1/models/composer", { target, refresh }), getComposerActions: (target, refresh) => request("/v1/composer/actions", { target, refresh }),
  getComposerCompletions: query => request("/v1/composer/completions", query),
  workspaceQuery: (target, query) => request<WorkspaceQueryResult>("/v1/workspace/query", { target, query }), command: async (envelope: CommandEnvelope) => {
    const result = await request<CommandResult>("/v5/commands", envelope);
    const state = await request<HostState>("/v1/state");
    for (const listener of listeners) listener({ type: "state", sequence: state.lastEventSequence, hostId: owner, state });
    return result;
  },
  getBtw: id => request(`/v1/sessions/${encodeURIComponent(id)}/btw`), chooseDirectory: async () => null,
};
window.agentDesktop = new Proxy(bridge as DesktopBridge, { get(target, key) { if (key in target) return target[key as keyof DesktopBridge]; return async () => { throw new Error(`Unexpected bridge call: ${String(key)}`); }; } });
createRoot(document.getElementById("root")!).render(<App/>);

const wait = async (read: () => unknown, label: string, timeout = 20_000) => { const start = performance.now(); while (performance.now() - start < timeout) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error(`Timed out: ${label}`); };
const assert = (value: unknown, message: string): asserts value => { if (!value) throw new Error(message); };
const rect = (element: Element | null) => element ? element.getBoundingClientRect().toJSON() : null;
const state = () => { const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Side chat prompt"]'), fieldStyle = field ? getComputedStyle(field) : undefined; return ({ renderer: { viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio, zoom: visualViewport?.scale ?? 1,
  font: getComputedStyle(document.body).fontFamily, colors: { background: getComputedStyle(document.documentElement).backgroundColor, foreground: getComputedStyle(document.body).color } },
  route: structuredClone(windowState.route), dock: rect(document.querySelector(".dock-region.right")), sideChat: rect(document.querySelector(".side-chat")),
  mainPrompt: document.querySelector<HTMLTextAreaElement>("#prompt")?.value, prompt: field?.value, promptFocus: fieldStyle ? { active: field === document.activeElement, outlineStyle: fieldStyle.outlineStyle, outlineWidth: fieldStyle.outlineWidth, boxShadow: fieldStyle.boxShadow } : null,
  transcript: document.querySelector(".side-chat-transcript")?.textContent?.trim(), status: [...document.querySelectorAll('[role="status"], [role="alert"]')].map(item => item.textContent?.trim()), checks: [...checks] }); };
Object.assign(window, {
  acceptanceTarget(selector: string, text?: string) { const candidates = [...document.querySelectorAll<HTMLElement>(selector)]; const element = text === undefined ? candidates[0] : candidates.find(item => item.textContent?.trim() === text || item.getAttribute("aria-label") === text); if (!element) throw new Error(`Missing target ${selector} ${text ?? ""}`); element.scrollIntoView({ block: "nearest" }); const bounds = element.getBoundingClientRect(); if (!bounds.width || !bounds.height || bounds.top < 0 || bounds.bottom > innerHeight) throw new Error(`Target is not visible: ${selector}`); return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }; },
  acceptanceState: state,
  awaitEmpty: async () => { await wait(() => document.querySelector(".side-chat-empty") && document.querySelector<HTMLTextAreaElement>('[aria-label="Side chat prompt"]') === document.activeElement && !document.querySelector('[role="status"], [role="alert"]'), "settled connected empty focused Side Chat"); checks.push("empty side chat opened for the connected owning session after surrounding App loading settled"); return state(); },
  awaitClosed: async () => { await wait(() => !document.querySelector(".side-chat"), "closed side chat dock"); return state(); },
  awaitReopenedDraft: async (expected: string) => { await wait(() => document.querySelector<HTMLTextAreaElement>('[aria-label="Side chat prompt"]')?.value === expected, "reopened side chat draft"); const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Side chat prompt"]')!; assert(field === document.activeElement, "Reopened side chat did not focus its draft"); assert(getComputedStyle(field).outlineStyle === "none", "Focused side-chat field retained the generic rectangular outline"); checks.push("closing and reopening the dock retained and refocused the unsent draft without a generic textarea outline"); return state(); },
  awaitRunning: async (expected: string) => { await wait(() => document.querySelector(".side-chat-working") && document.querySelector(".side-chat-question")?.textContent === expected, "running native side chat"); assert(document.querySelector<HTMLButtonElement>('[aria-label="Stop side chat"]') && !document.querySelector<HTMLButtonElement>('[aria-label="Stop side chat"]')?.disabled, "Running side chat has no enabled Stop"); checks.push("Send reached a running native side turn with its captured question"); return state(); },
  awaitStopped: async () => { await wait(() => document.querySelector(".side-chat-transcript")?.textContent?.includes("Stopped") && document.querySelector('[aria-label="Send side question"]'), "stopped side chat"); checks.push("Stop cancelled only the side turn and restored Send"); return state(); },
  awaitSlashMenu: async () => { await wait(() => [...document.querySelectorAll('.composer-autocomplete-row')].some(item => item.querySelector('.completion-label')?.textContent === 'btw' && item.getAttribute('aria-disabled') === 'false'), 'enabled native btw command completion'); checks.push('native btw completion is enabled in the real main composer'); return state(); },
  awaitSlashComplete: async (question: string) => { await wait(() => document.querySelector('.side-chat-question')?.textContent === question && document.querySelector('.side-chat-copy') && document.querySelector<HTMLTextAreaElement>('#prompt')?.value === '', 'native composer side answer and consumed main draft'); checks.push('main composer native btw completes in Side chat and consumes only its submitted main draft'); return state(); },
  awaitPromotionDrafts: async () => {
    await wait(() => document.querySelector<HTMLTextAreaElement>('#prompt')?.value === 'Keep unsent main prompt'
      && document.querySelector<HTMLTextAreaElement>('[aria-label="Side chat prompt"]')?.value === 'Keep unsent side prompt'
      && document.querySelector<HTMLButtonElement>('.side-chat-promote')?.disabled === false, 'saved drafts and enabled promotion');
    checks.push('both original drafts remain visible beside a completed promotable side answer'); return state();
  },
  awaitPromoted: async () => {
    await wait(() => Boolean(windowState.route?.sessionId && windowState.route.sessionId !== sessionId)
      && document.querySelector('main')?.textContent?.includes('Answer the second side question'), 'new native branch selected with its side question in history');
    checks.push('one visible promotion action selected the distinct native conversation with the side answer in its history'); return state();
  },
  awaitComplete: async (question: string) => { await wait(() => document.querySelector(".side-chat-question")?.textContent === question && document.querySelector(".side-chat-transcript")?.textContent?.includes("Side answer") && document.querySelector(".side-chat-copy"), "completed side chat", 25_000); checks.push("a second native side turn completed and rendered its streamed answer"); return state(); },
});
declare global { interface Window { acceptanceTarget(selector:string,text?:string):{x:number;y:number}; acceptanceState():unknown } }
