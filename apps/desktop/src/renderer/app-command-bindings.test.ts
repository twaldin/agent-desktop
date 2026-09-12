import { applicationKeybindingAdmissionDefinitions } from "../../../../packages/shared/src/application-commands";
import { updateCommandBinding } from "../../../../packages/shared/src/command-keybindings";
import { expect, test } from "bun:test";
import { readAppCommandBindings, appCommandShortcutLabel } from "./app-command-bindings";
import type { CommandKeymapPreferenceRecord } from "../../../../packages/shared/src/preferences-v2";
const record = (overrides: { command: string; keys: string[] }[]): CommandKeymapPreferenceRecord => ({
  key: "general.commandKeymap", deleted: false, value: { version: 1, platform: "mac", overrides },
  revision: { counter: 1, actor: "00000000-0000-4000-8000-000000000001", opId: "00000000-0000-4000-8000-000000000002" },
});
test("App dispatch reads the committed number target while retaining explicit alternatives and clears", () => {
  const base = record([{ command: "thread1", keys: ["Command+J"] }, { command: "thread2", keys: [] }]);
  if (base.deleted) throw new Error("expected live fixture");
  const sidebar: CommandKeymapPreferenceRecord = { ...base, value: { ...base.value, version: 2, primaryNumberShortcutTarget: "sidebar" } };
  const before = JSON.stringify(sidebar), mapped = readAppCommandBindings(sidebar, true);
  expect(mapped.bindings["thread-1"]).toEqual(["Command+J"]);
  expect(mapped.bindings["thread-2"]).toEqual([]);
  expect(mapped.bindings["thread-3"]).toEqual(["Command+3"]);
  expect(readAppCommandBindings(base, true).bindings["thread-3"]).toEqual(["Ctrl+3"]);
  expect(JSON.stringify(sidebar)).toBe(before);
});
test("App bindings wait for cache restoration and distinguish confirmed clear from native defaults", () => {
  expect(readAppCommandBindings(undefined, false).bindings).toEqual({});
  const defaults = readAppCommandBindings(undefined, true);
  expect(defaults.bindings["new-chat"]).toEqual(["CmdOrCtrl+N", "CmdOrCtrl+Shift+O"]);
  expect(defaults.bindings.sidebar).toEqual(["CmdOrCtrl+B"]);
  expect(appCommandShortcutLabel(defaults.bindings, "side-chat")).toBe("⌥⌘S");
  const saved = record([{ command: "newTask", keys: [] }, { command: "toggleSidebar", keys: ["Command+J"] }]);
  const before = JSON.stringify(saved), changed = readAppCommandBindings(saved, true);
  expect(changed.bindings["new-chat"]).toEqual([]);
  expect(changed.bindings.sidebar).toEqual(["Command+J"]);
  expect(appCommandShortcutLabel(changed.bindings, "sidebar")).toBe("⌘J");
  expect(appCommandShortcutLabel(changed.bindings, "new-chat")).toBeUndefined();
  expect(JSON.stringify(saved)).toBe(before);
  expect(readAppCommandBindings({ key: saved.key, deleted: true, revision: saved.revision }, true).bindings).toEqual(defaults.bindings);
});
test("command menu, chat drill-in and folder action have distinct configurable owners", () => {
  const result = readAppCommandBindings(record([{ command: "future-command", keys: ["Command+U"] }, { command: "searchChats", keys: ["Command+L"] }]), true);
  expect(result.unsupportedCommandIds).toEqual(["future-command"]);
  expect(result.bindings.search).toEqual(["CmdOrCtrl+K", "CmdOrCtrl+Shift+P"]);
  expect(result.bindings.search).not.toContain("Command+L");
  expect(result.bindings["search-chats"]).toEqual(["Command+L"]);
  expect(result.bindings["open-folder"]).toEqual(["CmdOrCtrl+O"]);
  expect(result.bindings["browser-address"]).toEqual(["CmdOrCtrl+L"]);
  expect(readAppCommandBindings(record([{ command: "focusBrowserAddressBar", keys: ["Command+J"] }]), true).bindings["browser-address"]).toEqual(["Command+J"]);
  expect(readAppCommandBindings(record([{ command: "focusBrowserAddressBar", keys: [] }]), true).bindings["browser-address"]).toEqual([]);
  expect(readAppCommandBindings(record([{ command: "keyboardShortcuts", keys: ["Command+Alt+K"] }]), true).bindings["keyboard-shortcuts"]).toEqual(["Command+Alt+K"]);
  // Reassignment persists the native suppression as part of the same host
  // operation. Reading a manually incomplete override is not that operation.
  const moved = updateCommandBinding("toggleTerminal", { type: "set", accelerator: "Command+K" }, applicationKeybindingAdmissionDefinitions(), { overrides: [] }, "mac");
  expect(readAppCommandBindings(record(moved.overrides), true).bindings.search).toEqual([]);
  expect(readAppCommandBindings(record(moved.overrides), true).bindings.terminal).toEqual(["Command+K"]);
  expect(readAppCommandBindings(record([{ command: "openCommandMenu", keys: [] }]), true).bindings.search).toEqual([]);
  const bad = record([{ command: "newTask", keys: ["Command++Q"] }]);
  expect(readAppCommandBindings(bad, true).error).toBeTruthy();
  expect(readAppCommandBindings(bad, true).bindings).toEqual({});
});
