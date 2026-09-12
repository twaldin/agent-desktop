import { createRoot } from "react-dom/client";
// @ts-expect-error This fixture alias is supplied by chooser-lifecycle.ts.
import { App } from "chooser-lifecycle-app";
import type { DesktopBridge, DesktopEvent, HostState } from "@agent-desktop/shared";
import { defaultWindowView } from "../../apps/desktop/src/window-state";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const listeners = new Set<(event: DesktopEvent) => void>();
const errors: string[] = [];
window.addEventListener("error", event => errors.push(String(event.error ?? event.message)));
const status = { branch: "main", entries: [], revision: "a".repeat(64) };
let releaseGit!: () => void, gitRequested!: () => void;
const pendingGit = new Promise<void>(resolve => { releaseGit = resolve; });
const requestedGit = new Promise<void>(resolve => { gitRequested = resolve; });
const state: HostState = { protocolVersion: 1, host: { id: "home", name: "Fixture" }, projects: [{ id: "project", name: "Fixture project", path: "/fixture" }], sessions: [], drafts: [{ id: "new-conversation", projectId: "project", text: "", model: null, revision: 0 }], models: [], lastEventSequence: 0 };
window.agentDesktopWindow = { initial: { state: defaultWindowView() }, save: () => ({}) };
window.agentDesktop = new Proxy({} as DesktopBridge, { get: (_target, property) => {
  if (property === "subscribe") return (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); };
  if (String(property).startsWith("subscribe")) return () => {};
  if (property === "getState") return async () => state;
  if (property === "getHosts") return async () => ({ ownNodeId: "node", hosts: [] });
  if (property === "workspaceQuery") return async (_target: unknown, query: { type: string }) => {
    if (query.type !== "git.status") throw new Error(`Unexpected workspace query ${query.type}`);
    gitRequested(); await pendingGit; return { type: "git.status", status };
  };
  if (property === "getComposerCatalog") return async () => ({ default: {}, models: [] });
  if (property === "getPreferences") return async () => ({ revision: 0, values: {} });
  if (property === "getLocalFonts") return async () => [];
  if (property === "applyWindowTheme") return async () => {};
  if (property === "getMessages") return async () => [];
  if (property === "command") return async () => ({ ok: true, commandId: "fixture", value: {} });
  if (["getBtw", "getBrowserMetadata", "createBrowserTab", "createTerminal", "subscribeNotificationNavigation"].includes(String(property))) return undefined;
  return async () => undefined;
} });
createRoot(document.getElementById("root")!).render(<App/>);
const waitFor = async <T,>(read: () => T, name: string) => {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Timed out: ${name}`);
};
const key = (key: string, options: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }); document.body.dispatchEvent(event); return event;
};
async function runChooserLifecycleAcceptance() {
  await requestedGit;
  const toggle = key("∫", { code: "KeyB", metaKey: true, altKey: true });
  if (!toggle.defaultPrevented) throw new Error("eligible side-panel shortcut was not dispatched");
  await waitFor(() => document.querySelector(".dock-empty-actions"), "empty chooser");
  const before = [...document.querySelectorAll(".dock-empty-actions button")].map(button => button.textContent?.trim());
  const failures: string[] = [];
  if (before.some(label => label?.startsWith("Review"))) failures.push(`Review appeared before delayed git.status: ${JSON.stringify(before)}`);
  await new Promise(resolve => setTimeout(resolve, 300));
  const unavailable = key("g", { code: "KeyG", ctrlKey: true, shiftKey: true });
  if (unavailable.defaultPrevented) failures.push("unavailable Review shortcut was prevented");
  const composer = await waitFor(() => document.querySelector<HTMLElement>("#prompt"), "composer");
  composer.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  releaseGit();
  await new Promise(resolve => setTimeout(resolve, 100));
  const after = [...document.querySelectorAll(".dock-empty-actions button")].map(button => button.textContent?.trim());
  if (!after.some(label => label?.startsWith("Review"))) failures.push(`Review missing after delayed git.status: ${JSON.stringify(after)}; errors=${JSON.stringify(errors)}`);
  if (after.some(label => label?.startsWith("Review")) && !after[0]?.startsWith("Review")) failures.push(`Review was not first after git.status: ${JSON.stringify(after)}`);
  const composingEligible = key("g", { code: "KeyG", ctrlKey: true, shiftKey: true, isComposing: false, keyCode: 71 });
  if (composingEligible.isComposing || composingEligible.keyCode === 229) failures.push("composition probe was not a non-IME key event");
  if (composingEligible.defaultPrevented) failures.push("Review shortcut was handled before compositionend");
  await new Promise(resolve => setTimeout(resolve, 30));
  const composingTabs = [...document.querySelectorAll<HTMLElement>('.dock-panel [role="tab"]')].map(tab => tab.textContent?.trim());
  if (composingTabs.length) failures.push(`Review opened before compositionend: ${JSON.stringify(composingTabs)}`);
  composer.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  const eligible = key("g", { code: "KeyG", ctrlKey: true, shiftKey: true, isComposing: false, keyCode: 71 });
  if (!eligible.defaultPrevented) failures.push("eligible Review shortcut was not prevented");
  await new Promise(resolve => setTimeout(resolve, 30));
  const reviewTabs = [...document.querySelectorAll<HTMLElement>('.dock-panel [role="tab"]')].map(tab => tab.textContent?.trim());
  if (eligible.defaultPrevented && (reviewTabs.length !== 1 || !reviewTabs[0]?.startsWith("Review"))) failures.push(`eligible Review dispatched ${JSON.stringify(reviewTabs)}`);
  return { passed: failures.length === 0, failures, before, after, unavailablePrevented: unavailable.defaultPrevented, composition: { startedBeforeGitRelease: true, probePrevented: composingEligible.defaultPrevented, probeIsComposing: composingEligible.isComposing, probeKeyCode: composingEligible.keyCode, tabsBeforeEnd: composingTabs, eligiblePrevented: eligible.defaultPrevented }, reviewTabs, scope: "Full production App with a delayed real WorkspaceState git.status redraw during an active composer composition; no host, provider, or native work." };
}
Object.assign(window, { runChooserLifecycleAcceptance });
