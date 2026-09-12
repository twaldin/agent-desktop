import { APPEARANCE_PRESETS, defaultChromeTheme, parseChromeTheme, type AppearancePreset, type ChromeTheme, type ThemeVariant } from "../../../../packages/shared/src/appearance";
import literals from "./appearance-presets.json";
import type { ThemeRegistration } from "@pierre/diffs";
interface Rule { scope?: string | string[]; settings?: { foreground?: string; background?: string; fontStyle?: string } }
interface PresetData { name: string; type?: ThemeVariant; colors: Record<string, string>; tokenColors?: Rule[]; settings?: Rule[]; chromeTheme?: Partial<ChromeTheme> & { fonts?: Record<string, string | null> } }
const presets = literals as unknown as Record<AppearancePreset, { label: string; light?: PresetData; dark?: PresetData }>;
export function themeRegistration(id: AppearancePreset, variant: ThemeVariant): ThemeRegistration {
  const data = presets[id]?.[variant]; if (!data) throw new Error(`That theme has no ${variant} variant.`);
  return { ...data, name: `agent-appearance-${id}-${variant}`, type: variant } as ThemeRegistration;
}
const rgb = (value: string) => [1, 3, 5].map(at => Number.parseInt(value.slice(at, at + 2), 16));
const distance = (a: string, b: string) => Math.sqrt(rgb(a).reduce((sum, component, index) => sum + (component - rgb(b)[index]!) ** 2, 0));
const range = (value: string) => Math.max(...rgb(value)) - Math.min(...rgb(value));
function color(value: unknown, minimumAlpha = .98, minimumRange = 0): string | undefined {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) return;
  if (value.length === 9 && Number.parseInt(value.slice(7), 16) / 255 < minimumAlpha || range(value) < minimumRange) return;
  return value.slice(0, 7).toLowerCase();
}
function hue(value: string): number | undefined {
  const [r, g, b] = rgb(value).map(value => value / 255) as [number, number, number];
  const max = Math.max(r, g, b), delta = max - Math.min(r, g, b); if (!delta) return;
  return ((max === r ? (g - b) / delta % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
}
export function presetChromeTheme(id: AppearancePreset, variant: ThemeVariant, current: ChromeTheme): ChromeTheme {
  const data = presets[id]?.[variant]; if (!data) throw new Error(`That theme has no ${variant} variant.`);
  const defaults = defaultChromeTheme(variant), rules = [...data.tokenColors ?? [], ...data.settings ?? []];
  const first = (keys: string[], alpha?: number, chromatic?: number) => keys.map(key => color(data.colors[key], alpha, chromatic)).find(Boolean);
  const surface = first(["editor.background", "sideBar.background", "editorGroupHeader.tabsBackground", "panel.background", "activityBar.background"]) ?? defaults.surface;
  const ink = first(["editor.foreground", "sideBarTitle.foreground", "sideBar.foreground", "foreground"]) ?? defaults.ink;
  const distinguishable = (value: string) => distance(value, surface) >= 42 && distance(value, ink) >= 42;
  const score = (value: string) => range(value) + distance(value, surface) / 4 + distance(value, ink) / 4;
  const ranked = rules.map(rule => color(rule.settings?.foreground, .45, 24)).filter((value): value is string => Boolean(value && distinguishable(value))).sort((a, b) => score(b) - score(a));
  const accent = ["activityBarBadge.background", "textLink.foreground", "editorCursor.foreground", "focusBorder", "button.background", "activityBar.activeBorder"].map(key => color(data.colors[key], .45, 24)).find(value => value && distinguishable(value)) ?? ranked[0] ?? defaults.accent;
  const candidates = [...new Set([...Object.values(data.colors), ...rules.map(rule => rule.settings?.foreground)].map(value => color(value, .45, 24)).filter((value): value is string => Boolean(value && distinguishable(value))))];
  const semantic = (keys: string[], min: number, max: number, target: number, fallback: string) => first(keys) ?? candidates.filter(value => { const h = hue(value); return h !== undefined && (min <= max ? h >= min && h <= max : h >= min || h <= max); }).sort((a, b) => {
    const rate = (value: string) => { const difference = Math.abs(hue(value)! - target); return score(value) - Math.min(difference, 360 - difference) * 2; }; return rate(b) - rate(a);
  })[0] ?? fallback;
  const seed = { ...current, codeThemeId: id, surface, ink, accent, semanticColors: {
    diffAdded: semantic(["gitDecoration.addedResourceForeground", "gitDecoration.untrackedResourceForeground", "terminal.ansiGreen", "terminal.ansiBrightGreen"], 80, 170, 125, defaults.semanticColors.diffAdded),
    diffRemoved: semantic(["gitDecoration.deletedResourceForeground", "terminal.ansiRed", "terminal.ansiBrightRed"], 345, 15, 0, defaults.semanticColors.diffRemoved),
    skill: semantic(["charts.purple", "terminal.ansiMagenta", "terminal.ansiBrightMagenta"], 210, 320, 265, distinguishable(accent) ? accent : defaults.semanticColors.skill),
  } };
  const custom = data.chromeTheme;
  if (custom) {
    for (const field of ["surface", "ink", "accent", "contrast", "opaqueWindows"] as const) if (custom[field] !== undefined) Object.assign(seed, { [field]: custom[field] });
    if (custom.semanticColors) seed.semanticColors = { ...seed.semanticColors, ...custom.semanticColors };
    if (custom.fonts) for (const role of ["ui", "content", "code"] as const) if (Object.hasOwn(custom.fonts, role)) seed.fonts = { ...seed.fonts, [role]: { family: custom.fonts[role] } };
  }
  return parseChromeTheme(seed, variant);
}
export function availablePresets(variant: ThemeVariant) { return APPEARANCE_PRESETS.filter(value => value[variant === "light" ? 2 : 3]); }
// The pinned app shares the palette and code-theme ID in this public text format.
export function exportAppearanceTheme(theme: ChromeTheme, variant: ThemeVariant): string {
  const { codeThemeId, fonts, ...palette } = parseChromeTheme(theme, variant);
  const nativeFonts: Record<string, unknown> = {};
  for (const role of ["ui", "content", "code"] as const) {
    nativeFonts[role] = fonts[role].family;
    if (fonts[role].face) nativeFonts[`${role}Face`] = fonts[role].face;
  }
  return `codex-theme-v1:${JSON.stringify({ codeThemeId, theme: { ...palette, accentSource: "custom", fonts: nativeFonts }, variant })}`;
}
export function importAppearanceTheme(value: string, variant: ThemeVariant): ChromeTheme {
  const prefix = "codex-theme-v1:", text = value.trim();
  if (text.length > 64 * 1024 || !text.startsWith(prefix)) throw new Error("Paste a Codex theme share string.");
  const encoded = text.slice(prefix.length);
  const parsed = JSON.parse(encoded.startsWith("{") ? encoded : decodeURIComponent(encoded));
  if (!parsed || parsed.variant !== variant || Object.keys(parsed).some(key => !["variant", "theme", "codeThemeId"].includes(key))) throw new Error(`Import a ${variant} theme into this card.`);
  const { fonts, accentSource, ...palette } = parsed.theme;
  if (accentSource !== undefined && !["chatgpt", "custom"].includes(accentSource)) throw new Error("Invalid theme accent source.");
  if (!fonts || Object.keys(fonts).some(key => !["ui", "content", "code", "uiFace", "contentFace", "codeFace"].includes(key))) throw new Error("Invalid theme fonts.");
  const selection = (role: string) => ({ family: fonts[role] ?? null, ...(fonts[`${role}Face`] ? { face: fonts[`${role}Face`] } : {}) });
  return parseChromeTheme({ ...palette, codeThemeId: parsed.codeThemeId, fonts: { ui: selection("ui"), content: selection("content"), code: selection("code") } }, variant);
}
