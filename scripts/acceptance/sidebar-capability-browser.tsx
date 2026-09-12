import { useEffect, useMemo, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopBridge } from "../../packages/shared/src/protocol";
import { DEFAULT_THEME, type ThemeDocument, type ThemeState } from "../../packages/shared/src/theme";
import { ThemeSettings } from "../../apps/desktop/src/renderer/ThemeSettings";
import { ThemeEditor, type ThemeStorage } from "../../apps/desktop/src/renderer/theme-state";
import { PreferencesState } from "../../apps/desktop/src/renderer/preferences-state";
import type { OfflineCache } from "../../apps/desktop/src/renderer/offline-cache";
import { ThemeImageState } from "../../apps/desktop/src/renderer/theme-image-state";
import type { DraftCache } from "../../apps/desktop/src/renderer/drafts";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const runtimeErrors: string[] = [], saves: Array<{ expectedRevision: string; document: ThemeDocument }> = [], calls: string[] = [];
let saved: ThemeState = { revision: "theme-1", filePath: "/controlled/theme.json", document: { ...structuredClone(DEFAULT_THEME), material: "sidebar", opaqueWindows: false } };
const themeStorage: ThemeStorage = {
  async getTheme() { calls.push("theme.get"); return structuredClone(saved); },
  async setTheme(document, expectedRevision) {
    calls.push("theme.set"); saves.push({ expectedRevision, document: structuredClone(document) });
    if (expectedRevision !== saved.revision) throw new Error("Controlled revision mismatch");
    saved = { revision: `theme-${saves.length + 1}`, filePath: saved.filePath, document: structuredClone(document) };
    return structuredClone(saved);
  },
};
const values = new Map<string, string>();
const receipts: DraftCache = { read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, value); } };
const cache: OfflineCache = { async read(key) { calls.push(`cache.read:${key}`); return values.get(key) ?? null; }, async write(key, value) { calls.push(`cache.write:${key}`); values.set(key, value); } };
const preferenceBridge = {
  async getPreferences() { calls.push("preferences.get"); return { version: 1 as const, records: [] }; },
  async command() { calls.push("preferences.command"); throw new Error("Preference writes are outside this fixture"); },
  subscribe() { return () => {}; },
} satisfies Pick<DesktopBridge, "getPreferences" | "command" | "subscribe">;
const imageBridge = { async getThemeBackground() { calls.push("image.get"); return null; } } satisfies Pick<DesktopBridge, "getThemeBackground">;
const theme = new ThemeEditor(themeStorage, receipts), preferences = new PreferencesState(preferenceBridge, cache, receipts), image = new ThemeImageState(imageBridge);
let setCapability: (supported: boolean) => void = () => {};

window.addEventListener("error", event => runtimeErrors.push(`${event.message}\n${event.error?.stack ?? ""}`));
window.addEventListener("unhandledrejection", event => runtimeErrors.push(String(event.reason?.stack ?? event.reason)));

function Fixture() {
  const [, redraw] = useReducer(value => value + 1, 0), [supported, setSupported] = useState(false);
  setCapability = setSupported;
  useMemo(() => { void preferences.restore(); }, []);
  useEffect(() => { const offTheme = theme.subscribe(redraw), offPreferences = preferences.subscribe(redraw), offImage = image.subscribe(redraw); void theme.refresh(); return () => { offTheme(); offPreferences(); offImage(); }; }, []);
  return <main className="main-pane settings-open controlled-sidebar-capability">
    <ThemeSettings backdropSupported={supported} data={theme} preferences={preferences} fonts={["SF Mono", "Menlo"]} effectsError={supported ? "Controlled effective window fallback is active." : undefined} image={image} onImportImage={async () => { calls.push("import"); return null; }} onOpenFile={async () => { calls.push("open-file"); }} onRefreshFonts={() => calls.push("fonts.refresh")} onClose={() => calls.push("close")}/>
  </main>;
}

document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture/>);
const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter(node => node.getClientRects().length);
Object.assign(window, {
  capability(value: boolean) { setCapability(value); },
  target(selector: string, label?: string, index = 0) { const node = visible(selector).filter(item => label === undefined || item.textContent?.trim() === label || item.getAttribute("aria-label") === label)[index]; if (!node) throw new Error(`Missing ${selector} ${label ?? ""}`); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; },
  state() {
    const switchControl = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Translucent sidebar"]'), material = [...document.querySelectorAll<HTMLSelectElement>("select")].find(node => node.parentElement?.textContent?.includes("macOS window material")), save = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Save theme");
    return {
      supported: !switchControl?.disabled,
      switch: switchControl && { checked: switchControl.ariaChecked, disabled: switchControl.disabled, rect: switchControl.getBoundingClientRect().toJSON() },
      material: material && { value: material.value, disabled: material.disabled, rect: material.getBoundingClientRect().toJSON() },
      save: save && { disabled: save.disabled, text: save.textContent, rect: save.getBoundingClientRect().toJSON() },
      notice: document.body.innerText.includes("Native window material is unavailable on this desktop."),
      fallback: document.body.innerText.includes("Controlled effective window fallback is active."),
      dirty: theme.dirty, loading: theme.loading, saving: theme.saving, current: theme.current && structuredClone(theme.current), draft: structuredClone(theme.draft), preview: structuredClone(theme.preview), saves: structuredClone(saves), calls: [...calls], runtimeErrors: [...runtimeErrors], active: document.activeElement?.outerHTML,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, controls: visible("button,select").map(node => ({ tag: node.tagName, text: node.textContent?.trim(), label: node.getAttribute("aria-label"), role: node.getAttribute("role"), checked: node.getAttribute("aria-checked"), disabled: (node as HTMLButtonElement).disabled })),
    };
  },
});

