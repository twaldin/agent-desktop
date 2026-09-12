import { KeyboardAcceleratorMatcher } from "./keyboard-accelerators";
export type NumberedChatShortcut = `thread-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
export type NumberedTaskShortcut = `task-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
export type AppShortcut = "step-workspace-layout" | "next-task-tab" | "previous-task-tab" | NumberedTaskShortcut | NumberedChatShortcut | "new-chat" | "search" | "search-chats" | "open-folder" | "sidebar" | "settings" | "keyboard-shortcuts" | "files" | "side-chat" | "browser" | "browser-address" | "terminal" | "review" | "toggle-side-panel";
export type AppShortcutPlatform = "mac" | "other";
type ShortcutKey = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "keyCode" | "defaultPrevented" | "getModifierState">;

/** Primary-modifier commands stay fixed. Native Control panel commands are matched narrowly and owned editors can still claim them before dispatch. */
export function matchAppShortcut(event: ShortcutKey, platform: AppShortcutPlatform): AppShortcut | undefined {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.getModifierState("AltGraph")) return;
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1].toLowerCase() ?? event.key.toLowerCase();
  if (!event.metaKey && event.ctrlKey && !event.altKey) {
    if (!event.shiftKey && (event.code === "Backquote" || event.key === "`")) return "terminal";
    if (event.shiftKey && letter === "g") return "review";
  }
  if (event.shiftKey) {
    if (!event.altKey && (platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && letter === "p") return "search";
    if (!event.altKey && (platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && letter === "b") return "step-workspace-layout";
    return;
  }
  if (platform === "mac" ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
  if (event.altKey) {
    // macOS Option changes `key` to the layer character (⌥S → "ß", ⌥B → "∫"); the physical code is stable.
    return letter === "s" ? "side-chat" : letter === "b" ? "toggle-side-panel" : undefined;
  }
  switch (event.key.toLowerCase()) {
    case "n": return "new-chat";
    case "k": return "search";
    case "p": return "files";
    case "t": return "browser";
    case "l": return "browser-address";
    case "o": return "open-folder";
    case "\\": return "sidebar";
    case ",": return "settings";
  }
}

export interface AppShortcutOptions {
  actions: Partial<Record<AppShortcut, () => void>>;
  /** Complete resolved keys for these consumers. Empty/missing entries stay unbound; undefined retains the legacy caller. */
  bindings?: Partial<Record<AppShortcut, readonly string[]>>;
  /** The prompt deliberately retains app commands. Other editors keep their input. */
  composer?: () => HTMLElement | null;
  /** Narrow local input owners, already gated by the current focused surface. */
  inputActions?: readonly AppShortcut[];
  /** Explicit React-owned transient state, including menus not yet committed to the DOM. */
  blocked?: () => boolean;
  platform?: AppShortcutPlatform;
}

const ownedSurface = '.xterm, .native-terminal-grid, .editor-content, .interaction-card, [data-app-shortcuts="off"]';
const popup = 'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"], [role="menu"], .action-menu';
function element(value: EventTarget | null | undefined): value is HTMLElement {
  return Boolean(value && "nodeType" in value && value.nodeType === 1);
}
function visiblePopup(document: Document): boolean {
  return [...document.querySelectorAll<HTMLElement>(popup)].some(value => {
    if (value.closest('[hidden], [aria-hidden="true"], details:not([open])') || !value.getClientRects().length) return false;
    const style = document.defaultView!.getComputedStyle(value);
    return style.visibility !== "hidden" && style.visibility !== "collapse";
  });
}
function focusedElements(event: KeyboardEvent, document: Document): HTMLElement[] {
  // composedPath includes editable shadow descendants instead of only their retargeted host.
  const values = event.composedPath().filter(element);
  let active = document.activeElement;
  while (active) {
    if (element(active)) values.push(active);
    active = active.shadowRoot?.activeElement ?? null;
  }
  return values;
}
function ownsInput(value: HTMLElement, composer: HTMLElement | null | undefined): boolean {
  if (value.closest(ownedSurface)) return true;
  if (value === composer || composer?.contains(value)) return false;
  return value.isContentEditable || Boolean(value.closest('input, textarea, select, [role="textbox"], [role="combobox"]'));
}

/** Bubble-phase arbitration lets focused controls claim the event before the app does. */
export function installAppShortcuts(window: Window, options: AppShortcutOptions | (() => AppShortcutOptions)): (() => void) & { handleKey(event: KeyboardEvent): void } {
  const currentOptions = typeof options === "function" ? options : () => options;
  const platform = currentOptions().platform ?? (/Mac|iPhone|iPad|iPod/.test(window.navigator.platform) ? "mac" : "other");
  const sequences = new KeyboardAcceleratorMatcher<AppShortcut>(platform);
  let composing = false;
  const handled = new WeakSet<KeyboardEvent>();
  const start = () => { composing = true; sequences.reset(); };
  const end = () => { composing = false; };
  const blur = (event: FocusEvent) => { if (event.target === window) { composing = false; sequences.reset(); } };
  const onKey = (event: KeyboardEvent) => {
    // An input bridge can offer the same event before forwarding a native page
    // key. Its later window bubble must not execute twice or reset a prefix.
    if (handled.has(event)) return;
    const options = currentOptions();
    if (composing || options.blocked?.()) { sequences.reset(); return; }
    const legacyCommand = options.bindings === undefined ? matchAppShortcut(event, platform) : undefined;
    if (options.bindings === undefined && (!legacyCommand || !options.actions[legacyCommand])) return;
    if (visiblePopup(window.document)) { sequences.reset(); return; }
    const composer = options.composer?.();
    const focused = focusedElements(event, window.document);
    if (focused.some(value => value.closest(ownedSurface) || value.closest('[data-codex-shortcut-capture]'))) { sequences.reset(); return; }
    const inputOwned = focused.some(value => ownsInput(value, composer));
    const eligible = (command: AppShortcut) => Boolean(options.actions[command]) && (!inputOwned || options.inputActions?.includes(command));
    if (inputOwned && !Object.keys(options.actions).some(command => eligible(command as AppShortcut))) { sequences.reset(); return; }
    if (options.bindings !== undefined) {
      const active = (Object.keys(options.actions) as AppShortcut[]).filter(eligible)
        .map(command => ({ command, keys: options.bindings![command] ?? [], allowsKeyRepeat: command === "next-task-tab" || command === "previous-task-tab" }));
      const editable = focused.some(value => value.isContentEditable || Boolean(value.closest('input, textarea, [role="textbox"]')));
      const match = sequences.match(event, active, performance.now(), editable);
      if (!match) return;
      handled.add(event);
      event.preventDefault();
      if (match.type === "command") options.actions[match.command]!();
      return;
    }
    if (!eligible(legacyCommand!)) return;
    sequences.reset();
    handled.add(event);
    event.preventDefault();
    options.actions[legacyCommand!]!();
  };
  window.addEventListener("compositionstart", start, true);
  window.addEventListener("compositionend", end, true);
  window.addEventListener("blur", blur, true);
  window.addEventListener("keydown", onKey);
  const dispose = () => {
    sequences.reset();
    window.removeEventListener("compositionstart", start, true);
    window.removeEventListener("compositionend", end, true);
    window.removeEventListener("blur", blur, true);
    window.removeEventListener("keydown", onKey);
  };
  return Object.assign(dispose, { handleKey: onKey });
}
