import { parsePreferenceChange, type ThemeBackground, type ThemeTokens } from "./preferences";

export interface ThemeDocument {
  version: 1;
  mode: "system" | "light" | "dark";
  material: "none" | "sidebar" | "under-window" | "hud";
  tokens: ThemeTokens;
  background: ThemeBackground;
}
export interface ThemeState { document: ThemeDocument; revision: string; filePath: string; fileError?: string }
export interface WindowThemeEffects { material: ThemeDocument["material"]; backgroundColor: string }
export interface ThemeAsset { sha256: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; bytes: number }
export const DEFAULT_THEME: ThemeDocument = { version: 1, mode: "system", material: "none", tokens: {}, background: { kind: "none" } };

export function parseThemeDocument(input: unknown): ThemeDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A theme document must be an object.");
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || Object.keys(value).some(key => !["version", "mode", "material", "tokens", "background"].includes(key))) throw new Error("Unsupported theme document version or field.");
  const mode = parsePreferenceChange({ key: "theme.mode", value: value.mode });
  const material = parsePreferenceChange({ key: "theme.material", value: value.material ?? "none" });
  const tokens = parsePreferenceChange({ key: "theme.tokens", value: value.tokens });
  const background = parsePreferenceChange({ key: "theme.background", value: value.background });
  if (mode.deleted || material.deleted || tokens.deleted || background.deleted) throw new Error("Invalid theme values.");
  return { version: 1, mode: mode.value as ThemeDocument["mode"], material: material.value as ThemeDocument["material"], tokens: tokens.value as ThemeTokens, background: background.value as ThemeBackground };
}
