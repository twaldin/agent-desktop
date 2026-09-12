/** Application keybindings only. OMP tool/editor and OS-global dispatch keep their own owners. */
export type KeybindingPlatform = "mac" | "other";
export interface CommandBindingDefinition {
  id: string;
  defaults: readonly string[];
  /** Commands with separate focused owners can deliberately share an accelerator. */
  sharesBindingsWith?: readonly string[];
  multiple?: boolean;
  configurable?: boolean;
}
export interface CommandBindingOverride { command: string; keys: string[] }
export interface CommandKeymap { overrides: CommandBindingOverride[] }
export type CommandBindingUpdate =
  | { type: "set" | "append"; accelerator: string }
  | { type: "replace"; previousAccelerator: string; accelerator: string }
  | { type: "remove"; accelerator: string }
  | { type: "clear" | "reset" };

export class KeybindingError extends Error {
  constructor(readonly code: "INVALID_KEYBINDING" | "UNKNOWN_COMMAND" | "STALE_KEYBINDING", message: string) {
    super(message); this.name = "KeybindingError";
  }
}

const modifierAliases: Record<string, string> = {
  ctrl: "Ctrl", control: "Ctrl", cmd: "Command", command: "Command", meta: "Command", super: "Command",
  alt: "Alt", option: "Alt", shift: "Shift", cmdorctrl: "CmdOrCtrl", commandorcontrol: "CmdOrCtrl",
};
const keyAliases: Record<string, string> = {
  esc: "Escape", escape: "Escape", return: "Enter", enter: "Enter", space: "Space", spacebar: "Space",
  arrowup: "Up", up: "Up", arrowdown: "Down", down: "Down", arrowleft: "Left", left: "Left", arrowright: "Right", right: "Right",
  tab: "Tab", backspace: "Backspace", delete: "Delete", del: "Delete", insert: "Insert", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown", plus: "Plus", mouseback: "MouseBack", mouseforward: "MouseForward",
  fn: "Fn", leftoption: "LeftOption", rightoption: "RightOption", leftcommand: "LeftCommand", rightcommand: "RightCommand", leftcontrol: "LeftControl",
};
const modifierOrder = ["Ctrl", "Command", "CmdOrCtrl", "Alt", "Shift"];
const bareModifiers = new Set(["Fn", "LeftOption", "RightOption", "LeftCommand", "RightCommand", "LeftControl"]);
const invalid = (message: string): never => { throw new KeybindingError("INVALID_KEYBINDING", message); };
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)));

/** Validate the operation itself at the wire boundary; TypeScript types do not validate received JSON. */
export function parseCommandBindingUpdate(value: unknown): CommandBindingUpdate {
  if (!plain(value)) return invalid("Invalid shortcut edit.");
  const fields = value.type === "clear" || value.type === "reset" ? ["type"]
    : value.type === "set" || value.type === "append" || value.type === "remove" ? ["type", "accelerator"]
    : value.type === "replace" ? ["type", "previousAccelerator", "accelerator"] : undefined;
  if (!fields || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))
    || Object.keys(value).some(field => !fields.includes(field))) return invalid("Invalid shortcut edit fields.");
  switch (value.type) {
    case "clear": case "reset": return { type: value.type };
    case "set": case "append": case "remove":
      if (typeof value.accelerator !== "string") return invalid("A shortcut requires an accelerator.");
      return { type: value.type, accelerator: normalizeAccelerator(value.accelerator) };
    case "replace":
      if (typeof value.accelerator !== "string" || typeof value.previousAccelerator !== "string") return invalid("Replacing a shortcut requires its previous and new accelerators.");
      return { type: value.type, previousAccelerator: normalizeAccelerator(value.previousAccelerator), accelerator: normalizeAccelerator(value.accelerator) };
    default: return invalid("Unknown shortcut edit.");
  }
}

/** Canonical accelerator spelling; primary modifiers stay portable until comparison. */
export function normalizeAccelerator(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return invalid("A shortcut must contain valid keys.");
  return value.trim().split(/ +/).map(stroke => {
    const parts = stroke.split("+");
    if (parts.some(part => !part)) return invalid("Use Plus for the plus key.");
    const rawKey = parts.pop()!;
    const modifiers = parts.map(part => Object.hasOwn(modifierAliases, part.toLowerCase()) ? modifierAliases[part.toLowerCase()]! : invalid("Unknown shortcut modifier."));
    if (new Set(modifiers).size !== modifiers.length) return invalid("A shortcut repeats a modifier.");
    if (modifiers.includes("CmdOrCtrl") && (modifiers.includes("Command") || modifiers.includes("Ctrl"))) return invalid("The primary modifier cannot be combined with Command or Control.");
    const key = Object.hasOwn(keyAliases, rawKey.toLowerCase()) ? keyAliases[rawKey.toLowerCase()]!
      : /^f(?:[1-9]|1\d|2[0-4])$/i.test(rawKey) ? rawKey.toUpperCase()
      : [...rawKey].length === 1 ? /^[a-z]$/i.test(rawKey) ? rawKey.toUpperCase() : rawKey
      : /^[A-Za-z][A-Za-z0-9]{1,63}$/.test(rawKey) ? rawKey : invalid("Unknown shortcut key.");
    if (bareModifiers.has(key) && modifiers.length) return invalid("A bare modifier cannot be combined with other keys.");
    return [...modifierOrder.filter(modifier => modifiers.includes(modifier)), key].join("+");
  }).join(" ");
}

function comparableStrokes(value: string, platform: KeybindingPlatform): string[] {
  return normalizeAccelerator(value).split(" ").map(stroke => {
    const parts = stroke.split("+");
    const key = parts.pop()!;
    const modifiers = parts.map(modifier => modifier === "CmdOrCtrl" ? platform === "mac" ? "Command" : "Ctrl" : modifier);
    return [...modifierOrder.filter(modifier => modifiers.includes(modifier)), key].join("+").toLowerCase();
  });
}
export function sameAccelerator(left: string, right: string, platform: KeybindingPlatform): boolean {
  return comparableStrokes(left, platform).join(" ") === comparableStrokes(right, platform).join(" ");
}
/** Exact and sequence-prefix collisions share the same input stream. */
export function acceleratorsConflict(left: string, right: string, platform: KeybindingPlatform): boolean {
  const a = comparableStrokes(left, platform), b = comparableStrokes(right, platform);
  return a.slice(0, Math.min(a.length, b.length)).every((stroke, index) => stroke === b[index]);
}

export function effectiveCommandBindings(definition: CommandBindingDefinition, keymap: CommandKeymap): string[] {
  // An explicit empty override clears a command. An absent override restores defaults.
  return [...(keymap.overrides.find(value => value.command === definition.id)?.keys ?? definition.defaults)];
}
export function validateCommandBindingDefinitions(definitions: readonly CommandBindingDefinition[], platform: KeybindingPlatform): void {
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (typeof definition.id !== "string" || !definition.id.trim() || definition.id.length > 256 || /[\u0000-\u001f\u007f]/.test(definition.id) || ids.has(definition.id)) return invalid("Shortcut command identities must be unique and nonempty.");
    ids.add(definition.id);
    const normalized = uniqueKeys(definition.defaults, platform);
    if (normalized.length !== definition.defaults.length || definition.multiple === false && normalized.length > 1) return invalid("A command has invalid shortcut defaults.");
  }
  for (const definition of definitions) {
    if (definition.sharesBindingsWith?.some(id => !ids.has(id))) return invalid("A shared shortcut owner is unknown.");
  }
}
/** Parse shared state without silently discarding an unknown command or malformed override. */
export function parseCommandKeymap(value: unknown, definitions: readonly CommandBindingDefinition[], platform: KeybindingPlatform): CommandKeymap {
  validateCommandBindingDefinitions(definitions, platform);
  if (!plain(value) || Object.keys(value).some(key => key !== "overrides") || !Array.isArray(value.overrides)) return invalid("A command keymap requires an overrides array.");
  if (value.overrides.length > definitions.length) return invalid("The keymap has too many commands.");
  const seen = new Set<string>();
  return { overrides: value.overrides.map(item => {
    if (!plain(item) || Object.keys(item).some(key => key !== "command" && key !== "keys") || typeof item.command !== "string" || !Array.isArray(item.keys)) return invalid("Invalid command shortcut override.");
    const definition = definitions.find(command => command.id === item.command);
    if (!definition) throw new KeybindingError("UNKNOWN_COMMAND", "This keymap contains an unsupported command. Update the app before editing it.");
    if (definition.configurable === false) return invalid("This command has a fixed shortcut.");
    if (seen.has(item.command)) return invalid("A command has more than one override record.");
    seen.add(item.command);
    if (item.keys.length > 256 || item.keys.some(key => typeof key !== "string")) return invalid("Invalid shortcut alternatives.");
    const keys = uniqueKeys(item.keys as string[], platform);
    if (definition.multiple === false && keys.length > 1) return invalid("This command supports one shortcut.");
    return { command: item.command, keys };
  }) };
}
function uniqueKeys(keys: readonly string[], platform: KeybindingPlatform): string[] {
  const result: string[] = [];
  for (const value of keys) {
    const key = normalizeAccelerator(value);
    if (!result.some(existing => sameAccelerator(existing, key, platform))) result.push(key);
  }
  return result;
}
function canShare(left: CommandBindingDefinition, right: CommandBindingDefinition): boolean {
  return left.id === right.id || Boolean(left.sharesBindingsWith?.includes(right.id) || right.sharesBindingsWith?.includes(left.id));
}
export function findBindingConflict(command: CommandBindingDefinition, accelerator: string, definitions: readonly CommandBindingDefinition[], keymap: CommandKeymap, platform: KeybindingPlatform): CommandBindingDefinition | undefined {
  validateCommandBindingDefinitions(definitions, platform);
  return definitions.find(other => !canShare(command, other) && effectiveCommandBindings(other, keymap).some(key => acceleratorsConflict(key, accelerator, platform)));
}

/** Pure admission calculation. Its caller must supply current state and persist the returned map as one operation. */
export function updateCommandBinding(commandId: string, update: CommandBindingUpdate, definitions: readonly CommandBindingDefinition[], current: CommandKeymap, platform: KeybindingPlatform): CommandKeymap {
  update = parseCommandBindingUpdate(update);
  current = parseCommandKeymap(current, definitions, platform);
  const command = definitions.find(value => value.id === commandId);
  if (!command) throw new KeybindingError("UNKNOWN_COMMAND", "The shortcut command is unavailable.");
  if (command.configurable === false) return invalid("This command has a fixed shortcut.");
  const previous = uniqueKeys(effectiveCommandBindings(command, current), platform);
  const overrides = new Map(current.overrides.map(value => [value.command, [...value.keys]]));
  let next: string[], added: string | undefined, released = previous;
  switch (update.type) {
    case "reset": overrides.delete(commandId); next = uniqueKeys(command.defaults, platform); break;
    case "clear": next = []; overrides.set(commandId, next); break;
    case "set": added = normalizeAccelerator(update.accelerator); next = uniqueKeys([added, ...previous.slice(1)], platform); overrides.set(commandId, next); break;
    case "append":
      if (command.multiple === false) return invalid("This command supports one shortcut.");
      added = normalizeAccelerator(update.accelerator); next = uniqueKeys([...previous, added], platform); released = []; overrides.set(commandId, next); break;
    case "replace": {
      const index = previous.findIndex(key => sameAccelerator(key, update.previousAccelerator, platform));
      if (index < 0) throw new KeybindingError("STALE_KEYBINDING", "This shortcut changed. Refresh before editing it.");
      added = normalizeAccelerator(update.accelerator); released = [previous[index]!]; next = [...previous]; next[index] = added; next = uniqueKeys(next, platform); overrides.set(commandId, next); break;
    }
    case "remove": {
      const index = previous.findIndex(key => sameAccelerator(key, update.accelerator, platform));
      if (index < 0) throw new KeybindingError("STALE_KEYBINDING", "This shortcut changed. Refresh before removing it.");
      released = [previous[index]!]; next = previous.filter((_, at) => at !== index); overrides.set(commandId, next); break;
    }
  }
  if (command.multiple === false && next.length > 1) return invalid("This command supports one shortcut.");
  if (added) {
    for (const other of definitions) {
      if (canShare(command, other)) continue;
      const keys = effectiveCommandBindings(other, { overrides: [...overrides].map(([command, keys]) => ({ command, keys })) });
      if (keys.some(key => !sameAccelerator(key, added!, platform) && acceleratorsConflict(key, added!, platform))) return invalid("This shortcut has a sequence-prefix conflict with another command.");
      const retained = keys.filter(key => !sameAccelerator(key, added!, platform));
      if (retained.length !== keys.length) {
        if (other.configurable === false) return invalid("This shortcut is reserved by a fixed command.");
        // Pinned behavior distinguishes default suppression, partial explicit lists and a displaced custom key.
        if (overrides.has(other.id) && retained.length) overrides.set(other.id, retained);
        else if (other.defaults.some(key => sameAccelerator(key, added!, platform))) overrides.set(other.id, []);
        else overrides.delete(other.id);
      }
    }
  }
  // Pinned set/reset restoration also considers retained alternatives; it can restore a shared default.
  for (const key of released.filter(key => !added || !sameAccelerator(key, added, platform))) {
    for (const other of definitions) {
      if (other.id !== commandId && overrides.get(other.id)?.length === 0 && other.defaults.some(value => sameAccelerator(value, key, platform))) overrides.delete(other.id);
    }
  }
  return { overrides: [...overrides].sort(([a], [b]) => a.localeCompare(b)).map(([command, keys]) => ({ command, keys: [...keys] })) };
}
