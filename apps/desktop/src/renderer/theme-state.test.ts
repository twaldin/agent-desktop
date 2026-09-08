import { describe, expect, test } from "bun:test";
import { DEFAULT_THEME, parseThemeDocument, type ThemeState } from "../../../../packages/shared/src/theme";
import { ThemeEditor, type ThemeStorage } from "./theme-state";
import { themePresentation } from "./theme-application";

const state = (revision: string, tokens = {}): ThemeState => ({ document: { ...structuredClone(DEFAULT_THEME), tokens }, revision, filePath: "/fixture/theme.json" });
function fixture() {
  let current = state("one"); const saves: { revision: string; document: unknown }[] = [];
  const storage: ThemeStorage = { getTheme: async () => structuredClone(current), setTheme: async (document, expectedRevision) => { saves.push({ revision: expectedRevision, document }); if (expectedRevision !== current.revision) throw new Error("The theme file changed"); current = { ...current, revision: `${current.revision}+`, document: parseThemeDocument(document) }; return structuredClone(current); } };
  return { storage, data: new ThemeEditor(storage), saves, setCurrent: (value: ThemeState) => { current = value; }, current: () => current };
}
describe("theme preview and saved-file revisions", () => {
  test("additional transcript syntax colors survive save/reload and reject executable values", async () => {
    const f = fixture(); await f.data.refresh();
    const tokens = { "--syntax-attribute": "#f9dc78", "--syntax-name": "#63a8f8", "--syntax-error": "#ff8583" };
    f.data.edit({ ...f.data.draft, tokens }); await f.data.save(); await f.data.refresh();
    expect(f.data.preview.tokens).toEqual(tokens); expect(f.current().document.tokens).toEqual(tokens);
    f.data.edit({ ...f.data.draft, tokens: { ...tokens, "--syntax-name": "url(https://invalid.example)" } });
    expect(f.data.validationError).toBeDefined(); expect(f.data.preview.tokens).toEqual(tokens);
  });
  test("invalid native field text is preserved while the previous valid preview remains active", async () => {
    const f = fixture(); await f.data.refresh(); f.data.edit({ ...f.data.draft, tokens: { "--radius": "18px" } });
    f.data.edit({ ...f.data.draft, tokens: { "--radius": "18" } });
    expect(f.data.draft.tokens["--radius"]).toBe("18"); expect(f.data.preview.tokens["--radius"]).toBe("18px"); expect(f.data.validationError).toContain("Invalid numeric"); await f.data.save(); expect(f.saves).toHaveLength(0);
  });
  test("a conflicting saved theme cannot replace edits until explicit resolution", async () => {
    const f = fixture(); await f.data.refresh(); f.data.edit({ ...f.data.draft, tokens: { "--radius": "22px" } }); f.setCurrent(state("two", { "--radius": "8px" })); await f.data.save();
    expect(f.data.draft.tokens["--radius"]).toBe("22px"); expect(f.data.conflict?.document.tokens["--radius"]).toBe("8px"); expect(f.current().document.tokens["--radius"]).toBe("8px");
    f.data.resolve("local"); await f.data.save(); expect(f.saves.at(-1)?.revision).toBe("two"); expect(f.current().document.tokens["--radius"]).toBe("22px"); expect(f.data.dirty).toBe(false);
  });
  test("edits made while a theme save is pending survive the accepted result", async () => {
    const f = fixture(); await f.data.refresh(); let resolve!: (value: ThemeState) => void; f.storage.setTheme = () => new Promise(done => { resolve = done; });
    f.data.edit({ ...f.data.draft, tokens: { "--radius": "20px" } }); const pending = f.data.save(); f.data.edit({ ...f.data.draft, tokens: { "--radius": "30px" } }); resolve(state("saved", { "--radius": "20px" })); await pending;
    expect(f.data.draft.tokens["--radius"]).toBe("30px"); expect(f.data.preview.tokens["--radius"]).toBe("30px"); expect(f.data.current?.document.tokens["--radius"]).toBe("20px"); expect(f.data.baseRevision).toBe("saved"); expect(f.data.dirty).toBe(true);
  });
  test("a stale read cannot regress a newer accepted save", async () => {
    const f = fixture(); await f.data.refresh(); let resolve!: (value: ThemeState) => void; f.storage.getTheme = () => new Promise(done => { resolve = done; }); const read = f.data.refresh();
    f.data.edit({ ...f.data.draft, mode: "dark" }); await f.data.save(); resolve(state("old")); await read; expect(f.data.current?.document.mode).toBe("dark"); expect(f.data.baseRevision).toBe("one+");
  });
  test("a stale failed read cannot label a newer accepted save as failed", async () => {
    const f = fixture(); await f.data.refresh(); let reject!: (reason: Error) => void; f.storage.getTheme = () => new Promise((_, fail) => { reject = fail; }); const read = f.data.refresh();
    f.data.edit({ ...f.data.draft, mode: "dark" }); await f.data.save(); reject(new Error("An obsolete connection failed")); await read;
    expect(f.data.current?.document.mode).toBe("dark"); expect(f.data.error).toBeUndefined();
  });
  test("matching the current saved file clears a resolved conflict without another write", async () => {
    const f = fixture(); await f.data.refresh(); f.data.edit({ ...f.data.draft, mode: "dark" }); f.setCurrent(state("two", { "--radius": "22px" })); await f.data.refresh(); expect(f.data.conflict).toBeDefined();
    f.data.edit(structuredClone(f.current().document)); expect(f.data.conflict).toBeUndefined(); expect(f.data.dirty).toBe(false); expect(f.data.baseRevision).toBe("two");
  });
  test("invalid file diagnostics retain the last valid document and baseline reset remains a draft", async () => {
    const f = fixture(); f.setCurrent({ ...state("one", { "--radius": "24px" }), fileError: "Theme JSON is malformed; last valid document retained" }); await f.data.refresh();
    expect(f.data.current?.fileError).toContain("malformed"); expect(f.data.preview.tokens["--radius"]).toBe("24px"); f.data.reset(); expect(f.data.draft).toEqual(DEFAULT_THEME); expect(f.data.dirty).toBe(true); expect(f.saves).toHaveLength(0);
  });
  test("background presentation uses validated colors and cannot turn a token into a network URL", () => {
    const doc = { ...DEFAULT_THEME, background: { kind: "gradient" as const, angle: 45, stops: [{ color: "#123456", position: 0 }, { color: "#abcdef", position: 1 }] } };
    expect(themePresentation(doc).styles["--theme-background-image"]).toBe("linear-gradient(45deg, #123456 0%, #abcdef 100%)");
    expect(() => themePresentation({ ...DEFAULT_THEME, tokens: { "--app-surface": "url(https://example.invalid)" } })).toThrow();
    expect(() => themePresentation({ ...DEFAULT_THEME, tokens: { "--ui-font": "url(/private/font)" } })).toThrow();
  });
});
