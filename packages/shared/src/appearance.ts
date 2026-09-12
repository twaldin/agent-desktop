export type ThemeVariant = "light" | "dark";
export const APPEARANCE_PRESETS = [
  ["absolutely", "Absolutely", "absolutely-light", "absolutely-dark"], ["ayu", "Ayu", null, "ayu-dark"],
  ["catppuccin", "Catppuccin", "catppuccin-latte", "catppuccin-mocha"], ["codex", "Codex", "codex-light", "codex-dark"],
  ["dracula", "Dracula", null, "dracula"], ["everforest", "Everforest", "everforest-light", "everforest-dark"],
  ["github", "GitHub", "github-light-default", "github-dark-default"], ["gruvbox", "Gruvbox", "gruvbox-light-medium", "gruvbox-dark-medium"],
  ["linear", "Linear", "linear-light", "linear-dark"], ["lobster", "Lobster", null, "lobster-dark"],
  ["material", "Material", null, "material-theme-darker"], ["matrix", "Matrix", null, "matrix-dark"],
  ["monokai", "Monokai", null, "monokai"], ["night-owl", "Night Owl", null, "night-owl"], ["nord", "Nord", null, "nord"],
  ["notion", "Notion", "notion-light", "notion-dark"], ["one", "One", "one-light", "one-dark-pro"], ["oscurange", "Oscurange", null, "oscurange"],
  ["proof", "Proof", "proof-light", null], ["raycast", "Raycast", "raycast-light", "raycast-dark"],
  ["rose-pine", "Rose Pine", "rose-pine-dawn", "rose-pine-moon"], ["sentry", "Sentry", null, "sentry-dark"],
  ["solarized", "Solarized", "solarized-light", "solarized-dark"], ["temple", "Temple", null, "temple-dark"], ["tokyo-night", "Tokyo Night", null, "tokyo-night"],
  ["vercel", "Vercel", "vercel-light", "vercel-dark"], ["vscode-plus", "VS Code Plus", "light-plus", "dark-plus"], ["xcode", "Xcode", "xcode-light", "xcode-dark"],
] as const;
export type AppearancePreset = typeof APPEARANCE_PRESETS[number][0];
export interface ThemeFontFace { family: string; fullName: string; postscriptName: string }
export interface LocalFontFace extends ThemeFontFace { styleName: string; isMonospaced: boolean }
export interface AppearanceFont { family: string | null; face?: ThemeFontFace }
export interface ChromeTheme {
  codeThemeId: AppearancePreset;
  accent: string; surface: string; ink: string; contrast: number; opaqueWindows: boolean;
  fonts: { ui: AppearanceFont; content: AppearanceFont; code: AppearanceFont };
  semanticColors: { diffAdded: string; diffRemoved: string; skill: string };
}
export interface Appearance {
  light: ChromeTheme; dark: ChromeTheme;
  fontSmoothing: boolean; pointerCursors: boolean; reducedMotion: "system" | "on" | "off";
}
const font = (): AppearanceFont => ({ family: null });
export function defaultChromeTheme(variant: ThemeVariant): ChromeTheme {
  return { codeThemeId: "codex", accent: "#339cff", surface: variant === "dark" ? "#181818" : "#ffffff", ink: variant === "dark" ? "#ffffff" : "#1a1c1f", contrast: variant === "dark" ? 60 : 45, opaqueWindows: false,
    fonts: { ui: font(), content: font(), code: font() }, semanticColors: variant === "dark" ? { diffAdded: "#40c977", diffRemoved: "#fa423e", skill: "#ad7bf9" } : { diffAdded: "#00a240", diffRemoved: "#ba2623", skill: "#924ff7" } };
}
export function defaultAppearance(): Appearance { return { light: defaultChromeTheme("light"), dark: defaultChromeTheme("dark"), fontSmoothing: true, pointerCursors: false, reducedMotion: "system" }; }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid appearance fields.");
  return value as Record<string, unknown>;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("Appearance switch must be a boolean."); return value; }
function color(value: unknown): string { if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Choose a six-digit hexadecimal theme color."); return value.toLowerCase(); }
function fontName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500 || !/^[\p{L}\p{M}\p{N} +:_,.'"\-]+$/u.test(value) || /\burl\b/i.test(value)) throw new Error("A font name cannot contain a file path or URL.");
  return value;
}
export function parseThemeFontFace(value: unknown): ThemeFontFace {
  const item = object(value, ["family", "fullName", "postscriptName"]);
  return { family: fontName(item.family), fullName: fontName(item.fullName), postscriptName: fontName(item.postscriptName) };
}
function parseFont(value: unknown): AppearanceFont {
  const item = object(value, ["family", "face"]);
  const family = item.family === null ? null : fontName(item.family);
  const face = item.face === undefined ? undefined : parseThemeFontFace(item.face);
  if (face && (family === null || family.replace(/["']/g, "") !== face.family)) throw new Error("Choose a face from the selected font family.");
  return { family, ...(face ? { face } : {}) };
}
export function parseChromeTheme(value: unknown, variant: ThemeVariant): ChromeTheme {
  const item = object(value, ["codeThemeId", "accent", "surface", "ink", "contrast", "opaqueWindows", "fonts", "semanticColors"]);
  if (!APPEARANCE_PRESETS.some(preset => preset[0] === item.codeThemeId && preset[variant === "light" ? 2 : 3])) throw new Error(`That code theme is unavailable in ${variant} mode.`);
  if (!Number.isInteger(item.contrast) || Number(item.contrast) < 0 || Number(item.contrast) > 100) throw new Error("Theme contrast must be between 0 and 100.");
  const fonts = object(item.fonts, ["ui", "content", "code"]), semantic = object(item.semanticColors, ["diffAdded", "diffRemoved", "skill"]);
  return { codeThemeId: item.codeThemeId as AppearancePreset, accent: color(item.accent), surface: color(item.surface), ink: color(item.ink), contrast: item.contrast as number, opaqueWindows: boolean(item.opaqueWindows),
    fonts: { ui: parseFont(fonts.ui), content: parseFont(fonts.content), code: parseFont(fonts.code) }, semanticColors: { diffAdded: color(semantic.diffAdded), diffRemoved: color(semantic.diffRemoved), skill: color(semantic.skill) } };
}
export function parseAppearance(value: unknown): Appearance {
  const item = object(value, ["light", "dark", "fontSmoothing", "pointerCursors", "reducedMotion"]);
  if (!["system", "on", "off"].includes(item.reducedMotion as string)) throw new Error("Invalid reduced motion selection.");
  return { light: parseChromeTheme(item.light, "light"), dark: parseChromeTheme(item.dark, "dark"), fontSmoothing: boolean(item.fontSmoothing), pointerCursors: boolean(item.pointerCursors), reducedMotion: item.reducedMotion as Appearance["reducedMotion"] };
}
