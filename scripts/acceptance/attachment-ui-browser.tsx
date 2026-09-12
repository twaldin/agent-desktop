import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../apps/desktop/src/renderer/App";
import { DEFAULT_THEME } from "../../packages/shared/src/theme";
import type { CommandEnvelope, CommandResult, DesktopBridge, DesktopEvent, Draft, HostState, OmpComposerCatalog, SessionSummary, UploadedImageMetadata } from "@agent-desktop/shared";
import { defaultWindowView } from "../../apps/desktop/src/window-state";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

declare global { interface Window { attachmentFixture: { inspect(bytes: Uint8Array): Promise<UploadedImageMetadata> } } }
const owner = "image-fixture-owner", checks: string[] = [], calls: CommandEnvelope[] = [], uploads: string[] = [], binaries = new Map<string, { data: Uint8Array; metadata: UploadedImageMetadata }>();
const caps = { protocolVersion: 1 as const, commandVersion: 3 as const, maxImages: 4, maxImageBytes: 20 * 1024 * 1024, maxBatchBytes: 20 * 1024 * 1024, maxImagePixels: 16_777_216, mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] as const };
const model = { provider: "controlled", id: "image-model", name: "Controlled image model", input: ["text", "image"], contextWindow: 1000, maxTokens: 1000, reasoning: false, authenticated: true, available: true };
const session = (id: string): SessionSummary => ({ id, hostId: owner, projectId: null, cwd: "/isolated/controlled", title: id === "existing" ? "Existing controlled conversation" : "Controlled image admission", sessionFile: "/isolated/controlled/session.jsonl", status: "idle", model, archived: false, createdAt: 1, updatedAt: 1 });
let state: HostState = { protocolVersion: 1, host: { id: owner, name: "Isolated fixture", platform: "darwin", architecture: "arm64" }, projects: [], sessions: [session("existing")], models: [model], drafts: [], lastEventSequence: 1, imageAttachments: caps };
const listeners = new Set<(event: DesktopEvent) => void>(); let connected = true, inspectGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let windowState = defaultWindowView();
window.agentDesktopWindow = { initial: { state: windowState }, save: next => { windowState = structuredClone(next); return {}; } };
const publish = () => { state = { ...state, lastEventSequence: state.lastEventSequence + 1 }; for (const listener of listeners) listener({ type: "state", sequence: state.lastEventSequence, hostId: owner, state: structuredClone(state) }); };
const methods: Partial<DesktopBridge> = {
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getState: async () => { if (!connected) throw new Error("Controlled offline owner"); return structuredClone(state); },
  getHosts: async () => ({ status: "connected", ownNodeId: owner, checkedAt: 1, hosts: [] }),
  getPreferences: async () => ({ version: 1, records: [] }),
  getTheme: async () => ({ document: { ...DEFAULT_THEME, mode: "dark" }, revision: "controlled-theme", filePath: "/isolated/fixture/theme.json" }),
  getLocalFonts: async () => [], applyWindowTheme: async () => {},
  subscribeWindowTheme: () => () => {}, subscribeNotificationNavigation: () => () => {},
  subscribeWindowClose: () => () => {}, answerWindowClose: async () => {},
  getDetachedQuestions: async () => null,
  getComposerCatalog: async () => ({ models: [model], cwd: "/isolated/controlled", default: { model, approvalMode: "always-ask", source: "configured-role" }, resolution: "native-registry-preview" } as OmpComposerCatalog),
  getSessionControls: async () => ({ sessionId: "existing", revision: "fixture", model, capabilities: { ...model, api: "controlled", thinkingSelectors: [], serviceTierOptions: {}, supportsTools: false, capabilities: {}, compatibility: {}, settingsPaths: [], excludedSensitiveFields: [], unmappedCapabilityFields: [] }, settings: [], overrides: [], serviceTiers: {}, runtimeMutablePaths: [], persistence: "native-session-model-thinking-tiers; runtime-settings-until-dispose" }),
  getInteractions: async () => [], getMessages: async () => [],
  inspectImageAttachment: async bytes => { if (inspectGate) await inspectGate.promise; return window.attachmentFixture.inspect(bytes); },
  uploadImageAttachment: async (sha, data, host) => { assert(host === owner && connected, "Upload owner/connection"); const metadata = await window.attachmentFixture.inspect(data); assert(metadata.sha256 === sha, "Upload hash"); binaries.set(sha, { data: new Uint8Array(data), metadata }); uploads.push(sha); return metadata; },
  getImageAttachment: async (sha, host) => { assert(host === owner && connected, "Read owner/connection"); const found = binaries.get(sha); if (!found) throw new Error("Controlled missing image"); return { ...found.metadata, data: new Uint8Array(found.data) }; },
  command: async (envelope, host): Promise<CommandResult> => {
    assert(connected && host === owner, "Command owner/connection"); calls.push(structuredClone(envelope)); const command = envelope.command;
    if (command.type === "draft.put") {
      const old = state.drafts.find(item => item.id === command.draft.id);
      if ((old?.revision ?? 0) !== command.expectedRevision) return { ok: false, commandId: envelope.id, currentDraft: old, error: { code: "DRAFT_CONFLICT", message: "Controlled revision conflict" } };
      for (const ref of command.draft.attachments ?? []) assert(binaries.has(ref.sha256), "Draft cannot precede owner upload");
      const saved: Draft = { ...structuredClone(command.draft), revision: command.expectedRevision + 1, updatedAt: Date.now() };
      state.drafts = [...state.drafts.filter(item => item.id !== saved.id), saved]; publish(); return { ok: true, commandId: envelope.id, value: saved };
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
const liveUrls = new Set<string>(), originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
URL.createObjectURL = blob => { const url = originalCreate(blob); liveUrls.add(url); return url; };
URL.revokeObjectURL = url => { liveUrls.delete(url); originalRevoke(url); };
let root = createRoot(document.getElementById("root")!); root.render(<StrictMode><App/></StrictMode>);
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const wait = async (read: () => unknown, label: string, timeout = 8000) => { const start = performance.now(); while (performance.now() - start < timeout) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out: ${label}`); };
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const prompt = () => document.querySelector<HTMLElement>("#prompt")!;
const promptText = () => prompt()?.textContent ?? "";
const form = () => document.querySelector<HTMLFormElement>("form.composer")!;
const chips = () => [...document.querySelectorAll<HTMLElement>(".composer-image-chip")];
const setText = (value: string) => { const target = prompt(); target.focus(); target.dispatchEvent(new FocusEvent("focus")); const selection = getSelection(), range = document.createRange(); range.selectNodeContents(target); selection?.removeAllRanges(); selection?.addRange(range); assert(document.execCommand("insertText", false, value), "production contenteditable accepted text"); };
const click = (label: string) => { const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label || item.querySelector(":scope > span")?.textContent === label); assert(button, `Missing button ${label}`); button.click(); };
async function png(name: string, color: string) { const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 100; const ctx = canvas.getContext("2d")!; ctx.fillStyle = color; ctx.fillRect(0, 0, 160, 100); ctx.fillStyle = "white"; ctx.font = "18px sans-serif"; ctx.fillText(name.slice(0, 10), 8, 54); return new File([await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"))], name, { type: "image/png" }); }
function transfer(files: File[]) { const data = new DataTransfer(); for (const file of files) data.items.add(file); return data; }
async function addFile(file: File, kind: "picker" | "paste" | "drop") {
  const data = transfer([file]);
  if (kind === "picker") { const input = document.querySelector<HTMLInputElement>('input[type="file"][aria-label="Choose images"]')!; input.files = data.files; input.dispatchEvent(new Event("change", { bubbles: true })); }
  else if (kind === "paste") prompt().dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  else form().dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  await settle();
}
function connection(value: boolean) { connected = value; for (const listener of listeners) listener({ type: "connection", hostId: owner, sequence: ++state.lastEventSequence, connected: value }); }
async function removeAll() { for (const button of [...document.querySelectorAll<HTMLButtonElement>('.composer-image-actions button[aria-label^="Remove "]')]) button.click(); await wait(() => chips().length === 0, "chips removed"); }
Object.assign(window, {
  attachmentUIProgress: () => ({ checks, calls: calls.map(item => ({ id: item.id, type: item.command.type })), uploads, route: windowState.route, liveUrls: liveUrls.size, errors: [...document.querySelectorAll('[role="alert"]')].map(item => item.textContent) }),
  runAttachmentUIAcceptance: async () => {
    await wait(() => prompt() && document.querySelector<HTMLButtonElement>(".attach-image-button")?.disabled === false, "StrictMode production App ready");
    const first = await png("Architecture.png", "#395db8"), second = await png("Layout.png", "#347766"), third = await png("Paste.png", "#864785");
    await addFile(first, "picker"); await wait(() => chips().length === 1 && chips()[0]?.querySelector("img")?.complete, "actual IDB and decoded image after StrictMode replay");
    await addFile(second, "drop"); await wait(() => chips().length === 2, "drop"); await addFile(third, "paste"); await wait(() => chips().length === 3, "paste");
    assert(!promptText(), "image-only draft should have no authored text"); checks.push("production App StrictMode; picker-equivalent File event, actual drop/paste handlers, header IPC, browser decode and real IndexedDB chips");
    const last = chips()[2]!; last.focus(); last.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true })); await settle();
    assert(chips()[1]?.textContent?.includes("Paste.png"), "keyboard reorder"); chips()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })); await wait(() => chips().length === 2, "keyboard remove");
    click("Preview Architecture.png"); await wait(() => document.querySelector(".image-preview-dialog[open]"), "real native dialog open"); document.querySelector<HTMLDialogElement>(".image-preview-dialog[open]")!.dispatchEvent(new Event("cancel", { cancelable: true })); await wait(() => !document.querySelector(".image-preview-dialog[open]"), "Escape-like cancellation closes dialog"); checks.push("ordered keyboard chips, delete, actual modal preview and cancellation");
    inspectGate = Promise.withResolvers<void>(); await addFile(await png("Cancelled.png", "#aa4d31"), "drop"); click("Cancel adding Cancelled.png"); inspectGate.resolve(); inspectGate = undefined; await settle(); assert(chips().length === 2, "cancel prevented late chip");
    inspectGate = Promise.withResolvers<void>(); await addFile(await png("Old route.png", "#725131"), "drop");
    const existingRow = () => document.querySelector<HTMLButtonElement>('[data-session-id="existing"]');
    if (!existingRow()) [...document.querySelectorAll<HTMLButtonElement>(".sidebar-section-toggle")].find(item => item.textContent?.includes("Recents"))?.click();
    await wait(existingRow, "existing conversation row"); existingRow()!.click(); await wait(() => windowState.route.sessionId === "existing", "session navigation"); inspectGate.resolve(); inspectGate = undefined; await settle(); assert(chips().length === 0, "late completion did not reach selected session"); click("New chat"); await wait(() => windowState.route.sessionId === null && chips().length === 2, "original draft preserved"); checks.push("cancel and owning-route switch prevent late image publication");
    const truncated = new File([(await first.arrayBuffer()).slice(0, 33)], "Truncated.png", { type: "image/png" }); await addFile(truncated, "drop"); await wait(() => document.querySelector(".composer-image-staging [role=alert]"), "actual browser decode rejects header-only PNG"); assert(chips().length === 2, "bad compressed pixels not published"); click("Cancel adding Truncated.png");
    const originalAdd = IDBObjectStore.prototype.add; let rejected = false;
    IDBObjectStore.prototype.add = function(...args: Parameters<IDBObjectStore["add"]>) { if (this.name === "bytes" && !rejected) { rejected = true; throw new DOMException("Controlled quota failure", "QuotaExceededError"); } return originalAdd.apply(this, args); };
    try { await addFile(await png("Cache failure.png", "#331155"), "drop"); await wait(() => document.querySelector(".composer-image-staging [role=alert]"), "actual IDB write boundary rejection"); assert(rejected && chips().length === 2, "failed cache write did not publish chip"); }
    finally { IDBObjectStore.prototype.add = originalAdd; }
    click("Cancel adding Cache failure.png"); checks.push("actual browser decode failure and controlled native IDB quota exception remain visible without saved chips");
    await wait(() => state.drafts.find(item => item.id === "new-conversation")?.attachments?.length === 2, "owner draft saved after uploads");
    const promptsBefore = calls.filter(item => item.command.type === "session.prompt").length;
    connection(false); await settle(); await addFile(third, "paste"); await wait(() => chips().length === 3, "offline cached capability attach"); await wait(() => chips().every(item => item.querySelector("img")?.complete), "offline cached previews");
    assert(document.querySelector<HTMLButtonElement>(".send-button")!.disabled, "offline send disabled"); connection(true); await wait(() => state.drafts.find(item => item.id === "new-conversation")?.attachments?.length === 3, "reconnect saves refs");
    assert(calls.filter(item => item.command.type === "session.prompt").length === promptsBefore, "reconnect must not auto-send"); checks.push("offline new-image attach and cached preview; reconnect uploads/saves but never sends");
    setText("/help"); await settle(); assert(document.querySelector<HTMLButtonElement>(".send-button")!.disabled && document.body.textContent?.includes("Slash commands cannot include images"), "slash image guard"); setText(""); await settle();
    assert(!document.querySelector<HTMLButtonElement>(".send-button")!.disabled, "image-only send enabled"); form().requestSubmit(); await wait(() => calls.some(item => item.command.type === "session.prompt"), "controlled image-only submission");
    const sent = calls.find(item => item.command.type === "session.prompt")!; assert(sent.command.type === "session.prompt" && sent.command.text === "" && sent.command.attachments?.length === 3, "actual App sends exact image-only manifest");
    await wait(() => windowState.route.sessionId === "created", "matching marker navigation"); checks.push("production image-only send and authoritative marker UI under explicitly controlled admission; no provider/native execution");
    root.unmount(); await settle(); assert(liveUrls.size === 0, "all preview object URLs revoked on unmount"); root = createRoot(document.getElementById("root")!); root.render(<StrictMode><App/></StrictMode>); await wait(() => prompt(), "production remount"); click("New chat"); await wait(() => windowState.route.sessionId === null, "new scene route"); await removeAll(); await addFile(first, "picker"); await addFile(second, "drop"); await wait(() => chips().length === 2 && chips().every(item => item.querySelector("img")?.complete), "remounted cache open and final previews"); checks.push("all object URLs revoked, full App remount and actual persistent cache reopen");
    await wait(() => !document.querySelector(".composer-footnote")?.textContent?.trim(), "final draft saved before visual capture");
    return { passed: true, checks, providerRequests: 0, nativeAdmission: false, nativeOSFilePicker: false, calls: calls.map(item => ({ id: item.id, type: item.command.type, ...(item.command.type === "session.prompt" ? { draft: item.command.draft, attachmentIds: item.command.attachments?.map(ref => ref.id) } : {}) })), uploads: uploads.length };
  },
  attachmentUIGeometry: async () => {
    await document.fonts.ready; await settle();
    const composer = form().getBoundingClientRect(), list = document.querySelector(".composer-image-list")!.getBoundingClientRect();
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const composerStyle = style(".composer"), headerStyle = style(".main-header"), sidebarStyle = style(".sidebar");
    const bounds = chips().map(item => { const box = item.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right }; });
    const controls = [...document.querySelectorAll<HTMLElement>(".composer-toolbar button, .composer-toolbar select")].map(element => { const box = element.getBoundingClientRect(); return { label: element.getAttribute("aria-label"), x: box.x, right: box.right, y: box.y, bottom: box.bottom, width: box.width, height: box.height }; });
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, cornerShapeSupported: CSS.supports("corner-shape", "superellipse(1.5)"),
      composer: { x: composer.x, y: composer.y, width: composer.width, height: composer.height }, list: { x: list.x, width: list.width }, chips: bounds, controls,
      styling: { composerSurface: composerStyle.backgroundColor, composerRadius: composerStyle.borderRadius, composerCorner: composerStyle.getPropertyValue("corner-shape"), composerBorder: composerStyle.borderWidth, composerShadow: composerStyle.boxShadow, sidebarSurface: sidebarStyle.backgroundColor, sidebarDivider: sidebarStyle.borderRightWidth, sidebarDividerColor: sidebarStyle.borderRightColor, headerDivider: headerStyle.borderBottomWidth, headerDividerColor: headerStyle.borderBottomColor, savedFooterHeight: document.querySelector(".composer-footnote")!.getBoundingClientRect().height, sendWidth: style(".send-button").width, sendIconWidth: style(".send-button .icon").width },
      fitting: bounds.every(box => box.x >= composer.x && box.right <= composer.right) && controls.every(box => box.x >= composer.x && box.right <= composer.right && box.width > 0) && composer.bottom <= innerHeight,
      errors: [...document.querySelectorAll('[role="alert"]')].map(item => item.textContent),
    };
  },
});
