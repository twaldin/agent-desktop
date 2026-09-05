export type AppShortcut = "new-chat" | "search" | "sidebar" | "settings";
export type AppShortcutPlatform = "mac" | "other";
type ShortcutKey = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "keyCode" | "defaultPrevented" | "getModifierState">;

/** Keep the existing four commands; Control on macOS belongs to text/terminal editing. */
export function matchAppShortcut(event: ShortcutKey, platform: AppShortcutPlatform): AppShortcut | undefined {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || event.shiftKey || event.getModifierState("AltGraph")) return;
  if (platform === "mac" ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
  switch (event.key.toLowerCase()) {
    case "n": return "new-chat";
    case "k": return "search";
    case "\\": return "sidebar";
    case ",": return "settings";
  }
}

export interface AppShortcutOptions {
  actions: Record<AppShortcut, () => void>;
  /** The prompt deliberately retains app commands. Other editors keep their input. */
  composer?: () => HTMLElement | null;
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
    if (value.closest('[hidden], [aria-hidden="true"]') || !value.getClientRects().length) return false;
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
export function installAppShortcuts(window: Window, options: AppShortcutOptions): () => void {
  const platform = options.platform ?? (/Mac|iPhone|iPad|iPod/.test(window.navigator.platform) ? "mac" : "other");
  let composing = false;
  const start = () => { composing = true; };
  const end = () => { composing = false; };
  const blur = (event: FocusEvent) => { if (event.target === window) composing = false; };
  const onKey = (event: KeyboardEvent) => {
    const command = matchAppShortcut(event, platform);
    if (!command || composing || options.blocked?.() || visiblePopup(window.document)) return;
    const composer = options.composer?.();
    if (focusedElements(event, window.document).some(value => ownsInput(value, composer))) return;
    event.preventDefault();
    options.actions[command]();
  };
  window.addEventListener("compositionstart", start, true);
  window.addEventListener("compositionend", end, true);
  window.addEventListener("blur", blur, true);
  window.addEventListener("keydown", onKey);
  return () => {
    window.removeEventListener("compositionstart", start, true);
    window.removeEventListener("compositionend", end, true);
    window.removeEventListener("blur", blur, true);
    window.removeEventListener("keydown", onKey);
  };
}
