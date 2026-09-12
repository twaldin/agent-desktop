import { expect, test } from "bun:test";
import { acceleratorsConflict, effectiveCommandBindings, findBindingConflict, KeybindingError, normalizeAccelerator, parseCommandKeymap, sameAccelerator, updateCommandBinding, type CommandBindingDefinition, type CommandBindingUpdate, type CommandKeymap } from "./command-keybindings";

const commands: CommandBindingDefinition[] = [
  { id: "new-chat", defaults: ["CmdOrCtrl+N", "CmdOrCtrl+Shift+O"] },
  { id: "search", defaults: ["CmdOrCtrl+K"] },
  { id: "browser", defaults: ["CmdOrCtrl+T"] },
];
const empty = (): CommandKeymap => ({ overrides: [] });
const keys = (id: string, map: CommandKeymap) => effectiveCommandBindings(commands.find(command => command.id === id)!, map);

test("normalization retains portable primary modifiers and compares platform equivalents", () => {
  expect(normalizeAccelerator(" shift+cmdorctrl+n ")).toBe("CmdOrCtrl+Shift+N");
  expect(normalizeAccelerator("Option+Control+ArrowLeft")).toBe("Ctrl+Alt+Left");
  expect(sameAccelerator("CmdOrCtrl+N", "Super+n", "mac")).toBe(true);
  expect(sameAccelerator("CmdOrCtrl+N", "Control+n", "other")).toBe(true);
  expect(sameAccelerator("CmdOrCtrl+N", "Control+n", "mac")).toBe(false);
  expect(sameAccelerator("CmdOrCtrl+N", "Command+n", "other")).toBe(false);
  expect(normalizeAccelerator("Ctrl+Plus")).toBe("Ctrl+Plus");
  expect(normalizeAccelerator("ß")).toBe("ß");
});

test("grammar rejects malformed modifiers and object-prototype names", () => {
  for (const value of ["", "Ctrl++", "Shift+Shift+A", "CmdOrCtrl+Ctrl+A", "Command+Fn", "constructor+A", "__proto__+A", "Ctrl+N\nCmd+K"]) {
    expect(() => normalizeAccelerator(value)).toThrow();
  }
});

test("captured named keys retain their bounded spelling and compare without case sensitivity", () => {
  for (const key of ["Pause", "PrintScreen", "CapsLock", "MediaPlayPause", "AudioVolumeMute", "F35"]) {
    expect(normalizeAccelerator(`Ctrl+${key}`)).toBe(`Ctrl+${key}`);
    expect(sameAccelerator(`Ctrl+${key}`, `Control+${key.toLowerCase()}`, "mac")).toBe(true);
  }
});

test("direct admission rejects sequence-prefix conflicts, including fixed Find", () => {
  const definitions = [...commands, { id: "find", defaults: ["CmdOrCtrl+F"], configurable: false }];
  for (const accelerator of ["Command+K C", "Command+F X"]) {
    expect(() => updateCommandBinding("browser", { type: "append", accelerator }, definitions, empty(), "mac")).toThrow("prefix");
  }
});

test("invalid registry identities and coexistence references fail before mutation", () => {
  for (const definitions of [[...commands, commands[0]!], [...commands, { id: "extra", defaults: [], sharesBindingsWith: ["typo"] }],
    [...commands, { id: "extra", defaults: ["Ctrl++"] }]]) {
    expect(() => updateCommandBinding("search", { type: "clear" }, definitions, empty(), "mac")).toThrow();
  }
});

test("clear and reset both release a reassigned default without mutating the prior state", () => {
  for (const type of ["clear", "reset"] as const) {
    const current = updateCommandBinding("browser", { type: "set", accelerator: "Command+K" }, commands, empty(), "mac");
    const result = updateCommandBinding("browser", { type }, commands, current, "mac");
    expect(keys("search", result)).toEqual(["CmdOrCtrl+K"]);
    expect(keys("browser", result)).toEqual(type === "clear" ? [] : ["CmdOrCtrl+T"]);
    expect(keys("search", current)).toEqual([]);
  }
});

test("conflicts include equivalent shortcuts and sequence prefixes", () => {
  expect(acceleratorsConflict("CmdOrCtrl+K", "Command+K C", "mac")).toBe(true);
  expect(acceleratorsConflict("G G", "G", "mac")).toBe(true);
  expect(acceleratorsConflict("G G", "G T", "mac")).toBe(false);
  expect(acceleratorsConflict("G", "Ctrl+G", "mac")).toBe(false);
  expect(findBindingConflict(commands[0]!, "Command+K", commands, empty(), "mac")?.id).toBe("search");
  expect(findBindingConflict(commands[0]!, "Command+N", commands, empty(), "mac")).toBeUndefined();
});

test("explicit clear survives parsing while reset removes the override", () => {
  const cleared = updateCommandBinding("search", { type: "clear" }, commands, empty(), "mac");
  expect(cleared.overrides).toEqual([{ command: "search", keys: [] }]);
  expect(keys("search", parseCommandKeymap(JSON.parse(JSON.stringify(cleared)), commands, "mac"))).toEqual([]);
  const reset = updateCommandBinding("search", { type: "reset" }, commands, cleared, "mac");
  expect(reset).toEqual(empty());
  expect(keys("search", reset)).toEqual(["CmdOrCtrl+K"]);
});

test("set preserves alternatives; replace and append select the intended binding without duplicates", () => {
  const set = updateCommandBinding("new-chat", { type: "set", accelerator: "CmdOrCtrl+J" }, commands, empty(), "mac");
  expect(keys("new-chat", set)).toEqual(["CmdOrCtrl+J", "CmdOrCtrl+Shift+O"]);
  const replaced = updateCommandBinding("new-chat", { type: "replace", previousAccelerator: "Command+Shift+O", accelerator: "CmdOrCtrl+U" }, commands, set, "mac");
  expect(keys("new-chat", replaced)).toEqual(["CmdOrCtrl+J", "CmdOrCtrl+U"]);
  const appended = updateCommandBinding("new-chat", { type: "append", accelerator: "Command+J" }, commands, replaced, "mac");
  expect(keys("new-chat", appended)).toEqual(["CmdOrCtrl+J", "CmdOrCtrl+U"]);
  expect(keys("new-chat", set)).toEqual(["CmdOrCtrl+J", "CmdOrCtrl+Shift+O"]);
});

test("direct reassignment persists suppression and restores the released default in one returned map", () => {
  const before = empty();
  const reassigned = updateCommandBinding("browser", { type: "set", accelerator: "Command+K" }, commands, before, "mac");
  expect(keys("browser", reassigned)).toEqual(["Command+K"]);
  expect(keys("search", reassigned)).toEqual([]);
  expect(before).toEqual(empty());
  const released = updateCommandBinding("browser", { type: "remove", accelerator: "CmdOrCtrl+K" }, commands, reassigned, "mac");
  expect(keys("browser", released)).toEqual([]);
  expect(keys("search", released)).toEqual(["CmdOrCtrl+K"]);
  expect(released.overrides).toEqual([{ command: "browser", keys: [] }]);
});

test("reassignment retains other alternatives and respects separate owners that can share", () => {
  const initial: CommandKeymap = { overrides: [{ command: "search", keys: ["Command+K", "Command+U"] }] };
  const result = updateCommandBinding("browser", { type: "append", accelerator: "Command+K" }, commands, initial, "mac");
  expect(keys("search", result)).toEqual(["Command+U"]);
  expect(initial.overrides[0]!.keys).toEqual(["Command+K", "Command+U"]);
  const shared = commands.map(command => command.id === "browser" ? { ...command, sharesBindingsWith: ["search"] } : command);
  const coexist = updateCommandBinding("browser", { type: "set", accelerator: "Command+K" }, shared, empty(), "mac");
  expect(keys("search", coexist)).toEqual(["CmdOrCtrl+K"]);
  expect(findBindingConflict(shared[2]!, "Command+K", shared, coexist, "mac")).toBeUndefined();
});

test("stale selected bindings are rejected without changing current state", () => {
  const current: CommandKeymap = { overrides: [{ command: "search", keys: ["Command+J"] }] };
  expect(() => updateCommandBinding("search", { type: "replace", previousAccelerator: "Command+K", accelerator: "Command+U" }, commands, current, "mac")).toThrow("changed");
  expect(() => updateCommandBinding("search", { type: "remove", accelerator: "Command+K" }, commands, current, "mac")).toThrow("changed");
  expect(current).toEqual({ overrides: [{ command: "search", keys: ["Command+J"] }] });
});

test("shared parsing never silently discards unknown commands, malformed overrides or duplicate records", () => {
  for (const value of [null, [], { overrides: [], extra: true }, { overrides: [{ command: "future-command", keys: [] }] },
    { overrides: [{ command: "search", keys: null }] }, { overrides: [{ command: "search", keys: [12] }] },
    { overrides: [{ command: "search", keys: [] }, { command: "search", keys: ["Command+K"] }] }]) {
    expect(() => parseCommandKeymap(value, commands, "mac")).toThrow();
  }
  expect(parseCommandKeymap({ overrides: [{ command: "search", keys: ["CmdOrCtrl+K", "Command+K"] }] }, commands, "mac")).toEqual({ overrides: [{ command: "search", keys: ["CmdOrCtrl+K"] }] });
});

test("single-binding owners reject extra alternatives without changing their map", () => {
  const single: CommandBindingDefinition[] = [{ id: "single", defaults: ["Ctrl+Space"], multiple: false }];
  expect(() => updateCommandBinding("single", { type: "append", accelerator: "Ctrl+K" }, single, empty(), "mac")).toThrow("one shortcut");
  expect(() => parseCommandKeymap({ overrides: [{ command: "single", keys: ["Ctrl+Space", "Ctrl+K"] }] }, single, "mac")).toThrow("one shortcut");
});

test("fixed commands participate in conflict checks but cannot be rebound or displaced", () => {
  const definitions = [...commands, { id: "find", defaults: ["CmdOrCtrl+F"], configurable: false }];
  expect(findBindingConflict(commands[0]!, "Command+F", definitions, empty(), "mac")?.id).toBe("find");
  expect(() => updateCommandBinding("find", { type: "clear" }, definitions, empty(), "mac")).toThrow("fixed");
  expect(() => updateCommandBinding("browser", { type: "set", accelerator: "Command+F" }, definitions, empty(), "mac")).toThrow("reserved");
  expect(() => parseCommandKeymap({ overrides: [{ command: "find", keys: [] }] }, definitions, "mac")).toThrow("fixed");
});

test("admission validates wire-shaped edits before calculating any change", () => {
  const before: CommandKeymap = { overrides: [{ command: "search", keys: ["Command+J"] }] };
  for (const update of [null, [], {}, { type: "unknown" }, { type: "reset", accelerator: "Command+K" },
    { type: "set" }, { type: "remove", accelerator: 4 }, { type: "replace", accelerator: "Command+K" },
    { type: "replace", previousAccelerator: "Command+J", accelerator: "Command+K", extra: true }]) {
    expect(() => updateCommandBinding("search", update as CommandBindingUpdate, commands, before, "mac")).toThrow(KeybindingError);
  }
  expect(before).toEqual({ overrides: [{ command: "search", keys: ["Command+J"] }] });
});

test("admission refuses damaged or newer stored maps instead of preserving unknown entries through an edit", () => {
  for (const value of [{ overrides: [{ command: "future-command", keys: ["Command+U"] }] },
    { overrides: [{ command: "search", keys: [] }, { command: "search", keys: ["Command+J"] }] },
    { overrides: [{ command: "browser", keys: "Command+T" }] }]) {
    const before = JSON.stringify(value);
    expect(() => updateCommandBinding("search", { type: "clear" }, commands, value as CommandKeymap, "mac")).toThrow(KeybindingError);
    expect(JSON.stringify(value)).toBe(before);
  }
});

test("taking one default suppresses all defaults, while taking one explicit alternative preserves the others", () => {
  const taken = updateCommandBinding("search", { type: "set", accelerator: "Command+N" }, commands, empty(), "mac");
  expect(keys("new-chat", taken)).toEqual([]);
  const released = updateCommandBinding("search", { type: "reset" }, commands, taken, "mac");
  expect(keys("new-chat", released)).toEqual(["CmdOrCtrl+N", "CmdOrCtrl+Shift+O"]);
  const explicit: CommandKeymap = { overrides: [{ command: "new-chat", keys: ["CmdOrCtrl+N", "CmdOrCtrl+Shift+O"] }] };
  const explicitTaken = updateCommandBinding("search", { type: "set", accelerator: "Command+N" }, commands, explicit, "mac");
  expect(keys("new-chat", explicitTaken)).toEqual(["CmdOrCtrl+Shift+O"]);
  const explicitReleased = updateCommandBinding("search", { type: "reset" }, commands, explicitTaken, "mac");
  expect(keys("new-chat", explicitReleased)).toEqual(["CmdOrCtrl+Shift+O"]);
});

test("reset restores defaults without displacing their current owners, matching the pinned reset operation", () => {
  const taken = updateCommandBinding("browser", { type: "set", accelerator: "Command+K" }, commands, empty(), "mac");
  const reset = updateCommandBinding("search", { type: "reset" }, commands, taken, "mac");
  expect(keys("search", reset)).toEqual(["CmdOrCtrl+K"]);
  expect(keys("browser", reset)).toEqual(["Command+K"]);
  expect(findBindingConflict(commands[1]!, "Command+K", commands, reset, "mac")?.id).toBe("browser");
});

test("displacing the last explicit nondefault shortcut restores that command's defaults", () => {
  const custom = updateCommandBinding("browser", { type: "set", accelerator: "Command+U" }, commands, empty(), "mac");
  const taken = updateCommandBinding("search", { type: "set", accelerator: "Command+U" }, commands, custom, "mac");
  expect(keys("browser", taken)).toEqual(["CmdOrCtrl+T"]);
  expect(taken.overrides.some(value => value.command === "browser")).toBe(false);
  expect(keys("search", taken)).toEqual(["Command+U"]);
});

test("set applies pinned restoration to prior alternatives even when they remain on the edited command", () => {
  const taken = updateCommandBinding("new-chat", { type: "append", accelerator: "Command+T" }, commands, empty(), "mac");
  expect(keys("browser", taken)).toEqual([]);
  const changed = updateCommandBinding("new-chat", { type: "set", accelerator: "Command+J" }, commands, taken, "mac");
  expect(keys("new-chat", changed)).toEqual(["Command+J", "CmdOrCtrl+Shift+O", "Command+T"]);
  expect(keys("browser", changed)).toEqual(["CmdOrCtrl+T"]);
});
