import { createRoot } from "react-dom/client";
import { App } from "../../apps/desktop/src/renderer/App";
import { defaultWindowView, type WindowViewState } from "../../apps/desktop/src/window-state";
import type { CommandEnvelope, CommandResult, DesktopBridge, NetworkState, WorkspaceQueryResult } from "@agent-desktop/shared";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const params = new URLSearchParams(location.search);
const endpoint = params.get("endpoint")!, owner = params.get("owner")!;
const checks: string[] = [];
let windowState: WindowViewState = { ...defaultWindowView(), route: { hostId: owner, sessionId: null } };
window.agentDesktopWindow = { initial: { state: structuredClone(windowState) }, save: value => { windowState = structuredClone(value); return {}; }, subscribe: () => () => {} };
const request = async <T,>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${endpoint}${path}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`Fixture route ${path} failed with ${response.status}: ${await response.text()}`);
  return response.json();
};
const bridge: Partial<DesktopBridge> = {
  subscribe: () => () => {}, getState: () => request("/v1/state"),
  getHosts: async (): Promise<NetworkState> => ({ status: "connected", ownNodeId: "fixture-node", checkedAt: Date.now(), hosts: [] }),
  getPreferences: () => request("/v1/preferences"), getTheme: () => request("/v1/theme"),
  getLocalFonts: async () => [], applyWindowTheme: async () => {}, getThemeBackground: async () => null,
  getMessages: sessionId => request(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`),
  getInteractions: sessionId => request(`/v1/sessions/${encodeURIComponent(sessionId)}/interactions`),
  getComposerCatalog: (target, refresh) => request("/v1/models/composer", { target, refresh }),
  getComposerActions: async () => null,
  getComposerCompletions: async () => ({ items: [], replacement: { start: 0, end: 0 }, catalogRevision: "fixture" }),
  workspaceQuery: (target, query) => request<WorkspaceQueryResult>("/v1/workspace/query", { target, query }),
  command: (envelope: CommandEnvelope) => request<CommandResult>("/v5/commands", envelope),
  chooseDirectory: async () => null,
};
window.agentDesktop = new Proxy(bridge as DesktopBridge, { get(target, key) { if (key in target) return target[key as keyof DesktopBridge]; return async () => { throw new Error(`Unexpected bridge call: ${String(key)}`); }; } });
createRoot(document.getElementById("root")!).render(<App/>);

const wait = async (read: () => unknown, label: string, timeout = 15_000) => { const start = performance.now(); while (performance.now() - start < timeout) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error(`Timed out: ${label}`); };
const assert = (value: unknown, message: string): asserts value => { if (!value) throw new Error(message); };
const exactButton = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
const state = () => ({
  renderer: { viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio,
    font: getComputedStyle(document.body).fontFamily,
    colors: { background: getComputedStyle(document.documentElement).backgroundColor, foreground: getComputedStyle(document.body).color } },
  route: structuredClone(windowState.route), prompt: document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
  preparation: document.querySelector(".environment-preparation-card")?.textContent,
  settings: document.querySelector(".local-environment-settings")?.textContent,
  context: [...document.querySelectorAll(".composer-context button")].map(item => ({ label: item.getAttribute("aria-label"), text: item.textContent?.trim() })),
  alerts: [...document.querySelectorAll('[role="alert"], [role="status"]')].map(item => item.textContent?.trim()), checks: [...checks],
});

Object.assign(window, {
  acceptanceTarget(selector: string, text?: string) {
    const candidates = [...document.querySelectorAll<HTMLElement>(selector)];
    const element = text === undefined ? candidates[0] : candidates.find(item => item.textContent?.trim() === text || item.getAttribute("aria-label") === text);
    if (!element) throw new Error(`Missing target ${selector} ${text ?? ""}`);
    element.scrollIntoView({ block: "nearest" }); const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.top < 0 || rect.bottom > innerHeight) throw new Error(`Target is not visible: ${selector} ${text ?? ""}`);
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, acceptanceState: state,
  awaitReady: async () => {
    await wait(() => document.querySelector('[aria-label="Select where to run the chat"]') && document.querySelector<HTMLButtonElement>('[aria-label="Select project"]')?.textContent?.includes("Environment composer fixture"), "production App project draft");
    await wait(() => !document.querySelector<HTMLButtonElement>('[aria-label="Select where to run the chat"]')?.disabled, "composer enabled");
    return state();
  },
  awaitMenu: async (label: string, item: string) => { await wait(() => exactButton(item, document.querySelector(`.composer-context-menu[aria-label="${label}"]`) ?? document.body), `${label}: ${item}`); return state(); },
  assertWorktreeSelected: async () => {
    await wait(() => document.querySelector<HTMLButtonElement>('[aria-label="Select where to run the chat"]')?.textContent?.includes("New local worktree"), "worktree selected");
    await wait(() => document.querySelector<HTMLButtonElement>('[aria-label="Select a local environment"]'), "environment selector");
    checks.push("production composer selected a new local worktree without creating one"); return state();
  },
  assertEnvironmentSelected: async () => {
    await wait(() => document.querySelector<HTMLButtonElement>('[aria-label="Select a local environment"]')?.textContent?.includes("Acceptance environment"), "environment selected");
    checks.push("production composer persisted the reviewed environment revision in its draft"); return state();
  },
  awaitSettings: async () => { await wait(() => document.querySelector(".local-environment-settings") && document.body.textContent?.includes("Acceptance environment"), "environment settings"); checks.push("selected environment and prompt survived opening project environment settings"); return state(); },
  awaitComposerAfterSettings: async (expected: string) => { await wait(() => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === expected, "composer after settings"); assert(document.querySelector<HTMLButtonElement>('[aria-label="Select a local environment"]')?.textContent?.includes("Acceptance environment"), "Environment selection was lost across settings"); checks.push("settings round trip retained the prompt and environment selection"); return state(); },
  awaitFailure: async () => { await wait(() => document.querySelector(".environment-preparation-card")?.textContent?.includes("Environment setup failed"), "setup failure", 25_000); const text = document.querySelector(".environment-preparation-card")!.textContent!; assert(text.includes("original prompt are preserved") && exactButton("Retry setup and send") , "Recovery card omitted preserved prompt or explicit retry"); checks.push("real setup failure paused the original submission with an explicit retry"); return state(); },
  assertNewerDraft: async (expected: string) => { await wait(() => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === expected, "newer draft"); assert(document.body.textContent?.includes("View pending prompt and selections"), "Pending snapshot is not visible"); checks.push("a newer editor draft survived beside the captured original submission"); return state(); },
  awaitRestored: async (expected: string) => { await wait(() => document.querySelector(".environment-preparation-card")?.textContent?.includes("Environment setup failed"), "restored preparation", 20_000); assert(document.querySelector<HTMLTextAreaElement>("#prompt")?.value === expected, "Reload lost newer draft"); assert(exactButton("Retry setup and send"), "Reload lost explicit retry"); checks.push("renderer reload restored the durable preparation and newer draft without replay"); return state(); },
  awaitCompleted: async (expected: string) => { await wait(() => !document.querySelector(".environment-preparation-card") && document.querySelector<HTMLTextAreaElement>("#prompt")?.value === expected, "completed original prompt", 30_000); checks.push("explicit retry completed one session while retaining the newer draft"); return state(); },
});

declare global { interface Window { acceptanceTarget(selector:string,text?:string):{x:number;y:number}; acceptanceState():unknown } }
