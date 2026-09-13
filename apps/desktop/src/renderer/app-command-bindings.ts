import { normalizeAccelerator } from "../../../../packages/shared/src/command-keybindings";
import { resolveEffectiveApplicationBindings, type PrimaryNumberShortcutTarget } from "../../../../packages/shared/src/application-commands";
import { commandKeymapNumberTarget, type CommandKeymapPreferenceRecord } from "../../../../packages/shared/src/preferences-v2";
import type { AppShortcut } from "./app-shortcuts";

/** Explicit consumer cutover. Related catalogue metadata is not execution authority. */
export const APP_COMMAND_BINDING_OWNERS = {
  nextTab: "next-task-tab", previousTab: "previous-task-tab",
  focusTab1: "task-tab-1", focusTab2: "task-tab-2", focusTab3: "task-tab-3",
  focusTab4: "task-tab-4", focusTab5: "task-tab-5", focusTab6: "task-tab-6",
  focusTab7: "task-tab-7", focusTab8: "task-tab-8", focusTab9: "task-tab-9",
  thread1: "thread-1", thread2: "thread-2", thread3: "thread-3",
  thread4: "thread-4", thread5: "thread-5", thread6: "thread-6",
  thread7: "thread-7", thread8: "thread-8", thread9: "thread-9",
  newTask: "new-chat", searchFiles: "files", openSideChat: "side-chat",
  toggleSidebar: "sidebar", settings: "settings", toggleTerminal: "terminal",
  openBrowserTab: "browser", openReviewTab: "review", toggleSidePanel: "toggle-side-panel",
  focusBrowserAddressBar: "browser-address",
  stepWorkspaceLayout: "step-workspace-layout",
  keyboardShortcuts: "keyboard-shortcuts",
  forkThread: "fork-thread",
  openCommandMenu: "search", searchChats: "search-chats", openFolder: "open-folder",
} as const satisfies Record<string, AppShortcut>;

export function appCommandShortcutLabel(bindings: Partial<Record<AppShortcut, readonly string[]>>, owner: AppShortcut): string | undefined {
  const key = bindings[owner]?.[0];
  if (!key) return;
  return normalizeAccelerator(key).split(" ").map(stroke => {
    const parts = stroke.split("+"), key = parts.pop()!;
    const modifiers = [parts.includes("Ctrl") && "⌃", parts.includes("Alt") && "⌥", parts.includes("Shift") && "⇧", (parts.includes("Command") || parts.includes("CmdOrCtrl")) && "⌘"];
    return modifiers.filter(Boolean).join("") + key;
  }).join(" ");
}

export function readAppCommandBindings(record: CommandKeymapPreferenceRecord | undefined, loaded: boolean, target: PrimaryNumberShortcutTarget = commandKeymapNumberTarget(record)) {
  const bindings: Partial<Record<AppShortcut, readonly string[]>> = {};
  if (!loaded) return { bindings, unsupportedCommandIds: [] as readonly string[], error: undefined as string | undefined };
  try {
    const resolved = resolveEffectiveApplicationBindings(record && !record.deleted ? record.value : undefined, { primaryNumberShortcutTarget: target });
    for (const [command, owner] of Object.entries(APP_COMMAND_BINDING_OWNERS)) {
      bindings[owner] = resolved.bindings.find(binding => binding.command === command)?.keys ?? [];
    }
    return { bindings, unsupportedCommandIds: resolved.unsupportedOverrideCommandIds, error: undefined };
  } catch (cause) {
    return { bindings: {}, unsupportedCommandIds: [] as readonly string[], error: cause instanceof Error ? cause.message : "The saved keyboard shortcuts could not be read." };
  }
}
