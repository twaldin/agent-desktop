import { createRoot } from "react-dom/client";
import { App } from "../../apps/desktop/src/renderer/App";
import { defaultWindowView, type WindowViewState } from "../../apps/desktop/src/window-state";
import type { CommandEnvelope, CommandResult, DesktopBridge, NativeTerminalAction, NativeTerminalInputRequest, NativeTerminalQuery, NetworkState, WorkspaceQueryResult } from "@agent-desktop/shared";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const params = new URLSearchParams(location.search);
const endpoint = params.get("endpoint")!, owner = params.get("owner")!;
const checks: string[] = [];
let windowState: WindowViewState = { ...defaultWindowView(), route: { hostId: owner, sessionId: null } };
window.agentDesktopWindow = { initial: { state: structuredClone(windowState) }, save: value => { windowState = structuredClone(value); return {}; }, subscribe: () => () => {} };

const request = async <T,>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${endpoint}${path}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) { const failure = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } }; throw Object.assign(new Error(failure.error?.message ?? `Fixture route ${path} failed with ${response.status}`), { status: response.status, code: failure.error?.code }); }
  return response.json();
};
const native = async <T,>(path: string, body?: unknown) => {
  try { return { ok: true as const, value: await request<T>(path, body) }; }
  catch (cause) { const error = cause as Error & { status?: number; code?: string }; return { ok: false as const, error: { message: error.message, status: error.status, code: error.code } }; }
};
const bridge: Partial<DesktopBridge> = {
  subscribe: () => () => {}, getState: () => request("/v1/state"),
  getHosts: async (): Promise<NetworkState> => ({ status: "connected", ownNodeId: "fixture-node", checkedAt: Date.now(), hosts: [] }),
  getPreferences: () => request("/v1/preferences"), getTheme: () => request("/v1/theme"), getLocalFonts: async () => [], applyWindowTheme: async () => {}, getThemeBackground: async () => null,
  getMessages: sessionId => request(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`), getInteractions: sessionId => request(`/v1/sessions/${encodeURIComponent(sessionId)}/interactions`),
  getComposerCatalog: (target, refresh) => request("/v1/models/composer", { target, refresh }), getComposerActions: async () => null,
  getComposerCompletions: async () => ({ items: [], replacement: { start: 0, end: 0 }, catalogRevision: "fixture" }),
  workspaceQuery: (target, query) => request<WorkspaceQueryResult>("/v1/workspace/query", { target, query }), command: (envelope: CommandEnvelope) => request<CommandResult>("/v5/commands", envelope), chooseDirectory: async () => null,
  getNativeTerminalCapabilities: () => native("/v2/terminals/capabilities"), nativeTerminalQuery: (query: NativeTerminalQuery) => native("/v2/terminals/query", query),
  nativeTerminalAction: (action: NativeTerminalAction) => native("/v2/terminals/action", action), writeNativeTerminal: (input: NativeTerminalInputRequest) => native("/v2/terminals/input", input), subscribeNativeTerminals: () => () => {},
};
window.agentDesktop = new Proxy(bridge as DesktopBridge, { get(target, key) { if (key in target) return target[key as keyof DesktopBridge]; return async () => { throw new Error(`Unexpected bridge call: ${String(key)}`); }; } });
createRoot(document.getElementById("root")!).render(<App/>);

const wait = async (read: () => unknown, label: string, timeout = 20_000) => { const start = performance.now(); while (performance.now() - start < timeout) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error(`Timed out: ${label}`); };
const assert = (value: unknown, message: string): asserts value => { if (!value) throw new Error(message); };
const rect = (element: Element | null) => element ? element.getBoundingClientRect().toJSON() : null;
const state = () => {
  const menu = document.querySelector(".environment-actions-menu"), terminal = document.querySelector(".dock-native-terminal"), terminalRows = terminal?.querySelector(".xterm-rows");
  return { renderer: { viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio, zoom: visualViewport?.scale ?? 1, font: getComputedStyle(document.body).fontFamily,
    colors: { background: getComputedStyle(document.documentElement).backgroundColor, foreground: getComputedStyle(document.body).color } }, route: structuredClone(windowState.route),
    environmentCard: rect(document.querySelector(".environment-card")), menu: rect(menu), menuText: menu?.textContent?.trim(), active: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim(),
    terminal: rect(terminal), terminalText: terminalRows?.textContent, terminalTabs: [...document.querySelectorAll(".dock-tab")].map(item => ({ text: item.textContent?.trim(), terminalId: item.getAttribute("data-terminal-id") })), checks: [...checks] };
};

Object.assign(window, {
  acceptanceTarget(selector: string, text?: string) {
    const candidates = [...document.querySelectorAll<HTMLElement>(selector)];
    const element = text === undefined ? candidates[0] : candidates.find(item => item.textContent?.trim() === text || item.getAttribute("aria-label") === text);
    if (!element) throw new Error(`Missing target ${selector} ${text ?? ""}`);
    element.scrollIntoView({ block: "nearest" }); const bounds = element.getBoundingClientRect();
    if (!bounds.width || !bounds.height || bounds.top < 0 || bounds.bottom > innerHeight) throw new Error(`Target is not visible: ${selector} ${text ?? ""}`);
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  }, acceptanceState: state,
  awaitReady: async () => { await wait(() => document.querySelector<HTMLButtonElement>('[aria-label="Environment"]') && document.querySelector<HTMLButtonElement>('[aria-label="Select project"]')?.textContent?.includes("Action fixture"), "production App project"); return state(); },
  awaitCard: async () => { await wait(() => document.querySelector('[aria-label="Environment summary"]'), "environment card"); await wait(() => document.querySelector<HTMLButtonElement>('[aria-label="Actions"]'), "Actions control"); return state(); },
  awaitMenu: async () => { await wait(() => document.querySelector('.environment-actions-menu [aria-label="Run: Count run"]'), "configured actions menu"); const menu = document.querySelector(".environment-actions-menu")!.getBoundingClientRect(); assert(menu.left >= 0 && menu.top >= 0 && menu.right <= innerWidth && menu.bottom <= innerHeight, "Actions menu escaped viewport"); checks.push("portal action menu remained within the renderer viewport"); return state(); },
  assertActionFocus: () => { assert(document.activeElement?.getAttribute("aria-label") === "Run: Count run", "Menu did not focus its first configured action"); checks.push("menu open focused the first action"); return state(); },
  assertTriggerFocus: async () => { await wait(() => document.activeElement?.getAttribute("aria-label") === "Actions" && !document.querySelector(".environment-actions-menu"), "Escape focus restoration"); checks.push("Escape closed the menu and restored the Actions trigger focus"); return state(); },
  awaitTerminal: async () => { await wait(() => { const view = document.querySelector(".dock-native-terminal .native-terminal-view"), rows = view?.querySelector(".xterm-rows")?.textContent; return rows?.includes("ACTION_READY_1") && !view.querySelector('[role="status"], [role="alert"]'); }, "settled native action terminal output", 25_000); checks.push("menu action opened the settled returned native terminal in the dock with real output"); return state(); },
  awaitSecondRun: async () => { await wait(() => { const view = document.querySelector(".dock-native-terminal .native-terminal-view"), rows = view?.querySelector(".xterm-rows")?.textContent; return !document.querySelector<HTMLButtonElement>('[aria-label="Run: Count run"]')?.disabled && rows?.includes("ACTION_READY_2") && !view.querySelector('[role="status"], [role="alert"]'); }, "settled second action terminal output", 25_000); checks.push("primary action recovered the same configured terminal dock after restart"); return state(); },
});

declare global { interface Window { acceptanceTarget(selector:string,text?:string):{x:number;y:number}; acceptanceState():unknown } }
