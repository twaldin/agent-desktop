import { describe, expect, test } from "bun:test";
import { APPEARANCE_PRESETS, defaultAppearance, defaultChromeTheme, parseAppearance } from "../../../../packages/shared/src/appearance";
import { DEFAULT_THEME, parseThemeDocument } from "../../../../packages/shared/src/theme";
import { availablePresets, exportAppearanceTheme, importAppearanceTheme, presetChromeTheme, themeRegistration } from "./appearance-presets";
import { themePresentation } from "./theme-application";
import { THEME_TOKEN_DEFINITIONS } from "../../../../packages/shared/src/preferences";

describe("Appearance palette and code theme contract", () => {
  test("every pinned preset variant has a complete registration and usable palette", () => {
    let count = 0;
    for (const variant of ["light", "dark"] as const) for (const [id] of availablePresets(variant)) {
      const registration = themeRegistration(id, variant), palette = presetChromeTheme(id, variant, defaultChromeTheme(variant));
      expect(registration.type).toBe(variant); expect(registration.colors?.["editor.background"]).toBeDefined();
      expect(registration.tokenColors?.length || registration.settings?.length).toBeGreaterThan(0);
      expect(palette.codeThemeId).toBe(id); expect(importAppearanceTheme(exportAppearanceTheme(palette, variant), variant)).toEqual(palette);
      count++;
    }
    expect(APPEARANCE_PRESETS).toHaveLength(28); expect(count).toBe(43);
    expect(() => themeRegistration("dracula", "light")).toThrow("no light variant");
  });
  test("share import preserves real local faces and accepts percent-encoded pinned format", () => {
    const palette = defaultChromeTheme("dark");
    palette.fonts.code = { family: '"Menlo"', face: { family: "Menlo", fullName: "Menlo Bold", postscriptName: "Menlo-Bold" } };
    const text = exportAppearanceTheme(palette, "dark");
    expect(text.startsWith("codex-theme-v1:")).toBe(true);
    expect(importAppearanceTheme(`codex-theme-v1:${encodeURIComponent(text.slice(15))}`, "dark")).toEqual(palette);
    expect(() => importAppearanceTheme(text, "light")).toThrow("light theme");
    const bad = JSON.parse(text.slice(15)); bad.theme.fonts.codeFace.postscriptName = 'url(/private/font)';
    expect(() => importAppearanceTheme(`codex-theme-v1:${JSON.stringify(bad)}`, "dark")).toThrow("file path or URL");
  });
  test("separate variants change actual app and code styling while legacy v2 remains unchanged", () => {
    const appearance = defaultAppearance(); appearance.dark = presetChromeTheme("dracula", "dark", appearance.dark);
    appearance.light.fonts.content.family = '"Georgia"';
    const document = parseThemeDocument({ ...DEFAULT_THEME, appearance });
    const dark = themePresentation(document, "dark"), light = themePresentation(document, "light");
    expect(dark.styles["--app-surface"]).toBe("#282a36"); expect(light.styles["--app-surface"]).toBe("#ffffff");
    expect(light.styles["--content-font"]).toBe('"Georgia"'); expect(dark.styles["--content-font"]).toBeUndefined();
    for (const key of Object.keys(dark.styles)) expect(Object.hasOwn(THEME_TOKEN_DEFINITIONS, key)).toBe(true);
    expect(themePresentation(DEFAULT_THEME, "dark").styles).toEqual({});
    const overridden = themePresentation({ ...document, tokens: { "--editor-surface": "#123456" } }, "dark");
    expect(overridden.styles["--editor-surface"]).toBe("#123456");
  });
  test("invalid palette values never become executable styles and parsed state has no caller ownership", () => {
    const original = defaultAppearance(); const parsed = parseAppearance(original);
    original.dark.accent = "#111111"; expect(parsed.dark.accent).toBe("#339cff");
    parsed.light.fonts.ui.family = "serif"; expect(original.light.fonts.ui.family).toBeNull();
    expect(() => parseAppearance({ ...original, dark: { ...original.dark, contrast: 100.1 } })).toThrow();
    expect(() => parseAppearance({ ...original, light: { ...original.light, surface: "url(https://example.invalid)" } })).toThrow();
  });
});
