import {
  KeybindingError,
  normalizeAccelerator,
  parseCommandKeymap,
  type CommandBindingDefinition,
  type CommandKeymap,
} from "./command-keybindings";

export type ApplicationCommandGroup = "thread" | "navigation" | "panels" | "workspace" | "skills" | "configure" | "app" | "ungrouped";
export type ReferenceCommandFamily = "webview" | "electron-only";
export type GoalCommandExclusion = "pets" | "realtime-voice" | "openai-sign-in";
export const REFERENCE_COMMAND_DECLARATION_COUNT = 140 as const;
export const APPLICATION_COMMAND_IDENTITY_COUNT = 148 as const;
export const APPLICATION_COMMAND_GOAL_BOUNDARIES = {
  excludedConsumerCapabilities: ["hosted-only"] as const,
  excludedCommandIds: {
    pets: ["openAvatarOverlay"],
    realtimeVoice: ["realtimeVoice", "composer.startVoiceMode", "realtimeVoice.toggleMicrophoneMute", "realtimeVoice.toggleOutputMute", "realtimeVoice.endCall"],
    openAiSignIn: ["logOut"],
  },
} as const;
export type NumberShortcutFamily = "tabs" | "sidebar" | "mode";
export type PrimaryNumberShortcutTarget = "tabs" | "sidebar";

export interface EffectiveApplicationBinding {
  readonly command: string;
  readonly keys: readonly string[];
}

export interface EffectiveApplicationBindings {
  readonly definitions: readonly CommandBindingDefinition[];
  readonly bindings: readonly EffectiveApplicationBinding[];
  /** Persisted commands this catalogue cannot execute. Callers must surface or reject them. */
  readonly unsupportedOverrideCommandIds: readonly string[];
}

export interface ApplicationCommandMetadata {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly group: ApplicationCommandGroup;
  readonly referenceFamily: ReferenceCommandFamily;
  /** macOS defaults declared by the pinned registry before its number-layout transform. */
  readonly referenceDefaults: readonly string[];
  readonly configurable?: false;
  /** A related command name in the current renderer. This does not assert identical eligibility or behavior. */
  readonly relatedCurrentCommandId?: string;
  readonly goalExclusion?: GoalCommandExclusion;
  readonly numberShortcutFamily?: NumberShortcutFamily;
}

/**
 * Pinned 7982 declares 140 Electron/webview entries. The focusTab template expands
 * to nine commands, so the runtime catalogue contains 148 identities. VS Code-only
 * declarations are a separate owner and are not application shortcuts.
 *
 * Catalogue membership records reference identity. Consumers must separately gate
 * commands by implemented capability, access, owner and active UI state. In
 * particular, hosted-only consumers remain outside GOAL even when a shared command
 * identity can also have a local consumer.
 */
export const APPLICATION_COMMANDS: readonly ApplicationCommandMetadata[] = [
  { id: "hotkeyWindow", title: "Popout Window hotkey", description: "Show or hide Popout Window from anywhere on desktop", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: [] },
  { id: "focusQuickChat", title: "Quick Chat in Mini", description: "Start a lightweight quick chat in mini", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: ["Alt+Space"] },
  { id: "globalDictationHold", title: "Hold-to-dictate hotkey", description: "Hold anywhere on desktop to dictate where your cursor is", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: [] },
  { id: "globalDictationToggle", title: "Toggle dictation hotkey", description: "Press once anywhere on desktop to dictate, then press again to stop", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: [] },
  { id: "realtimeVoice", title: "Voice Chat hotkey", description: "Start a Voice Chat from anywhere on desktop", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: [], goalExclusion: "realtime-voice" },
  { id: "copyConversationPath", title: "Copy conversation path", description: "Copy the current chat path", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: ["CmdOrCtrl+Alt+Shift+C"] },
  { id: "copyDeeplink", title: "Copy deeplink", description: "Copy a deeplink to the current chat", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: ["CmdOrCtrl+Alt+L"] },
  { id: "copyWorkingDirectory", title: "Copy working directory", description: "Copy the current chat working directory", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: ["CmdOrCtrl+Shift+C"] },
  { id: "closeTab", title: "Close Tab", description: "Close the active tab", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: ["CmdOrCtrl+W"] },
  { id: "closeWindow", title: "Close", description: "Close the active window", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: ["CmdOrCtrl+W"] },
  { id: "reloadBrowserPage", title: "Reload Browser Page", description: "Reload the active browser page", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: ["CmdOrCtrl+R"] },
  { id: "hardReloadBrowserPage", title: "Force Reload Browser Page", description: "Force reload the active browser page", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: ["CmdOrCtrl+Shift+R"] },
  { id: "newWindow", title: "New Window", description: "Open a new window", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: [] },
  { id: "openCommandMenu", title: "Open command menu", description: "Open the command menu", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: ["CmdOrCtrl+K", "CmdOrCtrl+Shift+P"] },
  { id: "searchFiles", title: "Search Files…", description: "Search files", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: ["CmdOrCtrl+P"], relatedCurrentCommandId: "files" },
  { id: "renameThread", title: "Rename chat", description: "Rename the current chat", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: ["CmdOrCtrl+Alt+R"] },
  { id: "toggleFileTreePanel", title: "Toggle File Tree", description: "Toggle the file tree panel", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: ["CmdOrCtrl+Shift+E"] },
  { id: "toggleTraceRecording", title: "Start Trace Recording", description: "Start or stop trace recording", group: "ungrouped", referenceFamily: "electron-only", referenceDefaults: ["CmdOrCtrl+Shift+S"] },
  { id: "newTask", title: "New chat", description: "Start a new chat", group: "thread", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+N", "CmdOrCtrl+Shift+O"], relatedCurrentCommandId: "new-chat" },
  { id: "newProjectlessTask", title: "New standalone chat", description: "Start a new chat outside of any project", group: "thread", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+O"] },
  { id: "quickChat", title: "Quick chat", description: "Start a lightweight chat in the quick composer", group: "thread", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+N"] },
  { id: "temporaryChat", title: "New Temporary Chat", description: "Start a chat that won't appear in history", group: "thread", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Shift+N"] },
  { id: "openThreadInNewWindow", title: "Open in new window", description: "Open the current chat in a new window", group: "thread", referenceFamily: "webview", referenceDefaults: [] },
  { id: "archiveThread", title: "Archive chat", description: "Archive the current chat", group: "thread", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Shift+A"] },
  { id: "markThreadUnread", title: "Mark as unread", description: "Mark the current chat as unread", group: "thread", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Shift+U"] },
  { id: "toggleThreadPin", title: "Toggle pin", description: "Pin or unpin the current chat", group: "thread", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+P"] },
  { id: "copyConversationMarkdown", title: "Copy as Markdown", description: "Copy the current chat as Markdown", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "openSideChat", title: "Open side chat", description: "Open the current chat in a side chat", group: "thread", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+S"], relatedCurrentCommandId: "side-chat" },
  { id: "openControlWindow", title: "Open control window", description: "Open the voice chat control window", group: "app", referenceFamily: "webview", referenceDefaults: [] },
  { id: "toggleDebugModal", title: "Toggle debug panel", description: "Show or hide the internal debug panel", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["Ctrl+D"] },
  { id: "undoAppAction", title: "Undo last action", description: "Undo the most recent app action", group: "app", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Z"] },
  { id: "redoAppAction", title: "Redo last action", description: "Redo the most recently undone app action", group: "app", referenceFamily: "webview", referenceDefaults: ["Command+Shift+Z"] },
  { id: "reopenClosedTab", title: "Reopen closed tab", description: "Reopen the most recently closed tab", group: "panels", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Shift+T"] },
  { id: "composer.openModelPicker", title: "Open model picker", description: "Open the composer model picker", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["Ctrl+Shift+M"] },
  { id: "composer.openProjectPicker", title: "Open project picker", description: "Open the composer project picker", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+Shift+O"] },
  { id: "composer.startVoiceMode", title: "Toggle voice chat", description: "Start or stop voice chat", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["Ctrl+Shift+V"], goalExclusion: "realtime-voice" },
  { id: "realtimeVoice.toggleMicrophoneMute", title: "Toggle Voice Chat microphone", description: "Mute or unmute your microphone during a Voice Chat", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [], goalExclusion: "realtime-voice" },
  { id: "realtimeVoice.toggleOutputMute", title: "Toggle Voice Chat audio", description: "Mute or unmute Voice Chat audio", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [], goalExclusion: "realtime-voice" },
  { id: "realtimeVoice.endCall", title: "End Voice Chat", description: "End the active Voice Chat", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [], goalExclusion: "realtime-voice" },
  { id: "composer.startDictation", title: "Start dictation", description: "Start dictation in the current composer", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["Ctrl+Shift+D"] },
  { id: "composer.submitInBackground", title: "Send message in background", description: "Send the current composer message without opening its chat", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Enter"] },
  { id: "composer.submit", title: "Send message", description: "Send the current composer message", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "composer.steer", title: "Steer prompt", description: "Submit the current composer prompt as a steering message", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "composer.queue", title: "Queue prompt", description: "Submit the current composer prompt as a queued message", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "composer.clear", title: "Clear prompt", description: "Clear the current composer prompt", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "composer.addPhotos", title: "Add photos", description: "Add photos to the active composer", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "composer.captureAppshot", title: "Capture appshot", description: "Capture an appshot for the active composer", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [], configurable: false },
  { id: "composer.addFiles", title: "Attach files and folders", description: "Attach files and folders to the active composer", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "composer.toggleFastMode", title: "Toggle Fast mode", description: "Turn Fast mode on or off in the current composer", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "composer.increaseReasoningEffort", title: "Increase reasoning effort", description: "Increase the current composer reasoning effort", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "composer.decreaseReasoningEffort", title: "Decrease reasoning effort", description: "Decrease the current composer reasoning effort", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "composer.cycleReasoningEffort", title: "Cycle reasoning effort", description: "Cycle through composer reasoning effort options", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "composer.togglePlanMode", title: "Toggle plan mode", description: "Turn plan mode on or off in the current composer", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "composer.toggleWorktreeMode", title: "Toggle Local/Worktree", description: "Switch the current composer between local and a new worktree", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "composer.toggleWorkRunLocation", title: "Toggle Cloud/Local", description: "Switch ChatGPT Work between cloud and local execution", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "approval.approve", title: "Approve request", description: "Approve the active request", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["Enter"] },
  { id: "approval.decline", title: "Decline request", description: "Decline the active request", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["Escape"] },
  { id: "git.commit", title: "Commit or push", description: "Open commit or push options", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "git.createPullRequest", title: "Create PR", description: "Open pull request creation options", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "git.createDraftPullRequest", title: "Create draft PR", description: "Open draft pull request creation options", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "git.createBranch", title: "Create branch", description: "Open branch creation options", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "git.mergePullRequest", title: "Merge PR", description: "Open pull request merge options", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "git.openPullRequest", title: "Open PR on GitHub", description: "Open the pull request linked to the current chat", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "git.toggleBlame", title: "Toggle Git blame", description: "Show or hide author and commit details for the active editor line", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "forkThread", title: "Fork chat", description: "Fork the current chat", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "openAvatarOverlay", title: "Show or hide pet", description: "Toggle the pet from anywhere", group: "app", referenceFamily: "webview", referenceDefaults: ["Ctrl+Space"], goalExclusion: "pets" },
  { id: "searchChats", title: "Switch chat…", description: "Search and switch to a chat", group: "navigation", referenceFamily: "webview", referenceDefaults: [], relatedCurrentCommandId: "search" },
  { id: "togglePriorityFilter", title: "Toggle activity view", description: "Turn the sidebar activity view on or off", group: "navigation", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+U"] },
  { id: "focusMainChat", title: "Focus main chat", description: "Move keyboard focus to the main chat composer", group: "navigation", referenceFamily: "webview", referenceDefaults: [] },
  { id: "focusSideChat", title: "Focus side chat", description: "Move keyboard focus to an open side chat composer", group: "navigation", referenceFamily: "webview", referenceDefaults: [] },
  { id: "nextThreadNeedingAttention", title: "Next chat needing attention", description: "Switch to the next chat awaiting input or with unread activity", group: "navigation", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+A"] },
  { id: "previousTab", title: "Previous tab", description: "Switch to the previous tab", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+Shift+Tab", "Command+Shift+[", "Command+Alt+Left"] },
  { id: "previousThread", title: "Previous chat", description: "Switch to the previous chat", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Command+Shift+[", "Command+Alt+Left"] },
  { id: "previousRecentThread", title: "Previous recently viewed chat", description: "Cycle to the previous recently viewed chat", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+Shift+Tab"] },
  { id: "nextTab", title: "Next tab", description: "Switch to the next tab", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+Tab", "Command+Shift+]", "Command+Alt+Right"] },
  { id: "nextThread", title: "Next chat", description: "Switch to the next chat", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Command+Shift+]", "Command+Alt+Right"] },
  { id: "nextRecentThread", title: "Next recently viewed chat", description: "Cycle to the next recently viewed chat", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+Tab"] },
  { id: "recentThread1", title: "Go to recent chat 1", description: "Open the recently updated chat in this shortcut slot", group: "navigation", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+1"] },
  { id: "recentThread2", title: "Go to recent chat 2", description: "Open the recently updated chat in this shortcut slot", group: "navigation", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+2"] },
  { id: "recentThread3", title: "Go to recent chat 3", description: "Open the recently updated chat in this shortcut slot", group: "navigation", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+3"] },
  { id: "recentThread4", title: "Go to recent chat 4", description: "Open the recently updated chat in this shortcut slot", group: "navigation", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+4"] },
  { id: "recentThread5", title: "Go to recent chat 5", description: "Open the recently updated chat in this shortcut slot", group: "navigation", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+5"] },
  { id: "recentThread6", title: "Go to recent chat 6", description: "Open the recently updated chat in this shortcut slot", group: "navigation", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+6"] },
  { id: "focusTab1", title: "Focus tab 1", description: "Focus the tab at this position in the task tab strip", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+1"], numberShortcutFamily: "tabs" },
  { id: "focusTab2", title: "Focus tab 2", description: "Focus the tab at this position in the task tab strip", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+2"], numberShortcutFamily: "tabs" },
  { id: "focusTab3", title: "Focus tab 3", description: "Focus the tab at this position in the task tab strip", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+3"], numberShortcutFamily: "tabs" },
  { id: "focusTab4", title: "Focus tab 4", description: "Focus the tab at this position in the task tab strip", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+4"], numberShortcutFamily: "tabs" },
  { id: "focusTab5", title: "Focus tab 5", description: "Focus the tab at this position in the task tab strip", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+5"], numberShortcutFamily: "tabs" },
  { id: "focusTab6", title: "Focus tab 6", description: "Focus the tab at this position in the task tab strip", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+6"], numberShortcutFamily: "tabs" },
  { id: "focusTab7", title: "Focus tab 7", description: "Focus the tab at this position in the task tab strip", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+7"], numberShortcutFamily: "tabs" },
  { id: "focusTab8", title: "Focus tab 8", description: "Focus the tab at this position in the task tab strip", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+8"], numberShortcutFamily: "tabs" },
  { id: "focusTab9", title: "Focus tab 9", description: "Focus the tab at this position in the task tab strip", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+9"], numberShortcutFamily: "tabs" },
  { id: "switchToMode1", title: "Switch to Chat", description: "Switch to Chat", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+1"], numberShortcutFamily: "mode" },
  { id: "switchToMode2", title: "Switch to Work", description: "Switch to Work", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+2"], numberShortcutFamily: "mode" },
  { id: "switchToMode3", title: "Switch to Codex", description: "Switch to Codex", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+3"], numberShortcutFamily: "mode" },
  { id: "settings", title: "Settings", description: "Open settings for Codex", group: "app", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+,"], relatedCurrentCommandId: "settings" },
  { id: "codexMicroSettings", title: "Codex Micro setup", description: "Open Codex Micro setup", group: "configure", referenceFamily: "webview", referenceDefaults: [], configurable: false },
  { id: "mcpSettings", title: "MCP", description: "Configure MCP servers", group: "configure", referenceFamily: "webview", referenceDefaults: [] },
  { id: "personalitySettings", title: "Personality", description: "Adjust tone and response style", group: "configure", referenceFamily: "webview", referenceDefaults: [] },
  { id: "importExternalAgent", title: "Import from other AI apps", description: "Import from other AI apps", group: "configure", referenceFamily: "webview", referenceDefaults: [] },
  { id: "keyboardShortcuts", title: "Keyboard shortcuts", description: "Customize keyboard shortcuts", group: "configure", referenceFamily: "webview", referenceDefaults: [] },
  { id: "showKeyboardShortcuts", title: "Show keyboard shortcuts", description: "Show the shortcuts available right now", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+/"] },
  { id: "clearAllUnreads", title: "Clear all unreads", description: "Mark all chats and scheduled task updates as read", group: "app", referenceFamily: "webview", referenceDefaults: ["Shift+Escape"] },
  { id: "manageTasks", title: "Manage scheduled tasks", description: "Create or manage scheduled tasks from the current page", group: "app", referenceFamily: "webview", referenceDefaults: [] },
  { id: "forceReloadSkills", title: "Force reload skills", description: "Refresh the skill catalog for the current context", group: "skills", referenceFamily: "webview", referenceDefaults: [] },
  { id: "openSkills", title: "Go to skills", description: "Browse installed and recommended skills", group: "skills", referenceFamily: "webview", referenceDefaults: [] },
  { id: "openFolder", title: "Open folder", description: "Add a local project to Codex", group: "workspace", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+O"] },
  { id: "toggleSidebar", title: "Toggle sidebar", description: "Show or hide the sidebar", group: "panels", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+B"], relatedCurrentCommandId: "sidebar" },
  { id: "toggleBottomPanel", title: "Toggle bottom panel", description: "Show or hide the bottom panel", group: "panels", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+J"] },
  { id: "togglePinnedSummary", title: "Toggle pinned summary", description: "Show or hide the pinned summary", group: "panels", referenceFamily: "webview", referenceDefaults: [] },
  { id: "toggleTerminal", title: "Open terminal", description: "Open the terminal panel", group: "panels", referenceFamily: "webview", referenceDefaults: ["Control+`"], relatedCurrentCommandId: "terminal" },
  { id: "openBrowserTab", title: "Open browser tab", description: "Open a new browser tab", group: "panels", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+T"], relatedCurrentCommandId: "browser" },
  { id: "closeOtherTabs", title: "Close other tabs", description: "Close all tabs except the active tab", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+W"] },
  { id: "stepWorkspaceLayout", title: "Step workspace layout", description: "Steps between fullscreen content, split view, and fullscreen Chat", group: "panels", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Shift+B"] },
  { id: "openReviewTab", title: "Open review tab", description: "Open the review tab", group: "panels", referenceFamily: "webview", referenceDefaults: ["Ctrl+Shift+G"], relatedCurrentCommandId: "review" },
  { id: "toggleReviewTab", title: "Toggle review", description: "Show or hide Review for the current Git-backed chat", group: "panels", referenceFamily: "webview", referenceDefaults: [] },
  { id: "toggleSidePanel", title: "Toggle Review panel", description: "Show or hide Review for the current chat", group: "panels", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+Alt+B"], relatedCurrentCommandId: "toggle-side-panel" },
  { id: "toggleMaximizeSidePanel", title: "Toggle maximize side panel", description: "Expand or restore the side panel", group: "ungrouped", referenceFamily: "webview", referenceDefaults: [] },
  { id: "file.goToDefinition", title: "Go to definition", description: "Open the definition of the selected file symbol", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Ctrl+]"] },
  { id: "file.navigateBack", title: "Go back in file navigation", description: "Return to the previous file location", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Control+-"] },
  { id: "file.navigateForward", title: "Go forward in file navigation", description: "Return to the next file location", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Control+Shift+-"] },
  { id: "findInThread", title: "Find", description: "Search the current chat", group: "navigation", referenceFamily: "webview", referenceDefaults: ["Command+F"] },
  { id: "goToLine", title: "Go to line", description: "Go to a line in the current file", group: "navigation", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+L"] },
  { id: "focusBrowserAddressBar", title: "Focus browser address bar", description: "Focus the in-app browser address bar", group: "navigation", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+L"] },
  { id: "navigateBrowserBack", title: "Browser back", description: "Go back in browser history", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["Command+Left"] },
  { id: "navigateBrowserForward", title: "Browser forward", description: "Go forward in browser history", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["Command+Right"] },
  { id: "navigateBack", title: "Back", description: "Go back in navigation history", group: "navigation", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+[", "MouseBack"] },
  { id: "navigateForward", title: "Forward", description: "Go forward in navigation history", group: "navigation", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+]", "MouseForward"] },
  { id: "logOut", title: "Log out", description: "Log out of Codex", group: "app", referenceFamily: "webview", referenceDefaults: [], goalExclusion: "openai-sign-in" },
  { id: "feedback", title: "Feedback", description: "Send product feedback to the ChatGPT team", group: "app", referenceFamily: "webview", referenceDefaults: [] },
  { id: "environmentAction1", title: "Environment action 1", description: "Run the environment action in this shortcut slot", group: "workspace", referenceFamily: "webview", referenceDefaults: ["Command+Shift+D"] },
  { id: "environmentAction2", title: "Environment action 2", description: "Run the environment action in this shortcut slot", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "environmentAction3", title: "Environment action 3", description: "Run the environment action in this shortcut slot", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "environmentAction4", title: "Environment action 4", description: "Run the environment action in this shortcut slot", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "environmentAction5", title: "Environment action 5", description: "Run the environment action in this shortcut slot", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "environmentAction6", title: "Environment action 6", description: "Run the environment action in this shortcut slot", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "environmentAction7", title: "Environment action 7", description: "Run the environment action in this shortcut slot", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "environmentAction8", title: "Environment action 8", description: "Run the environment action in this shortcut slot", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "environmentAction9", title: "Environment action 9", description: "Run the environment action in this shortcut slot", group: "workspace", referenceFamily: "webview", referenceDefaults: [] },
  { id: "thread1", title: "Go to chat 1", description: "Open the visible chat in this shortcut slot", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+1"], numberShortcutFamily: "sidebar" },
  { id: "thread2", title: "Go to chat 2", description: "Open the visible chat in this shortcut slot", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+2"], numberShortcutFamily: "sidebar" },
  { id: "thread3", title: "Go to chat 3", description: "Open the visible chat in this shortcut slot", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+3"], numberShortcutFamily: "sidebar" },
  { id: "thread4", title: "Go to chat 4", description: "Open the visible chat in this shortcut slot", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+4"], numberShortcutFamily: "sidebar" },
  { id: "thread5", title: "Go to chat 5", description: "Open the visible chat in this shortcut slot", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+5"], numberShortcutFamily: "sidebar" },
  { id: "thread6", title: "Go to chat 6", description: "Open the visible chat in this shortcut slot", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+6"], numberShortcutFamily: "sidebar" },
  { id: "thread7", title: "Go to chat 7", description: "Open the visible chat in this shortcut slot", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+7"], numberShortcutFamily: "sidebar" },
  { id: "thread8", title: "Go to chat 8", description: "Open the visible chat in this shortcut slot", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+8"], numberShortcutFamily: "sidebar" },
  { id: "thread9", title: "Go to chat 9", description: "Open the visible chat in this shortcut slot", group: "ungrouped", referenceFamily: "webview", referenceDefaults: ["CmdOrCtrl+9"], numberShortcutFamily: "sidebar" },
] as const;

const sharedBindings = [
  ["closeTab", "closeWindow"],
  ["nextTab", "nextThread"],
  ["nextTab", "nextRecentThread"],
  ["previousTab", "previousThread"],
  ["previousTab", "previousRecentThread"],
  ["goToLine", "focusBrowserAddressBar"],
  ["file.goToDefinition", "navigateForward"],
] as const;

function peersFor(id: string): string[] {
  const peers = new Set<string>();
  for (const group of sharedBindings) {
    if ((group as readonly string[]).includes(id)) for (const peer of group) if (peer !== id) peers.add(peer);
  }
  return [...peers];
}

function defaultsFor(command: ApplicationCommandMetadata, target: PrimaryNumberShortcutTarget): readonly string[] {
  const match = /^(?:focusTab|thread)([1-9])$/.exec(command.id);
  if (command.numberShortcutFamily === "tabs" && match) return [`${target === "tabs" ? "Command" : "Ctrl"}+${match[1]}`];
  if (command.numberShortcutFamily === "sidebar" && match) return [`${target === "sidebar" ? "Command" : "Ctrl"}+${match[1]}`];
  // Once a number target is selected, the source suppresses the three product-mode defaults.
  if (command.numberShortcutFamily === "mode") return [];
  return command.referenceDefaults;
}

/** Build the macOS admission registry using the same explicit number layout as its consumer. */
export function applicationCommandDefinitions(
  options: { primaryNumberShortcutTarget?: PrimaryNumberShortcutTarget } = {},
): readonly CommandBindingDefinition[] {
  const target = options.primaryNumberShortcutTarget ?? "tabs";
  return APPLICATION_COMMANDS.map(command => {
    const sharesBindingsWith = peersFor(command.id);
    const allowsOnlyOneBinding = command.id === "globalDictationHold" || command.id === "globalDictationToggle" || command.id === "realtimeVoice";
    return {
      id: command.id,
      defaults: defaultsFor(command, target),
      ...(sharesBindingsWith.length ? { sharesBindingsWith } : {}),
      ...(allowsOnlyOneBinding ? { multiple: false } : {}),
      ...(command.configurable === false || command.id === "findInThread" ? { configurable: false } : {}),
    };
  });
}

function firstStrokeIdentity(accelerator: string): string {
  return (accelerator.trim().split(/\s+/, 1)[0] ?? "").toLowerCase().split("+").map(part => {
    switch (part) {
      case "cmdorctrl": case "commandorcontrol": case "cmd": case "command": case "super": return "meta";
      case "control": return "ctrl";
      case "option": return "alt";
      default: return part;
    }
  }).sort().join("+");
}

function isPrimaryEnterFirstStroke(accelerator: string): boolean {
  const parts = (accelerator.trim().split(/\s+/, 1)[0] ?? "").split("+");
  if (parts.length !== 2 || !parts.some(part => part.toLowerCase() === "enter")) return false;
  const modifier = parts[0]?.toLowerCase() === "enter" ? parts[1] : parts[0];
  return modifier === "CmdOrCtrl" || modifier === "Command" || modifier === "Cmd";
}

/**
 * Resolve the pinned macOS conditional defaults without rewriting persisted overrides.
 * Known entries use the shared parser; unsupported future command IDs are validated and
 * retained as diagnostics, but never returned as executable bindings.
 */
export function resolveEffectiveApplicationBindings(
  keymap: CommandKeymap | undefined,
  options: { primaryNumberShortcutTarget?: PrimaryNumberShortcutTarget } = {},
): EffectiveApplicationBindings {
  const definitions = applicationCommandDefinitions(options);
  const knownIds = new Set(definitions.map(command => command.id));
  const overrides = keymap?.overrides ?? [];
  const seen = new Set<string>();
  const unsupportedOverrideCommandIds: string[] = [];
  const knownOverrides = [] as CommandKeymap["overrides"];
  const normalizedUnknownOverrides = new Map<string, string[]>();

  for (const override of overrides) {
    if (!override || typeof override.command !== "string" || !override.command.trim() || override.command.length > 256
      || /[\u0000-\u001f\u007f]/.test(override.command) || !Array.isArray(override.keys)
      || override.keys.some(key => typeof key !== "string")) {
      throw new KeybindingError("INVALID_KEYBINDING", "Invalid command shortcut override.");
    }
    if (seen.has(override.command)) throw new KeybindingError("INVALID_KEYBINDING", "A command has more than one override record.");
    seen.add(override.command);
    if (knownIds.has(override.command)) knownOverrides.push(override);
    else {
      unsupportedOverrideCommandIds.push(override.command);
      normalizedUnknownOverrides.set(override.command, override.keys.map(normalizeAccelerator));
    }
  }
  // Reuse the shared parser for known fixed-command, alternative-count and accelerator validation.
  const normalizedKnownOverrides = keymap
    ? parseCommandKeymap({ overrides: knownOverrides }, definitions, "mac").overrides
    : [];
  const workingOverrides = overrides.map(override => knownIds.has(override.command)
    ? normalizedKnownOverrides.find(value => value.command === override.command)!
    : { command: override.command, keys: normalizedUnknownOverrides.get(override.command)! });

  const explicitKeys = (command: string): readonly string[] | undefined =>
    workingOverrides.find(override => override.command === command)?.keys;
  const ownedByAnotherCommand = (command: string, predicate: (key: string) => boolean): boolean =>
    workingOverrides.some(override => override.command !== command && override.keys.some(predicate));

  const bindings = definitions.map(definition => {
    const explicit = explicitKeys(definition.id);
    if (explicit) return { command: definition.id, keys: [...explicit] };

    let keys = [...definition.defaults];
    if (definition.id === "composer.submitInBackground") {
      if (!keymap || ownedByAnotherCommand(definition.id, isPrimaryEnterFirstStroke)) keys = [];
    } else if (definition.id === "focusQuickChat" || APPLICATION_COMMANDS.find(command => command.id === definition.id)?.numberShortcutFamily === "tabs"
      || APPLICATION_COMMANDS.find(command => command.id === definition.id)?.numberShortcutFamily === "sidebar") {
      keys = keys.filter(key => !ownedByAnotherCommand(definition.id, candidate => firstStrokeIdentity(candidate) === firstStrokeIdentity(key)));
    }
    return { command: definition.id, keys };
  });

  return { definitions, bindings, unsupportedOverrideCommandIds };
}

/** Fixed macOS Find menu owners are outside the reference command catalogue and never render as app actions. */
export const APPLICATION_RESERVED_KEYBINDINGS = [
  { id: "reserved.findNext", defaults: ["Command+G"], configurable: false },
  { id: "reserved.findPrevious", defaults: ["Command+Shift+G"], configurable: false },
] as const satisfies readonly CommandBindingDefinition[];

/** The complete registry used when admitting edits, including non-catalogue platform reservations. */
export function applicationKeybindingAdmissionDefinitions(
  options: { primaryNumberShortcutTarget?: PrimaryNumberShortcutTarget } = {},
): readonly CommandBindingDefinition[] {
  return [...applicationCommandDefinitions(options), ...APPLICATION_RESERVED_KEYBINDINGS];
}
