import { expect, test } from "bun:test";
import { matchAppShortcut } from "./app-shortcuts";

function key(overrides: Partial<Parameters<typeof matchAppShortcut>[0]> = {}): Parameters<typeof matchAppShortcut>[0] {
  return { key: "n", code: "KeyN", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 78, defaultPrevented: false, getModifierState: () => false, ...overrides };
}

test("the existing app commands use the platform primary modifier only", () => {
  for (const [value, command] of [["n", "new-chat"], ["K", "search"], ["\\", "sidebar"], [",", "settings"]] as const) {
    expect(matchAppShortcut(key({ key: value }), "mac")).toBe(command);
    expect(matchAppShortcut(key({ key: value, metaKey: false, ctrlKey: true }), "other")).toBe(command);
    expect(matchAppShortcut(key({ key: value, metaKey: false, ctrlKey: true }), "mac")).toBeUndefined();
    expect(matchAppShortcut(key({ key: value }), "other")).toBeUndefined();
  }
});

test("handled keys and both IME markers cannot issue an app command", () => {
  for (const value of [{ defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }]) expect(matchAppShortcut(key(value), "mac")).toBeUndefined();
});

test("held commands and additional modifiers are not duplicate or expanded bindings", () => {
  for (const value of [{ repeat: true }, { shiftKey: true }, { altKey: true }, { ctrlKey: true }, { getModifierState: (name: string) => name === "AltGraph" }]) expect(matchAppShortcut(key(value), "mac")).toBeUndefined();
  expect(matchAppShortcut(key({ ctrlKey: true }), "other")).toBeUndefined();
});

test("Option panel commands match the physical key even when macOS remaps the character", () => {
  expect(matchAppShortcut(key({ key: "ß", code: "KeyS", altKey: true }), "mac")).toBe("side-chat");
  expect(matchAppShortcut(key({ key: "∫", code: "KeyB", altKey: true }), "mac")).toBe("toggle-side-panel");
  expect(matchAppShortcut(key({ key: "b", code: "KeyB", altKey: true, metaKey: false, ctrlKey: true }), "other")).toBe("toggle-side-panel");
  expect(matchAppShortcut(key({ key: "b", code: "KeyB" }), "mac")).toBeUndefined();
  expect(matchAppShortcut(key({ key: "˜", code: "KeyN", altKey: true }), "mac")).toBeUndefined();
});

test("native panel shortcuts match their exact modifiers and physical keys", () => {
  expect(matchAppShortcut(key({ key: "p", code: "KeyP" }), "mac")).toBe("files");
  expect(matchAppShortcut(key({ key: "p", code: "KeyP", metaKey: false, ctrlKey: true }), "other")).toBe("files");
  expect(matchAppShortcut(key({ key: "t", code: "KeyT" }), "mac")).toBe("browser");
  expect(matchAppShortcut(key({ key: "`", code: "Backquote", metaKey: false, ctrlKey: true }), "mac")).toBe("terminal");
  expect(matchAppShortcut(key({ key: "`", code: "Backquote", metaKey: false, ctrlKey: true }), "other")).toBe("terminal");
  expect(matchAppShortcut(key({ key: "g", code: "KeyG", metaKey: false, ctrlKey: true, shiftKey: true }), "mac")).toBe("review");
  expect(matchAppShortcut(key({ key: "G", code: "KeyG", metaKey: false, ctrlKey: true, shiftKey: true }), "other")).toBe("review");
  expect(matchAppShortcut(key({ key: "g", code: "KeyG", metaKey: false, ctrlKey: true }), "mac")).toBeUndefined();
  expect(matchAppShortcut(key({ key: "`", code: "Backquote", metaKey: false, ctrlKey: true, shiftKey: true }), "mac")).toBeUndefined();
  expect(matchAppShortcut(key({ key: "`", code: "Backquote", metaKey: true, ctrlKey: true }), "mac")).toBeUndefined();
});

test("text, send, stop and editor-save keys do not become app commands", () => {
  for (const value of ["Enter", "Escape", "ArrowUp", "ArrowDown", "s", "a", "c", "v", "r", "Dead", "Process"]) expect(matchAppShortcut(key({ key: value }), "mac")).toBeUndefined();
  expect(matchAppShortcut(key({ metaKey: false }), "mac")).toBeUndefined();
});

test("the command palette alternate and folder default retain exact modifiers", () => {
  expect(matchAppShortcut(key({ key: "P", code: "KeyP", shiftKey: true }), "mac")).toBe("search");
  expect(matchAppShortcut(key({ key: "P", code: "KeyP", shiftKey: true, metaKey: false, ctrlKey: true }), "other")).toBe("search");
  expect(matchAppShortcut(key({ key: "P", code: "KeyP", shiftKey: true, altKey: true }), "mac")).toBeUndefined();
  expect(matchAppShortcut(key({ key: "o", code: "KeyO" }), "mac")).toBe("open-folder");
});
