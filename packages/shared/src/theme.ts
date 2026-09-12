import { defaultAppearance, parseAppearance, type Appearance } from "./appearance";
import { parsePreferenceChange, type ThemeBackground, type ThemeTokens } from "./preferences";

export interface ThemeDocument {
  version: 2;
  appearance?: Appearance;
  mode: "system" | "light" | "dark";
  material: "none" | "sidebar" | "under-window" | "hud";
  opaqueWindows: boolean;
  tokens: ThemeTokens;
  background: ThemeBackground;
}
export interface ThemeState { document: ThemeDocument; revision: string; filePath: string; fileError?: string }
export interface WindowThemeEffects { material: ThemeDocument["material"]; backgroundColor: string; opaqueWindows: boolean }
export interface ThemeAsset { sha256: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; bytes: number }
export const DEFAULT_THEME: ThemeDocument = { version: 2, mode: "system", material: "none", opaqueWindows: false, tokens: {}, background: { kind: "none" } };

export function parseThemeDocument(input: unknown): ThemeDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A theme document must be an object.");
  const value = input as Record<string, unknown>;
  if (![1, 2].includes(value.version as number) || Object.keys(value).some(key => !["version", "mode", "material", "opaqueWindows", "tokens", "background", "appearance"].includes(key))) throw new Error("Unsupported theme document version or field.");
  if (value.version === 1 && "opaqueWindows" in value) throw new Error("Unsupported theme document version or field.");
  if (value.version === 2 && typeof value.opaqueWindows !== "boolean") throw new Error("A v2 theme document requires opaqueWindows to be a boolean.");
  const mode = parsePreferenceChange({ key: "theme.mode", value: value.mode });
  const material = parsePreferenceChange({ key: "theme.material", value: value.material ?? "none" });
  const tokens = parsePreferenceChange({ key: "theme.tokens", value: value.tokens });
  const background = parsePreferenceChange({ key: "theme.background", value: value.background });
  if (mode.deleted || material.deleted || tokens.deleted || background.deleted) throw new Error("Invalid theme values.");
  return { ...(value.appearance === undefined ? {} : { appearance: parseAppearance(value.appearance) }), version: 2, mode: mode.value as ThemeDocument["mode"], material: material.value as ThemeDocument["material"], opaqueWindows: value.version === 1 ? material.value === "none" : value.opaqueWindows as boolean, tokens: tokens.value as ThemeTokens, background: background.value as ThemeBackground };
}

/** Initialize both variants without silently discarding the existing v1/v2 profile. */
export function appearanceFromTheme(document: ThemeDocument): Appearance {
  if (document.appearance) return structuredClone(document.appearance);
  const appearance = defaultAppearance();
  for (const variant of [appearance.light, appearance.dark]) {
    variant.opaqueWindows = document.opaqueWindows;
    for (const [field, token] of [["surface", "--app-surface"], ["ink", "--text"], ["accent", "--accent"]] as const) {
      const value = document.tokens[token]; if (value && /^#[0-9a-f]{6}$/i.test(value)) variant[field] = value;
    }
    variant.fonts.ui.family = document.tokens["--ui-font"] ?? null;
    variant.fonts.code.family = document.tokens["--code-font"] ?? null;
  }
  return appearance;
}
