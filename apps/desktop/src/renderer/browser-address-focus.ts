import type { AppShortcutOptions } from "./app-shortcuts";

/** Keyboard focus is scoped to the current chat/draft, not the browser worker.
 * Individual frame/control and selection identities remain separately owned. */
export function browserAddressFocusOwner(hostId: string, kind: "session" | "draft", id: string): string {
  return JSON.stringify(kind === "session" ? [hostId, id] : ["draft", hostId, id]);
}

const inputSelector = "input[data-browser-address-owner]";
const editableSelector = 'input, textarea, select, [contenteditable="true"], [data-codex-composer], .xterm, .native-terminal-grid, .editor-content, [data-app-shortcuts="off"]';

function visible(input: HTMLInputElement, root: HTMLElement, owner: string): boolean {
  const dock = input.closest('section[data-dock-destination]');
  return input.isConnected && root.contains(input) && !input.disabled
    && input.dataset.browserAddressOwner === owner
    && dock?.getAttribute("data-open") === "true"
    // Radix hides the underlying app from AX while the command menu is open;
    // that does not remove the target from the palette's available commands.
    && !input.closest('[hidden], [inert]')
    && input.getClientRects().length > 0;
}

/** Pinned browser focus is local to the focused browser, otherwise the visible
 * side browser wins over the bottom fallback. Main chat may hand focus over;
 * another editor or another panel's control may not. This never opens a tab. */
export function browserAddressTarget(root: HTMLElement | null, owner: string | undefined, origin?: Element | null): HTMLInputElement | undefined {
  if (!root || !owner) return;
  let focused = origin === undefined ? root.ownerDocument.activeElement : origin;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  const candidates = [...root.querySelectorAll<HTMLInputElement>(inputSelector)].filter(input => visible(input, root, owner));
  const browser = focused?.closest(".browser-panel");
  if (browser) return candidates.find(input => browser.contains(input));
  const main = focused?.closest("[data-main-task-chat], [data-codex-composer]");
  const idle = !focused || focused === root.ownerDocument.body;
  if (!main && !idle && focused?.closest(editableSelector)) return;
  const dock = focused?.closest('section[data-dock-destination]');
  const eligible = candidates.filter(input => main || idle || (dock && dock.contains(input)));
  return eligible.find(input => input.closest('section[data-dock-destination]')?.getAttribute("data-dock-destination") === "right") ?? eligible[0];
}

export function withBrowserAddressShortcut(options: AppShortcutOptions, root: HTMLElement | null, owner: string | undefined, origin?: Element | null): AppShortcutOptions {
  const input = browserAddressTarget(root, owner, origin);
  if (!root || !owner || !input) return options;
  return { ...options, inputActions: [...(options.inputActions ?? []), "browser-address"], actions: { ...options.actions,
    "browser-address": () => {
      // Read the live App boundary, not the old input's owner alone. DOM commit
      // updates this before close-autofocus effects, including route suppression.
      if (root.getAttribute("data-browser-current-owner") !== owner || !visible(input, root, owner)) return;
      input.focus();
      if (input.dataset.browserAddressDraft !== "true") input.select();
      input.scrollLeft = 0;
    },
  } };
}
