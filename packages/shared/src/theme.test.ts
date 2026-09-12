import { expect, test } from "bun:test";
import { parsePreferenceChange } from "./preferences";
import { parseThemeDocument } from "./theme";

const base = { mode: "dark", tokens: { "--sidebar-surface": "#393939" }, background: { kind: "none" } } as const;

test("v1 themes migrate native opacity from material without changing their tokens", () => {
  expect(parseThemeDocument({ version: 1, material: "none", ...base })).toEqual({ version: 2, material: "none", opaqueWindows: true, ...base });
  for (const material of ["sidebar", "under-window", "hud"] as const) expect(parseThemeDocument({ version: 1, material, ...base })).toEqual({ version: 2, material, opaqueWindows: false, ...base });
});

test("v2 themes require an explicit opaqueWindows boolean", () => {
  expect(parseThemeDocument({ version: 2, material: "none", opaqueWindows: false, ...base }).opaqueWindows).toBe(false);
  expect(parseThemeDocument({ version: 2, material: "hud", opaqueWindows: true, ...base }).opaqueWindows).toBe(true);
  expect(() => parseThemeDocument({ version: 2, material: "none", ...base })).toThrow();
  expect(() => parseThemeDocument({ version: 2, material: "none", opaqueWindows: "false", ...base })).toThrow();
  expect(parsePreferenceChange({ key: "theme.opaqueWindows", value: true })).toMatchObject({ value: true });
  expect(() => parsePreferenceChange({ key: "theme.opaqueWindows", value: 1 })).toThrow();
});
