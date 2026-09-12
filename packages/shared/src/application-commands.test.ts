import { expect, test } from "bun:test";
import { effectiveCommandBindings, findBindingConflict, updateCommandBinding, validateCommandBindingDefinitions } from "./command-keybindings";
import {
  APPLICATION_COMMAND_GOAL_BOUNDARIES,
  APPLICATION_COMMAND_IDENTITY_COUNT,
  APPLICATION_COMMANDS,
  APPLICATION_RESERVED_KEYBINDINGS,
  REFERENCE_COMMAND_DECLARATION_COUNT,
  applicationCommandDefinitions,
  applicationKeybindingAdmissionDefinitions,
  resolveEffectiveApplicationBindings,
} from "./application-commands";

const byId = (target: "tabs" | "sidebar" = "tabs") =>
  new Map(applicationCommandDefinitions({ primaryNumberShortcutTarget: target }).map(command => [command.id, command]));

test("the 140 reference declarations expand to 148 unique application command identities", () => {
  expect(REFERENCE_COMMAND_DECLARATION_COUNT).toBe(140);
  expect(APPLICATION_COMMANDS).toHaveLength(APPLICATION_COMMAND_IDENTITY_COUNT);
  expect(new Set(APPLICATION_COMMANDS.map(command => command.id)).size).toBe(APPLICATION_COMMAND_IDENTITY_COUNT);
  expect(APPLICATION_COMMANDS.filter(command => command.referenceFamily === "electron-only")).toHaveLength(18);
  expect(APPLICATION_COMMANDS.filter(command => command.referenceFamily === "webview")).toHaveLength(130);
  expect(APPLICATION_COMMANDS.filter(command => /^focusTab[1-9]$/.test(command.id)).map(command => command.id))
    .toEqual(Array.from({ length: 9 }, (_, index) => `focusTab${index + 1}`));
  expect(APPLICATION_COMMANDS.every(command => command.title.length > 0 && command.description.length > 0)).toBe(true);
});

test("macOS number defaults follow the explicit shared tabs or sidebar layout", () => {
  const tabs = byId("tabs"), sidebar = byId("sidebar");
  for (let number = 1; number <= 9; number++) {
    expect(tabs.get(`focusTab${number}`)?.defaults).toEqual([`Command+${number}`]);
    expect(tabs.get(`thread${number}`)?.defaults).toEqual([`Ctrl+${number}`]);
    expect(sidebar.get(`focusTab${number}`)?.defaults).toEqual([`Ctrl+${number}`]);
    expect(sidebar.get(`thread${number}`)?.defaults).toEqual([`Command+${number}`]);
  }
  for (const id of ["switchToMode1", "switchToMode2", "switchToMode3"]) {
    expect(tabs.get(id)?.defaults).toEqual([]);
    expect(sidebar.get(id)?.defaults).toEqual([]);
  }
  expect(applicationCommandDefinitions()).toEqual(applicationCommandDefinitions({ primaryNumberShortcutTarget: "tabs" }));
  expect(tabs.get("toggleTerminal")?.defaults).toEqual(["Control+`"]);
});

test("definitions retain pinned shared owners, single-binding globals and fixed page exclusions", () => {
  const commands = byId();
  expect(commands.get("closeTab")?.sharesBindingsWith).toEqual(["closeWindow"]);
  expect(commands.get("nextTab")?.sharesBindingsWith).toEqual(["nextThread", "nextRecentThread"]);
  expect(commands.get("previousTab")?.sharesBindingsWith).toEqual(["previousThread", "previousRecentThread"]);
  expect(commands.get("goToLine")?.sharesBindingsWith).toEqual(["focusBrowserAddressBar"]);
  expect(commands.get("file.goToDefinition")?.sharesBindingsWith).toEqual(["navigateForward"]);
  for (const id of ["globalDictationHold", "globalDictationToggle", "realtimeVoice"])
    expect(commands.get(id)?.multiple).toBe(false);
  for (const id of ["composer.captureAppshot", "codexMicroSettings", "findInThread"])
    expect(commands.get(id)?.configurable).toBe(false);
  validateCommandBindingDefinitions([...commands.values()], "mac");
});

test("current renderer aliases are explicit relationships rather than invented consumers", () => {
  expect(Object.fromEntries(APPLICATION_COMMANDS.flatMap(command => command.relatedCurrentCommandId
    ? [[command.relatedCurrentCommandId, command.id] as const] : []))).toEqual({
    "new-chat": "newTask", search: "searchChats", sidebar: "toggleSidebar", settings: "settings",
    files: "searchFiles", "side-chat": "openSideChat", browser: "openBrowserTab", terminal: "toggleTerminal",
    review: "openReviewTab", "toggle-side-panel": "toggleSidePanel",
  });
});

test("GOAL exclusions are recorded without excluding context-dependent local commands", () => {
  expect(APPLICATION_COMMAND_GOAL_BOUNDARIES.excludedConsumerCapabilities).toEqual(["hosted-only"]);
  expect(APPLICATION_COMMAND_GOAL_BOUNDARIES.excludedCommandIds.pets).toEqual(["openAvatarOverlay"]);
  expect(APPLICATION_COMMANDS.filter(command => command.goalExclusion === "realtime-voice").map(command => command.id)).toEqual(
    [...APPLICATION_COMMAND_GOAL_BOUNDARIES.excludedCommandIds.realtimeVoice],
  );
  expect(APPLICATION_COMMANDS.find(command => command.id === "logOut")?.goalExclusion).toBe("openai-sign-in");
  for (const id of ["manageTasks", "switchToMode1", "switchToMode2", "switchToMode3"])
    expect(APPLICATION_COMMANDS.find(command => command.id === id)?.goalExclusion).toBeUndefined();
});


test("whole-registry admission persists ordinary edits and protects all fixed Find owners", () => {
  const definitions = applicationKeybindingAdmissionDefinitions();
  const empty = { overrides: [] };
  const search = definitions.find(command => command.id === "searchChats")!;
  const commandMenu = definitions.find(command => command.id === "openCommandMenu")!;
  const rebound = updateCommandBinding("searchChats", { type: "set", accelerator: "Command+K" }, definitions, empty, "mac");
  expect(effectiveCommandBindings(search, rebound)).toEqual(["Command+K"]);
  expect(effectiveCommandBindings(commandMenu, rebound)).toEqual([]);
  expect(APPLICATION_RESERVED_KEYBINDINGS.map(command => command.id)).toEqual(["reserved.findNext", "reserved.findPrevious"]);
  for (const [accelerator, owner] of [["Command+F", "findInThread"], ["Command+G", "reserved.findNext"], ["Command+Shift+G", "reserved.findPrevious"]] as const) {
    expect(findBindingConflict(search, accelerator, definitions, rebound, "mac")?.id).toBe(owner);
    expect(() => updateCommandBinding("searchChats", { type: "set", accelerator }, definitions, rebound, "mac"))
      .toThrow("reserved by a fixed command");
  }
  for (const accelerator of ["Command+G X", "Command+Shift+G X"])
    expect(() => updateCommandBinding("searchChats", { type: "set", accelerator }, definitions, rebound, "mac"))
      .toThrow("sequence-prefix conflict");
});

const effectiveById = (keymap: { overrides: Array<{ command: string; keys: string[] }> } | undefined, target: "tabs" | "sidebar" = "tabs") =>
  new Map(resolveEffectiveApplicationBindings(keymap, { primaryNumberShortcutTarget: target }).bindings.map(binding => [binding.command, binding.keys]));

test("background submission keeps the pinned state and primary-Enter suppression rules", () => {
  expect(effectiveById(undefined).get("composer.submitInBackground")).toEqual([]);
  expect(effectiveById({ overrides: [] }).get("composer.submitInBackground")).toEqual(["CmdOrCtrl+Enter"]);
  expect(effectiveById({ overrides: [{ command: "newTask", keys: ["Command+Enter"] }] }).get("composer.submitInBackground")).toEqual([]);
  expect(effectiveById({ overrides: [{ command: "newTask", keys: ["cmd+enter"] }] }).get("composer.submitInBackground")).toEqual([]);
  expect(effectiveById({ overrides: [{ command: "newTask", keys: ["commandorcontrol+enter"] }] }).get("composer.submitInBackground")).toEqual([]);
  expect(effectiveById({ overrides: [{ command: "newTask", keys: ["meta+enter"] }] }).get("composer.submitInBackground")).toEqual([]);
  expect(effectiveById({ overrides: [{ command: "newTask", keys: ["Command+Enter X"] }] }).get("composer.submitInBackground")).toEqual([]);
  expect(effectiveById({ overrides: [{ command: "newTask", keys: ["Ctrl+Enter"] }] }).get("composer.submitInBackground")).toEqual(["CmdOrCtrl+Enter"]);
  expect(effectiveById({ overrides: [{ command: "newTask", keys: ["Command+Shift+Enter"] }] }).get("composer.submitInBackground")).toEqual(["CmdOrCtrl+Enter"]);
  expect(effectiveById({ overrides: [{ command: "composer.submitInBackground", keys: ["Alt+Enter"] }] }).get("composer.submitInBackground")).toEqual(["Alt+Enter"]);
});

test("Quick Chat and number defaults yield to another explicit owner of their first stroke", () => {
  const overrides = [{ command: "newTask", keys: ["Option+Space", "Command+1 X", "Ctrl+1"] }];
  const tabs = effectiveById({ overrides });
  expect(tabs.get("focusQuickChat")).toEqual([]);
  expect(tabs.get("focusTab1")).toEqual([]);
  expect(tabs.get("thread1")).toEqual([]);
  expect(tabs.get("focusTab2")).toEqual(["Command+2"]);
  const sidebar = effectiveById({ overrides }, "sidebar");
  expect(sidebar.get("focusTab1")).toEqual([]);
  expect(sidebar.get("thread1")).toEqual([]);
  expect(effectiveById({ overrides: [{ command: "focusQuickChat", keys: ["cmd+space"] }] }).get("focusQuickChat")).toEqual(["Command+Space"]);
});

test("unsupported persisted commands remain diagnostic owners and never become executable bindings", () => {
  const keymap = { overrides: [{ command: "future.command", keys: ["Alt+Space"] }] };
  const before = JSON.stringify(keymap);
  const result = resolveEffectiveApplicationBindings(keymap);
  expect(result.unsupportedOverrideCommandIds).toEqual(["future.command"]);
  expect(result.bindings.some(binding => binding.command === "future.command")).toBe(false);
  expect(result.bindings.find(binding => binding.command === "focusQuickChat")?.keys).toEqual([]);
  expect(JSON.stringify(keymap)).toBe(before);
  expect(() => resolveEffectiveApplicationBindings({ overrides: [
    { command: "future.command", keys: ["Alt+Space"] },
    { command: "future.command", keys: ["Command+Space"] },
  ] })).toThrow("more than one override record");
  expect(() => resolveEffectiveApplicationBindings({ overrides: [
    { command: "future.command", keys: ["Command++K"] },
  ] })).toThrow("Use Plus for the plus key");
  expect(() => resolveEffectiveApplicationBindings({ overrides: [
    { command: "", keys: ["Command+K"] },
  ] })).toThrow("Invalid command shortcut override");
});
