import { expect, test } from "bun:test";
import { resolveWindowTheme } from "./window-theme";

const normal = { platform: "darwin", focused: true, width: 1440, height: 1000, scaleFactor: 2 };
const theme = { material: "none" as const, opaqueWindows: false, backgroundColor: "#181818" };

test("translucent macOS baseline uses native menu with transparent backing", () => {
  expect(resolveWindowTheme(theme, normal)).toEqual({ opaqueWindows: false, backgroundColor: "#00000000", vibrancy: "menu" });
  expect(resolveWindowTheme({ ...theme, material: "hud" }, normal).vibrancy).toBe("hud");
  expect(resolveWindowTheme({ ...theme, opaqueWindows: true, backgroundColor: "#abcdef" }, normal))
    .toEqual({ opaqueWindows: true, backgroundColor: "#abcdef", vibrancy: null });
});

test("focus and physical dimensions control the pinned primary-window fallback", () => {
  expect(resolveWindowTheme(theme, { ...normal, focused: false }).opaqueWindows).toBe(true);
  expect(resolveWindowTheme(theme, { ...normal, width: 1920, height: 1080 }).opaqueWindows).toBe(true);
  expect(resolveWindowTheme(theme, { ...normal, width: 1919, height: 1080 }).opaqueWindows).toBe(false);
  expect(resolveWindowTheme(theme, { ...normal, width: 1920, height: 1079 }).opaqueWindows).toBe(false);
  expect(resolveWindowTheme(theme, { ...normal, width: 1080, height: 1920 }).opaqueWindows).toBe(true);
  expect(resolveWindowTheme(theme, { ...normal, width: 1920, height: 1080, scaleFactor: 1 }).opaqueWindows).toBe(false);
  expect(resolveWindowTheme(theme, { ...normal, platform: "linux" }).vibrancy).toBeNull();
});

test("explicit alpha is preserved and missing or malformed native inputs are rejected", () => {
  expect(resolveWindowTheme({ material: "sidebar", opaqueWindows: true, backgroundColor: "#12345680" }, normal))
    .toEqual({ opaqueWindows: true, backgroundColor: "#80123456", vibrancy: null });
  expect(() => resolveWindowTheme({ ...theme, opaqueWindows: undefined as never }, normal)).toThrow("Invalid native window theme");
  expect(() => resolveWindowTheme({ ...theme, opaqueWindows: "false" as never }, normal)).toThrow("Invalid native window theme");
  expect(() => resolveWindowTheme({ ...theme, material: "invalid" as never }, normal)).toThrow("Invalid native window theme");
  expect(() => resolveWindowTheme({ ...theme, backgroundColor: "url(file:///test)" }, normal)).toThrow("Invalid native window theme");
});
