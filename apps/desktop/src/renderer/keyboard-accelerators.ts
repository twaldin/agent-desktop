import { normalizeAccelerator, sameAccelerator, type KeybindingPlatform } from "../../../../packages/shared/src/command-keybindings";

export type AcceleratorKeyEvent = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "keyCode" | "defaultPrevented" | "getModifierState">;
/** Keys come from the validated effective application keymap; only currently eligible owners belong here. */
export interface ActiveShortcutBinding<Command extends string> { command: Command; keys: readonly string[]; allowsKeyRepeat?: boolean }
export type ShortcutMatch<Command extends string> = { type: "command"; command: Command } | { type: "prefix" };
const physicalKeys: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Space: "Space",
  NumpadAdd: "Plus", NumpadSubtract: "-", NumpadMultiply: "*", NumpadDivide: "/", NumpadDecimal: ".", NumpadEnter: "Enter",
};

/** Option produces a different character on macOS. Other modifiers retain the actual layout's key. */
export function acceleratorStroke(event: AcceleratorKeyEvent): string | undefined {
  if (event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")) return;
  let key = event.key;
  if (event.altKey) key = /^(?:Key|Digit|Numpad)([A-Z0-9])$/.exec(event.code)?.[1]
    ?? (Object.hasOwn(physicalKeys, event.code) ? physicalKeys[event.code]! : key);
  if (["Dead", "Process", "Unidentified", "Meta", "Control", "Shift", "Alt", "AltGraph"].includes(key)) return;
  if (key === " ") key = "Space";
  if (key === "+") key = "Plus";
  try { return normalizeAccelerator([event.ctrlKey && "Ctrl", event.metaKey && "Command", event.altKey && "Alt", event.shiftKey && "Shift", key].filter(Boolean).join("+")); }
  catch { return; }
}

/** One per input owner, not per render. It holds only sequence progress, never action closures. */
export class KeyboardAcceleratorMatcher<Command extends string> {
  private pending: Array<{ command: Command; key: string; next: number }> = [];
  private expires = 0;
  constructor(private readonly platform: KeybindingPlatform, private readonly sequenceTimeout = 1000) {}
  reset() { this.pending = []; this.expires = 0; }

  match(event: AcceleratorKeyEvent, active: readonly ActiveShortcutBinding<Command>[], now: number, editable = false): ShortcutMatch<Command> | undefined {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")) { this.reset(); return; }
    const stroke = acceleratorStroke(event);
    if (!stroke) {
      if (!event.repeat && ["Dead", "Process", "Unidentified"].includes(event.key)) this.reset();
      return;
    }
    const candidates = active.flatMap(binding => binding.keys.map(key => ({ command: binding.command, key: normalizeAccelerator(key), next: 0 })))
      .filter(binding => {
        if (!editable) return true;
        // Never swallow editor text or start multi-stroke application sequences in an editable.
        if (binding.key.includes(" ")) return false;
        const first = binding.key.split("+");
        return first.some(part => ["Command", "Ctrl", "CmdOrCtrl", "Alt"].includes(part)) || binding.key === "Shift+Escape";
      });
    // Native tab cycling permits held single-stroke keys. Repeats never start,
    // advance, or reset a multi-stroke sequence, nor repeat other app actions.
    if (event.repeat) {
      const repeated = candidates.find(candidate => !candidate.key.includes(" ") && active.some(binding => binding.command === candidate.command && binding.allowsKeyRepeat)
        && sameAccelerator(candidate.key,stroke,this.platform));
      return repeated ? {type:"command",command:repeated.command} : undefined;
    }
    const pending = now < this.expires ? this.pending.filter(item => candidates.some(candidate => candidate.command === item.command && candidate.key === item.key)) : [];
    const advance = (items: typeof candidates, value = stroke) => items.filter(item => sameAccelerator(item.key.split(" ")[item.next]!, value, this.platform));
    // A mismatching stroke can be the first stroke of a different command.
    let matches = pending.length ? advance(pending) : [];
    if (!matches.length) matches = advance(candidates);
    // Native Ctrl+Shift+Minus reports "_". Saved logical underscore bindings
    // keep priority; only an unmatched physical chord tries its base spelling.
    if (!matches.length && event.ctrlKey && !event.metaKey && !event.altKey && event.shiftKey && event.code === "Minus" && event.key === "_") {
      const physicalStroke = stroke.slice(0, -1) + "-";
      matches = pending.length ? advance(pending, physicalStroke) : [];
      if (!matches.length) matches = advance(candidates, physicalStroke);
    }
    this.reset();
    const completed = matches.find(item => item.next + 1 === item.key.split(" ").length);
    if (completed) return { type: "command", command: completed.command };
    if (matches.length) {
      this.pending = matches.map(item => ({ ...item, next: item.next + 1 }));
      this.expires = now + this.sequenceTimeout;
      return { type: "prefix" };
    }
  }
}
