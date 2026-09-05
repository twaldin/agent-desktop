import { createRoot } from "react-dom/client";
import { App } from "../../apps/desktop/src/renderer/App";
import type { CommandEnvelope, DesktopBridge, DesktopEvent, Draft, OmpComposerCatalog } from "@agent-desktop/shared";
import { defaultWindowView } from "../../apps/desktop/src/window-state";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

declare global { interface Window { fixtureApi: { call(method: string, args: unknown[]): Promise<any>; subscribe(listener: (event: DesktopEvent) => void): () => void } } }
const observations: string[] = [];
const fixtureListeners = new Set<(event: DesktopEvent) => void>();
let omitPermissionCapability = false;
let delayNextDraft = false;
let delayedDraft: { release(): void } | undefined;
let latestWindowState = defaultWindowView();
window.agentDesktopWindow = { initial: { state: latestWindowState }, save: state => { latestWindowState = structuredClone(state); return {}; } };
window.agentDesktop = new Proxy({} as DesktopBridge, { get: (_target, property) => {
  if (property === "subscribe") return (listener: (event: DesktopEvent) => void) => { fixtureListeners.add(listener); const off = window.fixtureApi.subscribe(listener); return () => { fixtureListeners.delete(listener); off(); }; };
  return async (...args: unknown[]) => {
    if (property === "command" && delayNextDraft && (args[0] as CommandEnvelope).command.type === "draft.put") {
      delayNextDraft = false; await new Promise<void>(release => { delayedDraft = { release }; }); delayedDraft = undefined;
    }
    const result = await window.fixtureApi.call(String(property), args);
    if (property === "getComposerCatalog" && omitPermissionCapability) {
      const catalog = structuredClone(result) as OmpComposerCatalog; delete catalog.default.approvalMode; return catalog;
    }
    return result;
  };
} });
createRoot(document.getElementById("root")!).render(<App/>);
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
async function waitFor<T>(read: () => T, description: string, timeout = 20_000): Promise<NonNullable<T>> {
  const start = performance.now();
  while (performance.now() - start < timeout) { const value = read(); if (value) return value as NonNullable<T>; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Timed out: ${description}`);
}
const prompt = () => document.querySelector<HTMLTextAreaElement>("#prompt")!;
const permissions = () => document.querySelector<HTMLSelectElement>('select[aria-label="Permissions"]')!;
function setText(value: string) {
  const input = prompt(); input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}
function setPermission(value: string) { permissions().value = value; permissions().dispatchEvent(new Event("change", { bubbles: true })); }
function key(target: HTMLElement, key: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, metaKey: true, ...extra }); target.dispatchEvent(event); return event;
}
function rect(element: Element | null) {
  if (!element) return null;
  const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
}
function appStartupGeometry() {
  const composer = document.querySelector<HTMLElement>(".composer")!, selectionRow = document.querySelector<HTMLElement>(".composer-selections")!;
  const controls = [...selectionRow.querySelectorAll<HTMLElement>(".select-control")].map(element => ({ label: element.querySelector("select,button")?.getAttribute("aria-label"), bounds: rect(element), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  const box = composer.getBoundingClientRect(), pending = document.querySelector<HTMLElement>(".pending-interactions");
  const fitting = controls.every(control => control.bounds!.x >= box.x - 1 && control.bounds!.right <= box.right + 1 && control.bounds!.bottom <= box.bottom + 1);
  const actions = [...document.querySelectorAll<HTMLElement>(".interaction-actions button")].map(element => ({ text: element.textContent, bounds: rect(element) }));
  return { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, composer: rect(composer), permission: rect(permissions()), selectionRow: rect(selectionRow), controls, fitting,
    pending: rect(pending), actions, horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    questionVisible: !pending || pending.getBoundingClientRect().y >= 0 && pending.getBoundingClientRect().bottom <= innerHeight,
    fontReady: document.fonts.status, route: latestWindowState.route, errors: [...document.querySelectorAll('[role="alert"]')].map(value => value.textContent) };
}
async function prepareAppStartupAcceptance() {
  await waitFor(() => prompt() && permissions() && !permissions().disabled, "native permission catalog loaded");
  assert(permissions().selectedOptions[0]!.text.includes("Always ask"), "native configured permission default was not displayed");
  const state = await window.agentDesktop.getState(); assert(state.sessions.length === 0, "fixture must begin without sessions");
  setPermission("write"); await waitFor(() => permissions().value === "write", "permission choice");
  await waitFor(() => document.body.textContent?.includes("Draft permissions: Write. Applied on send"), "draft-specific permission explanation");
  assert((await window.agentDesktop.getState()).sessions.length === 0, "choosing permissions created a session");
  return { hostId: state.host.id, nativeDefault: "always-ask", selectedDraft: "write", sessionCount: 0 };
}
async function checkIntegratedAppShortcuts() {
  prompt().focus(); const before = latestWindowState.sidebarOpen;
  assert(key(prompt(), "\\").defaultPrevented, "App did not consume sidebar shortcut");
  await waitFor(() => latestWindowState.sidebarOpen !== before, "integrated sidebar shortcut");
  key(prompt(), "\\"); await waitFor(() => latestWindowState.sidebarOpen === before, "sidebar restored");
  key(prompt(), "k"); const search = await waitFor(() => document.querySelector<HTMLInputElement>('input[placeholder="Search conversations"]'), "sidebar search opened");
  await waitFor(() => document.activeElement === search, "search focus");
  assert(!key(search, "\\").defaultPrevented, "focused search text field lost ownership");
  assert(latestWindowState.sidebarOpen === before, "search shortcut changed sidebar");
  prompt().focus(); const handled = (event: KeyboardEvent) => event.preventDefault(); prompt().addEventListener("keydown", handled);
  key(prompt(), "\\"); prompt().removeEventListener("keydown", handled); assert(latestWindowState.sidebarOpen === before, "App ignored defaultPrevented");
  assert(!key(prompt(), "n", { metaKey: false, ctrlKey: true }).defaultPrevented, "macOS Control text editing was consumed");
  const model = document.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!; model.click();
  const modelSearch = await waitFor(() => document.querySelector<HTMLInputElement>('input[aria-label="Search models"]'), "production model dialog");
  const sidebar = latestWindowState.sidebarOpen; assert(!key(modelSearch, "\\").defaultPrevented, "model dialog command escaped ownership");
  assert(latestWindowState.sidebarOpen === sidebar, "model dialog command changed app state");
  document.querySelector<HTMLButtonElement>('button[aria-label="Close model picker"]')!.click();
  await waitFor(() => !document.querySelector('input[aria-label="Search models"]'), "model dialog closed");
  observations.push("Integrated App listener respects composer, handled events, macOS Control input, search editing and real model modal ownership.");
  return observations;
}
let sessionId: string;
async function startNativeAppQuestion() {
  setText("/renderer-startup-contract");
  await waitFor(() => prompt().value === "/renderer-startup-contract", "native command draft");
  document.querySelector<HTMLFormElement>("form.composer")!.requestSubmit();
  const request = await waitFor(() => [...document.querySelectorAll<HTMLElement>(".interaction-card")].find(value => value.textContent?.includes("Native startup question")), "native startup question visible in New chat", 35_000);
  assert(latestWindowState.route.sessionId === null, "startup question should be discoverable before leaving New chat");
  assert(document.body.textContent?.includes("Waiting for this session to accept the captured prompt"), "admission pending state not explained");
  const state = await window.agentDesktop.getState(); assert(state.sessions.length === 1, "one native session must be created"); sessionId = state.sessions[0]!.id;
  assert(state.sessions[0]!.approvalOverride === "write", "captured permission choice did not reach the real session");
  const requests = await window.agentDesktop.getInteractions(sessionId); assert(requests.length === 1 && requests[0]!.method === "confirm", "visible question is not the actual native pending request");
  const details = [...document.querySelectorAll<HTMLDetailsElement>("details")].find(value => value.querySelector("summary")?.textContent === "View pending prompt and selections")!; details.open = true;
  assert(details.textContent?.includes("Write") && details.textContent.includes("/renderer-startup-contract"), "pending snapshot omitted captured permissions or prompt"); details.open = false;
  setText("Newer unsent draft stays here"); setPermission("always-ask");
  await waitFor(() => prompt().value === "Newer unsent draft stays here" && permissions().value === "always-ask", "newer draft edits during pending acceptance");
  const yes = [...request.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent === "Yes")!; yes.focus();
  assert(!key(yes, "n").defaultPrevented, "app command intercepted native request focus");
  assert(latestWindowState.route.sessionId === null, "request-focus command navigated away");
  return { sessionId, nativeRequestId: requests[0]!.id, question: requests[0]!.title, capturedApproval: state.sessions[0]!.approvalOverride, newerApproval: permissions().value, geometry: appStartupGeometry() };
}
async function answerNativeAppQuestion() {
  const yes = [...document.querySelectorAll<HTMLButtonElement>(".interaction-card button")].find(value => value.textContent === "Yes")!; assert(yes, "native question disappeared before response"); yes.click();
  await waitFor(() => !document.querySelector(".interaction-card") && !document.body.textContent?.includes("Waiting for this session to accept"), "native response and prompt admission", 30_000);
  assert(prompt().value === "Newer unsent draft stays here" && permissions().value === "always-ask", "accepted old snapshot cleared newer draft edits");
  assert(latestWindowState.route.sessionId === null, "acceptance replaced a newer draft with navigation");
  await waitFor(() => [...document.querySelectorAll('[aria-live="polite"]')].some(value => value.textContent === "Draft saved"), "normal debounce saves the newer draft after pending submission unlocks");
  const state = await window.agentDesktop.getState(); const session = state.sessions.find(value => value.id === sessionId)!;
  assert(session.approvalOverride === "write", "new unsent permission edit changed live session policy");
  const controls = await window.agentDesktop.getSessionControls(sessionId);
  assert(controls.settings.find(value => value.path === "tools.approvalMode")?.effective === "write", "native worker does not use the captured permission policy");
  const draft = state.drafts.find(value => value.id === "new-conversation") as Draft;
  assert(draft.text === "Newer unsent draft stays here" && draft.approvalMode === "always-ask", "host draft failed to preserve newer text and permissions");
  return { sessionId, status: session.status, sessionApproval: session.approvalOverride, nativeApproval: "write", retainedDraft: draft, route: latestWindowState.route };
}
async function checkNativeDraftConflict() {
  const state = await window.agentDesktop.getState(), base = state.drafts.find(value => value.id === "new-conversation")!;
  delayNextDraft = true; setPermission("write"); await waitFor(() => delayedDraft, "controlled transport delay holds local draft delivery");
  try {
    const remote = await window.fixtureApi.call("command", [{ id: crypto.randomUUID(), command: { type: "draft.put", expectedRevision: base.revision,
      draft: { id: base.id, text: base.text, projectId: base.projectId, model: base.model, approvalMode: "yolo" } } }, state.host.id]);
    assert(remote.ok, "second isolated client draft update failed");
  } finally { delayedDraft!.release(); }
  const conflict = await waitFor(() => document.querySelector<HTMLElement>(".draft-conflict"), "actual owner revision conflict shown");
  const details = [...conflict.querySelectorAll<HTMLDetailsElement>("details")]; for (const detail of details) detail.open = true;
  const local = details.find(value => value.querySelector("summary")?.textContent === "View my draft")!, remote = details.find(value => value.querySelector("summary")?.textContent === "View host’s saved draft")!;
  function permission(detail: HTMLElement) { const dt = [...detail.querySelectorAll("dt")].find(value => value.textContent === "Permissions"); return dt?.nextElementSibling?.textContent; }
  assert(permission(local) === "Write" && permission(remote) === "Yolo", "selection-only conflict snapshots did not distinguish permissions");
  assert(local.querySelector("pre")?.textContent === base.text && remote.querySelector("pre")?.textContent === base.text, "conflict fixture should differ only by selection");
  assert(document.querySelector<HTMLButtonElement>('.send-button')!.disabled, "unresolved revision conflict still allows new send");
  return { scope: "Actual host revision conflict; only local draft transport delivery was deliberately delayed.", localPermission: permission(local), remotePermission: permission(remote), sameText: base.text, geometry: appStartupGeometry() };
}
async function finishConflictAndCheckOlderHost() {
  [...document.querySelectorAll<HTMLButtonElement>(".draft-conflict button")].find(value => value.textContent === "Keep my draft")!.click();
  await waitFor(() => !document.querySelector(".draft-conflict") && [...document.querySelectorAll('[aria-live="polite"]')].some(value => value.textContent === "Draft saved"), "explicit Keep my draft saved against current owner revision");
  const state = await window.agentDesktop.getState(), saved = state.drafts.find(value => value.id === "new-conversation")!;
  assert(saved.approvalMode === "write", "explicit local conflict resolution did not reach the host");
  omitPermissionCapability = true;
  for (const listener of fixtureListeners) listener({ type: "settings", hostId: state.host.id, sequence: state.lastEventSequence, scope: "global" });
  await waitFor(() => permissions().disabled, "controlled older-host catalog disables unsupported permission control");
  assert(permissions().value === "write", "missing capability silently discarded saved draft permission");
  assert(permissions().closest("label")?.title.includes("Update the owning host"), "unsupported host explanation missing");
  return { conflictResolution: "Actual host saved explicit local Write choice", unsupportedScope: "Controlled catalog projection removes only approvalMode capability; this is not a real old host.", retainedPermission: permissions().value, disabled: permissions().disabled };
}
Object.assign(window, { prepareAppStartupAcceptance, checkIntegratedAppShortcuts, startNativeAppQuestion, answerNativeAppQuestion, appStartupGeometry, checkNativeDraftConflict, finishConflictAndCheckOlderHost });
