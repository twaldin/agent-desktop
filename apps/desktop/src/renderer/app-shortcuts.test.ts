import { expect, test } from "bun:test";
import { matchAppShortcut } from "./app-shortcuts";

function key(overrides: Partial<Parameters<typeof matchAppShortcut>[0]> = {}): Parameters<typeof matchAppShortcut>[0] {
  return { key: "n", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 78, defaultPrevented: false, getModifierState: () => false, ...overrides };
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

test("text, send, stop, editor-save and terminal keys do not become app commands", () => {
  for (const value of ["Enter", "Escape", "ArrowUp", "ArrowDown", "s", "a", "c", "v", "r", "t", "Dead", "Process"]) expect(matchAppShortcut(key({ key: value }), "mac")).toBeUndefined();
  expect(matchAppShortcut(key({ metaKey: false }), "mac")).toBeUndefined();
});
