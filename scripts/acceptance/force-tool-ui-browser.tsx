import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ForceToolControl } from "../../apps/desktop/src/renderer/ForceToolControl";
import type { ForceToolPorts, ForceToolSnapshot } from "../../apps/desktop/src/renderer/force-tool-state";
import "../../apps/desktop/src/renderer/styles.css";

// Production component with controlled owner ports. No native/provider/App claim.
const owner = { hostId: "work-owner", sessionId: "conversation-1" };
let draft = "Inspect the implementation", connected = true;
let native: ForceToolSnapshot = { epoch: "worker-1", revision: 1, nativeSessionId: "native-1", model: { provider: "openai-codex", id: "controlled-model", api: "openai-codex-responses" },
  availability: { state: "supported", reason: "Controlled native capability snapshot." },
  tools: [{ name: "read", available: true }, { name: "write", available: true }], directives: [], canArm: true, canCancel: true };
const writes: unknown[] = [];
const ports: ForceToolPorts = {
  read: async () => ({ protocolVersion: 1, ...owner, value: structuredClone(native) }),
  insertDraft: (_owner, insertion) => { if (insertion.expectedDraftText !== draft) throw new Error("Draft changed"); writes.push(insertion); draft = insertion.text; render(); },
  cancel: async (_owner, request) => { if (request.epoch !== native.epoch || request.expectedRevision !== native.revision) throw new Error("Stale ticket"); writes.push(request); native = { ...native, revision: native.revision + 1, directives: native.directives.filter(item => item.id !== request.directiveId) }; return structuredClone(native); },
  recoverPrompt: async () => { throw new Error("No recovery fixture is armed"); },
};
const main = document.createElement("main"); main.style.cssText = "padding:24px;width:min(100%,520px);box-sizing:border-box"; document.body.append(main);
const outside = document.createElement("button"); outside.type = "button"; outside.textContent = "Outside force tool"; document.body.append(outside);
const root = createRoot(main);
function render() { flushSync(() => root.render(<StrictMode><ForceToolControl owner={owner} ports={ports} connected={connected} active draftText={draft}/></StrictMode>)); }
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
const requireValue = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
const trigger = () => main.querySelector<HTMLButtonElement>(".composer-selection-trigger")!;
const button = (text: string) => [...main.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text)!;
const input = () => main.querySelector<HTMLTextAreaElement>("textarea")!;
const select = () => main.querySelector<HTMLSelectElement>("select")!;
async function open() { if (trigger().getAttribute("aria-expanded") !== "true") trigger().click(); await settle(); }
Object.assign(globalThis, {
  runForceToolUiAcceptance: async () => {
    const checks: string[] = []; render(); await settle(); await open();
    requireValue(document.activeElement === select(), "Native tool select receives focus");
    select().value = "read"; select().dispatchEvent(new Event("change", { bubbles: true })); await settle();
    requireValue(!button("Add to composer").disabled, "Selecting an active tool enables draft preparation");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), "Keep my optional edit"); input().dispatchEvent(new Event("input", { bubbles: true })); await settle();
    requireValue(writes.length === 0, "Selection/input never sends or mutates queue");
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true })); outside.focus(); await settle();
    requireValue(trigger().getAttribute("aria-expanded") === "false" && document.activeElement === outside, "Outside pointer closes without stealing clicked focus");
    await open(); requireValue(input().value === "Keep my optional edit", "Outside dismissal retains optional prompt");
    document.body.tabIndex = -1; document.body.focus();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true })); await settle();
    requireValue(trigger().getAttribute("aria-expanded") === "true" && document.activeElement === document.body, "Body IME Escape preserves panel and focus");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await settle();
    requireValue(trigger().getAttribute("aria-expanded") === "false" && document.activeElement === trigger(), "Body Escape closes and returns trigger focus");
    await open(); requireValue(input().value === "Keep my optional edit", "Keyboard dismissal retains optional prompt");
    checks.push("outside pointer dismissal keeps clicked focus; body Escape restores trigger; IME Escape and optional prompt are retained");
    button("Add to composer").click(); await settle();
    requireValue(draft === "/force read Keep my optional edit" && writes.length === 1, "Exact native syntax enters the existing composer port");
    requireValue(document.activeElement === trigger() && trigger().getAttribute("aria-expanded") === "false", "Draft preparation closes and returns focus");
    checks.push("actual component DOM selection, optional input, draft-only insertion and focus return");
    await open(); native = { ...native, revision: 2, availability: { state: "degraded", reason: "Native provider downgrades named forcing to auto." } }; button("Refresh").click(); await settle();
    button("Review refreshed selection").click(); await settle();
    requireValue(main.textContent?.includes("Native forcing is limited") && !button("Add to composer").disabled, "Native-accepted degraded capability remains visible and usable after stale revision review");
    native = { ...native, revision: 3, availability: { state: "supported", reason: "Controlled native capability snapshot." }, directives: [{ id: "queued-1", toolName: "read", phase: "pending-tool", requeued: true }] }; button("Refresh").click(); await settle();
    requireValue(main.textContent?.includes("requeued by native OMP"), "Real snapshot phase is rendered");
    button("Remove").click(); await settle(); requireValue(native.directives.length === 0, "Cancellation uses supplied owner port");
    checks.push("degraded capability and pending queue cancellation");
    connected = false; render(); await settle(); requireValue(main.textContent?.includes("Offline · cached state") && button("Add to composer").disabled, "Offline edits remain readable without mutation");
    connected = true; render(); await settle(); checks.push("offline state and reconnection");
    return { passed: true, checks, evidence: "Production component in isolated Electron DOM with controlled ports and programmatic events; not integrated App, native provider, physical pointer or reference parity acceptance." };
  },
  showForceToolUiScene: async () => {
    connected = true; native = { ...native, revision: 4, directives: [{ id: "queued-1", toolName: "read", phase: "pending-tool", requeued: true }], availability: { state: "supported", reason: "This native model accepts named tool requests.", thinkingNote: "Native request policy remains authoritative." } };
    render(); await settle(); await open(); button("Refresh").click(); await settle();
    const panel = main.querySelector<HTMLElement>(".force-tool-panel")!, box = panel.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, panel: { x: box.x, y: box.y, width: box.width, height: box.height }, fits: box.left >= 0 && box.right <= innerWidth && panel.scrollWidth <= panel.clientWidth };
  },
});
