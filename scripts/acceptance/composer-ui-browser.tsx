import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../apps/desktop/src/renderer/App";
import { DEFAULT_THEME } from "../../packages/shared/src/theme";
import type { CommandEnvelope, CommandResult, DesktopBridge, DesktopEvent, Draft, HostState, OmpComposerCatalog, SessionSummary } from "@agent-desktop/shared";
import { defaultWindowView } from "../../apps/desktop/src/window-state";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";


const owner = "composer-fixture-owner", checks: string[] = [], calls: CommandEnvelope[] = [];
const caps = { protocolVersion: 1 as const, commandVersion: 3 as const, maxImages: 4, maxImageBytes: 20 * 1024 * 1024, maxBatchBytes: 20 * 1024 * 1024, maxImagePixels: 16_777_216, mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] as const };
const model = { provider: "controlled", id: "text-model", name: "Controlled model", input: ["text", "image"], contextWindow: 1000, maxTokens: 1000, reasoning: false, authenticated: true, available: true };
const session = (id: string): SessionSummary => ({ id, hostId: owner, projectId: null, cwd: "/isolated/controlled", title: id === "existing" ? "Existing controlled conversation" : "Controlled command admission", sessionFile: "/isolated/controlled/session.jsonl", status: "idle", model, archived: false, createdAt: Date.now(), updatedAt: Date.now() });
let state: HostState = { protocolVersion: 1, host: { id: owner, name: "Isolated fixture", platform: "darwin", architecture: "arm64" }, projects: [], sessions: [session("existing")], models: [model], drafts: [], lastEventSequence: 1, imageAttachments: caps };
const listeners = new Set<(event: DesktopEvent) => void>(); let connected = true, catalogGate: ReturnType<typeof Promise.withResolvers<void>> | undefined, archiveFailure = false, gatedCatalogs = 0;
let windowState = defaultWindowView();
window.agentDesktopWindow = { initial: { state: windowState }, save: next => { windowState = structuredClone(next); return {}; } };
const publish = () => { state = { ...state, lastEventSequence: state.lastEventSequence + 1 }; for (const listener of listeners) listener({ type: "state", sequence: state.lastEventSequence, hostId: owner, state: structuredClone(state) }); };
const methods: Partial<DesktopBridge> = {
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getState: async () => { if (!connected) throw new Error("Controlled offline owner"); return structuredClone(state); },
  getHosts: async () => ({ status: "connected", ownNodeId: "fixture", checkedAt: 1, hosts: [] }),
  getPreferences: async () => ({ version: 1, records: [] }),
  getTheme: async () => ({ document: { ...DEFAULT_THEME, mode: "dark" }, revision: "controlled-theme", filePath: "/isolated/fixture/theme.json" }),
  getLocalFonts: async () => [], applyWindowTheme: async () => {},
  getComposerCatalog: async () => ({ models: [model], cwd: "/isolated/controlled", default: { model, approvalMode: "always-ask", source: "configured-role" }, resolution: "native-registry-preview" } as OmpComposerCatalog),
  getSessionControls: async () => ({ sessionId: "existing", revision: "fixture", model, capabilities: { ...model, api: "controlled", thinkingSelectors: [], serviceTierOptions: {}, supportsTools: false, capabilities: {}, compatibility: {}, settingsPaths: [], excludedSensitiveFields: [], unmappedCapabilityFields: [] }, settings: [], overrides: [], serviceTiers: {}, runtimeMutablePaths: [], persistence: "native-session-model-thinking-tiers; runtime-settings-until-dispose" }),
  getInteractions: async () => [], getMessages: async () => [{ id: "operator-entry", nativeId: "operator-entry", role: "commandOutput", text: "", content: [], lifecycle: "complete", commandOutput: { entryId: "operator-entry", command: "help", output: "Controlled native operator output\n<literal>" } }],
  getComposerActions: async target => {
    if (catalogGate) { gatedCatalogs++; await catalogGate.promise; }
    return { protocolVersion: 1, hostId: owner, target, cwd: "/isolated/controlled", revision: "catalog-v1", referenceSchemes: ["skill"], diagnostics: [], commands: [
      { id: "mode", name: "mode", description: "Choose native mode", insertText: "/mode ", source: { kind: "builtin", label: "OMP" }, availability: "executable", argumentCompletions: true },
      { id: "blocked", name: "blocked", description: "Native UI required", insertText: "/blocked ", source: { kind: "builtin", label: "OMP" }, availability: "pending", reason: "Native UI required", argumentCompletions: false }
    ], skills: [{ id: "review", name: "Review", description: "Review the source", insertText: "/skill:review ", source: { kind: "skill", label: "Personal" }, availability: "executable", argumentCompletions: false }] };
  },
  getComposerCompletions: async query => ({ protocolVersion: 1, hostId: owner, target: query.target, cwd: "/isolated/controlled", revision: "catalog-v1", diagnostics: [], truncated: false, items: query.kind === "reference" ? [{ id: "uri", label: "review", kind: "native-reference", insertText: "skill://review " }] : query.kind === "command-argument" ? [{ id: "plan", label: "plan", description: "Native plan mode", kind: "command-argument", insertText: "plan" }] : [{ id: "file", label: "source file.ts", kind: "file-reference", insertText: '@"source file.ts" ' }] }),
  command: async (envelope, host): Promise<CommandResult> => {
    assert(connected && host === owner, "Command owner/connection"); calls.push(structuredClone(envelope)); const command = envelope.command;
    if (command.type === "draft.put") {
      const old = state.drafts.find(item => item.id === command.draft.id);
      if ((old?.revision ?? 0) !== command.expectedRevision) return { ok: false, commandId: envelope.id, currentDraft: old, error: { code: "DRAFT_CONFLICT", message: "Controlled revision conflict" } };
      const saved: Draft = { ...structuredClone(command.draft), revision: command.expectedRevision + 1, updatedAt: Date.now() };
      state.drafts = [...state.drafts.filter(item => item.id !== saved.id), saved]; publish(); return { ok: true, commandId: envelope.id, value: saved };
    }
    if (command.type === "session.archive") {
      if (archiveFailure) return { ok: false, commandId: envelope.id, error: { code: "FAILED", message: "Controlled archive failure" } };
      state.sessions = state.sessions.map(item => item.id === command.sessionId ? { ...item, archived: command.archived } : item); publish();
      return { ok: true, commandId: envelope.id };
    }
    if (command.type === "session.create") { const created = session("created"); state.sessions = [...state.sessions, created]; publish(); return { ok: true, commandId: envelope.id, value: created }; }
    if (command.type === "session.prompt") {
      // Explicit controlled admission only; no native session or provider exists.
      const current = state.drafts.find(item => item.id === command.draft?.id);
      if (current && current.revision === command.draft?.revision) state.drafts = state.drafts.map(item => item.id === current.id ? { ...item, text: "", attachments: [], revision: item.revision + 1, lastConsumption: { commandId: envelope.id, submittedRevision: item.revision } } : item);
      publish(); return { ok: true, commandId: envelope.id, value: state.sessions.find(item => item.id === command.sessionId), admission: { kind: "user-message", entryId: "controlled-entry" } };
    }
    throw new Error(`Forbidden/unimplemented fixture command: ${command.type}`);
  },
};
window.agentDesktop = new Proxy(methods as DesktopBridge, { get(target, key) { if (key in target) return target[key as keyof DesktopBridge]; return async () => { throw new Error(`Unexpected controlled bridge call: ${String(key)}`); }; } });
const root = createRoot(document.getElementById("root")!); root.render(<StrictMode><App/></StrictMode>);
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const wait = async (read: () => unknown, label: string, timeout = 8000) => { const start = performance.now(); while (performance.now() - start < timeout) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out: ${label}`); };
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const prompt = () => document.querySelector<HTMLTextAreaElement>("#prompt")!;
const popup = () => document.querySelector<HTMLElement>(".composer-autocomplete");
const options = () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
async function setText(value: string) { const target = prompt(); target.focus(); target.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(target, value); target.setSelectionRange(value.length, value.length); target.dispatchEvent(new InputEvent("input", { bubbles: true })); target.dispatchEvent(new Event("select", { bubbles: true })); await settle(); }
async function key(value: string, extra: KeyboardEventInit = {}) { const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...extra }); prompt().dispatchEvent(event); await settle(); return event.defaultPrevented; }
Object.assign(window, {
  composerUIProgress: () => ({ checks, input: prompt()?.value, caret: prompt()?.selectionStart, expanded: prompt()?.getAttribute("aria-expanded"), focused: document.activeElement?.id, popup: popup()?.textContent, calls: calls.map(item => item.command.type), errors: [...document.querySelectorAll('[role="alert"]')].map(item => item.textContent) }),
  runComposerUIAcceptance: async () => {
    await wait(() => prompt() && document.querySelector<HTMLButtonElement>(".attach-image-button")?.disabled === false, "production App ready");
    await setText("/"); await wait(() => options().some(item => item.textContent?.includes("Choose native mode")), "catalog popup");
    assert(options().some(item => item.textContent?.includes("Archive")), "app actions included");
    assert(options().some(item => item.getAttribute("aria-disabled") === "true" && item.textContent?.includes("blocked")), "unsupported command explicit");
    assert(await key("ArrowDown"), "popup owns arrows"); assert(await key("Escape"), "popup owns Escape"); assert(!popup(), "Escape closes popup");
    checks.push("real App combines native commands and app actions; keyboard navigation and explicit unavailable command");
    await setText("$rev"); await wait(() => options().some(item => item.textContent?.includes("Review the source")), "skills");
    await key("Tab"); assert(prompt().value === "/skill:review ", "Tab inserts exact native skill invocation");
    assert(!calls.some(item => item.command.type === "session.prompt"), "completion does not send");
    await setText("Read @source"); await wait(() => options().some(item => item.textContent?.includes("source file.ts")), "file lookup");
    await key("Enter"); assert(prompt().value === 'Read @"source file.ts" ', "file completion quoting");
    await setText("/mode "); await wait(() => options().some(item => item.textContent?.includes("Native plan mode")), "native args");
    await key("Tab"); assert(prompt().value === "/mode plan", "native arguments replaced");
    await setText("skill://rev"); await wait(() => options().some(item => item.textContent?.includes("review")), "native URI lookup");
    await key("Enter"); assert(prompt().value === "skill://review ", "native URI preserved");
    checks.push("native skill, quoted file and native argument insertion; no accidental prompt execution");
    await setText("/mode"); await wait(() => popup(), "IME menu");
    prompt().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); await settle();
    assert(!popup(), "IME hides completion"); await key("Enter", { isComposing: true });
    assert(!calls.some(item => item.command.type === "session.prompt"), "IME Enter does not send");
    prompt().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); await settle();
    checks.push("IME composition never submits or selects completion");
    await setText(""); prompt().dispatchEvent(new FocusEvent("focusout", { bubbles: true })); await settle(); catalogGate = Promise.withResolvers<void>(); await setText("/"); await wait(() => gatedCatalogs > 0, "actual pending catalog"); await key("Enter");
    assert(!calls.some(item => item.command.type === "session.prompt"), "loading Enter does not send");
    document.querySelector<HTMLButtonElement>('[data-session-id="existing"]')!.click(); await wait(() => windowState.route.sessionId === "existing", "switch owner scope");
    catalogGate.resolve(); catalogGate = undefined; await settle(); assert(!popup(), "late old menu not published after session navigation");
    checks.push("pending catalog and navigation cannot submit or publish into another draft");
    await wait(() => document.querySelector(".transcript-command-output"), "command output projection");
    assert(document.querySelector(".transcript-command-output pre")?.textContent === "Controlled native operator output\n<literal>", "command output exact literal text");
    assert(!document.querySelector(".transcript-command-output")?.closest(".assistant-message"), "operator output is not assistant prose");
    checks.push("native command-output metadata renders separately with exact literal content");
    archiveFailure = true; await setText("/archive"); await wait(() => options().some(item => item.textContent?.includes("Archive")), "archive app action");
    await key("Enter"); await wait(() => popup()?.textContent?.includes("Controlled archive failure"), "archive rejection visible");
    assert(prompt().value === "/archive", "failed action preserves draft");
    checks.push("actual App archive bridge error is visible and preserves input");
    await setText("$"); await wait(() => options().length > 0, "final visual scene");
    return { passed: true, checks, providerRequests: 0, scope: "Production App and autocomplete in isolated Electron; controlled owner bridge, no real native commands or providers" };
  },
  composerUIGeometry: async () => {
    await document.fonts.ready; await settle(); const box = popup()!.getBoundingClientRect(), form = document.querySelector("form.composer")!.getBoundingClientRect();
    const style = getComputedStyle(popup()!), rows = options().map(item => { const rect = item.getBoundingClientRect(); return { height: rect.height, width: rect.width }; });
    return { popup: { x: box.x, y: box.y, width: box.width, bottom: box.bottom }, composer: { x: form.x, y: form.y, width: form.width }, rows, background: style.backgroundColor, radius: style.borderRadius, fontSize: style.fontSize,
      fitting: Math.abs(box.x - form.x) < 1 && Math.abs(box.width - form.width) < 1 && Math.abs(form.top - box.bottom - 8) < 1 && box.x >= 0 && box.right <= innerWidth && box.y >= 0 };
  },
});
