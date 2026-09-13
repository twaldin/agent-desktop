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
  openCommandMenu: "search", searchChats: "search-chats", openFolder: "open-folder",
  findInThread: "find-in-thread",
  copyConversationPath: "copy-conversation-path", copyWorkingDirectory: "copy-working-directory",
  copyConversationMarkdown: "copy-conversation-markdown",
  renameThread: "rename-thread", archiveThread: "archive-thread",
  markThreadUnread: "mark-thread-unread", toggleThreadPin: "toggle-thread-pin",
  "composer.openModelPicker": "composer-open-model-picker",
  "composer.openProjectPicker": "composer-open-project-picker",
  "composer.submit": "composer-submit", "composer.steer": "composer-steer", "composer.queue": "composer-queue",
  "composer.clear": "composer-clear", "composer.addPhotos": "composer-add-photos",
  "composer.increaseReasoningEffort": "composer-increase-reasoning-effort",
  "composer.decreaseReasoningEffort": "composer-decrease-reasoning-effort",
  "composer.cycleReasoningEffort": "composer-cycle-reasoning-effort",
  "composer.toggleWorktreeMode": "composer-toggle-worktree-mode",
  "git.toggleBlame": "git-toggle-blame",
  "git.commit": "git-commit", focusMainChat: "focus-main-chat",
  previousThread: "previous-thread", nextThread: "next-thread",
  nextThreadNeedingAttention: "next-thread-needing-attention",
  recentThread1: "recent-thread-1", recentThread2: "recent-thread-2", recentThread3: "recent-thread-3",
  recentThread4: "recent-thread-4", recentThread5: "recent-thread-5", recentThread6: "recent-thread-6",
  mcpSettings: "mcp-settings", openSkills: "open-skills", forceReloadSkills: "force-reload-skills",
  toggleBottomPanel: "toggle-bottom-panel", toggleMaximizeSidePanel: "toggle-maximize-side-panel",
  newProjectlessTask: "new-projectless-task",
  reloadBrowserPage: "reload-browser-page", navigateBrowserBack: "navigate-browser-back",
  navigateBrowserForward: "navigate-browser-forward",
  "approval.approve": "approval-approve", "approval.decline": "approval-decline",
  goToLine: "go-to-line", closeTab: "close-tab",
  toggleFileTreePanel: "toggle-file-tree-panel", toggleReviewTab: "toggle-review-tab",
  "git.createBranch": "git-create-branch",
  environmentAction1: "environment-action-1", environmentAction2: "environment-action-2",
  environmentAction3: "environment-action-3", environmentAction4: "environment-action-4",
  environmentAction5: "environment-action-5", environmentAction6: "environment-action-6",
  environmentAction7: "environment-action-7", environmentAction8: "environment-action-8",
  environmentAction9: "environment-action-9",
  focusSideChat: "focus-side-chat",
  manageTasks: "manage-tasks",
} as const;

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
    for (const binding of resolved.bindings) {
      const owner = APP_COMMAND_BINDING_OWNERS[binding.command as keyof typeof APP_COMMAND_BINDING_OWNERS];
      if (owner) bindings[owner] = binding.keys;
    }
    return { bindings, unsupportedCommandIds: resolved.unsupportedOverrideCommandIds, error: undefined };
  } catch (cause) {
    return { bindings: {}, unsupportedCommandIds: [] as readonly string[], error: cause instanceof Error ? cause.message : "The saved keyboard shortcuts could not be read." };
  }
}
