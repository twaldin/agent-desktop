import { useEffect, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeSettings } from "../../apps/desktop/src/renderer/ThemeSettings";
import { ThemeEditor, type ThemeStorage } from "../../apps/desktop/src/renderer/theme-state";
import { ThemeImageState } from "../../apps/desktop/src/renderer/theme-image-state";
import { PreferencesState } from "../../apps/desktop/src/renderer/preferences-state";
import { applyTheme } from "../../apps/desktop/src/renderer/theme-application";
import { loadThemeFonts } from "../../apps/desktop/src/renderer/theme-fonts";
import { ReviewDiff, ReviewDiffs } from "../../apps/desktop/src/renderer/ReviewDiff";
import { parseReviewPatch, DEFAULT_REVIEW_OPTIONS } from "../../apps/desktop/src/renderer/review-model";
import { PierreSourceEditor } from "../../apps/desktop/src/renderer/PierreSourceEditor";
import type { LocalFontFace } from "../../packages/shared/src/appearance";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

declare global { interface Window { fixtureEndpoint: string } }
async function request(path: string, body?: unknown) {
  const response = await fetch(window.fixtureEndpoint + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
}
const storage: ThemeStorage = { getTheme: () => request("/theme"), setTheme: (document, expectedRevision) => request("/theme", { document, expectedRevision }) };
const theme = new ThemeEditor(storage), image = new ThemeImageState({ getThemeBackground: async () => null });
const preferences = new PreferencesState({ getPreferences: async () => ({ version: 1, records: [] }), command: async () => { throw new Error("Fixture does not mutate unrelated preferences"); }, subscribe: () => () => {} }, { read: async () => null, write: async () => {} }, { read: () => null, write() {} });
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message)); window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
let capability: (value: boolean) => void;
const diff = parseReviewPatch(["diff --git a/theme.ts b/theme.ts", "--- a/theme.ts", "+++ b/theme.ts", "@@ -1 +1 @@", "-const greeting = 'old';", "+const greeting = 'hello';"].join("\n"), "appearance-preset-diff").files[0]!;
let text = "const greeting = 'hello';\nconsole.log(greeting);\n";
function Fixture() {
  const [, redraw] = useReducer(value => value + 1, 0), [supported, setSupported] = useState(true), [faces, setFaces] = useState<LocalFontFace[]>([]), [contents, setContents] = useState(text), [fontError, setFontError] = useState<string>();
  capability = setSupported; text = contents;
  useEffect(() => { const off = theme.subscribe(redraw); void theme.refresh(); void request("/fonts").then(setFaces).catch(error => setFontError(String(error))); return off; }, []);
  useEffect(() => {
    let live = true;
    const update = () => { applyTheme(theme.preview); const appearance = theme.preview.appearance; if (appearance) { const variant = document.documentElement.dataset.resolvedTheme === "dark" ? "dark" : "light"; void loadThemeFonts(Object.values(appearance[variant].fonts)).catch(error => { if (live) setFontError(String(error)); }); } };
    update(); const media = matchMedia("(prefers-color-scheme: dark)"); media.addEventListener("change", update); return () => { live = false; media.removeEventListener("change", update); };
  }, [theme.preview]);
  return <main className="appearance-fixture"><div className="appearance-fixture-settings"><ThemeSettings data={theme} preferences={preferences} image={image} backdropSupported={supported} fonts={[...new Set(faces.map(face => face.family))]} fontFaces={faces} fontsError={fontError} onImportImage={async () => null} onOpenFile={async () => {}} onRefreshFonts={() => {}} onClose={() => {}}/></div><aside aria-label="Live editor preview"><h2>Open file</h2><PierreSourceEditor documentKey="same-open-file" name="theme.ts" value={contents} label="Theme source editor" onChange={setContents} onSave={() => {}}/><section className="appearance-diff" aria-label="Live review preview"><ReviewDiffs options={DEFAULT_REVIEW_OPTIONS}><ReviewDiff file={diff} options={DEFAULT_REVIEW_OPTIONS}/></ReviewDiffs></section></aside></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
Object.assign(window, {
  theme, request, capability: (value: boolean) => capability(value),
  snapshot() { return { current: theme.current, preview: theme.preview, dirty: theme.dirty, saving: theme.saving, error: theme.error, conflict: theme.conflict, styles: document.documentElement.style.cssText, dataset: { ...document.documentElement.dataset }, text, errors, diffColors: Array.from(document.querySelector(".appearance-diff diffs-container")?.shadowRoot?.querySelectorAll("span") ?? []).filter(node => node.textContent?.trim()).map(node => ({ text: node.textContent, color: getComputedStyle(node).color })), alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(node => node.textContent), fonts: Array.from(document.fonts).map(face => ({ family: face.family, status: face.status })) }; },
  point(selector: string) { const element = document.querySelector<HTMLElement>(selector); if (!element) throw new Error("Missing " + selector); element.scrollIntoView({ block: "center" }); const rect = element.getBoundingClientRect(); if (!rect.width || !rect.height) throw new Error("Hidden " + selector); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; },
});
