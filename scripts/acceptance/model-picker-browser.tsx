import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ModelPicker } from "../../apps/desktop/src/renderer/ModelPicker";
import type { ModelPickerOption } from "../../apps/desktop/src/renderer/model-picker";

// Production component in an actual Electron DOM. Controlled catalog; no provider claim.
const checks: string[] = [];
const requireValue = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
const container = document.createElement("main"); document.body.append(container); const root = createRoot(container);
const options: ModelPickerOption[] = [
  { value: "", label: "Follow current session model and reasoning" },
  ...Array.from({ length: 4900 }, (_, index) => ({ value: `provider-${index}/model-${index}`, label: `Model ${index}`, provider: `provider-${index}`, detail: `model-${index} · 1,000,000 context`, disabled: index === 4898 })),
  { value: "duplicate-provider/same-model", label: "Model 4899", provider: "duplicate-provider", detail: "Separate provider identity" },
];
let current = options[4900]!.value, disabled = false, writes: string[] = [];
function render() { flushSync(() => root.render(<ModelPicker label="Model" value={current} options={options} disabled={disabled} onChange={value => { writes.push(value); current = value; render(); }}/>)); }
const trigger = () => container.querySelector<HTMLButtonElement>(".model-picker-trigger")!;
const search = () => document.querySelector<HTMLInputElement>('[aria-label="Search models"]')!;
const type = async (text: string) => { const input = search(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); await settle(); };
const key = async (value: string, composing = false) => { search().dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, isComposing: composing })); await settle(); };
const open = async () => { trigger().click(); await settle(); requireValue(document.querySelector("dialog[open]"), "Native dialog opens"); requireValue(document.activeElement === search(), "Search receives focus"); };

Object.assign(globalThis, {
  runModelPickerAcceptance: async () => {
    render(); await open();
    requireValue(document.querySelectorAll('[role="option"]').length === 100, "Large selected catalog opens bounded page");
    requireValue(document.querySelector('[role="option"]')?.getAttribute("aria-selected") === "true", "Current model remains first and checked");
    requireValue(document.querySelector('[role="status"]')?.textContent?.includes("4,902"), "Full catalog count remains visible");
    (document.querySelector(".model-picker-more") as HTMLButtonElement).click(); await settle();
    requireValue(document.querySelectorAll('[role="option"]').length === 200, "Explicit paging retains access to remaining models"); checks.push("bounded initial catalog, selected row and paging");
    await type("model 4899"); requireValue(document.querySelectorAll('[role="option"]').length === 2, "Duplicate names retain both providers");
    await type("duplicate-provider 4899"); requireValue(document.querySelectorAll('[role="option"]').length === 1, "Search combines provider and identity");
    await key("Enter", true); requireValue(writes.length === 0, "IME composition cannot select a model");
    await key("Enter"); requireValue(writes.at(-1) === "duplicate-provider/same-model", "Exact selected provider identity delivered"); requireValue(document.activeElement === trigger(), "Selection returns focus"); checks.push("search, duplicate provider identity, IME and focus return");
    await open(); await type("provider-4898"); requireValue(document.querySelector('[role="option"]')?.getAttribute("aria-disabled") === "true", "Unavailable disabled option stays visible");
    const count = writes.length; await key("Enter"); (document.querySelector('[role="option"]') as HTMLElement).click(); await settle(); requireValue(writes.length === count, "Disabled item cannot submit through mouse or keyboard");
    await type("absolutely nonexistent model"); requireValue(document.querySelectorAll('[role="option"]').length === 0, "Empty search has no stale option"); await key("Enter"); requireValue(writes.length === count, "Empty search cannot submit prior active row"); checks.push("disabled and empty search preserve selection");
    await type("model 489"); await key("ArrowDown"); const active = document.getElementById(search().getAttribute("aria-activedescendant")!); requireValue(active && active.getAttribute("aria-disabled") !== "true", "Keyboard active row is selectable and present");
    const cancel = new Event("cancel", { cancelable: true }); document.querySelector("dialog")!.dispatchEvent(cancel); await settle(); requireValue(!document.querySelector("dialog[open]") && document.activeElement === trigger(), "Escape cancellation closes and restores focus"); checks.push("keyboard active descendant and cancellation");
    await open(); disabled = true; render(); await settle(); requireValue(!document.querySelector("dialog[open]") && trigger().disabled, "Disconnect disables trigger and dismisses picker"); disabled = false; render();
    await open(); await type("Follow current"); await key("Enter"); requireValue(writes.at(-1) === "", "Native default is a real selectable empty identity"); checks.push("disconnect and follow-current selection");
    return { passed: true, checks, source: "Actual Electron DOM with production ModelPicker and controlled catalog; programmatic DOM events, not native pointer/provider acceptance", viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, userAgent: navigator.userAgent };
  },
  showModelPickerScene: async () => {
    current = options[4900]!.value; disabled = false; render(); await open(); await type("model 489");
    const panel = document.querySelector("dialog")!.getBoundingClientRect();
    requireValue(panel.left >= 0 && panel.top >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight, "Picker stays within actual viewport");
    return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, panel: { x: panel.x, y: panel.y, width: panel.width, height: panel.height }, optionCount: document.querySelectorAll('[role="option"]').length };
  },
});
