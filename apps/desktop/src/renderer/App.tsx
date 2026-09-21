import { GoalComposerIntent } from "./GoalComposerIntent";
import { goalComposerCommand } from "./goal-composer";
import { ExtensionStatuses, ExtensionWidgets, useExtensionSessionUi } from "./ExtensionSessionUi";
import { SessionTreeHistory, SessionTreeEdit } from "./SessionTree";
import { useSessionTree, type SessionTreePorts } from "./use-session-tree";
import { parseSessionTreeResponse, type TreeMutationResult, type TreeTicket } from "../../../../packages/shared/src/session-tree";
import type { TodoEditorPorts } from "./todo-external-editor-state";
import { SessionExportDialog } from "./SessionExportDialog";
import { SessionUsagePanel } from "./SessionUsagePanel";
import { SessionUsageState } from "./session-usage-state";
import { usageResetArgument, nativeUsageResetWinner } from "./usage-reset-command";
import { sameDraftContent } from "./drafts";
import type { PlanEditorPorts } from "./plan-external-editor-state";
import { PlanExecutionContinuationControl, PlanReviewPanel } from "./PlanReviewPanel";
import { useSessionPlan, type SessionPlanPorts } from "./use-session-plan";
import type { PlanReviewPorts } from "./plan-review-model";
import type { SessionPlan } from "../../../../packages/shared/src/session-plan";
import { SessionTodosPanel } from "./SessionTodos";
import { SessionJobsPanel } from "./SessionJobsPanel";
import { SessionTodosModel, type SessionTodosPanelPorts } from "./session-todos-model";
import { useSessionTodos, type SessionTodosPorts } from "./use-session-todos";
import type { TodoMutationResult } from "../../../../packages/shared/src/session-todos";
import { ForceToolControl } from "./ForceToolControl";
import { forceCommandSpelling, nativeForceWinner, type NativeForceSubmission } from "./force-tool-submissions";
import type { ForceToolPorts, ForceToolSnapshot } from "./force-tool-state";
import { PullRequestComposers } from "./pull-request-composers";
import { PullRequestCache } from './pull-request-cache';
import { PullRequestsPage, PullRequestIcon } from './PullRequestsPage';
import type { PullRequestWindowView } from '../pull-request-window-state';
import { HtmlPreviewViews } from './html-preview-views';
import { useMcpDirectoryOwners } from "./use-mcp-directory-owners";
import { McpDirectoryConnection, McpDirectoryStatus } from "./McpDirectoryPanel";
import { useMcpAppCatalogue } from "./use-mcp-app-catalogue";
import { mcpAppActionId, mcpAppDockTab, mcpDirectoryAppDockTab, mcpArtifactDockTab, mcpFileViewerForPath, mcpFileViewerDockTab, mcpDirectoryFileViewerDockTab } from "./mcp-app-dock";
import { McpAppController } from "./mcp-app-controller";
import { McpAppPanel } from "./McpAppPanel";
import { AutomationsPage, type AutomationPageMemory } from './AutomationsPage';
import { AutomationRequests } from './automation-requests';
import { AUTOMATIONS_CAPABILITY, type AutomationsSnapshot } from '../../../../packages/shared/src/automations';
import { useSessionReadState } from "./use-session-read-state";
import { NotificationNavigationOwner } from "./notification-navigation-owner";
import { loadThemeFonts } from "./theme-fonts";
import { QueuedMessages } from "./QueuedMessages";
import { BrowserCloseFocus } from "./browser-close-focus";
import { BrowserCloseDockOwner } from "./browser-close-dock-owner";
import { BrowserSearchSelection } from "./browser-search-activation";
import { DraftBrowserDockController } from "./draft-browser-dock-controller";
import { DraftBrowserDockPanel } from "./DraftBrowserDockPanel";
import { createDraftBrowserDockTab } from "./draft-browser-dock";
import { draftBrowserDockTarget, draftBrowserIdFromDock } from "./dock-state";
import { hasRemoteExecution } from "../../../../packages/shared/src/new-chat";
import { remoteWorktreeIssue, remoteWorktreeResumeIssue } from "./worktree-starting-availability";
import { BranchSwitchDialog, type BranchSwitchRequest } from "./BranchSwitchDialog";
import { TerminalWindowOwner } from "./terminal-window-owner";
import { TerminalRequestRecovery } from "./TerminalRequestRecovery";
import type { TerminalWindowIntent } from "../terminal-window-intent";
import { captureBrowserReplacement } from "./browser-workspace-replacement";
import { BrowserWindowCheckpoint } from "./browser-window-checkpoint";
import { useTaskPaneDrag } from "./use-task-pane-drag";
import { TaskPaneDropPreview } from "./TaskPaneDropPreview";
import { useTaskPlacementMenu } from "./use-task-placement-menu";
import { resolveContentSide, setContentSide, placeTask, taskDropGeometry, paneDropAt, taskDropDestinations } from "./content-side-placement";
import { taskShortcutHintLabels } from "./task-shortcut-hints";
import { useTaskShortcutHints } from "./use-task-shortcut-hints";
import { readTaskLayoutActivation, type TaskLayoutActivation, mainTaskLayoutChange, unifiedMainTaskStrip, adjacentMainTask, mainTaskContainsFocus, mainTaskTargets, numberedMainTaskActions, activateMainTask, focusMainTask, type MainTaskTarget, type MainChatTarget } from "./main-task-targets";
import { workspaceLayoutStepAvailable } from "./workspace-layout-step";
import { commandMenuRecents } from "./command-menu-recents";
import { CommandMenu } from "./CommandMenu";
import { CommandMenuSearchButton } from "./CommandMenuSearchButton";
import { activateBrowserSearchTab } from "./command-browser-tabs";
import { BrowserSearchRegistry } from "./browser-search-registry";
import { browserSearchPresentationKey } from "./command-browser-tabs";
import { captureDockPresentation, isCurrentDockPresentation, type DockPresentationRef } from "./dock-presentations";
import { draftBrowserSearchEntries } from "./draft-browser-search";
import { useCommandBrowserTabs } from "./use-command-browser-tabs";
import { APPLICATION_COMMANDS } from "../../../../packages/shared/src/application-commands";
import { ComposerEditor, type ComposerEditorHandle } from "./ComposerEditor";
import { useHeaderContextMenu } from "./use-header-context-menu";
import { effectiveSendMode, submissionForEnter } from "./follow-up-submit";
import { createTranscriptImageResolver } from "./transcript-image-source";
import { remapFileOffsets } from "./composer-document";
import { appendWholeFile, wholeFileSendIssue, wholeFileOpenTarget } from "./whole-file-composer";
import { ComposerSelectedText } from "./ComposerSelectedText";
import { appendSelectedText, selectedTextSendIssue } from "./selected-text-composer";
import type { FileTextSelection } from "@agent-desktop/shared";
import { NativeSkillFileController } from "./native-skill-file-state";
import { NativeSkillFilePanel } from "./NativeSkillFilePanel";
import type { NativeSkillFileRef } from "@agent-desktop/shared";
import { PendingMcpAuthorization } from "./SessionMcpAuthorization";
import { EnvironmentActions, environmentActionCommands } from "./EnvironmentActions";
import { branchCreationCommand } from "./BranchSelector";
import { goToLineCommand } from "./GoToLine";
import { captureFileEditorCommands, focusedFileEditorCommands, type CapturedFileEditorCommands, type FileEditorCommandActions, type FileEditorShortcut } from "./SymbolNavigationControls";
import { workspaceGitBlameCommand } from "./WorkspaceGitFilePanel";
import { GoalStrip } from "./GoalStrip";
import { GoalPanel } from "./GoalPanel";
import { useId, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Draft, Project, SessionSummary } from "../../../../packages/shared/src/protocol";
import { readWindowRestoration, useWindowViewPersistence } from "./window-view-state";
import { defaultFileTreeView, defaultCollapsedSidebarSections, type SidebarSectionKey, type EnvironmentSectionKey, type SettingsPage, type WindowNavigation, type WorkspaceTab } from "../window-state";
import { prepareSkillDraft } from "./skill-draft";
import type { ComposerAction } from "@agent-desktop/shared";
import { DraftController, hasDraftContent } from "./drafts";
import { DraftBrowserWindowOwner } from "./draft-browser-window-owner";
import { DraftBrowserWindowPages } from "./draft-browser-window-pages";
import { EnvironmentPreparationPause, SubmissionController } from "./submissions";
import { EnvironmentCatalog } from "./environment-catalog";
import { EnvironmentPreparationCard } from "./EnvironmentPreparationCard";
import { ComposerCatalogState, composerSelection, composerTargetKey } from "./composer-catalog";
import { ComposerSelections } from "./ComposerSelections";
import { AdvancedStreamControls } from "./AdvancedStreamControls";
import { useComposerAutocomplete } from "./ComposerAutocomplete";
import { approvalModes, composerApproval } from "./ComposerPermissions";
import { DraftSnapshot } from "./DraftSnapshot";
import { createAttachmentCache } from "./attachment-cache";
import { AttachmentComposer, attachmentDraftSender, imageCapabilityIssue, imageSendIssue } from "./attachment-composer";
import { ComposerImages, type ComposerImagesHandle } from "./ComposerImages";
import type { ComposerSelectionPopupHandle } from "./ComposerSelectionPopup";
import type { AttachmentMediaContext } from "./attachment-media";
import { installAppShortcuts, type AppShortcutOptions } from "./app-shortcuts";
import { errorMessage, useDesktop, useTranscript } from "./desktop-state";
import { actionError as ownedActionError, clearRecoveredForceError, type ActionError } from "./action-error";
import { captureConversationMarkdown, conversationMarkdownIssue } from "./conversation-markdown";
import { Icon } from "./Icons";
import { TranscriptMessages } from "./Transcript";
import type { TurnReviewOpenRequest } from "../../../../packages/shared/src/turn-review";
import { useTranscriptScroll } from "./use-transcript-scroll";
import "./transcript-scroll.css";
import { AccountsSettings } from "./AccountsSettings";
import { PendingInteractions, approvalCommands } from "./PendingInteractions";
import { ComposerContext, type ComposerContextHandle } from "./ComposerContext";
import { PendingDetachedQuestions } from "./DetachedQuestionCard";
import { WorkspacePanel } from "./WorkspacePanel";
import { WorkspaceFileBrowser } from "./WorkspaceFileBrowser";
import { WorkspaceFileSearch } from "./WorkspaceFileSearch";
import { canReplaceFilePreview } from "./file-preview-tabs";
import { routedTranscriptHostFileActions } from "./transcript-file-actions";
import { resolveTranscriptLink, type TranscriptLinkActions, type WorkspaceFileRequest } from "./transcript-links";
import { WorkspaceState, workspaceKey } from "./workspace-state";
import { offlineCache } from "./offline-cache";
import { PreferencesState } from "./preferences-state";
import { CommandKeymapState } from "./command-keymap-state";
import { observeCommandKeymap } from "./command-keymap-observer";
import { readAppCommandBindings, appCommandShortcutLabel, APP_COMMAND_BINDING_OWNERS } from "./app-command-bindings";
import { KeyboardShortcutsSettings } from "./KeyboardShortcutsSettings";
import { SidebarNavigationIcon } from "./SidebarNavigationIcon";
import { OrganizedSidebar } from "./OrganizedSidebar";
import { moveSidebarItem, sidebarLayout, sidebarChatActions } from "./sidebar-layout";
import { sessionUnreadKey } from "./session-read-state";
import { SidebarNavigation } from "./SidebarNavigation";
import { useSidebarNavigation } from "./use-sidebar-navigation";
import { SidebarActivity, SidebarActivityIcon } from "./SidebarActivity";
import { sidebarActivity } from "./sidebar-activity";
import { NativeSettings } from "./NativeSettings";
import { GeneralSettings } from "./GeneralSettings";
import { GitSettings } from "./GitSettings";
import { SettingsSidebar } from "./SettingsSidebar";
import { ProfileMenu } from "./ProfileMenu";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { LocalEnvironmentSettings } from "./LocalEnvironmentSettings";
import { NativePluginBrowser } from "./NativePluginBrowser";
import { NativeIntegrations } from "./NativeIntegrations";
import { ThemeSettings } from "./ThemeSettings";
import { ThemeEditor } from "./theme-state";
import { ThemeImageState } from "./theme-image-state";
import { applyTheme } from "./theme-application";
import { cssColorToRgba } from "./css-color";
import { transcriptSources, type RecordedSource } from "./transcript-sources";
import { ImagePreview } from "./ImagePreview";
import { DockPanel, type DockPanelCommands, type DockAddAction, type DockDragTask } from "./DockPanel";
import { useSuggestedOutputs } from "./use-suggested-outputs";
import { DockEmptyActions } from "./DockEmptyActions";
import { dockEmptyActionCatalogue } from "./dock-empty-action-model";
import { useWindowClose } from "./WindowClose";
import { useWorkspaceFileClose } from "./WorkspaceFileClose";
import { DockTerminal } from "./DockTerminal";
import { hasNativeTerminalBridge } from "./native-terminal-state";
import { dockTabId, moveDockTab, type DockTab, type DockDestination } from "./dock-state";
import { useWorkbenchDock, targetFromDock, type TerminalPreparation } from "./use-workbench-dock";
import { EnvironmentCard } from "./EnvironmentCard";
import { useTaskLocation } from "./task-location-state";
import { SideChat, sideChatFocusCommand } from "./SideChat";
import { BtwState } from "./btw-state";
import { SessionFork, forkSlashQueryRemoval, type SessionForkMenuRequest } from "./SessionFork";
import { SessionForkState, type ForkExecution } from "./session-fork-state";
import { nativeBtwQuestion } from "../../../../packages/shared/src/btw";
import { assertComposerOwner } from "./composer-autocomplete";
import { BrowserPanel, browserPanelCommands } from "./BrowserPanel";
import { BrowserNewTabPanel } from "./BrowserNewTabPanel";
import { BrowserWorkspaceMenu, browserWorkspaceRows } from "./browser-workspace-menu";
import { prepareBrowserReplacementFocus, rememberBrowserAddressFocus } from "./browser-replacement-admission";
import { DockTabIcon } from "./DockTabIcon";
import { browserAddressFocusOwner, browserAddressTarget, withBrowserAddressShortcut } from "./browser-address-focus";
import { useSessionActivity } from "./use-session-activity";
import { retainWorkspace } from "./workspace-lease";
import { GitSubmissionDialog, GitSubmissionFeedback } from "./GitSubmissionDialog";
import "./dock-layout.css";
import { DEFAULT_THEME } from "../../../../packages/shared/src/theme";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace-protocol";
import type { NewChatExecution } from "../../../../packages/shared/src/new-chat";
import { Welcome } from "./Welcome";
import { applyProjectExecutionMode, executionModeLabel, projectExecutionModeDraftId, projectExecutionModeView, resolveProjectExecutionMode, sameModeConflict, selectProjectExecutionMode, selectProjectWithExecutionMode } from "./project-execution-mode";

export function App() {
  const composerContext = useRef<ComposerContextHandle>(null);
  const composerSelections = useRef<ComposerSelectionPopupHandle>(null);
  const composerImages = useRef<ComposerImagesHandle>(null);
  const rightDockCommands = useRef<DockPanelCommands>(null);
  const bottomDockCommands = useRef<DockPanelCommands>(null);
  const bridge = window.agentDesktop;
  const [windowRestoration] = useState(readWindowRestoration);
  const [browserWindowCheckpoint] = useState(() => new BrowserWindowCheckpoint());
  const [route, setRoute] = useState<WindowNavigation>(windowRestoration.state.route);
  const selectedId = route.sessionId;
  const desktop = useDesktop(bridge, route.hostId);
  const { state, connected, loading, refresh, command } = desktop;
  const routeKey = `${route.hostId ?? desktop.localHostId ?? ""}:${selectedId ?? ""}`;
  const selectedRef = useRef(routeKey); selectedRef.current = routeKey;
  const usageRoute = useRef({ key: routeKey });
  if (usageRoute.current.key !== routeKey) usageRoute.current = { key: routeKey };
  const [sidebarOpen, setSidebarOpen] = useState(windowRestoration.state.sidebarOpen);
  const [sidebarActivityOpen, setSidebarActivityOpen] = useState(false);
  const [commandMenuMode, setCommandMenuMode] = useState<"commands" | "chats">();
  const commandMenuOrigin = useRef<Element | null>(null);
  const commandMenuGitBlame = useRef<(() => void) | undefined>(undefined);
  const commandMenuFileEditor = useRef<CapturedFileEditorCommands | undefined>(undefined);
  const openCommandMenu = (mode: "commands" | "chats", capturedFileEditor?: CapturedFileEditorCommands | null) => {
    commandMenuOrigin.current = document.activeElement;
    commandMenuGitBlame.current = workbenchElement.current ? workspaceGitBlameCommand(workbenchElement.current, commandMenuOrigin.current) : undefined;
    commandMenuFileEditor.current = capturedFileEditor === undefined
      ? (workbenchElement.current ? captureFileEditorCommands(workbenchElement.current, document.activeElement) : undefined)
      : capturedFileEditor ?? undefined;
    setCommandMenuMode(mode);
  };
  const [fileSearchOwner, setFileSearchOwner] = useState<string>();
  const [showArchived, setShowArchived] = useState(windowRestoration.state.showArchived);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set(windowRestoration.state.expandedProjects));
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState<Set<SidebarSectionKey>>(() => new Set(windowRestoration.state.collapsedSidebarSections ?? defaultCollapsedSidebarSections()));
  const [actionError, setActionErrorState] = useState<ActionError | null>(null);
  const setActionError = useCallback((message: string | null) => setActionErrorState(message === null ? null : ownedActionError(message)), []);
  const markdownCopyRoute = useRef({ key: routeKey });
  if (markdownCopyRoute.current.key !== routeKey) markdownCopyRoute.current = { key: routeKey };
  const [markdownCopy, setMarkdownCopy] = useState<{ owner: { key: string }; state: "copying" | "copied" | "failed"; message: string } | null>(null);
  const markdownCopyPending = useRef<object | null>(null);
  const clipboardWritePending = useRef(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [addingProject, setAddingProject] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "status" | "project" | null>(null);
  const [remotePath, setRemotePath] = useState("");
  const [renameTitle, setRenameTitle] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [usageOwner, setUsageOwner] = useState<{ hostId: string; sessionId: string; hostName: string; controller?: SessionUsageState }>();
  const [pluginDirectoryOpen,setPluginDirectoryOpen]=useState(windowRestoration.state.pluginDirectoryOpen??false);
  const [pullRequestsOpen, setPullRequestsOpen] = useState(windowRestoration.state.pullRequestsOpen ?? false);
  const pullRequestCache = useRef(new PullRequestCache());
  const [, redrawPullRequestComposers] = useState(0);
  const [pullRequestComposers] = useState(() => new PullRequestComposers(windowRestoration.state.pullRequestComposers ?? [], () => redrawPullRequestComposers(value => value + 1)));
  const [pullRequestViews, setPullRequestViews] = useState<PullRequestWindowView[]>(windowRestoration.state.pullRequestViews ?? []);
  const [automationsOpen, setAutomationsOpen] = useState(windowRestoration.state.automationsOpen ?? false);
  const [, redrawAutomations] = useState(0);
  const [automationRequests] = useState(() => new AutomationRequests(windowRestoration.state.automationRequests ?? [], () => redrawAutomations(value => value + 1)));
  const automationViews = useRef(new Map<string, AutomationPageMemory>());
  const automationCache = useRef(new Map<string, AutomationsSnapshot>());
  const [pluginDirectoryTab,setPluginDirectoryTab]=useState<"plugins"|"skills">(windowRestoration.state.pluginDirectoryTab??"plugins");
  const [skillRefresh, setSkillRefresh] = useState(0);
  const [integrationSelection,setIntegrationSelection]=useState<{hostId:string;pluginId?:string;marketplace?:{name?:string;add?:boolean}}>();
  const [settingsOpen, setSettingsOpen] = useState(windowRestoration.state.settingsOpen);
  const contentOverlayOpen = settingsOpen || pluginDirectoryOpen || automationsOpen || pullRequestsOpen;
  const [settingsPage, setSettingsPage] = useState<SettingsPage>(windowRestoration.state.settingsPage);
  const [environmentProject, setEnvironmentProject] = useState<{hostId:string;projectId:string}>();
  const projectAddContext = useRef<{hostId:string;environments:boolean} | undefined>(undefined);
  const settingsOriginLabel = useRef<string | null>(null);
  const settingsWasOpen = useRef(false);
  const skillFileFocusPending = useRef(false);
  const openSettings = useCallback(() => {
    settingsOriginLabel.current = document.activeElement?.getAttribute("aria-label") ?? null;
    setAutomationsOpen(false); setPullRequestsOpen(false); setSettingsOpen(true);
  }, []);
  const openAutomations = () => { setAutomationsOpen(true); setPullRequestsOpen(false); setPluginDirectoryOpen(false); setSettingsOpen(false); };
  useEffect(() => {
    const closing = settingsWasOpen.current && !settingsOpen;
    settingsWasOpen.current = settingsOpen;
    if (!closing) return;
    const frame = requestAnimationFrame(() => {
      if(skillFileFocusPending.current){const panel=document.querySelector<HTMLElement>(".dock-panel-right .native-skill-file-panel");if(panel){skillFileFocusPending.current=false;panel.focus();return;}}
      const origin = settingsOriginLabel.current ? document.querySelector<HTMLElement>(`[aria-label="${CSS.escape(settingsOriginLabel.current)}"]`) : null;
      (origin ?? (settingsPage === "git" ? document.querySelector<HTMLElement>('[aria-label="Switch branch"]') : null) ?? textarea.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [settingsOpen]);
  const [workspaceFileRequest, setWorkspaceFileRequest] = useState<{ owner: string; request: WorkspaceFileRequest }>();
  const [fileTree, setFileTree] = useState({ ...defaultFileTreeView(), open: windowRestoration.state.fileTreeOpen ?? false });
  const [environmentOpen, setEnvironmentOpen] = useState(windowRestoration.state.environmentOpen ?? false);
  const [environmentCollapsed, setEnvironmentCollapsed] = useState<EnvironmentSectionKey[]>(windowRestoration.state.environmentCollapsed ?? []);
  const [sourcePreview, setSourcePreview] = useState<{hostId:string;source:Extract<RecordedSource,{kind:"image"}>;current?:()=>boolean}>();
  const [commitRequest, setCommitRequest] = useState<{owner:string;id:string}>();
  const [turnReviewRequest, setTurnReviewRequest] = useState<{owner:string;request:TurnReviewOpenRequest & {id:string}}>();
  const [gitDialog, setGitDialog] = useState<{ data: WorkspaceState; navigationOwner?: string; id: string }>();
  const branchSwitchOwner = useRef<{ workspace?: WorkspaceState; enabled: boolean }>({ enabled: false });
  const [branchSwitch, setBranchSwitch] = useState<{ request: BranchSwitchRequest; owner: typeof branchSwitchOwner.current }>();
  const [gitFeedback, setGitFeedback] = useState<{ data: WorkspaceState; label: string }>();
  const workbenchElement = useRef<HTMLDivElement>(null);
  const [dockViewport, setDockViewport] = useState({ width: 1000, height: 800, left: 0, top: 0 });
  useEffect(() => {
    const element = workbenchElement.current; if (!element) return;
    const read = () => { const rect = element.getBoundingClientRect(); setDockViewport({ width:rect.width,height:rect.height,left:rect.left,top:rect.top }); };
    const observer = new ResizeObserver(read); observer.observe(element); read();
    window.addEventListener("resize",read); return () => { observer.disconnect();window.removeEventListener("resize",read); };
  }, [sidebarOpen]);
  const expandAfterNavigation = useRef<string | undefined>(undefined);
  const workspaces = useMemo(() => new Map<string, WorkspaceState>(), [bridge]);
  const skillFiles = useMemo(() => new Map<string, NativeSkillFileController>(), [bridge]);
  const fileClose = useWorkspaceFileClose(tab => tab.target === "host" ? undefined : workspaces.get(`${tab.hostId}:${tab.target}`),tab=>skillFiles.get(tab.id));
  useEffect(() => { for (const controller of skillFiles.values()) controller.setConnected(Boolean(desktop.catalog.records.get(controller.state.hostId)?.connected)); });
  useEffect(() => () => { for (const controller of skillFiles.values()) controller.dispose(); }, [skillFiles]);
  const textarea = useRef<ComposerEditorHandle>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [, redraw] = useReducer(value => value + 1, 0);
  const preferences = useMemo(() => new PreferencesState(bridge, offlineCache, { read: key => localStorage.getItem(key), write: (key, value) => localStorage.setItem(key, value) }), [bridge]);
  const localConnected = Boolean(desktop.localHostId && desktop.catalog.records.get(desktop.localHostId)?.connected);
  const sidebarNavigation = useSidebarNavigation(bridge, desktop.localHostId, localConnected, desktop.localHostId ? desktop.catalog.records.get(desktop.localHostId)?.state?.sidebarNavigation?.version === 1 : false);
  const commandKeymap = useMemo(() => windowRestoration.ownerSlot ? new CommandKeymapState(windowRestoration.ownerSlot, bridge, offlineCache, { read: key => localStorage.getItem(key), write: (key, value) => localStorage.setItem(key, value) }) : undefined, [bridge, windowRestoration.ownerSlot]);
  const keymapCapability = desktop.localHostId ? desktop.catalog.records.get(desktop.localHostId)?.state?.commandKeybindings : undefined;
  useEffect(() => {
    if (!commandKeymap) return;
    const off = commandKeymap.subscribe(redraw);
    commandKeymap.setConnection(desktop.localHostId, localConnected, keymapCapability);
    const observer = observeCommandKeymap(commandKeymap, bridge);
    void observer.refresh();
    return () => { observer.stop(); off(); };
  }, [commandKeymap, bridge, desktop.localHostId, localConnected, keymapCapability?.commandVersion, keymapCapability?.snapshotVersion, keymapCapability?.numberTargetVersion]);
  useEffect(() => { const off = preferences.subscribe(redraw); preferences.start(); void preferences.restore().then(() => preferences.refresh()); return () => { off(); preferences.stop(); }; }, [preferences]);
  useEffect(() => { preferences.setConnection(desktop.localHostId, localConnected); if (localConnected) void preferences.refresh(); }, [preferences, desktop.localHostId, localConnected]);
  const theme = useMemo(() => new ThemeEditor(bridge, { read: key => localStorage.getItem(key), write: (key, value) => localStorage.setItem(key, value) }), [bridge]);
  const [localFonts, setLocalFonts] = useState<string[]>([]);
  const [localFontFaces, setLocalFontFaces] = useState<import("../../../../packages/shared/src/appearance").LocalFontFace[]>([]);
  const [fontsError, setFontsError] = useState<string>();
  const [themeEffectsError, setThemeEffectsError] = useState<string>();
  const refreshFonts = useCallback(() => { setFontsError(undefined); void Promise.all([bridge.getLocalFonts(), bridge.getLocalFontFaces?.() ?? Promise.resolve([])]).then(([families, faces]) => { setLocalFonts(families); setLocalFontFaces(faces); }, cause => setFontsError(errorMessage(cause))); }, [bridge]);
  useEffect(() => { const off = theme.subscribe(redraw); void theme.refresh(); refreshFonts(); return off; }, [theme, refreshFonts]);
  useEffect(() => { const off = bridge.subscribe(event => { if (event.type === "preferences" && (event.hostId ?? desktop.localHostId) === desktop.localHostId) void theme.refresh(); }); if (localConnected) void theme.refresh(); return off; }, [bridge, theme, desktop.localHostId, localConnected]);
  const themeImage = useMemo(() => new ThemeImageState(bridge), [bridge]);
  useEffect(() => themeImage.subscribe(redraw), [themeImage]);
  useEffect(() => bridge.subscribe(event => { if (event.type === "preferences" && (event.hostId ?? desktop.localHostId) === desktop.localHostId) void themeImage.refresh(); }), [bridge, themeImage, desktop.localHostId]);
  const appliedTheme = settingsOpen && settingsPage === "appearance" ? theme.preview : theme.current?.document ?? DEFAULT_THEME;
  const imageHash = appliedTheme.background.kind === "asset" ? appliedTheme.background.sha256 : undefined;
  useEffect(() => { themeImage.select(imageHash); }, [themeImage, imageHash]);
  useEffect(() => { if (localConnected) void themeImage.refresh(); }, [themeImage, localConnected]);
  useEffect(() => bridge.subscribeWindowTheme?.(opaqueWindows => {
    document.documentElement.dataset.opaqueWindowSurface = String(opaqueWindows);
  }), [bridge]);
  useEffect(() => {
    let cancelled = false, application = 0;
    const apply = () => {
      const version = ++application;
      let backgroundColor: string;
      let effectiveTheme = appliedTheme;
      try { effectiveTheme = applyTheme(appliedTheme); backgroundColor = cssColorToRgba(getComputedStyle(document.documentElement).getPropertyValue("--app-surface").trim()); }
      catch (cause) { setThemeEffectsError(errorMessage(cause)); return; }
      const fonts = effectiveTheme.appearance?.[document.documentElement.dataset.resolvedTheme === "dark" ? "dark" : "light"].fonts;
      void Promise.all([fonts ? loadThemeFonts(Object.values(fonts)) : Promise.resolve(), bridge.applyWindowTheme({ material: appliedTheme.material, opaqueWindows: effectiveTheme.opaqueWindows, backgroundColor })]).then(() => { if (!cancelled && version === application) setThemeEffectsError(undefined); }, cause => { if (!cancelled && version === application) setThemeEffectsError(errorMessage(cause)); });
    };
    apply(); const systemScheme = matchMedia("(prefers-color-scheme: dark)"); systemScheme.addEventListener("change", apply);
    return () => { cancelled = true; systemScheme.removeEventListener("change", apply); };
  }, [bridge, appliedTheme]);
  const sendBehavior = preferences.get("general.sendBehavior") ?? "enter";
  const followUpQueueMode = preferences.get("general.followUpQueueMode") ?? "steer";
  const reduceMotion = preferences.get("general.reduceMotion") ?? false;
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { const mode = appliedTheme.appearance?.reducedMotion; document.documentElement.dataset.reduceMotion = String(mode === "system" ? media.matches : mode ? mode === "on" : reduceMotion); };
    update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update);
  }, [reduceMotion, appliedTheme.appearance?.reducedMotion]);
  const hostId = route.hostId ?? state?.host.id ?? desktop.localHostId ?? "unconnected";
  const imageResources = useMemo(() => ({ cache: createAttachmentCache(), mounted: false }), [bridge]);
  const imageCache = imageResources.cache;
  const attachmentMedia = useMemo<AttachmentMediaContext>(() => ({ bridge, cache: imageCache }), [bridge, imageCache]);
  useEffect(() => {
    imageResources.mounted = true;
    return () => { imageResources.mounted = false; queueMicrotask(() => { if (!imageResources.mounted) imageResources.cache.close(); }); };
  }, [imageResources]);
  const stores = useMemo(() => new Map<string, { drafts: DraftController; submissions: SubmissionController; state?: typeof state; connected?: boolean }>(), [bridge]);
  const sideChatControllers = useMemo(() => new Map<string, BtwState>(), [bridge]);
  const [exportOwner, setExportOwner] = useState<{ hostId: string; sessionId: string; commandId?: string }>();
  const forkControllers = useMemo(() => new Map<string, SessionForkState>(), [bridge]);
  function controllers(owner: string) {
    let pair = stores.get(owner);
    if (!pair) {
      const cache = { read: (key: string) => localStorage.getItem(key), write: (key: string, value: string) => localStorage.setItem(key, value) };
      pair = { drafts: new DraftController(attachmentDraftSender(owner, attachmentMedia, bridge), owner, cache), submissions: new SubmissionController(envelope => bridge.command(envelope, owner), owner, cache, async (sessionId, text) => {
        if (!bridge.getComposerActions) throw new Error("Update this desktop to resolve native /force.");
        const target = { sessionId }, catalog = await bridge.getComposerActions(target, false, owner);
        assertComposerOwner(catalog, owner, target);
        const native = nativeForceWinner(catalog, text), host = desktop.catalog.records.get(owner)?.state;
        if (native && host?.forceTool?.commandVersion !== 18) throw new Error("Update the owning host to use native /force. The draft was retained.");
        return native;
      }) };
      for (const pending of pair.submissions.entries()) {
        if (pending.send && pending.forceToolReceipt?.arm !== "not-armed") pair.drafts.beginPendingSubmission(pending.draft, pending.send.id);
        else if (!pending.uncertain) {
          pair.drafts.get(pending.draft.id, pending.draft);
          pair.drafts.finishSubmission(pending.draft.id, pending.draft, false);
        }
      }
      const record = desktop.catalog.records.get(owner);
      for (const draft of record?.state?.drafts ?? []) pair.drafts.ingest(draft);
      pair.drafts.setConnected(record?.connected ?? false); pair.state = record?.state; pair.connected = record?.connected ?? false;
      stores.set(owner, pair);
    }
    return pair;
  }
  function sideChatController(owner: string, sessionId: string) {
    const key = `${owner}:${sessionId}`;
    let controller = sideChatControllers.get(key);
    if (!controller) {
      controller = new BtwState(bridge, owner, sessionId, controllers(owner).drafts, { read: key => localStorage.getItem(key), write: (key, value) => localStorage.setItem(key, value) });
      sideChatControllers.set(key, controller);
    }
    return controller;
  }
  const { drafts, submissions } = controllers(hostId);
  useEffect(() => drafts.subscribe(redraw), [drafts]);
  useEffect(() => submissions.subscribe(redraw), [submissions]);
  useEffect(() => {
    if (!connected || state?.queuedMessages?.submissions?.commandVersion !== 13) return;
    void submissions.reconcileQueuedSubmissions().catch(cause => setActionError(errorMessage(cause)));
  }, [submissions, connected, state?.lastEventSequence, state?.queuedMessages?.submissions?.commandVersion]);
  useEffect(() => {
    for (const [owner, pair] of stores) {
      const record = desktop.catalog.records.get(owner);
      if (pair.state !== record?.state) { for (const draft of record?.state?.drafts ?? []) pair.drafts.ingest(draft); pair.state = record?.state; }
      if (pair.connected !== Boolean(record?.connected)) { pair.drafts.setConnected(Boolean(record?.connected)); pair.connected = Boolean(record?.connected); }
    }
  }, [stores, desktop.catalog, desktop.catalogRevision]);
  useEffect(() => () => { for (const pair of stores.values()) pair.drafts.dispose(); }, [stores]);
  const selected = state?.sessions.find(session => session.id === selectedId) ?? null;
  const missingSession = Boolean(selectedId && state && !selected);
  const taskLocation = useTaskLocation(bridge, hostId, selected?.id, connected);
  const draftId = selectedId ? `session:${selectedId}` : "new-conversation";
  // A fresh session draft follows native session controls. Only an explicit
  // selection writes a model override; legacy saved choices remain untouched.
  const view = drafts.get(draftId, selected ? { projectId: selected.projectId } : undefined);
  const draft = view.draft;
  const sendMode = effectiveSendMode(sendBehavior, draft.text);
  const normalSendShortcut = sendMode.normal === "mod-enter" ? "Command Enter" : "Enter";
  const oppositeSendShortcut = sendMode.opposite === "mod-shift-enter" ? "Command Shift Enter" : "Command Enter";
  const project = state?.projects.find(project => project.id === (selected?.projectId ?? draft.projectId));
  const environmentAvailable = state?.localEnvironments?.execution?.commandVersion === 5;
  const environmentCatalog = useMemo(() => !selectedId && draft.projectId && state?.localEnvironments?.configuration
    ? new EnvironmentCatalog(bridge, hostId, draft.projectId, offlineCache, desktop.localHostId) : undefined,
    [bridge, hostId, draft.projectId, selectedId, state?.localEnvironments?.configuration, desktop.localHostId]);
  useEffect(() => {
    if (!environmentCatalog) return;
    const off = environmentCatalog.subscribe(redraw); environmentCatalog.start(); void environmentCatalog.restore();
    return () => { off(); environmentCatalog.stop(); };
  }, [environmentCatalog]);
  useEffect(() => { environmentCatalog?.setConnected(connected); }, [environmentCatalog, connected]);
  const [, redrawBrowserMenu] = useState(0);
  const [browserMenu] = useState(() => new BrowserWorkspaceMenu(() => redrawBrowserMenu(value => value + 1)));
  const [terminalRequests] = useState(() => new TerminalWindowOwner(bridge, windowRestoration.state.terminalCreations ?? [], () => redrawBrowserMenu(value => value + 1), windowRestoration.error));
  const [draftBrowserOwners] = useState(() => new DraftBrowserWindowOwner(bridge.draftBrowser, windowRestoration.state.draftBrowserOwners ?? [], () => redrawBrowserMenu(value => value + 1), windowRestoration.error));
  const [draftBrowserPages] = useState(() => new DraftBrowserWindowPages(bridge.draftBrowser, draftBrowserOwners, windowRestoration.state.draftBrowserPages ?? [], () => redrawBrowserMenu(value => value + 1), windowRestoration.error));
  const [draftBrowserDocks] = useState(() => new Map<string, DraftBrowserDockController>());
  const [notificationNavigation] = useState(() => new NotificationNavigationOwner(bridge, redraw));
  const closeBrowserDock = useRef<(source: import("./dock-presentations").DockPresentationRef, tab: DockTab, allowed: () => boolean, focusId?: string) => void>(() => {});
  const [browserCloses] = useState(() => new BrowserCloseDockOwner(bridge, windowRestoration.state.browserCloses ?? [], () => redrawBrowserMenu(value => value + 1),
    (source, tab, allowed, focusId) => { closeBrowserDock.current(source, tab, allowed, focusId); browserCloseFocus.queued(focusId); }, windowRestoration.error));
  const draftDockOwner = useMemo(() => ({ drafts, draftId, hostId, enabled: !selectedId && !contentOverlayOpen && !busy && !submitting.current && !submissions.get(draftId) }),
    [drafts, draftId, hostId, selectedId, settingsOpen, pluginDirectoryOpen, automationsOpen, pullRequestsOpen, busy, Boolean(submissions.get(draftId))]);
  const committedDraftDockOwner = useRef<typeof draftDockOwner | undefined>(undefined);
  useLayoutEffect(() => { committedDraftDockOwner.current = draftDockOwner; });
  const workspaceTarget: WorkspaceTarget | undefined = selectedId ? selected ? { sessionId: selected.id } : undefined : project ? { projectId: project.id } : undefined;
  const taskDirection = document.documentElement.dir === "rtl" ? "rtl" : "ltr";
  const dock = useWorkbenchDock(bridge, windowRestoration.state, hostId, workspaceTarget, connected, setActionError, tab => Boolean(tab.filePath) && canReplaceFilePreview(workspaces.get(`${tab.hostId}:${tab.target}`),tab.filePath!), taskDirection, (tab, state, signal) => browserWindowCheckpoint.wait(tab, state, signal), (presentations, tabId) => browserMenu.retainsSource(presentations, tabId) || terminalRequests.retainsSource(presentations, tabId) || browserCloses.retains(presentations, tabId), terminalRequests);
  const previousBrowserConversation = useRef<MainChatTarget | undefined>(undefined);
  useLayoutEffect(() => {
    const previous = previousBrowserConversation.current;
    const current: MainChatTarget = { kind: "chat", hostId, sessionId: selectedId };
    previousBrowserConversation.current = current;
    if (previous) dock.leaveBrowserConversation(previous, current);
  }, [hostId, selectedId]);
  const draftSearchPages = draftBrowserPages.intents;
  const committedDraftSearchPages = useRef(draftSearchPages);
  useLayoutEffect(() => { committedDraftSearchPages.current = draftSearchPages; }, [draftSearchPages]);
  const [browserCloseFocus] = useState(() => new BrowserCloseFocus(callback => requestAnimationFrame(callback), id => cancelAnimationFrame(id)));
  const [browserSearchSelection] = useState(() => new BrowserSearchSelection(callback => requestAnimationFrame(callback), id => cancelAnimationFrame(id)));
  const [browserSearchRegistry] = useState(() => new BrowserSearchRegistry(windowRestoration.state.sessionBrowserObservations));
  const commandBrowserTabs = useCommandBrowserTabs(commandMenuMode === "commands", dock.presentations,
    [...desktop.catalog.records].filter(([, record]) => record.connected).map(([id]) => id), bridge, draftSearchPages, browserSearchRegistry);
  useEffect(()=>{
    const live=new Set(dock.snapshot.tabs.map(tab=>tab.id));
    for(const [id,controller] of skillFiles)if(!live.has(id)){controller.dispose();skillFiles.delete(id);}
  },[skillFiles,dock.snapshot.tabs]);
  const workspaceOpen = dock.snapshot.state.right.open;
  const terminalOpen = dock.snapshot.state.bottom.open;
  const bottomPanelVisible = preferences.get("general.bottomPanel") !== false;
  const headerContextMenu = useHeaderContextMenu(bridge, preferences, !contentOverlayOpen, setActionError);
  const defaultTerminalLocation = bottomPanelVisible ? preferences.get("general.defaultTerminalLocation") ?? "bottom" : "right";
  useLayoutEffect(() => { terminalRequests.commit({ hostId, target: workspaceTarget && !("filePath" in workspaceTarget) ? workspaceTarget : undefined,
    connected, enabled: !contentOverlayOpen, presentations: dock.presentations }); });
  useLayoutEffect(() => { const context = { drafts, draftId, connected,
    enabled: !selectedId && !contentOverlayOpen && !busy && !submitting.current && !submissions.get(draftId) };
    draftBrowserOwners.commit(context); draftBrowserPages.commit(context);
    for (const [key, controller] of draftBrowserDocks) {
      controller.commit({ ...context, presentations: dock.presentations });
      if (![...dock.presentations.instances].some(([id, instance]) => JSON.stringify([id, instance]) === key)) {
        controller.dispose(); draftBrowserDocks.delete(key);
      }
    }
  });
  useLayoutEffect(() => {
    closeBrowserDock.current = dock.closeBrowser;
    browserCloseFocus.commit({ presentations: dock.presentations, root: workbenchElement.current, route: JSON.stringify([hostId, selectedId]),
      enabled: !contentOverlayOpen, connected: new Set([...desktop.catalog.records].filter(([, record]) => record.connected).map(([id]) => id)) });
    browserCloses.commit({ route: JSON.stringify([hostId, selectedId]), enabled: !contentOverlayOpen,
      connected: new Set([...desktop.catalog.records].filter(([, record]) => record.connected).map(([id]) => id)),
      presentations: dock.presentations, drafts: draftBrowserDocks, pages: draftBrowserPages.intents, launcher: dock.browserCloseState,
      protected: tab => browserMenu.retainsSource(dock.presentations, tab.id) || terminalRequests.retainsSource(dock.presentations, tab.id) });
  });
  const windowSaveObserver = useMemo(() => ({
    committed(value: import("../window-state").WindowViewState) { pullRequestComposers.committed(value); automationRequests.committed(value); browserWindowCheckpoint.committed(value); terminalRequests.committed(value); draftBrowserOwners.committed(value); draftBrowserPages.committed(value); browserCloses.committed(value); notificationNavigation.committed(value); },
    saved(value: import("../window-state").WindowViewState) { pullRequestComposers.saved(value); automationRequests.saved(value); browserWindowCheckpoint.saved(value); terminalRequests.saved(value); draftBrowserOwners.saved(value); draftBrowserPages.saved(value); browserCloses.saved(value); notificationNavigation.saved(value); },
    failed(message: string) { pullRequestComposers.failed(message); automationRequests.failed(message); browserWindowCheckpoint.failed(message); terminalRequests.failed(message); draftBrowserOwners.failed(message); draftBrowserPages.failed(message); browserCloses.failed(message); notificationNavigation.failed(message); },
  }), [pullRequestComposers, automationRequests, browserWindowCheckpoint, terminalRequests, draftBrowserOwners, draftBrowserPages, browserCloses, notificationNavigation]);
  const windowWarning = useWindowViewPersistence({ pullRequestComposers: pullRequestComposers.drafts, pullRequestsOpen, pullRequestViews, automationsOpen, automationRequests: automationRequests.intents, browserCloses: browserCloses.intents, sessionBrowserObservations: browserSearchRegistry.persisted(dock.presentations), draftBrowserPages: draftBrowserPages.intents, draftBrowserOwners: draftBrowserOwners.intents, terminalCreations: terminalRequests.intents, route, sidebarOpen, workspaceOpen, workspaceTab: dock.workspaceTab, terminalOpen, showArchived,
    expandedProjects: [...expandedProjects], collapsedSidebarSections: [...collapsedSidebarSections], settingsOpen, settingsPage, dock: dock.persisted, fileTreeOpen: fileTree.open, environmentOpen, environmentCollapsed, pluginDirectoryOpen, pluginDirectoryTab }, windowRestoration, windowSaveObserver);
  const composerTarget = composerTargetKey(workspaceTarget);
  const composer = useMemo(() => new ComposerCatalogState(bridge, hostId, workspaceTarget), [bridge, hostId, composerTarget]);
  useEffect(() => {
    const unsubscribe = composer.subscribe(redraw); composer.start(desktop.localHostId); composer.setConnected(connected);
    return () => { unsubscribe(); composer.stop(); };
  }, [composer, connected, desktop.localHostId]);
  const selection = composerSelection(draft, composer.catalog, selected, composer.controls);
  const permissionChoice = composerApproval(draft, composer.catalog, selected, composer.controls);
  const imageComposer = useMemo(() => new AttachmentComposer(hostId, draftId, drafts, imageCache, bytes => {
    if (!bridge.inspectImageAttachment) return Promise.reject(new Error("Update this desktop to inspect attached images."));
    return bridge.inspectImageAttachment(bytes);
  }), [hostId, draftId, drafts, imageCache, bridge, selected?.archived]);
  useEffect(() => { imageComposer.start(); const off = imageComposer.subscribe(redraw); return () => { off(); imageComposer.dispose(); }; }, [imageComposer]);
  let workspace: WorkspaceState | undefined;
  if (workspaceTarget) {
    const key = `${hostId}:${workspaceKey(workspaceTarget)}`;
    workspace = workspaces.get(key);
    if (!workspace) { workspace = new WorkspaceState(bridge, hostId, workspaceTarget, offlineCache, desktop.localHostId); workspaces.set(key, workspace); }
  }
  const workspaceOwner = workspaceTarget ? `${hostId}:${workspaceKey(workspaceTarget)}` : undefined;
  useLayoutEffect(() => {
    branchSwitchOwner.current = { workspace, enabled: connected && !contentOverlayOpen };
    setBranchSwitch(undefined);
    return () => { branchSwitchOwner.current = { enabled: false }; };
  }, [workspace, connected, settingsOpen, pluginDirectoryOpen, automationsOpen, pullRequestsOpen]);
  function openBranchSwitch(request: BranchSwitchRequest) {
    const owner = branchSwitchOwner.current;
    if (!owner.enabled || owner.workspace !== request.data || request.data.checkoutRefusal !== request.refusal) return;
    setEnvironmentOpen(false);
    setBranchSwitch({ request, owner });
  }
  const openGitSubmission = (data: WorkspaceState) => setGitDialog({ data, navigationOwner: workspaceOwner, id: crypto.randomUUID() });
  useEffect(() => { if (gitDialog && (gitDialog.navigationOwner !== workspaceOwner || settingsOpen)) setGitDialog(undefined); }, [workspaceOwner, settingsOpen, gitDialog]);
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    const unsubscribe = workspace.subscribe(redraw), release = retainWorkspace(workspace);
    workspace.setConnected(connected);
    void workspace.restore().then(() => {
      if (!cancelled && workspace.connected && !workspace.standalonePath) void workspace.loadGit();
    });
    return () => { cancelled = true; unsubscribe(); release(); };
  }, [workspace, connected]);
  const imageConnection = useRef(connected); imageConnection.current = connected;
  const transcriptImageResolver = useMemo(() => createTranscriptImageResolver(bridge, hostId, () => imageConnection.current), [bridge, hostId]);
  const transcriptFileWorkspace = (file: {path: string}) => {
    if (!file.path.startsWith("/")) {
      if (!workspace) throw new Error("This session has no owning workspace.");
      return workspace;
    }
    const target = { filePath: file.path }, owner = `${hostId}:${workspaceKey(target)}`;
    let data = workspaces.get(owner);
    if (!data) { data = new WorkspaceState(bridge, hostId, target, offlineCache, desktop.localHostId); workspaces.set(owner, data); }
    data.setConnected(Boolean(desktop.catalog.records.get(hostId)?.connected));
    return data;
  };
  useEffect(() => {
    for (const data of workspaces.values()) {
      const online = Boolean(desktop.catalog.records.get(data.hostId)?.connected);
      if (data.connected !== online) data.setConnected(online);
    }
  });
  const transcriptLinkActions: TranscriptLinkActions = {
    ownerKey: `${workspaceOwner}:${connected}`,
    images: { ownerKey: `${hostId}:${selectedId}:${workspace?.imageGeneration ?? 0}`, resolve: transcriptImageResolver },
    ...routedTranscriptHostFileActions(transcriptFileWorkspace),
    cwd: selected?.cwd,
    openExternal: url => bridge.openExternal(url),
    openFile: (file, options) => {
      if (selected?.id && !file.path.startsWith("/") && openMcpFileViewer(hostId, selected.id, file.path)) return;
      if (file.path.startsWith("/")) {
        const data = transcriptFileWorkspace(file);
        const owner = `${hostId}:${workspaceKey(data.target)}`;
        setWorkspaceFileRequest({ owner, request: { ...file, path: data.standaloneName!, id: crypto.randomUUID() } });
        dock.openHostFile(file.path, hostId, "right", options?.preview ?? true);
        return;
      }
      if (!workspace || !workspaceOwner) throw new Error("This session has no owning workspace.");
      setWorkspaceFileRequest({ owner: workspaceOwner, request: { ...file, id: crypto.randomUUID() } });
      dock.openFile(file.path, hostId, workspaceTarget!, "right", options?.preview ?? true);
    },
  };
  const transcript = useTranscript(bridge, selectedId, hostId === "unconnected" ? undefined : hostId, connected, desktop.localHostId, selected?.activitySequence);
  const activity = useSessionActivity(bridge, hostId, selected?.id, connected, !settingsOpen, desktop.localHostId);
  const extensionUi = useExtensionSessionUi(bridge, hostId, selected?.id, connected, !settingsOpen, desktop.localHostId);
  useEffect(() => {
    if (!environmentOpen || settingsOpen || !workspace) return;
    const release = retainWorkspace(workspace); workspace.setConnected(connected);
    void workspace.restore().then(() => { if (workspace.connected) void workspace.loadGit(); });
    const timer = setInterval(() => { if (workspace.connected) void workspace.loadGit(); }, 5000);
    return () => { release();clearInterval(timer); };
  }, [workspace,environmentOpen,settingsOpen,connected]);
  const transcriptReading = useTranscriptScroll(selectedId ? `${hostId}:${selectedId}` : undefined);
  const running = selected?.status === "running";
  const pendingSubmission = submissions.get(draftId);
  const reportSubmissionError = (cause: unknown, sendingDraftId: string, submittedForceCommandId?: string) => {
    const message = errorMessage(cause), pendingForce = submissions.get(sendingDraftId), receipt = pendingForce?.forceToolReceipt;
    if (pendingForce?.sessionId && submittedForceCommandId && receipt?.commandId === submittedForceCommandId
      && receipt.arm === "armed" && receipt.prompt === "not-recorded")
      setActionErrorState(ownedActionError(message, { hostId, sessionId: pendingForce.sessionId, commandId: receipt.commandId }));
    else setActionError(message);
  };
  const queuedSubmissionRecoveries = selectedId ? submissions.queuedEntries().filter(item => item.sessionId === selectedId
    && item.receipt?.phase === "settled" && item.receipt.outcome !== "succeeded") : [];
  useEffect(() => {
    if (!selectedId && environmentAvailable && draft.execution?.type === 'worktree' && draft.environment === undefined && !pendingSubmission && !view.conflict)
      drafts.update(draftId, { environment: null });
  }, [drafts, draftId, selectedId, environmentAvailable, draft.execution?.type, draft.environment, Boolean(pendingSubmission), view.conflict]);
  const pendingSessionId = pendingSubmission?.sessionId;
  const knownPendingSession = state?.sessions.find(session => session.id === pendingSessionId);
  const forceSessionId = selected?.id ?? pendingSessionId;
  const forceOwner = useRef({ routeKey, draftId, sessionId: forceSessionId, connected, archived: Boolean(selected?.archived), model: selection.model });
  useLayoutEffect(() => { forceOwner.current = { routeKey, draftId, sessionId: forceSessionId, connected, archived: Boolean(selected?.archived), model: selection.model }; });
  const forceToolPorts = useMemo<ForceToolPorts>(() => {
    let latest: ForceToolSnapshot | null = null;
    const assertOwner = (owner: { hostId: string; sessionId: string }) => {
      const current = forceOwner.current;
      if (owner.hostId !== hostId || owner.sessionId !== current.sessionId || current.routeKey !== routeKey || !current.connected || current.archived)
        throw new Error("Open the connected owning conversation before changing its force request.");
    };
    return {
      read: async (owner, commandId) => {
        assertOwner(owner);
        const host = desktop.catalog.records.get(owner.hostId)?.state;
        if (!bridge.getForceTool || host?.forceTool?.version !== 1 || host.forceTool.commandVersion !== 18)
          return { protocolVersion: 1, ...owner, value: null, unavailable: "Update the owning host and desktop to inspect native force requests." };
        const response = await bridge.getForceTool(owner.sessionId, owner.hostId, commandId);
        const reconciled = submissions.observeForceReceipt(owner.sessionId, response.receipt);
        if (reconciled) drafts.finishSubmission(reconciled.draft.id, reconciled.draft, reconciled.accepted, false, reconciled.commandId);
        latest = response.value; return response;
      },
      insertDraft: (owner, insertion) => {
        assertOwner(owner);
        const current = drafts.get(draftId).draft, model = forceOwner.current.model;
        if (submissions.get(draftId) || current.text !== insertion.expectedDraftText)
          throw new Error("The composer or pending submission changed. Review its current text before inserting.");
        if (!latest || latest.epoch !== insertion.guard.epoch || latest.revision !== insertion.guard.expectedRevision
          || model?.provider !== latest.model?.provider || model?.id !== latest.model?.id)
          throw new Error("The selected model differs from the owning worker. Apply the model and refresh its tools before preparing a force request.");
        if (current.attachments?.length || current.selectedTextAttachments?.length || current.wholeFileAttachments?.length)
          throw new Error("Native /force needs a plain-text draft. Remove its attachments before preparing it.");
        // Persist the prepared binding before changing composer text. A failed
        // cache write therefore cannot expose an unguarded prepared command.
        submissions.forceTools.prepare(owner.sessionId, { ...current, text: insertion.text }, insertion.guard);
        drafts.update(draftId, { text: insertion.text }); textarea.current?.focus();
      },
      cancel: async (owner, request) => {
        assertOwner(owner);
        const result = await submissions.cancelForce(owner.sessionId, request);
        if (result.draft) drafts.finishSubmission(result.draft.id, result.draft, false);
        return result.state;
      },
      recoverPrompt: async (owner, request) => {
        assertOwner(owner);
        const original = await submissions.recoverForcePrompt(owner.sessionId, request);
        drafts.finishSubmission(original.id, original, false);
        setActionErrorState(current => clearRecoveredForceError(current, {
          hostId: owner.hostId, sessionId: owner.sessionId, commandId: request.originalReceipt.commandId,
        }));
        void refresh();
      },
    };
  }, [bridge, hostId, routeKey, draftId, drafts, submissions, desktop.catalog]);

  const wholeFileIssue = wholeFileSendIssue(draft, hostId, running, state?.wholeFiles);
  const selectedTextIssue = selectedTextSendIssue(draft, running, state?.selectedText);
  const imageIssue = imageSendIssue(draft, running, state?.imageAttachments, composer.catalog, selected, composer.controls, state?.queuedMessages?.submissions?.images);
  const imagesStaging = imageComposer.staging.length > 0;
  const worktreesAvailable = state?.newChatExecution?.commandVersion === 4 && state.newChatExecution.worktrees === true;
  const modeView = !selectedId && worktreesAvailable && draft.projectId ? projectExecutionModeView(drafts, draft.projectId, draft.execution) : undefined;
  useEffect(() => {
    if (!modeView || !draft.projectId || view.conflict || pendingSubmission?.uncertain) return;
    if (modeView.conflict) {
      if (sameModeConflict(modeView)) resolveProjectExecutionMode(drafts, draftId, draft.projectId, "remote");
      return;
    }
    applyProjectExecutionMode(drafts, draftId, modeView.draft);
  }, [drafts, draftId, draft.projectId, draft.execution?.type, view.conflict?.revision, pendingSubmission?.uncertain, modeView?.draft.revision, modeView?.draft.execution?.type, modeView?.conflict?.revision, modeView?.conflict?.execution?.type]);
  const remoteExecutionIssue = remoteWorktreeIssue(draft.execution, state);
  const executionBranch = draft.execution?.type === "worktree" && draft.execution.startingState.type === "branch" ? draft.execution.startingState.branchName : undefined;
  const executionReady = Boolean(selectedId || draft.execution?.type !== "worktree" || worktreesAvailable && project && workspace?.restored && workspace.status && !workspace.busy && !workspace.pending && (draft.execution.startingState.type === "working-tree"
    ? workspace.status.entries.length
    : hasRemoteExecution(draft.execution) ? !remoteExecutionIssue : executionBranch === workspace.status.branch || workspace.branches.some(branch => !branch.remote && !branch.symbolicTarget && branch.name === executionBranch)));
  const environmentReady = Boolean(selectedId || draft.execution?.type !== 'worktree' || (draft.environment === undefined ? !environmentAvailable && !hasRemoteExecution(draft.execution) : environmentAvailable && (draft.environment === null
    || environmentCatalog?.restored && !environmentCatalog.loading && !environmentCatalog.error && environmentCatalog.items.some(item => item.type === 'environment' && item.configPath === draft.environment?.configPath && item.revision === draft.environment?.revision))));
  const canSend = connected && Boolean(state) && !busy && !missingSession && !pendingSubmission?.preparation && Boolean(hasDraftContent(draft) || pendingSubmission?.uncertain) && (Boolean(pendingSubmission?.uncertain) || (!imageIssue && !selectedTextIssue && !wholeFileIssue && !imagesStaging && !remoteExecutionIssue && executionReady && environmentReady)) && (view.status !== "conflict" || Boolean(pendingSubmission?.uncertain)) && (!modeView?.conflict || Boolean(pendingSubmission?.uncertain)) && !selected?.archived;
  const canRouteGoal = connected && Boolean(state) && !busy && !missingSession && !selected?.archived
    && !pendingSubmission && view.status !== "conflict" && !modeView?.conflict && Boolean(goalComposerCommand(draft.text));

  const navigate = useCallback((id: string | null, owner = route.hostId ?? state?.host.id ?? desktop.localHostId, keepSettings = false, focusComposer = true) => {
    settingsOriginLabel.current = null; setAutomationsOpen(false); setPullRequestsOpen(false); setRoute({ sessionId: id, hostId: owner }); if(!keepSettings)setPluginDirectoryOpen(false);setIntegrationSelection(undefined); setActionError(null); setMenuOpen(false); if (!keepSettings) setSettingsOpen(false);
    expandAfterNavigation.current = id ? `${owner ?? ""}:${id}` : undefined;
    if (focusComposer) requestAnimationFrame(() => textarea.current?.focus());
  }, [route.hostId, state?.host.id, desktop.localHostId]);
  const planOwner = useRef({ hostId, sessionId: selected?.id, enabled: connected && !selected?.archived && !contentOverlayOpen });
  useLayoutEffect(() => { planOwner.current = { hostId, sessionId: selected?.id, enabled: connected && !selected?.archived && !contentOverlayOpen }; });
  const planPorts = useMemo<SessionPlanPorts>(() => ({ bridge,
    documentSupported: state?.plan?.document?.version === 1 && state.plan.document.commandVersion === 20,
    storage: { read: key => localStorage.getItem(key), write: (key, value) => localStorage.setItem(key, value), remove: key => localStorage.removeItem(key) }, onTransition(owner, session) {
    // Host commit supplies the destination. Navigation never consumes either
    // conversation's unsent draft, and a late result cannot steal a new route.
    const current = () => planOwner.current.enabled && planOwner.current.hostId === owner.hostId && planOwner.current.sessionId === owner.sessionId;
    if (!current()) return;
    void refresh().then(() => {
      if (!current()) return;
      const committed = desktop.catalog.records.get(owner.hostId)?.state?.sessions.find(candidate => candidate.id === session.id && candidate.hostId === owner.hostId);
      if (!committed) throw new Error("The owning host has not published the committed Plan destination. Refresh its session catalog before navigating.");
      navigate(committed.id, committed.hostId);
    }).catch(cause => { if (current()) setActionError(errorMessage(cause)); });
  } }), [bridge, refresh, navigate, desktop.catalog, state?.plan?.document]);
  const nativePlan = useSessionPlan({ hostId, sessionId: selected?.id ?? "" }, planPorts, {
    connected: connected && !selected?.archived, active: !contentOverlayOpen,
    supported: state?.plan?.version === 1 && state.plan.commandVersion === 19, localHostId: desktop.localHostId,
  });
  const [planOpenOwner, setPlanOpenOwner] = useState<string>();
  const planRoute = JSON.stringify([hostId, selected?.id]);
  const planDialog = useRef<HTMLDialogElement>(null), planTrigger = useRef<HTMLButtonElement>(null);
  const seenPlanReviews = useRef(new Set<string>());
  const [retainedPlan, setRetainedPlan] = useState<{ owner: { hostId: string; sessionId: string }; value: SessionPlan }>();
  useLayoutEffect(() => {
    if (nativePlan.view.value) setRetainedPlan({ owner: nativePlan.view.owner, value: nativePlan.view.value });
  }, [nativePlan.view.owner, nativePlan.view.value]);
  const panelPlan = nativePlan.view.value ? { owner: nativePlan.view.owner, value: nativePlan.view.value } : retainedPlan;
  const planOpen = planOpenOwner === planRoute && !contentOverlayOpen && !!nativePlan.view.value;
  useEffect(() => {
    const value = nativePlan.view.value, review = value?.review;
    if (!review || !nativePlan.view.fresh || !connected) return;
    const key = JSON.stringify([hostId, selected?.id, value.ticket.epoch, review.id]);
    if (review.status === "dismissed") { setPlanOpenOwner(current => current === planRoute ? undefined : current); return; }
    if (!seenPlanReviews.current.has(key)) { seenPlanReviews.current.add(key); setPlanOpenOwner(planRoute); }
  }, [nativePlan.view.value, nativePlan.view.fresh, connected, hostId, selected?.id, planRoute]);
  useEffect(() => {
    const element = planDialog.current;
    if (planOpen && element && !element.open) element.showModal();
    else if (!planOpen && element?.open) element.close();
  }, [planOpen]);
  const hidePlan = () => { setPlanOpenOwner(undefined); requestAnimationFrame(() => planTrigger.current?.focus({ preventScroll: true })); };
  const planEditorPorts = useMemo<PlanEditorPorts>(() => ({
    bridge,
    storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
    copy: copyText,
    refreshPlan: async () => { await nativePlan.state.refresh(); },
    openTerminal: (ownerHostId, ownerSessionId, terminalId) => {
      const owner = planOwner.current;
      if (!owner.enabled || owner.hostId !== ownerHostId || owner.sessionId !== ownerSessionId)
        throw new Error("Select the original conversation before opening its editor terminal.");
      dock.bindTerminal(terminalId, ownerHostId, { sessionId: ownerSessionId }, defaultTerminalLocation, "Plan editor");
      setPlanOpenOwner(undefined);
    },
  }), [bridge, nativePlan.state, dock.bindTerminal, defaultTerminalLocation]);
  const planReviewPorts = useMemo<PlanReviewPorts>(() => ({
    mutate: async (owner, request) => {
      const current = () => planOwner.current.enabled && planOwner.current.hostId === owner.hostId && planOwner.current.sessionId === owner.sessionId;
      const operation = nativePlan.state.mutate(owner, request);
      // Native decision hooks can ask questions through PendingInteractions.
      // Hide this modal while they run; the mounted editor retains its buffers.
      if (request.mutation.action !== "edit" && request.mutation.action !== "document" && current()) setPlanOpenOwner(undefined);
      try {
        const receipt = await operation;
        if (current()) {
          if (receipt.outcome !== "applied") setPlanOpenOwner(planRoute);
          else if (request.mutation.action === "refine") requestAnimationFrame(() => textarea.current?.focus());
        }
        return receipt;
      } catch (cause) { if (current()) setPlanOpenOwner(planRoute); throw cause; }
    },
    readDocumentSection: (owner, request) => nativePlan.state.readDocumentSection(owner, request),
    refresh: async () => { await nativePlan.state.refresh(); },
    dismiss: async (owner, binding) => {
      await nativePlan.state.control(owner, { ...binding, action: "dismiss" });
      if (planOwner.current.hostId === owner.hostId && planOwner.current.sessionId === owner.sessionId) {
        setPlanOpenOwner(undefined); requestAnimationFrame(() => planTrigger.current?.focus({ preventScroll: true }));
      }
    },
    reopen: async (owner, binding) => {
      await nativePlan.state.control(owner, { ...binding, action: "reopen" });
      if (planOwner.current.hostId === owner.hostId && planOwner.current.sessionId === owner.sessionId) setPlanOpenOwner(planRoute);
    },
  }), [nativePlan.state, planRoute]);
  const openPlanReview = async () => {
    const value = nativePlan.view.value;
    if (!value) return;
    try {
      if (!value.review) await nativePlan.state.control(nativePlan.view.owner, { sessionId: nativePlan.view.owner.sessionId, ticket: value.ticket, action: "review" });
      else if (value.review.status === "dismissed") await planReviewPorts.reopen(nativePlan.view.owner, {
        sessionId: nativePlan.view.owner.sessionId, ticket: value.ticket, reviewId: value.review.id, reviewRevision: value.review.revision });
      if (planOwner.current.hostId === nativePlan.view.owner.hostId && planOwner.current.sessionId === nativePlan.view.owner.sessionId) setPlanOpenOwner(planRoute);
    } catch { setPlanOpenOwner(planRoute); /* The owner state displays the actual failure. */ }
  };
  let forkController = selected ? forkControllers.get(`${hostId}:${selected.id}`) : undefined;
  if (selected && !forkController) {
    forkController = new SessionForkState(bridge, hostId, selected.id, { read: key => localStorage.getItem(key), write: (key, value) => localStorage.setItem(key, value) });
    forkControllers.set(`${hostId}:${selected.id}`, forkController);
  }
  const forkSupported = state?.sessionForks?.version === 1 && state.sessionForks.commandVersion === 16;
  const forkOwner = useMemo(() => ({ data: forkController, enabled: Boolean(forkController && forkSupported && connected && !contentOverlayOpen && !selected?.archived && selected?.status === "idle") }),
    [forkController, forkSupported, connected, contentOverlayOpen, selected?.archived, selected?.status]);
  const forkOwnerRef = useRef(forkOwner);
  const [forkMenu, setForkMenu] = useState<{ owner: typeof forkOwner; request: SessionForkMenuRequest }>();
  useLayoutEffect(() => {
    forkOwnerRef.current = forkOwner;
    if (forkMenu && forkMenu.owner !== forkOwner) setForkMenu(undefined);
  }, [forkOwner, forkMenu]);
  useEffect(() => {
    if (!forkController) return;
    const off = forkController.subscribe(redraw);
    forkController.setConnection(connected, forkSupported);
    if (connected && forkSupported) void forkController.refresh();
    return () => { off(); forkController.setConnection(false, forkSupported); };
  }, [forkController, connected, forkSupported]);
  useEffect(() => bridge.subscribe(event => {
    if (event.type === "session.fork" && event.hostId === hostId && event.sessionId === forkController?.sessionId && connected) void forkController.refresh();
  }), [bridge, forkController, hostId, connected]);
  const canFork = forkOwner.enabled && forkController?.canStart;
  function openForkMenu(anchor: HTMLElement | null = textarea.current?.element ?? null, slashQuery?: string) {
    const owner = forkOwnerRef.current;
    if (!anchor || !owner.enabled || !owner.data?.canStart) return;
    const editor = textarea.current;
    let restoredText = drafts.get(draftId).draft.text;
    let selection = { start: editor?.selectionStart ?? 0, end: editor?.selectionEnd ?? 0 };
    setMenuOpen(false);
    setForkMenu({ owner, request: { anchor, dismissQuery() {
      if (slashQuery === undefined || forkOwnerRef.current !== owner || textarea.current !== editor || !editor) return;
      const removal = forkSlashQueryRemoval({ text: slashQuery, start: slashQuery.indexOf("/"), end: slashQuery.trimEnd().length }, drafts.get(draftId).draft.text, selection);
      if (!removal) return;
      editor.replaceText(removal.text); restoredText = removal.text; selection = removal.selection;
    }, restoreFocus() {
      if (forkOwnerRef.current !== owner || textarea.current !== editor || !editor?.element.isConnected) return;
      editor.focus();
      if (drafts.get(draftId).draft.text === restoredText) editor.setSelectionRange(selection.start, selection.end);
    } } });
  }
  async function openForkedChat(owner = forkOwnerRef.current) {
    const data = owner.data;
    if (!data?.child || forkOwnerRef.current !== owner || !owner.enabled) return;
    try {
      await desktop.catalog.refreshHost(data.hostId);
      if (forkOwnerRef.current !== owner || !owner.enabled) return;
      const child = data.takeChild();
      if (child) navigate(child.id, child.hostId);
    } catch (cause) { if (forkOwnerRef.current === owner) setActionError(errorMessage(cause)); }
  }
  async function runFork(execution?: ForkExecution) {
    const owner = forkOwnerRef.current, data = owner.data;
    if (!owner.enabled || !data || (execution ? !data.canStart : !data.canResume)) return;
    forkMenu?.request.restoreFocus(); setForkMenu(undefined);
    if (execution) await data.start(execution); else await data.resume();
    await data.refresh();
    if (forkOwnerRef.current === owner && data.child) await openForkedChat(owner);
  }
  useLayoutEffect(() => notificationNavigation.setNavigate(target => navigate(target.sessionId, target.hostId)), [notificationNavigation, navigate]);
  useEffect(() => { notificationNavigation.start(); return () => notificationNavigation.dispose(); }, [notificationNavigation]);
  // Bind legacy/new local routes once identity is known; never replace an
  // explicit unavailable remote owner with the local machine.
  useEffect(() => { if (!route.hostId && desktop.localHostId) setRoute(previous => previous.hostId ? previous : { ...previous, hostId: desktop.localHostId }); }, [route.hostId, desktop.localHostId]);
  useLayoutEffect(() => { browserSearchSelection.commit({ presentations: dock.presentations, pages: committedDraftSearchPages.current,
    route, settingsOpen, pluginDirectoryOpen: pluginDirectoryOpen || automationsOpen || pullRequestsOpen, root: workbenchElement.current, navigate }); });
  useEffect(() => () => browserSearchSelection.cancel(), [browserSearchSelection]);
  const newConversation = useCallback((projectId?: string, owner = route.hostId ?? state?.host.id ?? desktop.localHostId) => {
    setShowArchived(false); setSidebarActivityOpen(false);
    navigate(null, owner);
    if (projectId !== undefined && owner) {
      const pair = controllers(owner), capabilities = desktop.catalog.records.get(owner)?.state?.newChatExecution;
      if (capabilities?.commandVersion === 4 && capabilities.worktrees) selectProjectWithExecutionMode(pair.drafts, "new-conversation", projectId);
      else pair.drafts.update("new-conversation", { projectId });
    }
  }, [navigate, route.hostId, state?.host.id, desktop.localHostId, stores, desktop.catalog]);
  const trySkill = (action: ComposerAction) => {
    try {
      prepareSkillDraft(drafts, action, project?.id ?? null, worktreesAvailable);
      newConversation(project?.id, hostId);
    } catch (cause) { setActionError(errorMessage(cause)); }
  };
  useEffect(() => { setFileSearchOwner(undefined); }, [workspaceOwner]);
  const dockWorkspace = workspaceTarget && !("filePath" in workspaceTarget) ? workspaceTarget : undefined;
  const dockSession = dockWorkspace && "sessionId" in dockWorkspace && selected?.id === dockWorkspace.sessionId ? dockWorkspace : undefined;
  // Historical Transcript rows only name the conversation and an optional path; the owning host selects the Last turn.
  const openTurnReview = bridge.getTurnReview && workspaceOwner ? (request: TurnReviewOpenRequest) => { dock.open("review"); setTurnReviewRequest({ owner: workspaceOwner, request: { id: crypto.randomUUID(), ...request } }); } : undefined;
  const appCommandBindings = useMemo(() => readAppCommandBindings(commandKeymap?.record, commandKeymap?.loaded ?? false), [commandKeymap?.record, commandKeymap?.loaded]);
  const preparationTarget = dockWorkspace ? { hostId, target: workspaceKey(dockWorkspace) as DockTab["target"] } : undefined;
  const panelSingleton = (kind: "files" | "side-chat" | "review") => dockWorkspace ? dockTabId({ kind, hostId, target: workspaceKey(dockWorkspace) as DockTab["target"] }) : undefined;
  const preparePanel = (kind: "files" | "side-chat" | "browser" | "review") => async (signal: AbortSignal): Promise<TerminalPreparation> =>
    signal.aborted ? { status: "cancelled", creationMayHaveRun: false } : dock.prepareOpen(kind);
  const filesAction: DockAddAction | undefined = dockWorkspace ? {preparationTarget,id:"files",label:"Files",icon:"folder",deferSelectionUntilDropdownClose:true,shortcut:commandKeymap ? appCommandShortcutLabel(appCommandBindings.bindings,"files") : "⌘P",singletonTabId:panelSingleton("files"),requiresConnection:false,prepare:preparePanel("files"),onSelect:destination => dock.open("files",destination)} : undefined;
  const sideChatAction: DockAddAction | undefined = dockSession && bridge.getBtw ? {preparationTarget,id:"side-chat",label:"Side chat",icon:"sideChat",shortcut:commandKeymap ? appCommandShortcutLabel(appCommandBindings.bindings,"side-chat") : "⌥⌘S",singletonTabId:panelSingleton("side-chat"),requiresConnection:false,prepare:preparePanel("side-chat"),onSelect:destination => dock.open("side-chat",destination)} : undefined;
  const browserAction: DockAddAction | undefined = dockSession ? {preparationTarget,id:"browser",label:"Browser",icon:"globe",deferSelectionUntilDropdownClose:true,shortcut:commandKeymap ? appCommandShortcutLabel(appCommandBindings.bindings,"browser") : "⌘T",requiresConnection:false,prepare:preparePanel("browser"),onSelect:destination => {void dock.browser(destination,true);}} : bridge.draftBrowser && state && draftDockOwner.enabled ? {
    id: "browser", label: "Browser", icon: "globe", deferSelectionUntilDropdownClose: true, requiresConnection: false,
    preparationTarget: { hostId, target: draftBrowserDockTarget(draftId) },
    shortcut: commandKeymap ? appCommandShortcutLabel(appCommandBindings.bindings, "browser") : "⌘T",
    prepare: async signal => signal.aborted || committedDraftDockOwner.current !== draftDockOwner || !draftDockOwner.enabled
      ? { status: "cancelled", creationMayHaveRun: false } : { status: "ready", tab: createDraftBrowserDockTab(hostId, draftId) },
    onSelect: destination => dock.openDraftBrowser(hostId, draftId, destination, () => committedDraftDockOwner.current === draftDockOwner && draftDockOwner.enabled),
  } : undefined;
  const terminalAction: DockAddAction | undefined = connected && dockWorkspace && hasNativeTerminalBridge(bridge) ? {preparationTarget,id:"terminal",label:"Terminal",icon:"terminal",shortcut:commandKeymap ? appCommandShortcutLabel(appCommandBindings.bindings,"terminal") : "⌃`",prepare:(signal, origin) => {
    if (!origin) return Promise.resolve({ status: "error", outcome: "not-submitted", message: "The initiating browser is unavailable." } as const);
    const source = dock.snapshot.tabs.find(tab => tab.id === origin.presentation.tabId);
    if (!source?.browserInstanceId) return Promise.resolve({ status: "error", outcome: "not-submitted", message: "The initiating browser identity is unavailable." } as const);
    return dock.prepareTerminal(true, signal, { kind: "browser", tabId: source.id, browserInstanceId: source.browserInstanceId, title: origin.title, draft: origin.state.draft }, browserMenu.captureSettlement(origin));
  },onSelect:destination => {void dock.terminal(destination,true);}} : undefined;
  const reviewAction: DockAddAction | undefined = dockWorkspace && workspace?.status ? {preparationTarget,id:"review",label:"Review",icon:"compose",shortcut:commandKeymap ? appCommandShortcutLabel(appCommandBindings.bindings,"review") : "⌃⇧G",singletonTabId:panelSingleton("review"),requiresConnection:false,prepare:preparePanel("review"),onSelect:destination => dock.open("review",destination)} : undefined;
  const hostGroups = desktop.hosts.flatMap(host => { const hostState = host.hostId ? desktop.catalog.records.get(host.hostId)?.state : undefined; return hostState ? [{ host, hostState }] : []; });
  const sessionRead = useSessionReadState(preferences, selected, !contentOverlayOpen && !(dock.snapshot.state.right.open && dock.snapshot.state.rightLayout === "full"), transcript.loaded && (transcript.readSequence ?? -1) >= (selected?.activitySequence ?? 0));
  const unreadSessions = sessionRead.unreadKeys(hostGroups.flatMap(group => group.hostState.sessions));
  const organizedSidebar = sidebarLayout(preferences, hostGroups, "", showArchived, expandedProjects, unreadSessions);
  const sidebarActivityItems = sidebarActivity(hostGroups, unreadSessions);
  const mainChatPanelId = useId();
  const mainChatTabId = `${mainChatPanelId}-tab`;
  const [mainStripContainer,setMainStripContainer] = useState<HTMLDivElement | null>(null);
  const mainTaskArea = useRef<"chat" | "content">("chat");
  const [mainTaskFocus, setMainTaskFocus] = useState<{ target: MainTaskTarget; onlyWhenContentClosed?: true; isCurrent?: () => boolean }>();
  const mainChat: MainChatTarget = { kind: "chat", hostId, sessionId: selectedId };
  const taskTargets = mainTaskTargets(dock.snapshot, mainChat);
  const taskStrip = unifiedMainTaskStrip(dock.snapshot,mainChat);
  const taskLayoutChange = mainTaskLayoutChange(dock.snapshot,mainChat);
  const taskLayoutAction = taskLayoutChange ? {label:taskLayoutChange.label,onSelect:(activation?:TaskLayoutActivation) => {
    if(contentOverlayOpen) return;
    const change=mainTaskLayoutChange(dock.snapshot,mainChat,activation?.fillChat);
    if(!change) return;
    dock.change(change.state);
    mainTaskArea.current=change.focusTarget.kind;
    setMainTaskFocus(activation?.restoreFocus ? {target:change.focusTarget} : undefined);
  }} : undefined;
  const showUnifiedStrip = !contentOverlayOpen && Boolean(taskStrip);
  const taskHintsVisible = useTaskShortcutHints(commandKeymap?.primaryNumberShortcutTarget === "sidebar" ? "control" : "meta", !contentOverlayOpen && taskTargets.length > 1);
  const taskHints = taskHintsVisible ? taskShortcutHintLabels(taskTargets,taskDirection,appCommandBindings.bindings) : undefined;
  const selectMainTask = (target: MainTaskTarget, focus = true) => {
    const next = activateMainTask(dock.snapshot, mainChat, target);
    if (!next || contentOverlayOpen) return;
    if (next !== dock.snapshot.state) dock.change(next);
    mainTaskArea.current = target.kind;
    setMainTaskFocus(focus ? { target } : undefined);
  };
  const [paneDrag,setPaneDrag]=useState<{target:MainTaskTarget;point:{clientX:number;clientY:number}}>();
  useEffect(()=>{setPaneDrag(undefined);},[settingsOpen,pluginDirectoryOpen,automationsOpen,pullRequestsOpen,hostId,selectedId]);
  const dragTarget=(task:DockDragTask):MainTaskTarget=>task==="chat"?mainChat:{kind:"content",tabId:task.id,hostId:task.hostId,target:task.target};
  const applyPlacement=(change:NonNullable<ReturnType<typeof placeTask>>)=>{
    dock.change(change.state);
    if(change.focusTarget.kind === "content" && change.state.bottom.tabIds.includes(change.focusTarget.tabId)) {
      const id=change.focusTarget.tabId;
      requestAnimationFrame(()=>document.querySelector<HTMLElement>(`[data-dock-destination="bottom"] [data-dock-tab-id="${CSS.escape(id)}"]`)?.focus());
    } else { mainTaskArea.current=change.focusTarget.kind;setMainTaskFocus({target:change.focusTarget}); }
  };
  const taskPlacementMenu = useTaskPlacementMenu(bridge,dock.snapshot,mainChat,!contentOverlayOpen,applyPlacement,setActionError);
  const chatPaneDrag=useTaskPaneDrag<MainChatTarget>({owner:`${hostId}:${selectedId ?? "draft"}`,enabled:!contentOverlayOpen && !showUnifiedStrip && taskTargets.length>1,
    onMove:(target,point)=>setPaneDrag({target,point}),onEnd:()=>setPaneDrag(undefined),
    onDrop:(target,point)=>{
      const side=paneDropAt(taskDropGeometry(dock.snapshot,mainChat,target,dockViewport),point);
      if(side) {const change=placeTask(dock.snapshot,mainChat,target,side);if(change)applyPlacement(change);}
    },
  });
  const cycleMainTask = (direction: "next" | "previous") => {
    const transition = adjacentMainTask(dock.snapshot,mainChat,mainTaskArea.current,direction);
    if (!transition) return;
    const focus = Boolean(transition.focusSource && workbenchElement.current && mainTaskContainsFocus(workbenchElement.current,transition.focusSource));
    selectMainTask(transition.target,focus);
  };
  useLayoutEffect(() => {
    if (!mainTaskFocus) return;
    const frame = requestAnimationFrame(() => {
      if (mainTaskFocus.isCurrent && !mainTaskFocus.isCurrent()) { setMainTaskFocus(undefined); return; }
      if (mainTaskFocus.onlyWhenContentClosed && !contentOverlayOpen
        && mainTaskFocus.target.kind === "chat" && mainTaskFocus.target.hostId === mainChat.hostId && mainTaskFocus.target.sessionId === mainChat.sessionId) {
        mainTaskArea.current = dock.snapshot.state.right.open ? "content" : "chat";
      }
      if (!contentOverlayOpen && workbenchElement.current && (!mainTaskFocus.onlyWhenContentClosed || !dock.snapshot.state.right.open)) focusMainTask(workbenchElement.current, dock.snapshot, mainChat, mainTaskFocus.target);
      setMainTaskFocus(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [mainTaskFocus, dock.snapshot, hostId, selectedId, settingsOpen, pluginDirectoryOpen, automationsOpen, pullRequestsOpen]);
  const chatRoute = !contentOverlayOpen && !missingSession;
  const editableDraft = chatRoute && !selected?.archived && !busy && !pendingSubmission && !view.conflict;
  const writablePreferences = preferences.ready && preferences.connected && !preferences.busy && !preferences.pending.length;
  const selectedSidebarItem = organizedSidebar.allItems.find(item => item.kind === "session" && item.value.id === selectedId && item.value.hostId === hostId);
  const chatIndex = organizedSidebar.allChatSlots.findIndex(item => item.hostId === hostId && item.sessionId === selectedId);
  const adjacentChat = (direction: -1 | 1) => {
    const slots = organizedSidebar.allChatSlots;
    if (!slots.length) return;
    const next = slots[(chatIndex + direction + slots.length) % slots.length]!;
    navigate(next.sessionId, next.hostId);
  };
  const attentionChats = new Set(hostGroups.flatMap(({ hostState }) => (hostState.notifications ?? [])
    .filter(notice => notice.state === "open" && (notice.kind === "permission" || notice.kind === "question"))
    .map(notice => sessionUnreadKey(hostState.host.id, notice.sessionId))));
  const nextAttention = organizedSidebar.allChatSlots.slice(chatIndex + 1).concat(organizedSidebar.allChatSlots.slice(0, Math.max(0, chatIndex)))
    .find(item => unreadSessions.has(sessionUnreadKey(item.hostId, item.sessionId)) || attentionChats.has(sessionUnreadKey(item.hostId, item.sessionId)));
  const recentChats = commandMenuRecents(hostGroups.flatMap(({ hostState }) => hostState.sessions.filter(session => !session.archived).map(session => ({
    hostId: session.hostId, sessionId: session.id, title: session.title, updatedAt: session.updatedAt,
    pinned: preferences.sectionFor("session", session.id, session.hostId) === "pinned",
    pinnedPosition: preferences.entity("session", session.id, session.hostId)?.position, hostName: hostState.host.name,
  }))));
  const recentActions: AppShortcutOptions["actions"] = {};
  const recentOwners = ["recent-thread-1", "recent-thread-2", "recent-thread-3", "recent-thread-4", "recent-thread-5", "recent-thread-6"] as const;
  recentOwners.forEach((owner, index) => { const target = recentChats[index]; if (target) recentActions[owner] = () => navigate(target.sessionId, target.hostId); });
  const ordinalEfforts = selection.levels.filter(level => level !== "auto" && level !== "off");
  const effortIndex = ordinalEfforts.indexOf(selection.thinking ?? "");
  async function copyText(value: string) {
    if (clipboardWritePending.current) throw new Error("Wait for the current clipboard write to finish before copying again.");
    clipboardWritePending.current = true;
    try { await navigator.clipboard.writeText(value); }
    finally { clipboardWritePending.current = false; }
  }
  const copyPath = (value: string) => { void copyText(value).catch(cause => { if (selectedRef.current === routeKey) setActionError(errorMessage(cause)); }); };
  const todosPorts = useMemo<SessionTodosPorts>(() => ({ bridge,
    storage: { read: key => localStorage.getItem(key), write: (key, value) => localStorage.setItem(key, value), remove: key => localStorage.removeItem(key) } }), [bridge]);
  const nativeTodos = useSessionTodos({ hostId, sessionId: selected?.id ?? "" }, todosPorts, {
    connected: connected && !selected?.archived, active: !contentOverlayOpen,
    supported: state?.todos?.version === 1 && state.todos.commandVersion === 22, localHostId: desktop.localHostId,
  });
  const treePorts = useMemo<SessionTreePorts>(() => ({ bridge,
    storage: { read: key => localStorage.getItem(key), write: (key, value) => localStorage.setItem(key, value), remove: key => localStorage.removeItem(key) } }), [bridge]);
  const nativeTree = useSessionTree({ hostId, sessionId: selected?.id ?? "" }, treePorts, {
    connected: connected && !selected?.archived, active: !contentOverlayOpen,
    supported: state?.tree?.version === 1 && state.tree.commandVersion === 23, localHostId: desktop.localHostId,
  });
  const [treeHistoryOpen, setTreeHistoryOpen] = useState(false);
  const [treeEdit, setTreeEdit] = useState<{ owner: string; targetId: string; text: string; imageCount: number; prepared?: TreeMutationResult; originalTicket?: TreeTicket }>();
  useEffect(() => { setTreeHistoryOpen(false); setTreeEdit(undefined); }, [routeKey]);
  const openTreeHistory = () => { setMenuOpen(false); setTreeHistoryOpen(true); void nativeTree.state.refresh().catch(cause => setActionError(errorMessage(cause))); };
  const navigateTree = async (targetId: string, summarize: boolean, customInstructions?: string) => {
    const capturedRoute = routeKey, view = nativeTree.state.getSnapshot();
    if (!selectedId || !view.value) return;
    setTreeHistoryOpen(false);
    try {
      const result = await nativeTree.state.mutate({ hostId, sessionId: selectedId }, { sessionId: selectedId, ticket: view.value.ticket,
        mutation: { action: "navigate", targetId, summarize, ...(customInstructions === undefined ? {} : { customInstructions }) } });
      if (selectedRef.current !== capturedRoute) return;
      transcript.refresh();
      if (result.draft) setTreeEdit({ owner: capturedRoute, targetId, text: result.draft.text, imageCount: result.draft.images.length, prepared: result });
    } catch (cause) { if (selectedRef.current === capturedRoute) setActionError(errorMessage(cause)); }
  };
  const editHistoryMessage = (message: import("@agent-desktop/shared").TranscriptMessage) => {
    if (!message.nativeId || !nativeTree.view.fresh || !nativeTree.view.value) return;
    const entry = nativeTree.view.value.entries.find(entry => entry.id === message.nativeId);
    if (!entry?.editable) { setActionError("This native message is not currently editable. Refresh its history."); return; }
    setTreeEdit({ owner: routeKey, targetId: entry.id, text: entry.text, imageCount: entry.imageCount, originalTicket: nativeTree.view.value.ticket });
  };
  const restoreTreeEdit = async (commandId: string) => {
    const capturedRoute = routeKey;
    if (!selectedId || !bridge.getSessionTree) return;
    try {
      const response = parseSessionTreeResponse(await bridge.getSessionTree(selectedId, hostId, commandId), hostId, selectedId, commandId);
      if (selectedRef.current !== capturedRoute) return;
      const result = response.receipt?.result, recovered = result?.state.recoveredDraft;
      if (response.receipt?.state !== "succeeded" || !result?.draft || !recovered || recovered.commandId !== commandId)
        throw new Error("The original navigation has no confirmed editable receipt. It was not replayed.");
      setTreeHistoryOpen(false); setTreeEdit({ owner: capturedRoute, targetId: recovered.targetId, text: result.draft.text, imageCount: result.draft.images.length, prepared: result });
    } catch (cause) { if (selectedRef.current === capturedRoute) setActionError(errorMessage(cause)); }
  };
  const treeEditContent = treeEdit?.owner === routeKey && selectedId ? <SessionTreeEdit key={`${routeKey}:${treeEdit.targetId}`}
    owner={{ hostId, sessionId: selectedId, targetId: treeEdit.targetId }} initialText={treeEdit.text} imageCount={treeEdit.imageCount}
    prepared={treeEdit.prepared} originalTicket={treeEdit.originalTicket} bridge={bridge} connected={connected && !selected?.archived}
    onClose={() => setTreeEdit(undefined)} onSent={() => { setTreeEdit(undefined); transcript.refresh(); void nativeTree.state.refresh(); }}
    onStop={() => { void command({ type: "session.interrupt", sessionId: selectedId }); }}/>: undefined;
  const todosPanelPorts = useMemo<SessionTodosPanelPorts>(() => ({
    mutate: (owner, request) => nativeTodos.state.mutate(owner, request),
    refresh: async owner => {
      if (owner.hostId !== nativeTodos.state.owner.hostId || owner.sessionId !== nativeTodos.state.owner.sessionId) throw new Error("Open the owning conversation before refreshing its Todos.");
      await nativeTodos.state.refresh();
    },
  }), [nativeTodos.state]);
  const todoEditorPorts = useMemo<TodoEditorPorts>(() => ({
    bridge, storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
    copy: copyText, refreshTodos: async () => { await nativeTodos.state.refresh(); },
    openTerminal: (ownerHostId, ownerSessionId, terminalId) => {
      const owner = nativeTodos.state.owner;
      if (owner.hostId !== ownerHostId || owner.sessionId !== ownerSessionId)
        throw new Error("Select the original conversation before opening its editor terminal.");
      dock.bindTerminal(terminalId, ownerHostId, { sessionId: ownerSessionId }, defaultTerminalLocation, "Todos editor");
      setEnvironmentOpen(false);
    },
  }), [bridge, nativeTodos.state, dock.bindTerminal, defaultTerminalLocation]);
  const todosConnected = connected && !selected?.archived;
  const [todosModel] = useState(() => new SessionTodosModel({ ...nativeTodos.view, connected: todosConnected }, todosPanelPorts));
  const todosOpenCount = nativeTodos.view.value?.phases.reduce((sum, phase) => sum + phase.tasks.filter(task => task.status !== "completed" && task.status !== "abandoned").length, 0) ?? 0;
  const showTodosSection = () => { setEnvironmentOpen(true); setEnvironmentCollapsed(previous => previous.filter(value => value !== "todos")); };
  /** The owning host advertises structured actions for the TUI-only /todo verbs; the desktop performs them. */
  const applyTodoDesktopAction = (result: TodoMutationResult) => {
    if (result.desktopAction === "show" || result.desktopAction === "expand") showTodosSection();
    // The mounted panel configures the model with the confirmed state before the editor opens on it.
    else if (result.desktopAction === "edit") {
      const origin = routeKey;
      showTodosSection();
      requestAnimationFrame(() => {
        const current = todosModel.getSnapshot();
        if (selectedRef.current === origin && current.owner.sessionId === result.state.ticket.nativeSessionId
          && current.value?.ticket.epoch === result.state.ticket.epoch) todosModel.setEditing(true);
      });
    }
    else if (result.desktopAction === "collapse") setEnvironmentCollapsed(previous => previous.includes("todos") ? previous : [...previous, "todos"]);
    else if (result.desktopAction === "copy") copyPath(result.state.markdown);
  };
  const markdownOwner = selected && selected.id === selectedId && selected.hostId === hostId ? { hostId, sessionId: selected.id } : null;
  const markdownIssue = !chatRoute || !markdownOwner ? "Select the conversation to copy."
    : !connected ? "Reconnect to load this conversation from its owning host before copying it."
    : conversationMarkdownIssue(transcript, markdownOwner, markdownCopy?.state === "copying");
  const canCopyMarkdown = markdownIssue === null;
  async function copyConversationMarkdown() {
    if (markdownCopyPending.current || selectedRef.current !== routeKey) return;
    const owner = markdownCopyRoute.current, attempt = {};
    markdownCopyPending.current = attempt;
    setMenuOpen(false);
    try {
      if (markdownIssue || !markdownOwner || !selected) throw new Error(markdownIssue ?? "Select the conversation to copy.");
      const payload = captureConversationMarkdown(transcript, markdownOwner, selected.title);
      setMarkdownCopy({ owner, state: "copying", message: "Copying conversation as Markdown…" });
      await copyText(payload);
      if (markdownCopyRoute.current === owner && markdownCopyPending.current === attempt) setMarkdownCopy({ owner, state: "copied", message: "Copied conversation as Markdown" });
    } catch (cause) {
      if (markdownCopyRoute.current === owner && markdownCopyPending.current === attempt) setMarkdownCopy({ owner, state: "failed", message: `Failed to copy conversation as Markdown: ${errorMessage(cause)}` });
    } finally {
      if (markdownCopyPending.current === attempt) {
        markdownCopyPending.current = null;
        if (markdownCopyRoute.current !== owner) setMarkdownCopy(null);
      }
    }
  }
  const skillTarget = workspaceTarget && !("filePath" in workspaceTarget) ? workspaceTarget : undefined;
  async function reloadSkills() {
    if (!connected) return;
    if (pluginDirectoryOpen && !settingsOpen && !automationsOpen) { setSkillRefresh(value => value + 1); return; }
    try {
      const inventory = await bridge.getSkillInventory?.(skillTarget, true, hostId);
      if (inventory) assertComposerOwner(inventory, hostId, skillTarget);
      else {
        if (!bridge.getComposerActions) throw new Error("Update this desktop to reload native skills.");
        const actions = await bridge.getComposerActions(skillTarget, true, hostId);
        assertComposerOwner(actions, hostId, skillTarget);
      }
    } catch (cause) { if (selectedRef.current === routeKey) setActionError(errorMessage(cause)); }
  }
  const currentShortcutOptions: AppShortcutOptions = {
    ...(commandKeymap && { bindings: appCommandBindings.bindings }),
    composer: () => textarea.current?.element ?? null,
    inputActions: settingsOpen ? ["focus-main-chat", "find-in-thread"] : ["focus-main-chat"],
    blocked: () => Boolean(dialog || menuOpen || forkMenu || fileSearchOwner || commandMenuMode),
    actions: {
      ...(settingsOpen && {
        "find-in-thread": () => {
          const search = document.querySelector<HTMLInputElement>(".settings-sidebar-search input");
          search?.focus();
          search?.select();
        },
      }),
      ...sidebarChatActions(sidebarActivityOpen ? sidebarActivityItems.map(item => ({ hostId: item.session.hostId, sessionId: item.session.id })) : organizedSidebar.chatSlots, navigate),
      ...(!contentOverlayOpen ? numberedMainTaskActions(taskTargets, taskDirection, selectMainTask) : {}),
      ...(!contentOverlayOpen && taskTargets.length > 1 ? { "next-task-tab": () => cycleMainTask("next"), "previous-task-tab": () => cycleMainTask("previous") } : {}),
      "new-chat": () => newConversation(),
      search: () => openCommandMenu("commands"),
      "search-chats": () => openCommandMenu("chats"),
      ...(!busy && !submissions.get("new-conversation") && !drafts.get("new-conversation").conflict && {
        "new-projectless-task": () => {
          if (submitting.current) return;
          const view = drafts.get("new-conversation");
          if (submissions.get("new-conversation") || view.conflict) return;
          if (worktreesAvailable) selectProjectWithExecutionMode(drafts, "new-conversation", null);
          else drafts.update("new-conversation", { projectId: null, execution: { type: "local" } });
          navigate(null, hostId);
        },
      }),
      ...(connected && !addingProject && { "open-folder": () => { void addProject(); } }),
      sidebar: () => setSidebarOpen(value => !value),
      settings: () => openSettings(),
      "keyboard-shortcuts": () => { setSettingsPage("keyboard-shortcuts"); openSettings(); },
      "mcp-settings": () => { setSettingsPage("mcp"); openSettings(); },
      "manage-tasks": openAutomations,
      "open-skills": () => { settingsOriginLabel.current = null; setAutomationsOpen(false); setPluginDirectoryTab("skills"); setPluginDirectoryOpen(true); setSettingsOpen(false); },
      ...(!settingsOpen && !automationsOpen && connected && (bridge.getSkillInventory || bridge.getComposerActions) && { "force-reload-skills": () => { void reloadSkills(); } }),
      ...recentActions,
      ...(chatRoute && {
        "focus-main-chat": () => {
          const origin = document.activeElement;
          selectMainTask(mainChat, false);
          requestAnimationFrame(() => {
            if (selectedRef.current === routeKey && (document.activeElement === origin || !origin?.isConnected && document.activeElement === document.body)
              && !textarea.current?.element.closest("[hidden], [inert]")) textarea.current?.focus();
          });
        },
        ...(selected && {
          "copy-conversation-path": () => copyPath(selected.sessionFile),
          ...(canCopyMarkdown && { "copy-conversation-markdown": () => { void copyConversationMarkdown(); } }),
          ...(connected && !busy && {
            "rename-thread": () => { setRenameTitle(selected.title); setDialog("rename"); setMenuOpen(false); },
            ...(!selected.archived && { "archive-thread": () => { void archive(); } }),
          }),
          ...(writablePreferences && !sessionRead.busy && { "mark-thread-unread": () => { void sessionRead.mark(selected, true); } }),
          ...(writablePreferences && selectedSidebarItem && { "toggle-thread-pin": () => { void moveSidebarItem(preferences, organizedSidebar, selectedSidebarItem, organizedSidebar.sectionOf(selectedSidebarItem) === "pinned" ? null : "pinned").catch(cause => setActionError(errorMessage(cause))); } }),
        }),
        ...((selected?.cwd ?? project?.path) && { "copy-working-directory": () => copyPath((selected?.cwd ?? project?.path)!) }),
        ...(organizedSidebar.allChatSlots.length > 1 && { "previous-thread": () => adjacentChat(-1), "next-thread": () => adjacentChat(1) }),
        ...(nextAttention && { "next-thread-needing-attention": () => navigate(nextAttention.sessionId, nextAttention.hostId) }),
        ...(bottomPanelVisible && { "toggle-bottom-panel": () => dock.toggle("bottom") }),
        ...(taskLayoutAction && { "toggle-maximize-side-panel": () => taskLayoutAction.onSelect({ fillChat: false, restoreFocus: true }) }),
        ...(workspace && connected && workspace.status && workspace.restored && !workspace.busy && !workspace.pending && {
          "git-commit": () => {
            if (state?.gitSubmissions?.commandVersion === 10) openGitSubmission(workspace);
            else { dock.open("review"); setCommitRequest({ owner: workspaceOwner!, id: crypto.randomUUID() }); }
          },
        }),
        ...(canSend && { "composer-submit": () => { void submit(); } }),
        ...(canSend && running && state?.queuedMessages?.submissions?.commandVersion === 13 && {
          "composer-steer": () => { void submit("steer"); },
          "composer-queue": () => { void submit("follow-up"); },
        }),
      }),
      ...(editableDraft && {
        "composer-clear": () => {
          if (submitting.current) return;
          while (imageComposer.staging[0]) imageComposer.removeStaged(imageComposer.staging[0].id);
          textarea.current?.replaceText("");
          drafts.update(draftId, { text: "", attachments: [], wholeFileAttachments: [], selectedTextAttachments: [] });
        },
        ...(!imageCapabilityIssue(state?.imageAttachments) && { "composer-add-photos": () => composerImages.current?.addPhotos() }),
        ...(!selectedId && {
          "composer-open-project-picker": () => composerContext.current?.openProjects(),
        }),
        ...(!running && {
          "composer-open-model-picker": () => composerSelections.current?.openModels(),
          ...(effortIndex >= 0 && effortIndex < ordinalEfforts.length - 1 && { "composer-increase-reasoning-effort": () => drafts.update(draftId, { thinkingLevel: ordinalEfforts[effortIndex + 1] }) }),
          ...(effortIndex > 0 && { "composer-decrease-reasoning-effort": () => drafts.update(draftId, { thinkingLevel: ordinalEfforts[effortIndex - 1] }) }),
          ...(selection.levels.length > 1 && { "composer-cycle-reasoning-effort": () => drafts.update(draftId, { thinkingLevel: selection.levels[(selection.levels.indexOf(selection.thinking ?? "") + 1) % selection.levels.length] }) }),
        }),
      }),
      ...(canFork && { "fork-thread": () => openForkMenu() }),
      // The pinned keyboard command opens search; pointer Files keeps its distinct panel route.
      ...(filesAction && workspaceOwner && { files: () => setFileSearchOwner(workspaceOwner) }),
      ...(sideChatAction && { "side-chat": () => sideChatAction.onSelect("right") }),
      ...(browserAction && { browser: () => browserAction.onSelect("right") }),
      ...(terminalAction && { terminal: () => { void dock.terminal(defaultTerminalLocation); } }),
      ...(reviewAction && { review: () => reviewAction.onSelect("right") }),
      ...(!contentOverlayOpen && workspaceLayoutStepAvailable(dock.snapshot, Boolean(browserAction)) && {
        "step-workspace-layout": () => {
          const draftOwner = mainChat.sessionId === null ? {
            draftId,
            isCurrent: () => committedDraftDockOwner.current === draftDockOwner,
            canDispose: (tab: DockTab, presentations: import("./dock-presentations").DockPresentations) => {
              const controller = draftBrowserDocks.get(JSON.stringify([tab.id, presentations.instances.get(tab.id)]));
              return Boolean(draftDockOwner.enabled && controller?.enabled && !controller.needsInspection && controller.hasObservedPristinePresentation);
            },
          } : undefined;
          if (draftOwner && !draftOwner.isCurrent()) return;
          dock.stepLayout(mainChat, Boolean(browserAction), draftOwner);
          setMainTaskFocus({ target: mainChat, onlyWhenContentClosed: true, ...(draftOwner && { isCurrent: draftOwner.isCurrent }) });
        },
      }),
      "toggle-side-panel": () => dock.toggle("right"),
    },
  };
  const browserAddressOwner = !contentOverlayOpen
    ? dockSession ? browserAddressFocusOwner(hostId, "session", dockSession.sessionId)
      : draftDockOwner.enabled ? browserAddressFocusOwner(hostId, "draft", draftId) : undefined
    : undefined;
  function withLocalControlShortcuts(options: AppShortcutOptions, origin: Element | null = document.activeElement, retainedFileEditor?: FileEditorCommandActions): AppShortcutOptions {
    const root = workbenchElement.current;
    if (!root || !chatRoute) return withBrowserAddressShortcut(options, root, browserAddressOwner, origin);
    const actions = { ...options.actions };
    const inputActions = [...(options.inputActions ?? [])];
    const ownedSurfaceActions = [...(options.ownedSurfaceActions ?? [])];
    if (editableDraft && !selectedId && worktreesAvailable && project && !modeView?.conflict && composerContext.current?.canToggleWorktree) actions["composer-toggle-worktree-mode"] = () => composerContext.current?.toggleWorktree();
    const sideFocus = selectedId ? sideChatFocusCommand(root, hostId, selectedId, origin) : undefined;
    if (sideFocus) {
      actions["focus-side-chat"] = sideFocus;
      inputActions.push("focus-side-chat");
      if (origin?.closest(".side-chat")) ownedSurfaceActions.push("focus-main-chat", "focus-side-chat");
    }
    if (origin && textarea.current?.element?.contains(origin)) {
      inputActions.push("composer-open-model-picker", "composer-open-project-picker", "composer-submit", "composer-steer", "composer-queue", "composer-clear", "composer-add-photos", "composer-increase-reasoning-effort", "composer-decrease-reasoning-effort", "composer-cycle-reasoning-effort", "composer-toggle-worktree-mode");
    }
    const browserInput = browserAddressTarget(root, browserAddressOwner, origin);
    if (browserInput) {
      Object.assign(actions, browserPanelCommands(browserInput));
      inputActions.push("reload-browser-page", "navigate-browser-back", "navigate-browser-forward");
    }
    const approval = selectedId && connected ? approvalCommands(root, hostId, selectedId, origin) : undefined;
    if (approval) {
      Object.assign(actions, approval);
      inputActions.push("approval-approve", "approval-decline");
      ownedSurfaceActions.push("approval-approve", "approval-decline");
    }
    const blame = workspaceGitBlameCommand(root, origin);
    if (blame) {
      actions["git-toggle-blame"] = blame;
      inputActions.push("git-toggle-blame"); ownedSurfaceActions.push("git-toggle-blame");
    }
    const line = goToLineCommand(root, origin);
    if (line) {
      actions["go-to-line"] = line;
      inputActions.push("go-to-line"); ownedSurfaceActions.push("go-to-line");
    }
    const fileEditor = retainedFileEditor ?? focusedFileEditorCommands(root, origin);
    if (fileEditor) {
      for (const [command, run] of Object.entries(fileEditor) as [FileEditorShortcut, () => void][]) {
        actions[command] = () => { try { run(); } catch (cause) { setActionError(errorMessage(cause)); } };
        inputActions.push(command); ownedSurfaceActions.push(command);
      }
      ownedSurfaceActions.push("search");
    }
    const focusDestination = origin?.closest("[data-dock-destination]")?.getAttribute("data-dock-destination");
    const chatFocused = Boolean(origin?.closest("[data-main-task-chat], [data-main-task-chat-tab]"));
    const destination = chatFocused ? undefined : focusDestination === "bottom" ? "bottom" : focusDestination === "right" || mainTaskArea.current === "content" ? "right" : undefined;
    const region = destination && dock.snapshot.state[destination];
    const activeTab = region?.open && region.activeTabId ? dock.snapshot.tabs.find(tab => tab.id === region.activeTabId) : undefined;
    const close = activeTab && destination ? (destination === "right" ? rightDockCommands : bottomDockCommands).current?.closeCommand(activeTab.id) : undefined;
    if (close) {
      actions["close-tab"] = close; inputActions.push("close-tab");
      if (activeTab && activeTab.kind !== "terminal" && origin?.closest("[data-dock-content-id]")?.getAttribute("data-dock-content-id") === activeTab.id) ownedSurfaceActions.push("close-tab");
    }
    if (activeTab && (activeTab.kind === "files" || activeTab.kind === "file" && !activeTab.target.startsWith("file:"))) {
      actions["toggle-file-tree-panel"] = () => setFileTree(value => ({ ...value, open: !value.open }));
      inputActions.push("toggle-file-tree-panel");
      if (origin?.closest("[data-dock-content-id]")?.getAttribute("data-dock-content-id") === activeTab.id) ownedSurfaceActions.push("toggle-file-tree-panel");
    }
    if (reviewAction) {
      const id = panelSingleton("review");
      const destination = id && dock.destinationForTab(id);
      const closeReview = id && destination ? (destination === "right" ? rightDockCommands : bottomDockCommands).current?.closeCommand(id) : undefined;
      if (closeReview) actions["toggle-review-tab"] = closeReview;
      else if (!destination || !dock.snapshot.state[destination].open) actions["toggle-review-tab"] = () => reviewAction.onSelect("right");
    }
    if (workspace && connected) {
      const branch = branchCreationCommand(root, workspace);
      if (branch) actions["git-create-branch"] = branch;
      Object.assign(actions, environmentActionCommands(root, workspace));
    }
    return withBrowserAddressShortcut({ ...options, actions, inputActions, ownedSurfaceActions }, root, browserAddressOwner, origin);
  }
  const commandMenuShortcutOptions = withLocalControlShortcuts(currentShortcutOptions, commandMenuMode ? commandMenuOrigin.current : document.activeElement, commandMenuMode ? commandMenuFileEditor.current?.actions : undefined);
  const commandMenuActions = APPLICATION_COMMANDS.flatMap(definition => {
    const owner = APP_COMMAND_BINDING_OWNERS[definition.id as keyof typeof APP_COMMAND_BINDING_OWNERS];
    const onSelect = owner && commandMenuShortcutOptions.actions[owner];
    const retainedBlame = owner === "git-toggle-blame" ? commandMenuGitBlame.current : undefined;
    const retainedFileEditor = owner ? commandMenuFileEditor.current?.actions[owner as FileEditorShortcut] : undefined;
    if (owner?.startsWith("file-") && ["file-go-to-definition", "file-navigate-back", "file-navigate-forward"].includes(owner) && !retainedFileEditor) return [];
    if (owner === "git-toggle-blame" && !retainedBlame) return [];
    // These webview commands have actual owners above. Electron-only searchFiles
    // remains the dedicated file dialog, not an invented root command-menu row.
    if (definition.id === "nextTab" || definition.id === "previousTab") return [];
    if (!owner || !onSelect || definition.referenceFamily !== "webview" || (definition.numberShortcutFamily === "sidebar" || definition.numberShortcutFamily === "tabs")) return [];
    return [{ id: definition.id, title: definition.title, description: definition.description.replace(/\bCodex\b/g, "Agent Desktop"),
      group: definition.group, shortcut: appCommandShortcutLabel(appCommandBindings.bindings, owner), deferUntilClose: true,
      onSelect: () => {
        if (selectedRef.current !== routeKey) { if (retainedFileEditor) setActionError("The original file editor route changed. Open the command menu again from that source."); return; }
        if (retainedBlame) { retainedBlame(); return; }
        if (retainedFileEditor) { try { retainedFileEditor(); } catch (cause) { setActionError(errorMessage(cause)); } return; }
        const current = shortcutOptions.current;
        current.withControls(current.options, commandMenuOrigin.current).actions[owner]?.();
      } }];
  });
  const commandMenuHosts = [...desktop.catalog.records].flatMap(([id, record]) => record.state ? [{ id, name: record.state.host.name, connected: record.connected, searchAvailable: record.state.sessionSearch?.version === 1 }] : []);
  const commandMenuRecentChats = recentChats;
  // Settings edits installed owners, not only the actions eligible on this route.
  const supportedShortcutCommands = new Set(Object.keys(APP_COMMAND_BINDING_OWNERS));
  const shortcutOptions = useRef({ options: currentShortcutOptions, withControls: withLocalControlShortcuts });
  const installedShortcuts = useRef<ReturnType<typeof installAppShortcuts> | null>(null);
  // Keep one composition lifetime, while dispatch reads the latest committed eligibility and closures.
  useLayoutEffect(() => { shortcutOptions.current = { options: currentShortcutOptions, withControls: withLocalControlShortcuts }; });
  useEffect(() => {
    const installed = installAppShortcuts(window, () => shortcutOptions.current.withControls(shortcutOptions.current.options));
    installedShortcuts.current = installed;
    return () => { installedShortcuts.current = null; installed(); };
  }, []);
  useEffect(() => {
    if (dialog) {
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
      if (dialog === "project" || dialog === "rename") dialogRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    } else dialogRef.current?.close();
  }, [dialog]);
  useEffect(() => {
    if (selected?.projectId && expandAfterNavigation.current === `${hostId}:${selectedId}`) {
      expandAfterNavigation.current = undefined;
      setExpandedProjects(previous => new Set([...previous, `${hostId}:${selected.projectId!}`]));
    }
  }, [selectedId, selected?.projectId, hostId]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close);
  }, [menuOpen]);
  async function addProject(environments = false) {
    if (!bridge || !connected) return;
    projectAddContext.current = { hostId, environments };
    if (hostId !== desktop.localHostId) { setRemotePath(""); setActionError(null); setDialog("project"); return; }
    setAddingProject(true); setActionError(null);
    try {
      const path = await bridge.chooseDirectory(); if (!path) return;
      const value = await command({ type: "project.add", path });
      if (value && "path" in value) { if (environments) setEnvironmentProject({hostId,projectId:value.id}); else { if (worktreesAvailable) selectProjectWithExecutionMode(drafts, "new-conversation", value.id); else drafts.update("new-conversation", { projectId: value.id }); navigate(null); } await refresh(); }
    } catch (cause) { setActionError(errorMessage(cause)); }
    finally { setAddingProject(false); }
  }
  async function addRemoteProject(event: React.FormEvent) {
    event.preventDefault(); if (!remotePath.trim() || !connected) return;
    if (projectAddContext.current?.hostId !== hostId) { setActionError("Return to the selected host before adding this project."); return; }
    setAddingProject(true); setActionError(null);
    try {
      const value = await command({ type: "project.add", path: remotePath.trim() });
      if (value && "path" in value) { if (projectAddContext.current?.environments) setEnvironmentProject({hostId,projectId:value.id}); else { if (worktreesAvailable) selectProjectWithExecutionMode(drafts, "new-conversation", value.id); else drafts.update("new-conversation", { projectId: value.id }); navigate(null); } setDialog(null); await refresh(); }
    } catch (cause) { setActionError(errorMessage(cause)); }
    finally { setAddingProject(false); }
  }
  async function submit(activeDelivery?: "follow-up" | "steer") {
    if (submitting.current) return;
    const typedFork = drafts.get(draftId).draft.text;
    if (!submissions.get(draftId)?.uncertain && /^\s*\/fork(?:\s|$)/.test(typedFork)) {
      const owner = forkOwnerRef.current;
      submitting.current = true; setBusy(true); setActionError(null);
      try {
        if (!selectedId || !connected || !bridge.getComposerActions) throw new Error("Open a connected chat to resolve /fork. The draft was retained.");
        const target = { sessionId: selectedId }, catalog = await bridge.getComposerActions(target, false, hostId);
        assertComposerOwner(catalog, hostId, target);
        if (forkOwnerRef.current !== owner || drafts.get(draftId).draft.text !== typedFork) throw new Error("The chat or draft changed while resolving /fork. Nothing was sent.");
        const native = catalog.commands.find(value => value.name === "fork" && value.availability !== "shadowed");
        if (native?.source.kind === "builtin") {
          if (!owner.enabled || !owner.data?.canStart || !/^\s*\/fork\s*$/.test(typedFork) || hasDraftContent({ ...drafts.get(draftId).draft, text: "" }))
            throw new Error("Fork requires an idle chat and an otherwise empty composer. The draft was retained.");
          openForkMenu(undefined, typedFork); return;
        }
        if (!native || !["executable", "partial"].includes(native.availability)) throw new Error("The owning host did not expose a supported /fork action. The draft was retained.");
      } catch (cause) { setActionError(errorMessage(cause)); return; }
      finally { submitting.current = false; setBusy(false); }
    }
    const goalDraft = drafts.get(draftId).draft;
    const goalCommand = goalComposerCommand(goalDraft.text);
    if (goalCommand && !submissions.get(draftId)?.uncertain) {
      const originalRoute = selectedRef.current;
      submitting.current = true; setBusy(true); setActionError(null);
      try {
        if (!connected || !bridge.getComposerActions) throw new Error("Reconnect to the owning host to resolve /goal. The draft was retained.");
        const catalog = await bridge.getComposerActions(workspaceTarget, false, hostId);
        assertComposerOwner(catalog, hostId, workspaceTarget);
        if (selectedRef.current !== originalRoute || !desktop.catalog.records.get(hostId)?.connected || !sameDraftContent(goalDraft, drafts.get(draftId).draft))
          throw new Error("The original conversation, connection, or draft changed while resolving /goal. Nothing was sent.");
        const native = catalog.commands.find(row => row.name === "goal" && row.availability !== "shadowed");
        if (native?.source.kind === "builtin") {
          if (native.desktopAction !== "goal" || state?.goalComposer?.commandVersion !== 24) throw new Error("Update the owning host to use Goal composer intent. The draft was retained.");
          if (goalCommand.kind === "manage") {
            if (selectedId) dock.open("goal");
            throw new Error(selectedId ? `Use the Goal panel for /goal ${goalCommand.verb}. The command and attachments were retained; nothing was changed.` : "Open a conversation to manage an existing goal. The command was retained.");
          }
          if (selectedId && !goalCommand.text.trim()) {
            dock.open("goal");
            drafts.update(draftId, { text: goalCommand.text, wholeFileAttachments: remapFileOffsets(goalDraft.text, goalCommand.text, goalDraft.wholeFileAttachments ?? []) });
            return;
          }
          drafts.update(draftId, { text: goalCommand.text, goal: goalDraft.goal ?? { tokenBudget: "" },
            ...(goalDraft.wholeFileAttachments === undefined ? {} : { wholeFileAttachments: remapFileOffsets(goalDraft.text, goalCommand.text, goalDraft.wholeFileAttachments) }) });
          textarea.current?.focus();
          return;
        }
        if (!native || !["executable", "partial"].includes(native.availability)) throw new Error("The owning host did not expose a supported /goal action. The draft was retained.");
      } catch (cause) { if (selectedRef.current === originalRoute) setActionError(errorMessage(cause)); return; }
      finally { submitting.current = false; setBusy(false); }
    }
    if (!canSend) return;
    let browserContinuation;
    try {
      if (!selectedId && !submissions.get(draftId)?.uncertain) {
        browserContinuation = draftBrowserPages.captureContinuation(draftId);
        if (browserContinuation && state?.browserContinuations?.commandVersion !== 15)
          throw new Error("Update the owning host before sending a conversation with an open draft browser. The draft and browser were retained.");
      }
    } catch (cause) { setActionError(errorMessage(cause)); return; }
    submitting.current = true; draftBrowserOwners.beforeSubmission(); draftBrowserPages.beforeSubmission(); for (const controller of draftBrowserDocks.values()) controller.beforeSubmission();
    setBusy(true); setActionError(null);
    const sendingDraftId = draftId; const originalRoute = selectedRef.current;
    let snapshot: Draft | undefined, submittedForceCommandId: string | undefined;
    let sideHandled = false, usagePresented = false;
    let releaseUsageOwner: (() => void) | undefined;
    const usageSource = usageRoute.current;
    let usageOwnerLost = false;
    const observeUsageOwner = () => {
      if (usageRoute.current !== usageSource || selectedRef.current !== originalRoute || !desktop.catalog.records.get(hostId)?.connected) usageOwnerLost = true;
    };
    const assertUsageOwner = () => {
      observeUsageOwner();
      if (usageOwnerLost) throw new Error("The original conversation or connection changed. The reset draft was retained.");
    };
    try {
      // Observe from submission admission, including draft/catalog awaits.
      const offCatalog = desktop.catalog.subscribe(observeUsageOwner);
      releaseUsageOwner = offCatalog;
      const offConnection = bridge.subscribe(event => {
        if (event.type === "connection" && (event.hostId ?? desktop.localHostId) === hostId) usageOwnerLost = true;
      });
      releaseUsageOwner = () => { offCatalog(); offConnection(); };
      observeUsageOwner();
      const pending = submissions.get(sendingDraftId);
      snapshot = pending?.uncertain ? pending.draft : await drafts.prepareSubmission(sendingDraftId);
      if (!hasDraftContent(snapshot)) return;
      if (!pending?.uncertain && snapshot.goal) {
        if (state?.goalComposer?.version !== 1 || state.goalComposer.commandVersion !== 24) throw new Error("Update the owning host before sending Goal intent. The draft was retained.");
        if (running) throw new Error("Wait for the current response before starting a goal. The objective and attachments were retained.");
      }
      if (!pending?.uncertain && hasRemoteExecution(snapshot.execution)) {
        const currentOwner = desktop.catalog.records.get(hostId);
        if (!currentOwner?.connected) throw new Error('Reconnect to the owning host before sending this remote worktree draft.');
        const issue = remoteWorktreeIssue(snapshot.execution, currentOwner.state);
        if (issue) throw new Error(issue);
      }
      if (!pending?.uncertain && !selectedId && nativeBtwQuestion(snapshot.text) !== undefined) throw new Error('Open a conversation before asking a native /btw side question. The draft was retained.');
      if (!pending?.uncertain && selectedId && nativeBtwQuestion(snapshot.text) !== undefined) {
        if (!bridge.getComposerActions) throw new Error('Update this desktop to resolve native /btw. The draft was retained.');
        const target = { sessionId: selectedId };
        const catalog = await bridge.getComposerActions(target, false, hostId);
        assertComposerOwner(catalog, hostId, target);
        const native = catalog.commands.find(value => value.name === 'btw' && value.availability !== 'shadowed');
        // Native extensions/custom commands retain their dispatch precedence.
        if (native?.source.kind === 'builtin') {
          if (native.desktopAction !== 'side-chat') throw new Error('Update the owning host to use native /btw through Side chat. The draft was retained.');
          const side = sideChatController(hostId, selectedId);
          await side.refresh();
          if (!side.ready || side.busy || side.pending) throw new Error(side.error || side.unavailable || 'Resolve the previous side-chat request before sending another.');
          sideHandled = true;
          if (selectedRef.current === originalRoute) dock.open('side-chat');
          await side.start(snapshot);
          if (side.error) throw new Error(side.error);
          await refresh();
          return;
        }
      }
      if (!pending?.uncertain && /^\s*\/tree(?:[\s:]|$)/.test(snapshot.text)) {
        if (!selectedId || !bridge.getComposerActions) throw new Error("Open a connected conversation before using native /tree. The draft was retained.");
        const target = { sessionId: selectedId }, catalog = await bridge.getComposerActions(target, false, hostId);
        assertComposerOwner(catalog, hostId, target);
        if (selectedRef.current !== originalRoute) throw new Error("The original conversation changed. Nothing was sent.");
        const token = snapshot.text.trim().split(" ")[0]!.slice(1), literal = catalog.commands.find(row => row.name === token && row.availability !== "shadowed");
        const native = literal?.source.kind === "extension" || literal?.source.kind === "custom" ? literal : catalog.commands.find(row => row.id === "builtin:tree");
        if (native?.source.kind === "builtin") {
          if (native.desktopAction !== "tree" || !state?.tree || !/^\s*\/tree\s*$/.test(snapshot.text) || snapshot.attachments?.length || snapshot.selectedTextAttachments?.length || snapshot.wholeFileAttachments?.length)
            throw new Error("Use /tree without arguments or attachments to open native history. The draft was retained.");
          openTreeHistory(); return;
        }
      }
      if (!pending?.uncertain && /^\s*\/todo(?:[\s:]|$)/.test(snapshot.text)) {
        if (!selectedId) throw new Error("Open a conversation before using native /todo. The draft was retained.");
        if (!bridge.getComposerActions) throw new Error("Update this desktop to resolve native /todo. The draft was retained.");
        const target = { sessionId: selectedId }, catalog = await bridge.getComposerActions(target, false, hostId);
        assertComposerOwner(catalog, hostId, target);
        if (selectedRef.current !== originalRoute) throw new Error("The conversation changed while resolving /todo. Nothing was sent.");
        const text = snapshot.text.trim(), space = text.indexOf(" "), token = space < 0 ? text.slice(1) : text.slice(1, space);
        const literal = catalog.commands.find(value => value.name === token && value.availability !== "shadowed");
        // Native extension/custom dispatch uses the literal space-delimited token
        // before builtins parse ':' or other whitespace as argument separators.
        const native = literal?.source.kind === "extension" || literal?.source.kind === "custom" ? literal
          : catalog.commands.find(value => value.id === "builtin:todo");
        // Native extensions/custom commands retain their dispatch precedence.
        if (native?.source.kind === "builtin") {
          if (native.desktopAction !== "todos") throw new Error("Update the owning host to use native /todo through the Todos panel. The draft was retained.");
          if (snapshot.attachments?.length || snapshot.selectedTextAttachments?.length || snapshot.wholeFileAttachments?.length) throw new Error("Native /todo does not accept attachments. The draft was retained.");
          const current = nativeTodos.state.getSnapshot();
          if (!current.value) throw new Error(current.readError ?? current.error ?? "Refresh the native Todos before using /todo. The draft was retained.");
          const result = await nativeTodos.state.mutate({ hostId, sessionId: selectedId }, { sessionId: selectedId, ticket: current.value.ticket, mutation: { action: "command", text: snapshot.text.trim() } });
          drafts.finishSubmission(sendingDraftId, snapshot, false);
          if (drafts.get(sendingDraftId).draft.text === snapshot.text) drafts.update(sendingDraftId, { text: "" });
          if (selectedRef.current === originalRoute) applyTodoDesktopAction(result);
          return;
        }
      }
      const resetArgument = usageResetArgument(snapshot.text);
      if (!pending?.uncertain && resetArgument !== undefined) {
        if (!selectedId || !bridge.getComposerActions) throw new Error("Open a connected conversation before using /usage reset. The draft was retained.");
        assertUsageOwner();
        const target = { sessionId: selectedId }, catalog = await bridge.getComposerActions(target, false, hostId);
        assertComposerOwner(catalog, hostId, target);
        assertUsageOwner();
        if (nativeUsageResetWinner(catalog, snapshot.text)) {
          if (state?.sessionUsage?.version !== 1 || state.sessionUsage.commandVersion !== 20 || !bridge.getSessionUsage)
            throw new Error("Update this desktop and its owning host before using /usage reset. The draft was retained.");
          if (snapshot.attachments?.length || snapshot.selectedTextAttachments?.length || snapshot.wholeFileAttachments?.length)
            throw new Error("Native /usage reset does not accept attachments. The draft was retained.");
          const controller = new SessionUsageState(hostId, selectedId, bridge, localStorage);
          usagePresented = true;
          setUsageOwner({ hostId, sessionId: selectedId, hostName: state.host.name, controller });
          await controller.prepareCommand(resetArgument, assertUsageOwner);
          drafts.finishSubmission(sendingDraftId, snapshot, false);
          if (sameDraftContent(drafts.get(sendingDraftId).draft, snapshot)) drafts.update(sendingDraftId, { text: "" });
          return;
        }
      }
      let force: NativeForceSubmission | undefined;
      if (!pending?.uncertain && forceCommandSpelling(snapshot.text)) {
        if (!bridge.getComposerActions) throw new Error("Update this desktop to resolve native /force. The draft was retained.");
        if (!selectedId) {
          // Project catalogs do not load live extension callbacks. Create the
          // session first, then resolve the actual native winner before send.
          force = { nativeForce: true };
        } else {
          const target = { sessionId: selectedId }, catalog = await bridge.getComposerActions(target, false, hostId);
          assertComposerOwner(catalog, hostId, target);
          if (selectedRef.current !== originalRoute) throw new Error("The conversation changed while resolving /force. Nothing was sent.");
          force = submissions.forceTools.selection(selectedId, snapshot, nativeForceWinner(catalog, snapshot.text));
          if (force && (state?.forceTool?.commandVersion !== 18 || state.forceTool.version !== 1))
            throw new Error("Update the owning host to use native /force. The draft was retained.");
        }
        if (force && running) throw new Error("Wait for the current response to finish before sending native /force. The draft was retained.");
      }
      drafts.beginPendingSubmission(snapshot);
      if (running && !pending?.force && (!selectedId || state?.queuedMessages?.submissions?.commandVersion !== 13)) throw new Error("Update the owning host to send active-turn follow-ups. The draft was retained.");
      if (running && !pending?.force && snapshot.attachments?.length && state?.queuedMessages?.submissions?.images?.commandVersion !== 17)
        throw new Error("Update the owning host to send images during an active turn. The draft was retained.");
      const result = running && !pending?.force
        ? await submissions.submitActive(snapshot, selectedId!, activeDelivery ?? (followUpQueueMode === "queue" ? "follow-up" : "steer"), (submitted, commandId) => drafts.beginPendingSubmission(submitted, commandId))
        : await submissions.submit(snapshot, selectedId ?? undefined, "prompt", (submitted, commandId) => {
          if (force || pending?.force) submittedForceCommandId = commandId;
          drafts.beginPendingSubmission(submitted, commandId);
        }, browserContinuation, force);
      drafts.finishSubmission(sendingDraftId, result.submitted, true, false, result.commandId);
      await refresh(); transcript.refresh();
      if (/^\/export(?:\s|$)/.test(result.submitted.text) && bridge.getSessionExport) {
        const exported = await bridge.getSessionExport(result.sessionId, result.commandId, hostId).catch(() => undefined);
        if (selectedRef.current === originalRoute && exported?.hostId === hostId && exported.sessionId === result.sessionId && ["complete", "pending", "unknown"].includes(exported.state))
          setExportOwner({ hostId, sessionId: result.sessionId, commandId: result.commandId });
      }
      // The awaited catalog is authoritative before React runs its ingest effect.
      // Image-aware drafts cannot navigate based on an optimistic local clear.
      const savedDraft = desktop.catalog.records.get(hostId)?.state?.drafts.find(value => value.id === sendingDraftId);
      if (savedDraft) drafts.ingest(savedDraft);
      if (selectedRef.current === originalRoute && !hasDraftContent(drafts.get(sendingDraftId).draft)) navigate(result.sessionId);
    } catch (cause) {
      if (snapshot && !sideHandled) {
        const queued = submissions.queuedEntries().find(item => item.draft.id === sendingDraftId && item.draft.revision === snapshot!.revision);
        drafts.finishSubmission(sendingDraftId, snapshot, false, queued?.uncertain ?? submissions.get(sendingDraftId)?.uncertain, queued?.send.id ?? submissions.get(sendingDraftId)?.send?.id);
      }
      if (!(cause instanceof EnvironmentPreparationPause)) reportSubmissionError(cause, sendingDraftId, submittedForceCommandId);
    } finally { releaseUsageOwner?.(); submitting.current = false; setBusy(false); if (!sideHandled && !usagePresented) textarea.current?.focus(); }
  }
  async function resumeEnvironment() {
    if (submitting.current || !connected || !pendingSubmission?.preparation) return;
    const currentPending = submissions.get(draftId);
    if (!currentPending?.preparation) return;
    const currentOwner = desktop.catalog.records.get(hostId);
    if (!currentOwner?.connected) return;
    const issue = remoteWorktreeResumeIssue(currentPending, currentOwner.state);
    if (issue) { setActionError(issue); return; }
    const ownerDraftId = draftId, originalRoute = selectedRef.current, captured = currentPending.draft;
    submitting.current = true; draftBrowserOwners.beforeSubmission(); draftBrowserPages.beforeSubmission(); for (const controller of draftBrowserDocks.values()) controller.beforeSubmission(); setBusy(true); setActionError(null);
    try {
      drafts.beginPendingSubmission(captured);
      const result = await submissions.resumeEnvironment(ownerDraftId, (submitted, commandId) => drafts.beginPendingSubmission(submitted, commandId));
      drafts.finishSubmission(ownerDraftId, result.submitted, true, false, result.commandId);
      await refresh(); transcript.refresh();
      const savedDraft = desktop.catalog.records.get(hostId)?.state?.drafts.find(value => value.id === ownerDraftId);
      if (savedDraft) drafts.ingest(savedDraft);
      if (selectedRef.current === originalRoute && !hasDraftContent(drafts.get(ownerDraftId).draft)) navigate(result.sessionId);
    } catch (cause) {
      const pending = submissions.get(ownerDraftId);
      drafts.finishSubmission(ownerDraftId, captured, false, pending?.uncertain, pending?.send?.id);
      if (!(cause instanceof EnvironmentPreparationPause)) setActionError(errorMessage(cause));
    } finally { submitting.current = false; setBusy(false); }
  }
  async function interrupt() {
    if (!selectedId) return;
    setActionError(null);
    try { await command({ type: "session.interrupt", sessionId: selectedId }); await refresh(); }
    catch (cause) { setActionError(errorMessage(cause)); }
  }
  async function archive() {
    if (!selected) return;
    setMenuOpen(false); setActionError(null);
    try { await command({ type: "session.archive", sessionId: selected.id, archived: !selected.archived }); await refresh(); }
    catch (cause) { setActionError(errorMessage(cause)); }
  }
  function currentSidebarProject(original: Project) {
    const owner = desktop.catalog.records.get(original.hostId);
    const current = owner?.state?.projects.find(item => item.id === original.id && item.hostId === original.hostId);
    if (!bridge || !owner?.connected || !current || current.path !== original.path) {
      throw new Error("Reconnect to this project’s original host before changing it.");
    }
    return current;
  }
  async function renameSidebarProject(original: Project, name: string) {
    currentSidebarProject(original);
    const { id: projectId, hostId: ownerHostId } = original;
    const result = await bridge.command({ id: crypto.randomUUID(), command: { type: "project.rename", projectId, name } }, ownerHostId);
    if (!result.ok) throw new Error(result.error.message);
    await desktop.catalog.refreshHost(ownerHostId);
  }
  async function removeSidebarProject(original: Project) {
    currentSidebarProject(original);
    const { id: projectId, hostId: ownerHostId } = original;
    const result = await bridge.command({ id: crypto.randomUUID(), command: { type: "project.remove", projectId } }, ownerHostId);
    if (!result.ok) throw new Error(result.error.message);
    await desktop.catalog.refreshHost(ownerHostId);
  }
  async function revealSidebarProject(original: Project) {
    currentSidebarProject(original);
    if (original.hostId !== desktop.localHostId || !bridge.revealProjectDirectory) throw new Error("This project can only be revealed on its owning desktop.");
    await bridge.revealProjectDirectory(original.id, original.hostId);
  }
  async function archiveSidebarSession(sessionId: string, ownerHostId: string, archived: boolean) {
    setActionError(null);
    try {
      const owner = desktop.catalog.records.get(ownerHostId);
      if (!bridge || !owner?.connected || !owner.state?.sessions.some(session => session.id === sessionId)) {
        throw new Error("Reconnect to this chat’s host before changing its archive state.");
      }
      const result = await bridge.command({ id: crypto.randomUUID(), command: { type: "session.archive", sessionId, archived } }, ownerHostId);
      if (!result.ok) throw new Error(result.error.message);
      await desktop.catalog.refreshHost(ownerHostId);
      return true;
    } catch (cause) { setActionError(errorMessage(cause)); return false; }
  }
  async function rename(event: React.FormEvent) {
    event.preventDefault(); if (!selected || !renameTitle.trim()) return;
    try { await command({ type: "session.rename", sessionId: selected.id, title: renameTitle.trim() }); setDialog(null); await refresh(); }
    catch (cause) { setActionError(errorMessage(cause)); }
  }
  const autocomplete = useComposerAutocomplete({
    bridge, hostId, target: workspaceTarget, draftId, text: draft.text, connected,
    disabled: Boolean(selected?.archived || missingSession || busy || pendingSubmission?.uncertain || settingsOpen),
    input: textarea, readText: () => drafts.get(draftId).draft.text,
    fork: forkSupported && forkController ? { data: forkController, emptyComposer: !hasDraftContent({ ...draft, text: "" }), run: runFork } : undefined,
    insertFile: state?.wholeFiles?.inlineMentions?.commandVersion===8 ? (source,range) => {
      if(!textarea.current)throw new Error('The composer is unavailable. Your draft is unchanged.');
      const file=appendWholeFile(drafts.get(draftId).draft,hostId,source,{textOffset:range.start,allowRepeated:state?.wholeFiles?.inlineMentions?.repeatedSources?.commandVersion===9}).findLast(item=>item.source.hostId===source.hostId&&item.source.path===source.path)!;
      textarea.current.insertFile(file,range);
    } : undefined,
    updateText: text => { if(textarea.current)textarea.current.replaceText(text); else drafts.update(draftId,{text,wholeFileAttachments:remapFileOffsets(drafts.get(draftId).draft.text,text,drafts.get(draftId).draft.wholeFileAttachments??[])}); },
    actions: [
      { id: "side-chat", name: "Side chat", description: "Ask a native OMP side question", icon: "sideChat", reason: !selected ? "Open a conversation to ask a side question." : undefined, run: () => dock.open("side-chat") },
      { id: "goal", name: "Goal", description: selected ? "Manage the native goal" : "Start a conversation with a goal", icon: "compose", reason: !selected && state?.goalComposer?.commandVersion !== 24 ? "Update the owning host to use Goal composer intent." : undefined, run: () => { if (selected) dock.open("goal"); else { drafts.update(draftId, { goal: drafts.get(draftId).draft.goal ?? { tokenBudget: "" } }); textarea.current?.focus(); } } },
      { id: "archive", name: "Archive", description: "Archive the current chat", icon: "archive", reason: !selected ? "Open a conversation to archive it." : !connected ? "Reconnect to archive this conversation." : undefined,
        run: async () => { if (!selected || !connected) throw new Error("The conversation is unavailable."); await command({ type: "session.archive", sessionId: selected.id, archived: true }); await refresh(); } },
      { id: "review", name: "Code review", description: "Review changes in this workspace", icon: "compose", reason: !workspace ? "Choose a project to review its changes." : undefined,
        run: () => dock.open("review") },
      { id: "files", name: "Files", description: "Open workspace files", icon: "folder", reason: !workspace ? "Choose a project to browse its files." : undefined,
        run: () => dock.open("files") },
      { id: "terminal", name: "Terminal", description: "Open the workspace terminal", icon: "terminal", reason: !workspace ? "Choose a project to open its terminal." : undefined,
        run: () => dock.terminal(defaultTerminalLocation) },
      { id: "new-chat", name: "New chat", description: "Start a new conversation", icon: "compose", run: () => newConversation() },
      { id: "settings", name: "Settings", description: "Open native OMP settings", icon: "more", run: () => { setSettingsPage("omp"); openSettings(); } },
    ],
  });

  const directoryOwner = useMcpDirectoryOwners(bridge, (ownerHost, ownerProject) => {
    const record = desktop.catalog.records.get(ownerHost);
    return Boolean(record?.connected && (ownerProject === null || record.state?.projects.some(project => project.id === ownerProject)));
  });
  const [connectingDirectory, setConnectingDirectory] = useState<{ owner: import("./mcp-directory-owner").McpDirectoryOwner; connecting: boolean }>();
  const directoryMcp = !selected && !missingSession ? directoryOwner(hostId, project?.id ?? null) : undefined;
  const mcpCatalogue = useMcpAppCatalogue(bridge, hostId, selected?.archived ? undefined : selected?.id, connected);
  const committedArtifactOwner = useRef({ hostId, sessionId: selected?.id, enabled: false, messages: transcript.messages, presentations: dock.presentations });
  useLayoutEffect(() => { committedArtifactOwner.current = { hostId, sessionId: selected?.id, enabled: connected && !contentOverlayOpen, messages: transcript.messages, presentations: dock.presentations }; });
  const openMcpArtifact = (artifact: import("@agent-desktop/shared").McpArtifact, sourceCurrent: () => boolean = () => true) => {
    const original = committedArtifactOwner.current;
    const current = () => {
      const owner = committedArtifactOwner.current;
      return Boolean(sourceCurrent() && original.sessionId && owner.enabled && owner.hostId === original.hostId && owner.sessionId === original.sessionId
        && mcpCatalogue.current() && owner.messages.some(message => message.nativeId === artifact.entryId && message.mcpArtifact?.serverName === artifact.serverName
          && message.mcpArtifact.toolName === artifact.toolName && message.mcpArtifact.resourceUri === artifact.resourceUri));
    };
    const catalogue = mcpCatalogue.snapshot;
    if (!current() || !original.sessionId || !catalogue?.canOpenApps) { setActionError("This app result is unavailable from its original conversation."); return; }
    const tab = mcpArtifactDockTab(original.hostId, original.sessionId, artifact);
    tab.mcpAppSelection = { epoch: catalogue.epoch, expectedRevision: catalogue.revision, serverName: artifact.serverName, toolName: artifact.toolName, resourceUri: artifact.resourceUri };
    mcpOpeningFocus.current.set(tab.id, document.activeElement);
    dock.addMcpApp(tab, current);
  };
  const openMcpFileViewer = (ownerHost: string, ownerSession: string, path: string, origin?: DockPresentationRef, sourceCurrent: () => boolean = () => true): boolean => {
    const original = committedArtifactOwner.current, catalogue = mcpCatalogue.snapshot;
    const selectedViewer = mcpFileViewerForPath(catalogue, path);
    if (!selectedViewer || !catalogue || original.hostId !== ownerHost || original.sessionId !== ownerSession) return false;
    const current = (presentations = committedArtifactOwner.current.presentations) => {
      const owner = committedArtifactOwner.current;
      return sourceCurrent() && owner.enabled && owner.hostId === ownerHost && owner.sessionId === ownerSession && mcpCatalogue.current()
        && (!origin || isCurrentDockPresentation(presentations, origin));
    };
    if (!current()) return true;
    const tab = mcpFileViewerDockTab(ownerHost, ownerSession, path, selectedViewer.viewer, selectedViewer.serverName);
    tab.mcpAppSelection = { epoch: catalogue.epoch, expectedRevision: catalogue.revision, serverName: selectedViewer.serverName,
      toolName: selectedViewer.viewer.toolName, resourceUri: selectedViewer.viewer.resourceUri };
    mcpOpeningFocus.current.set(tab.id, document.activeElement);
    dock.addMcpFileViewer(tab, current);
    return true;
  };
  const openMcpDirectoryFileViewer = (ownerHost: string, projectId: string, path: string, origin: DockPresentationRef): boolean => {
    const owner = directoryOwner(ownerHost, projectId), snapshot = owner?.snapshot;
    const selectedViewer = mcpFileViewerForPath(snapshot?.catalogue, path);
    if (!owner || !snapshot || !selectedViewer || committedArtifactOwner.current.hostId !== ownerHost) return false;
    const current = (presentations = committedArtifactOwner.current.presentations) => owner.isCurrentSnapshot(snapshot)
      && committedArtifactOwner.current.enabled && committedArtifactOwner.current.hostId === ownerHost && isCurrentDockPresentation(presentations, origin);
    if (!current()) return true;
    const tab = mcpDirectoryFileViewerDockTab(ownerHost, { projectId, cwd: snapshot.cwd }, path, selectedViewer.viewer, selectedViewer.serverName);
    tab.mcpAppSelection = { epoch: snapshot.catalogue.epoch, expectedRevision: snapshot.catalogue.revision, serverName: selectedViewer.serverName,
      toolName: selectedViewer.viewer.toolName, resourceUri: selectedViewer.viewer.resourceUri };
    mcpOpeningFocus.current.set(tab.id, document.activeElement); dock.addMcpFileViewer(tab, current); return true;
  };
  const mcpOpeningFocus = useRef(new Map<string, Element | null>());
  const mcpPanels = useMemo(() => new Map<string, McpAppController>(), [bridge, bridge.mcpOwner]);
  useEffect(() => {
    const live = new Set(dock.snapshot.tabs.filter(tab => tab.kind === "mcp-app").map(tab => tab.id));
    for (const id of mcpOpeningFocus.current.keys()) if (!live.has(id)) mcpOpeningFocus.current.delete(id);
    for (const [id, controller] of mcpPanels) if (!live.has(id)) { mcpPanels.delete(id); void controller.dispose().catch(error => setActionError(errorMessage(error))); }
  }, [dock.snapshot.tabs, mcpPanels]);
  useEffect(() => () => { for (const controller of mcpPanels.values()) void controller.dispose().catch(() => {}); mcpPanels.clear(); }, [mcpPanels]);
  const sessionMcpActions: DockAddAction[] = !selected || !mcpCatalogue.snapshot?.canOpenApps ? [] : mcpCatalogue.snapshot.servers.flatMap(server => server.status !== "connected" ? [] : (server.apps ?? []).map(app => {
    const selection = { epoch: mcpCatalogue.snapshot!.epoch, expectedRevision: mcpCatalogue.snapshot!.revision, serverName: server.name, toolName: app.toolName, resourceUri: app.resourceUri };
    const create = () => ({ ...mcpAppDockTab(hostId, selected.id, app, server.name), mcpAppSelection: selection });
    return { id: mcpAppActionId(hostId, selected.id, server.name, app.toolName), label: app.title, icon: "compose" as const,
      appIcon: app.icon, destinations: ["right"] as const, requiresConnection: true, deferSelectionUntilDropdownClose: true,
      preparationTarget: { hostId, target: `session:${selected.id}` as const },
      prepare: async (signal: AbortSignal) => signal.aborted || !mcpCatalogue.current() ? { status: "cancelled" as const, creationMayHaveRun: false } : { status: "ready" as const, tab: create() },
      onSelect: (destination: "right" | "bottom") => { if (destination !== "right" || !mcpCatalogue.current()) return; const tab = create(); mcpOpeningFocus.current.set(tab.id, document.activeElement); dock.addMcpApp(tab, mcpCatalogue.current); },
    };
  }));
  const directoryAppEntries: DockAddAction[] = !directoryMcp ? [] : directoryMcp.current() && directoryMcp.snapshot?.catalogue.canOpenApps
    ? directoryMcp.snapshot.catalogue.servers.flatMap(server => server.status !== "connected" ? [] : (server.apps ?? []).map(app => {
      const owner = directoryMcp, snapshot = owner.snapshot!, catalogue = snapshot.catalogue;
      const current = () => owner.isCurrentSnapshot(snapshot);
      const create = () => ({ ...mcpDirectoryAppDockTab(hostId, { projectId: snapshot.projectId, cwd: snapshot.cwd }, app, server.name),
        mcpAppSelection: { epoch: catalogue.epoch, expectedRevision: catalogue.revision, serverName: server.name, toolName: app.toolName, resourceUri: app.resourceUri } });
      return { id: mcpAppActionId(hostId, `directory:${snapshot.cwd}`, server.name, app.toolName), label: app.title, icon: "compose" as const,
        appIcon: app.icon, destinations: ["right"] as const, requiresConnection: true, deferSelectionUntilDropdownClose: true,
        preparationTarget: { hostId, target: snapshot.projectId === null ? "host" as const : `project:${snapshot.projectId}` as const },
        prepare: async (signal: AbortSignal) => signal.aborted || !current() ? { status: "cancelled" as const, creationMayHaveRun: false } : { status: "ready" as const, tab: create() },
        onSelect: (destination: "right" | "bottom") => { if (destination !== "right" || !current()) return; const tab = create(); mcpOpeningFocus.current.set(tab.id, document.activeElement); dock.addMcpApp(tab, current); },
      };
    })) : [];
  const directoryMcpActions: DockAddAction[] = !directoryMcp ? [] : [...directoryAppEntries, {
    id: "connect-directory-apps", label: directoryMcp.current() ? "App connections" : directoryMcp.loading ? "Connecting apps…" : "Connect apps", icon: "compose", requiresConnection: true,
    destinations: ["right"], onSelect: () => {
      setConnectingDirectory({ owner: directoryMcp, connecting: !directoryMcp.current() || !directoryMcp.snapshot?.catalogue.available });
      if (!directoryMcp.current() && !directoryMcp.loading) void directoryMcp.acquire().catch(() => {});
    },
  }];
  const suggestedOutputs = useSuggestedOutputs({ bridge, hostId, sessionId: selected?.id,
    connected, active: Boolean(selected && !reviewAction && workspaceOpen && !dock.snapshot.state.right.tabIds.length && !contentOverlayOpen),
    entryIds: transcript.messages.flatMap(message => message.nativeId ? [message.nativeId] : []),
  });
  const [htmlPreviewViews] = useState(() => new HtmlPreviewViews(setActionError));
  useLayoutEffect(() => { htmlPreviewViews.start(); return () => htmlPreviewViews.dispose(); }, [htmlPreviewViews]);
  useLayoutEffect(() => { htmlPreviewViews.observe(dock.snapshot.tabs.map(tab => tab.id)); });
  const openSuggestedOutput = (output: import("@agent-desktop/shared").SessionOutput, current: () => boolean) => {
    const original = committedArtifactOwner.current;
    const retained = suggestedOutputs.capture(output, true);
    if (!current() || !retained || !original.sessionId) return;
    if (output.kind === "html-preview") {
      return htmlPreviewViews.open({ bridge, hostId: original.hostId, sessionId: original.sessionId, epoch: suggestedOutputs.snapshot!.epoch, output, admitted: current, retained,
        queue: (url, guard, preview) => dock.openOutputWebsite(url, original.hostId, original.sessionId!, current, guard, preview) });
    } else if (output.kind === "generated-image") {
      setSourcePreview({ hostId: original.hostId, current: retained, source: { id: `generated:${output.entryId}:${output.imageIndex}`, kind: "image", label: output.label,
        image: { kind: "transcript", source: "generated", sessionId: original.sessionId, nativeEntryId: output.entryId, blockIndex: output.imageIndex, mimeType: output.mimeType, sha256: output.sha256, bytes: output.bytes } } });
    } else if (output.kind === "mcp") {
      const artifact = original.messages.find(message => message.nativeId === output.entryId)?.mcpArtifact;
      if (!artifact || artifact.serverName !== output.serverName || artifact.toolName !== output.toolName || artifact.resourceUri !== output.resourceUri) throw new Error("The original saved app output is unavailable.");
      openMcpArtifact(artifact, current);
    } else if (output.kind === "website") {
      dock.openOutputWebsite(output.url, original.hostId, original.sessionId, current, retained);
    } else {
      const cwd = selected?.cwd.replace(/\/$/, ""), relative = cwd && output.path.startsWith(`${cwd}/`) ? output.path.slice(cwd.length + 1) : undefined;
      if (relative && openMcpFileViewer(original.hostId, original.sessionId, relative, undefined, current)) return;
      dock.openHostFile(output.path, original.hostId, "right", false, current);
    }
  };
  const mcpActions = [...sessionMcpActions, ...directoryMcpActions];
  // Pinned Git workspaces prioritize Review and Terminal; other workspaces retain the provider order.
  const dockActions: DockAddAction[] = dockEmptyActionCatalogue(
    [filesAction,sideChatAction,browserAction,reviewAction,...mcpActions,terminalAction],
    dock.snapshot.state,
    workspace?.gitAvailability === "repository" || workspace?.status !== undefined,
  );
  function terminalRecovery(intent: TerminalWindowIntent, enabled: boolean, detached = false) {
    const requestKey = `${intent.hostId}:${intent.request.requestId}`, status = terminalRequests.status(requestKey);
    return <TerminalRequestRecovery intent={intent} state={status?.state} running={status?.running ?? false} checking={status?.checking ?? false}
      detached={detached} enabled={enabled && !terminalRequests.error} onCheck={button => {
        const guard = terminalRequests.recoveryAttachmentGuard(requestKey, detached);
        const context = browserMenu.committedContext;
        const origin = intent.source.kind === "browser" && context ? captureBrowserReplacement(context.presentations, intent.source.tabId, context.owner) : undefined;
        const root = workbenchElement.current, document = button.ownerDocument;
        const focused = Boolean(root?.contains(button) && document.activeElement === button);
        const focus = () => Boolean(focused && root?.isConnected && (document.activeElement === button || !button.isConnected && document.activeElement === document.body));
        void (detached ? terminalRequests.inspectToDock(requestKey) : terminalRequests.inspect(requestKey)).then(result => {
          if (origin && result.status === "error" && result.outcome === "not-submitted"
            && !terminalRequests.intents.some(value => value.hostId === intent.hostId && value.request.requestId === intent.request.requestId)) browserMenu.releaseNotSubmitted(origin);
          if (result.status !== "ready" || !guard()) return;
          if (!detached && intent.source.kind === "browser") { if (origin) browserMenu.adopt(origin, result.tab, focus, guard); }
          else dock.publishTerminal(result.tab, intent.source.kind === "dock" ? intent.source.destination : defaultTerminalLocation, guard);
        });
      }}/>;
  }
  const browserMenuMounted = useRef(false), browserMenuFocus = useRef<number | undefined>(undefined);
  const browserMenuContext = {presentations:dock.presentations,owner:mainChat,enabled:!contentOverlayOpen,
    connected,actions:dockActions,chatTitle:selected?.title || "Chat",replace:dock.replaceBrowserDestination};
  // Commit observers run even while the source panel is hidden. Render values
  // alone cannot cancel a preparation during an away-and-back transition.
  useLayoutEffect(() => {
    browserMenu.commit(browserMenuContext);
    const admissions = dock.presentations.browserAdmissions;
    const completed = browserMenu.committed(admissions);
    if (admissions?.size) dock.acknowledgeBrowserReplacements([...admissions.keys()]);
    for (const admission of completed) {
      if (browserMenuFocus.current !== undefined) cancelAnimationFrame(browserMenuFocus.current);
      const root = workbenchElement.current;
      const focus = root && prepareBrowserReplacementFocus(root, admission, () => {
        const current = browserMenu.committedContext;
        return {presentations:current?.presentations ?? dock.presentations,owner:current?.enabled ? current.owner : undefined};
      });
      if (focus) browserMenuFocus.current = requestAnimationFrame(() => {
        browserMenuFocus.current = undefined;
        if (focus()) {
          if (admission.focus?.kind === "chat") mainTaskArea.current = "chat";
          else if (admission.focus?.destination === "right") mainTaskArea.current = "content";
        }
      });
    }
  });
  useEffect(() => {
    browserMenuMounted.current = true;
    return () => {
      browserMenuMounted.current = false;
      if (browserMenuFocus.current !== undefined) cancelAnimationFrame(browserMenuFocus.current);
      queueMicrotask(() => { if (!browserMenuMounted.current) { browserMenu.dispose(); browserCloseFocus.cancel(); browserCloses.dispose(); terminalRequests.dispose(); draftBrowserOwners.dispose(); draftBrowserPages.dispose(); for (const controller of draftBrowserDocks.values()) controller.dispose(); draftBrowserDocks.clear(); } });
    };
  }, [browserMenu, browserCloseFocus, browserCloses, terminalRequests, draftBrowserOwners, draftBrowserPages, draftBrowserDocks]);

  function openSkillFile(ref: NativeSkillFileRef, owner: string) {
    settingsOriginLabel.current = null;
    skillFileFocusPending.current = settingsOpen;
    setSettingsOpen(false); setPluginDirectoryOpen(false);
    dock.openSkillFile(ref,owner);
    if(!settingsOpen)requestAnimationFrame(()=>document.querySelector<HTMLElement>('.dock-panel-right .native-skill-file-panel')?.focus());
  }
  function addSelection(sourceHostId: string, sourcePath: string, selection: FileTextSelection) {
    if (selectedRef.current !== routeKey || selected?.archived || missingSession || state?.selectedText?.commandVersion !== 6) return;
    try {
      const current = drafts.get(draftId).draft;
      drafts.update(draftId, { selectedTextAttachments: appendSelectedText(current, { hostId: sourceHostId, path: sourcePath }, selection) });
      requestAnimationFrame(() => { if (selectedRef.current === routeKey) textarea.current?.focus(); });
    } catch (error) { setActionError(errorMessage(error)); }
  }
  function addWholeFile(sourceHostId: string, sourcePath: string) {
    if (selectedRef.current !== routeKey || selected?.archived || missingSession || state?.wholeFiles?.inlineMentions?.commandVersion !== 8) return;
    try {
      const files=appendWholeFile(drafts.get(draftId).draft, hostId, {hostId:sourceHostId,path:sourcePath},{textOffset:textarea.current?.selectionStart??drafts.get(draftId).draft.text.length,allowRepeated:state?.wholeFiles?.inlineMentions?.repeatedSources?.commandVersion===9});
      const file=files.findLast(file=>file.source.hostId===sourceHostId&&file.source.path===sourcePath)!;
      textarea.current?.insertFile(file);
      requestAnimationFrame(() => { if (selectedRef.current === routeKey) textarea.current?.focus(); });
    } catch (error) { setActionError(errorMessage(error)); }
  }
  const canAddWholeFile = !selected?.archived && !missingSession && state?.wholeFiles?.inlineMentions?.commandVersion === 8;
  const canAddSelection = !selected?.archived && !missingSession && state?.selectedText?.commandVersion === 6;
  function renderDockTab(tab:DockTab, active = true) {
    const searchKey = draftBrowserSearchEntries(dock.presentations, draftSearchPages).find(entry => entry.id === tab.id)?.sourceKey
      ?? browserSearchPresentationKey(dock.presentations, tab.id);
    const readSearchMetadata = () => {
      const publish = browserSearchRegistry.observe(tab.id, searchKey);
      return publish ? (value: Parameters<typeof publish>[0]) => { publish(value); redrawBrowserMenu(value => value + 1); } : undefined;
    };
    if (tab.kind === "mcp-app") {
      if (!tab.mcpApp || !tab.mcpApp.directory && !tab.target.startsWith("session:")) return <p>The saved app owner is unavailable.</p>;
      const directory = tab.mcpApp.directory, owner = directory && directoryOwner(tab.hostId, directory.projectId);
      if (directory && !owner) return <p>Directory apps are unavailable in this desktop version.</p>;
      let controller = mcpPanels.get(tab.id);
      if (!controller) {
        controller = new McpAppController(bridge, tab.hostId, directory ? undefined : tab.target.slice(8), tab.mcpApp, owner && directory ? {
          read: signal => owner.catalogue(directory.cwd, signal),
          request: request => owner.request(request),
          subscribeClose: listener => owner.subscribeClose(listener),
        } : undefined);
        mcpPanels.set(tab.id, controller);
      }
      const panel = <McpAppPanel controller={controller} connected={Boolean(desktop.catalog.records.get(tab.hostId)?.connected)} initialSelection={tab.mcpAppSelection} focusOnMount={element => {
        if (!mcpOpeningFocus.current.has(tab.id)) return;
        const origin = mcpOpeningFocus.current.get(tab.id); mcpOpeningFocus.current.delete(tab.id);
        const document = element.ownerDocument;
        if (active && !element.closest("[inert]")) {
          if (document.activeElement === origin || document.activeElement === document.body && !origin?.isConnected) element.focus({ preventScroll: true });
        }
      }}/>;
      return owner && directory ? <div className="mcp-directory-panel"><McpDirectoryStatus owner={owner} cwd={directory.cwd} hostLabel={desktop.catalog.records.get(tab.hostId)?.state?.host.name ?? tab.hostId}/>{panel}</div> : panel;
    }
    if (tab.kind === "skill-file") {
      if (!tab.skillFile) return <p>The saved skill file identity is unavailable.</p>;
      let controller = skillFiles.get(tab.id);
      if (!controller) { controller = new NativeSkillFileController(bridge,tab.hostId,tab.skillFile,offlineCache,tab.fileMode); skillFiles.set(tab.id,controller); }
      return <NativeSkillFilePanel onAddToChat={canAddSelection ? (path, selection) => addSelection(tab.hostId, path, selection) : undefined} controller={controller} fileMode={tab.fileMode??"markdown"} onFileModeChange={mode=>dock.setFileMode(tab.id,mode)} fileScroll={tab.fileScroll} onFileScrollChange={(mode,top)=>dock.setFileScroll(tab.id,mode,top)} connected={Boolean(desktop.catalog.records.get(tab.hostId)?.connected)} active={active} openExternal={url=>bridge.openExternal(url)}/>;
    }
    const localDraftId = draftBrowserIdFromDock(tab.target);
    if (localDraftId !== undefined) {
      const instance = dock.presentations.instances.get(tab.id);
      if (tab.kind !== "browser" || !instance) return <p>The original draft browser presentation is unavailable.</p>;
      const key = JSON.stringify([tab.id, instance]);
      let controller = draftBrowserDocks.get(key);
      if (!controller) {
        controller = new DraftBrowserDockController(tab, instance, controllers(tab.hostId).drafts, draftBrowserOwners, draftBrowserPages,
          () => redrawBrowserMenu(value => value + 1), (state, guard) => dock.updateDraftBrowserAddress(tab.id, instance, state, guard));
        draftBrowserDocks.set(key, controller);
      }
      const previewGuard = controller.previewGuard;
      return <DraftBrowserDockPanel bridge={bridge} controller={controller} active={active}
        onReadMetadata={readSearchMetadata} onMetadata={title => dock.updateDraftBrowserTitle(tab.id, instance, title, previewGuard)} onShortcutKeyDown={event => installedShortcuts.current?.handleKey(event)}/>;
    }
    if (tab.target === "host") return <p>This panel requires a project or session.</p>;
    const target = targetFromDock(tab.target), owner = `${tab.hostId}:${tab.target}`;
    const record = desktop.catalog.records.get(tab.hostId);
    const online = Boolean(record?.connected);
    if (tab.kind === "side-chat") {
      if (!("sessionId" in target)) return <p>Side chat belongs to a conversation.</p>;
      return <SideChat key={owner} controller={sideChatController(tab.hostId,target.sessionId)} hostId={tab.hostId} sessionId={target.sessionId} session={record?.state?.sessions.find(value => value.id === target.sessionId)} drafts={controllers(tab.hostId).drafts} connected={online} active={active} onTitle={title => dock.updateTitle(tab.id,title)} onUnread={unread => dock.setUnread(tab.id,unread)} onPromoted={session => { if (active && session.hostId === tab.hostId && selectedRef.current === `${tab.hostId}:${target.sessionId}`) { navigate(session.id, tab.hostId); void refresh(); } }}/>;
    }
    if (tab.kind === "goal") {
      if (!("sessionId" in target)) return <p>A goal belongs to a conversation.</p>;
      const goalSession = record?.state?.sessions.find(session => session.id === target.sessionId);
      return <GoalPanel draftWindowId={windowRestoration.ownerSlot} key={owner} bridge={bridge} hostId={tab.hostId} sessionId={target.sessionId} connected={online} running={goalSession?.status === "running"} archived={Boolean(goalSession?.archived)} active={active} activity={tab.hostId === hostId && target.sessionId === selected?.id ? activity : undefined} localHostId={desktop.localHostId}/>;
    }
    if(tab.kind === "terminal") return tab.terminalId ? <DockTerminal bridge={bridge} hostId={tab.hostId} target={target} terminalId={tab.terminalId} connected={online} onNewTerminal={() => {
      const pane = dock.snapshot.state.right.tabIds.includes(tab.id) ? "right"
        : dock.snapshot.state.bottom.tabIds.includes(tab.id) ? "bottom" : undefined;
      if (!pane) return;
      if (!dockWorkspace || tab.hostId !== hostId || tab.target !== workspaceKey(dockWorkspace)) {
        setActionError("Select this terminal’s workspace before opening another terminal.");
        return;
      }
      void dock.terminal(pane, true);
    }}/> : <p>Saved terminal identity is unavailable.</p>;
    if (tab.kind === "browser") {
      if (!("sessionId" in target)) return <p>Browser previews require a native session.</p>;
      if (tab.browserNewTab) {
        const controller = dock.browserLauncher(tab, online), instance = dock.presentations.instances.get(tab.id);
        const suggestions = browserWorkspaceRows(browserMenuContext, tab.id, controller.state.draft ?? "", navigator.language).map(row => ({...row,
          ariaLabel:row.kind === "action" ? undefined : `Switch to tab ${row.title}`,
          icon:row.kind === "chat" ? <Icon name="sideChat"/> : row.kind === "tab" ? <DockTabIcon tab={row.tab.descriptor}/> : <Icon name={row.action.descriptor.icon}/>,
        }));
        const pendingTerminals = terminalRequests.intents.filter(intent => intent.hostId === tab.hostId && intent.source.kind === "browser" && intent.source.tabId === tab.id && terminalRequests.hasRecoveryBrowser(`${intent.hostId}:${intent.request.requestId}`, dock.presentations));
        return <BrowserNewTabPanel controller={controller} active={active} suggestions={suggestions} onChoose={row => { browserMenu.choose(row, rememberBrowserAddressFocus(workbenchElement.current, row.origin)); }}
          workspaceState={instance ? browserMenu.state(instance) : undefined} onCancelWorkspace={instance ? () => browserMenu.cancel(instance) : undefined}
          terminalRecovery={pendingTerminals.length ? pendingTerminals.map(intent => <div key={intent.request.requestId}>{terminalRecovery(intent, active && online)}</div>) : undefined}/>;
      }
      return tab.browserTarget ? <BrowserPanel bridge={bridge} hostId={tab.hostId} sessionId={target.sessionId} nativeTarget={tab.browserTarget} onReadMetadata={readSearchMetadata} onMetadata={value => dock.updateBrowserTitle(tab.id, value.title || value.url || tab.title)} onShortcutKeyDown={event => installedShortcuts.current?.handleKey(event)} active={active}/> : <p>Saved browser tab identity is unavailable. Open existing native browser tabs to select a live target.</p>;
    }
    let data = workspaces.get(owner);
    if(!data) {data = new WorkspaceState(bridge,tab.hostId,target,offlineCache,desktop.localHostId);workspaces.set(owner,data);}
    const ownerSession = "sessionId" in target ? record?.state?.sessions.find(value => value.id === target.sessionId) : undefined;
    const ownerProject = record?.state?.projects.find(value => value.id === ("projectId" in target ? target.projectId : ownerSession?.projectId));
    const fileRoot = "filePath" in target ? target.filePath.slice(0,target.filePath.lastIndexOf("/")) || "/" : ownerSession?.cwd ?? ownerProject?.path;
    const filePresentation = captureDockPresentation(dock.presentations, tab.id);
    if (tab.kind === "files") return <WorkspaceFileBrowser key={tab.id} data={data} connected={online} active={active} cwd={fileRoot ?? ""} view={fileTree} onChange={setFileTree}
      onAddFile={canAddWholeFile && tab.hostId === hostId && fileRoot ? path => addWholeFile(tab.hostId, `${fileRoot.replace(/\/$/, "")}/${path}`) : undefined}
      onOpenFile={path => {
        if (!filePresentation || !isCurrentDockPresentation(committedArtifactOwner.current.presentations, filePresentation)) return;
        if ("sessionId" in target && openMcpFileViewer(tab.hostId, target.sessionId, path, filePresentation)) return;
      if ("projectId" in target && openMcpDirectoryFileViewer(tab.hostId, target.projectId, path, filePresentation)) return;
        setWorkspaceFileRequest({ owner, request: { id: crypto.randomUUID(), path } });
        dock.selectFile(tab.id, path);
      }}/>
    return <WorkspacePanel onCommit={record?.state?.gitSubmissions?.commandVersion === 10 ? () => openGitSubmission(data!) : undefined} onAddFile={canAddWholeFile && tab.hostId === hostId && fileRoot ? relativePath => addWholeFile(tab.hostId, `${(fileRoot ?? "").replace(/\/$/, "")}/${relativePath}`) : undefined} onFileEdit={() => dock.pinFile(tab.id)} onAddToChat={canAddSelection && fileRoot ? (relativePath, selection) => addSelection(tab.hostId, `${(fileRoot ?? "").replace(/\/$/, "")}/${relativePath}`, selection) : undefined} embedded active={active} fileTree={fileTree} onFileTreeChange={setFileTree} data={data} connected={online} filePath={tab.kind === "file" ? tab.filePath : undefined} fileMode={tab.fileMode} onFileModeChange={mode => dock.setFileMode(tab.id, mode)} openExternal={url => bridge.openExternal(url)} onOpenFile={(path, location, options) => {
      if (!filePresentation || !isCurrentDockPresentation(committedArtifactOwner.current.presentations, filePresentation)) return;
      if ("sessionId" in target && openMcpFileViewer(tab.hostId, target.sessionId, path, filePresentation)) return;
      if ("projectId" in target && openMcpDirectoryFileViewer(tab.hostId, target.projectId, path, filePresentation)) return;
      const destination = tab.kind !== "file" ? "right" : dock.destinationForTab(tab.id);
      if (!destination) return;
      if ("filePath" in target) {
        const absolutePath = path.startsWith("/") ? path : `${(fileRoot ?? "/").replace(/\/$/, "")}/${path}`;
        const targetOwner = `${tab.hostId}:${workspaceKey({ filePath: absolutePath })}`;
        setWorkspaceFileRequest({ owner: targetOwner, request: { ...location, id: crypto.randomUUID(), path: path.split("/").at(-1)! } });
        dock.openHostFile(absolutePath, tab.hostId, destination, options?.preview ?? true);
      } else {
        setWorkspaceFileRequest({ owner, request: { ...location, id: crypto.randomUUID(), path } });
        dock.openFile(path, tab.hostId, target, destination, options?.preview ?? true);
      }
    }} tab={tab.kind === "review" ? "changes" : tab.kind === "file" ? "files" : tab.kind} onTabChange={next => dock.open(next === "changes" ? "review" : next,"right",tab.hostId,target)} fileRequest={(tab.kind === "file" && tab.filePath === workspaceFileRequest?.request.path) && workspaceFileRequest?.owner === owner ? workspaceFileRequest.request : undefined} commitRequest={commitRequest?.owner === owner && tab.kind === "review" ? commitRequest.id : undefined} turn={bridge.getTurnReview ? { bridge, hostId: tab.hostId, localHostId: desktop.localHostId, conversationId: "sessionId" in target ? target.sessionId : tab.hostId === hostId && selected && "projectId" in target && selected.projectId === target.projectId ? selected.id : undefined, request: turnReviewRequest?.owner === owner && tab.kind === "review" ? turnReviewRequest.request : undefined } : undefined} name={ownerProject?.name ?? ownerSession?.title ?? tab.title} path={fileRoot ?? ""} onClose={() => {}} onOpenProject={async path => { const result = await bridge.command({id:crypto.randomUUID(),command:{type:"project.add",path}},tab.hostId); if(!result.ok || !result.value || !("path" in result.value)) throw new Error("The host did not return the project.");await refresh();newConversation(result.value.id,tab.hostId); }}/>
  }
  const shell = useRef<HTMLDivElement>(null);
  const closeStatus = useWindowClose(bridge, shell, async signal => {
    // The shell is inert during close preparation. Drain every app independently
    // before the window permits native close; descriptors remain restorable.
    const appDrains = await Promise.allSettled([...mcpPanels.values()].map(controller => controller.close()));
    signal.throwIfAborted();
    const appFailures = appDrains.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (appFailures.length) throw new AggregateError(appFailures, "MCP app cleanup could not be confirmed. Keep this window open and retry.");
    if (commandKeymap && !commandKeymap.prepareWindowClose(signal)) {
      if (signal.aborted) return false;
      throw new Error("Wait for the shortcut change to finish saving before closing this window. Pending command receipts are retained.");
    }
    for (const data of workspaces.values()) {
      signal.throwIfAborted();
      if (!await data.prepareWindowClose(signal)) return false;
    }
    for (const controller of skillFiles.values()) {
      signal.throwIfAborted();
      if (!await controller.prepareWindowClose(signal)) return false;
    }
    return true;
  });
  const activeHostName = state?.host.name ?? desktop.hosts.find(host => host.hostId === route.hostId)?.name ?? (route.hostId ? "Saved machine" : loading ? "Connecting…" : "Host unavailable");
  const connectionLabel = connected ? hostId === desktop.localHostId ? "Connected · This machine" : "Connected · Tailscale" : loading ? "Connecting…" : state ? "Offline · cached view" : "Host unavailable";
  const profileMenu = (triggerId?: string) => <ProfileMenu hosts={desktop.hosts} activeHostId={state?.host.id ?? route.hostId} hostName={activeHostName} connected={connected} connectionLabel={connectionLabel} onSelectHost={owner => navigate(null, owner, true)} onSettings={openSettings} onConnections={() => { setSettingsPage("connections"); openSettings(); }} onBuildStatus={() => setDialog("status")} onRefresh={() => desktop.refreshNetwork()} triggerId={triggerId}/>;
  // The right dock occupies the top-right corner of the titlebar band only when it renders as its own column.
  useEffect(() => { setExportOwner(undefined); }, [hostId, selected?.id]);
  const conversationActions = selected && <div className="no-drag"><div className="menu-anchor"><button className="icon-button" onClick={() => setMenuOpen(value => !value)} aria-label="Conversation actions" aria-expanded={menuOpen} title="Conversation actions"><Icon name="more"/></button>{menuOpen && <><button className="menu-dismiss" onClick={() => setMenuOpen(false)} tabIndex={-1} aria-label="Close conversation actions"/><div className="action-menu"><button disabled={!connected} onClick={() => { setRenameTitle(selected.title); setDialog("rename"); setMenuOpen(false); }}>Rename</button><button disabled={!connected} onClick={archive}>{selected.archived ? "Unarchive" : "Archive"}</button>{forkSupported && <button disabled={!canFork} title={forkController?.error ?? forkController?.value?.local.reason} onClick={() => openForkMenu(document.querySelector<HTMLElement>('[aria-label="Conversation actions"]'))}>Fork chat</button>}<button disabled={!connected || !state?.sessionExports || !bridge.getSessionExport || !bridge.saveSessionExport} onClick={() => { setExportOwner({ hostId, sessionId: selected.id }); setMenuOpen(false); }}>Export conversation…</button><button disabled={!canCopyMarkdown} title={markdownIssue ?? undefined} onClick={() => { void copyConversationMarkdown(); }}>Copy as Markdown</button>{state?.sessionUsage?.version === 1 && <button onClick={() => { setUsageOwner({ hostId, sessionId: selected.id, hostName: state.host.name }); setMenuOpen(false); }}>Provider usage…</button>}<button onClick={() => { dock.open("side-chat"); setMenuOpen(false); }}>Side chat</button><button disabled={!connected || !state?.tree || !bridge.getSessionTree} onClick={openTreeHistory}>Conversation history…</button><button onClick={() => { transcript.refresh(); setMenuOpen(false); }}>Refresh transcript</button></div></>}</div></div>;
  const environmentAction = workspace && <button role="checkbox" aria-checked={environmentOpen} className={`icon-button ${environmentOpen ? "active" : ""}`} aria-label="Environment" title={environmentOpen ? "Hide environment" : "Show environment"} onClick={() => setEnvironmentOpen(value => !value)}><Icon name="sliders"/></button>;
  const fullWidthContent = !contentOverlayOpen && workspaceOpen && dock.snapshot.state.rightLayout === "full";
  const contentSide = resolveContentSide(dock.snapshot.state,taskDirection);
  const rightDockColumn = !contentOverlayOpen && workspaceOpen && dockViewport.width >= 672;
  return <><div ref={shell} className={`app-shell ${settingsOpen ? "settings-open" : sidebarOpen ? "" : "sidebar-hidden"}`}>
    {settingsOpen ? <SettingsSidebar page={settingsPage} onSelect={setSettingsPage} onBack={() => setSettingsOpen(false)} environmentAvailable={Boolean(state?.localEnvironments?.configuration)} hostControl={profileMenu("settings-host")}/> : <aside className="sidebar" aria-label="Projects and conversations" inert={!sidebarOpen}>
      <div className="sidebar-titlebar drag-region"><button className="icon-button no-drag" onClick={() => setSidebarOpen(false)} aria-label="Hide sidebar" title="Hide sidebar (⌘\\)"><Icon name="sidebar"/></button></div>
      <div className="sidebar-brand"><strong>Agent Desktop</strong><div className="sidebar-brand-actions"><CommandMenuSearchButton title={`Search${appCommandShortcutLabel(appCommandBindings.bindings, "search") ? ` (${appCommandShortcutLabel(appCommandBindings.bindings, "search")})` : ""}`} expanded={commandMenuMode === "chats"} captureFileEditor={() => workbenchElement.current ? captureFileEditorCommands(workbenchElement.current, document.activeElement) : undefined} onOpen={captured => openCommandMenu("chats", captured)}><SidebarNavigationIcon name="search"/></CommandMenuSearchButton><button className={`icon-button small ${sidebarActivityOpen ? "active" : ""}`} aria-label={sidebarActivityOpen ? "Close activity view" : "View activity"} title={sidebarActivityItems.length ? "Chats are unread, active, or awaiting a response" : "View activity"} aria-pressed={sidebarActivityOpen} onClick={() => { setSidebarActivityOpen(value => !value); setShowArchived(false); }}><SidebarActivityIcon/></button></div></div>
      <SidebarNavigation data={sidebarNavigation} onNew={() => newConversation()} newShortcut={appCommandShortcutLabel(appCommandBindings.bindings, "new-chat")} destinations={[
        ...(state?.pullRequests?.version === 1 && bridge.pullRequests ? [{ id: "pull-requests" as const, label: "Pull requests", icon: <PullRequestIcon/>, current: pullRequestsOpen, onSelect: () => { setAutomationsOpen(false); setPluginDirectoryOpen(false); setSettingsOpen(false); setPullRequestsOpen(true); } }] : []),
        ...(state?.automations?.capability === AUTOMATIONS_CAPABILITY && bridge.automations ? [{ id: "scheduled" as const, label: "Scheduled", icon: <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.33"><circle cx="10" cy="10" r="7"/><path d="M10 5.5V10l-2.5 2" strokeLinecap="round" strokeLinejoin="round"/></svg>, current: automationsOpen, onSelect: openAutomations }] : []),
        { id: "plugins", label: "Plugins", icon: <SidebarNavigationIcon name="plugins"/>, current: pluginDirectoryOpen, onSelect: () => { settingsOriginLabel.current = null; setAutomationsOpen(false); setPullRequestsOpen(false); setPluginDirectoryOpen(true); setSettingsOpen(false); } },
        { id: "archive", label: "Archive", icon: <Icon name="archive"/>, current: showArchived && !contentOverlayOpen, onSelect: () => { setSidebarActivityOpen(false); setAutomationsOpen(false); setPullRequestsOpen(false); setPluginDirectoryOpen(false); setSettingsOpen(false); setShowArchived(true); } },
      ]}/>
      <div className="sidebar-scroll">{sidebarActivityOpen ? <SidebarActivity items={sidebarActivityItems} selectedId={selectedId} selectedHostId={hostId} onNavigate={navigate}/> : <OrganizedSidebar layout={organizedSidebar} preferences={preferences} groups={hostGroups} activeHostId={hostId} selectedId={selectedId} activeProjectId={!contentOverlayOpen && selectedId === null ? project?.id : undefined} query="" showArchived={showArchived} collapsedSections={collapsedSidebarSections} onToggleSection={key => setCollapsedSidebarSections(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; })} expandedProjects={expandedProjects} onToggleProject={key => setExpandedProjects(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; })} onNavigate={navigate} onNew={newConversation} onAddProject={addProject} addingProject={addingProject} connected={connected} onToggleArchived={() => setShowArchived(value => !value)} onArchive={archiveSidebarSession} onMarkRead={(target, unread) => { const session = hostGroups.find(group => group.hostState.host.id === target.hostId)?.hostState.sessions.find(session => session.id === target.id && session.hostId === target.hostId); return session ? sessionRead.mark(session, unread) : Promise.resolve(false); }} localHostId={desktop.localHostId ?? null} onRenameProject={renameSidebarProject} onRemoveProject={removeSidebarProject} onRevealProject={revealSidebarProject}/>}</div>
      <footer className="sidebar-footer">{profileMenu()}</footer>
    </aside>}
    <div ref={workbenchElement} data-browser-current-owner={browserAddressOwner} data-content-side={contentSide} data-content-column={rightDockColumn} onFocusCapture={event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-main-task-chat], [data-main-task-chat-tab]')) mainTaskArea.current = "chat";
      else if (target.closest('[data-dock-destination="right"]')) mainTaskArea.current = "content";
    }} className={`workbench ${showUnifiedStrip ? "has-main-task-strip" : ""} ${fullWidthContent ? "dock-full-width" : workspaceOpen && dockViewport.width < 672 ? "dock-narrow" : ""}`} style={{
      "--right-dock-size": rightDockColumn ? `${Math.max(320,Math.min(dockViewport.width - 352,dock.snapshot.state.rightWidthRatio*dockViewport.width))}px` : "0px",
      "--bottom-dock-size": !settingsOpen && terminalOpen ? `${Math.min(dockViewport.height/2,Math.max(160,dock.snapshot.state.bottomHeight))}px` : "0px",
      "--task-strip-actions-reserve": taskLayoutAction ? "107px" : "73px",
      "--header-cluster-reserve": rightDockColumn && contentSide === "right" ? "4px" : taskLayoutAction ? "107px" : "73px",
    } as React.CSSProperties}>
    <div ref={setMainStripContainer} className="main-task-strip-host" hidden={!showUnifiedStrip}/>
    <main id={mainChatPanelId} role={showUnifiedStrip ? "tabpanel" : undefined} aria-labelledby={showUnifiedStrip ? mainChatTabId : undefined} className="main-panel" data-main-task-chat tabIndex={-1} inert={fullWidthContent || undefined}>
      {appliedTheme.background.kind === "asset" && themeImage.sha256 === imageHash && themeImage.dataUrl && <div className="theme-image-background" aria-hidden="true" style={{ backgroundImage: `url("${themeImage.dataUrl}")`, backgroundSize: appliedTheme.background.fit === "tile" ? "auto" : appliedTheme.background.fit, backgroundRepeat: appliedTheme.background.fit === "tile" ? "repeat" : "no-repeat", opacity: appliedTheme.background.opacity, filter: `blur(${appliedTheme.background.blur}px)` }}/> }
      {windowWarning && <div className="connection-banner" role="status"><span>{windowWarning}</span></div>}
      {!contentOverlayOpen && terminalRequests.intents.filter(intent => (intent.source.kind === "dock" || !terminalRequests.hasRecoveryBrowser(`${intent.hostId}:${intent.request.requestId}`, dock.presentations)) && intent.hostId === hostId
        && workspaceTarget && !("filePath" in workspaceTarget) && workspaceKey(intent.request.target) === workspaceKey(workspaceTarget))
        .map(intent => <div className="connection-banner" key={intent.request.requestId}>{terminalRecovery(intent, connected, intent.source.kind === "browser")}</div>)}
      {!contentOverlayOpen && (browserCloses.message || browserCloses.intents.some(intent => intent.hostId === hostId)) && <div data-browser-close-history role="group" aria-label="Browser Close history" tabIndex={-1}>
      {browserCloses.message && <div className="connection-banner" role="status"><span>{browserCloses.message}</span></div>}
      {browserCloses.intents.filter(intent => intent.hostId === hostId).map(intent =>
        <div className="connection-banner" key={`close:${intent.owner.kind}:${intent.request.requestId}`}>
          <span>{intent.receipt?.outcome === "completed" ? "Browser Close confirmed" : intent.receipt?.outcome === "rejected" ? "Browser Close rejected" : "Browser Close needs confirmation"}: {intent.request.target.name}</span>
          <button disabled={!connected || !bridge.browserClose || browserCloses.pending} onClick={() => void browserCloses.inspect(intent)}>Check close status</button>
          {intent.receipt && intent.receipt.outcome !== "unknown" && <button disabled={!browserCloses.canDismiss(intent)} onClick={event => {
            // Focus the surviving group before this action removes its own row.
            if (event.currentTarget.ownerDocument.activeElement === event.currentTarget)
              event.currentTarget.closest<HTMLElement>("[data-browser-close-history]")?.focus();
            void browserCloses.dismiss(intent);
          }}>Dismiss close record</button>}
        </div>)}</div>}
      {sessionRead.error && <div className="connection-banner" role="alert"><span>{sessionRead.error}</span>{preferences.pending.length ? <button disabled={!preferences.connected || preferences.busy} onClick={() => void sessionRead.retry()}>Retry read marks</button> : <button onClick={() => sessionRead.dismissError()}>Dismiss</button>}</div>}
      {appCommandBindings.error && <div className="connection-banner" role="alert"><span>Keyboard shortcuts could not be loaded: {appCommandBindings.error}</span></div>}
      {settingsOpen ? <>{settingsPage === "keyboard-shortcuts" ? <KeyboardShortcutsSettings data={commandKeymap} supportedCommandIds={supportedShortcutCommands} primaryNumberShortcutTarget={commandKeymap?.primaryNumberShortcutTarget} onChangePrimaryNumberShortcutTarget={commandKeymap ? target => commandKeymap.submit({ type: "number-target", target }) : undefined}/> : settingsPage === "connections" ? <ConnectionsSettings preferences={preferences} bridge={bridge} hosts={desktop.hosts} network={desktop.network} networkError={desktop.networkError} localHost={desktop.localHostId ? desktop.catalog.records.get(desktop.localHostId)?.state?.host : undefined} activeHostId={state?.host.id ?? route.hostId} onSelectHost={owner => navigate(null,owner,true)} onRefresh={() => desktop.refreshNetwork()}/> : settingsPage === "general" ? <GeneralSettings preferences={preferences} bridge={bridge}/> : settingsPage === "environments" ? state?.localEnvironments?.configuration ? <LocalEnvironmentSettings key={hostId} bridge={bridge} hostId={hostId} hostName={state.host.name} localHostId={desktop.localHostId} connected={connected} projects={state.projects} initialProjectId={environmentProject?.hostId === hostId ? environmentProject.projectId : project?.id} onSelectProject={projectId => setEnvironmentProject({hostId,projectId})} onAddProject={() => void addProject(true)} onClose={() => setSettingsOpen(false)}/> : <section className="settings-page"><header className="settings-header"><h1>Environments</h1></header><p className="settings-unavailable" role="status">{loading ? "Connecting to the owning host…" : "This host does not support environment configuration. Update its host service to edit environments here."}</p></section> : settingsPage === "plugins" || settingsPage === "mcp" ? <NativeIntegrations onOpenSkillFile={openSkillFile} onTrySkill={trySkill} key={`${hostId}:${JSON.stringify(workspaceTarget)}`} bridge={bridge} hostId={hostId} hostName={state?.host.name ?? "Unavailable host"} connected={connected} target={workspaceTarget} sessionIdle={Boolean(selected && selected.status === "idle" && !selected.archived)} page={settingsPage} onPageChange={page=>{setIntegrationSelection(undefined);setSettingsPage(page);}} onBrowse={tab=>{settingsOriginLabel.current=null;setPluginDirectoryTab(tab??"plugins");setIntegrationSelection(undefined);setAutomationsOpen(false); setPullRequestsOpen(false);setPluginDirectoryOpen(true);setSettingsOpen(false);}} initialPluginId={integrationSelection?.hostId===hostId?integrationSelection.pluginId:undefined} initialMarketplace={integrationSelection?.hostId===hostId?integrationSelection.marketplace:undefined} onClose={() => setSettingsOpen(false)}/> : settingsPage === "appearance" ? <ThemeSettings backdropSupported={bridge.windowBackdropSupported === true} data={theme} preferences={preferences} fonts={localFonts} fontFaces={localFontFaces} fontsError={fontsError} effectsError={themeEffectsError} image={themeImage} onImportImage={() => bridge.importThemeBackground()} onOpenFile={() => bridge.openThemeFile()} onRefreshFonts={refreshFonts} onClose={() => setSettingsOpen(false)}/> : settingsPage === "omp" ? <NativeSettings key={hostId} bridge={bridge} hostId={hostId} hostName={state?.host.name ?? "Unavailable host"} localHostId={desktop.localHostId} connected={connected} session={selected} target={workspaceTarget}/> : settingsPage === "git" ? <GitSettings preferences={preferences} onClose={() => setSettingsOpen(false)}/> : <AccountsSettings key={hostId} bridge={bridge} hostId={hostId} hostName={state?.host.name ?? "Unavailable host"} localHostId={desktop.localHostId} connected={connected} session={selected} onClose={() => setSettingsOpen(false)} onChanged={() => void refresh()}/>}</> : pullRequestsOpen ? <PullRequestsPage composers={pullRequestComposers} writesSupported={state?.pullRequestWrites?.version === 1} discussionWritesSupported={state?.pullRequestWrites?.reviewThreads === 1} cache={pullRequestCache.current} key={hostId} bridge={bridge} hostId={hostId} hostName={state?.host.name ?? "Unavailable host"} hosts={hostGroups.map(group => group.hostState.host)} connected={connected} supported={state?.pullRequests?.version === 1} initial={pullRequestViews.find(view => view.hostId === hostId)} onChanged={view => setPullRequestViews(old => [view, ...old.filter(item => item.hostId !== view.hostId)].slice(0, 20))} onSelectHost={owner => setRoute({ hostId: owner, sessionId: null })} onClose={() => { setPullRequestsOpen(false); requestAnimationFrame(() => document.querySelector<HTMLElement>('.nav-action[aria-label="Pull requests"]')?.focus()); }}/> : automationsOpen ? <AutomationsPage key={hostId} bridge={bridge} hostId={hostId} hostName={state?.host.name ?? "Unavailable host"} hosts={hostGroups.map(group => group.hostState.host)} connected={connected} supported={state?.automations?.capability === AUTOMATIONS_CAPABILITY} projects={state?.projects ?? []} sessions={state?.sessions ?? []} models={state?.models ?? []} requests={automationRequests} cache={automationCache.current} views={automationViews.current} onSelectHost={owner => setRoute({ hostId: owner, sessionId: null })} onOpenChat={(id, owner) => navigate(id, owner)} onClose={() => { setAutomationsOpen(false); setPullRequestsOpen(false); requestAnimationFrame(() => document.querySelector<HTMLElement>('.nav-action[aria-label="Scheduled"]')?.focus()); }}/> : pluginDirectoryOpen ? <NativePluginBrowser refreshKey={skillRefresh} onOpenSkillFile={openSkillFile} onTrySkill={trySkill} restoreFocusLabel={settingsOriginLabel.current??undefined} initialTab={pluginDirectoryTab} onTabChange={setPluginDirectoryTab} key={`${hostId}:${JSON.stringify(workspaceTarget)}`} bridge={bridge} hostId={hostId} hostName={state?.host.name??"Unavailable host"} target={workspaceTarget} connected={connected} onClose={()=>{setPluginDirectoryOpen(false);requestAnimationFrame(()=>document.querySelector<HTMLElement>('.nav-action[aria-label="Plugins"]')?.focus());}} onManage={pluginId=>{setIntegrationSelection({hostId,pluginId});setSettingsPage("plugins");openSettings();}} onMarketplace={name=>{setIntegrationSelection({hostId,marketplace:{name,add:name===undefined}});setSettingsPage("plugins");openSettings();}}/> : <>
      <header className="main-header drag-region" onContextMenu={headerContextMenu}>
        {!sidebarOpen && <button className="icon-button no-drag" onClick={() => setSidebarOpen(true)} aria-label="Show sidebar"><Icon name="sidebar"/></button>}
        <div className="header-breadcrumb no-drag" title={project?.path} {...chatPaneDrag.handlers(mainChat)} onContextMenu={event=>void taskPlacementMenu(event,mainChat)}>{selected && <Icon name="folder"/>}{selectedId && <strong className="truncate">{selected?.title ?? (loading ? "Loading conversation…" : "Conversation unavailable")}</strong>}{!showUnifiedStrip && conversationActions}{selected && (selected.archived || selected.status !== "idle") && <span className={`status-label ${selected.status}`}>{selected.archived ? "Archived" : selected.status}</span>}</div>
        <div className="header-conversation-actions no-drag">
          {!showUnifiedStrip && environmentAction}
        </div>
      </header>
      {usageOwner && <SessionUsagePanel key={`${usageOwner.hostId}:${usageOwner.sessionId}`} {...usageOwner} connected={connected && hostId === usageOwner.hostId} onClose={() => { usageOwner.controller?.close(); setUsageOwner(undefined); }} onSettings={() => { if (hostId === usageOwner.hostId) { usageOwner.controller?.close(); setUsageOwner(undefined); setSettingsPage("omp"); openSettings(); } }}/>}
      {imageHash && themeImage.sha256 === imageHash && (themeImage.status === "loading" || themeImage.error) && <div className="connection-banner theme-image-status" role="status"><span>{themeImage.error ?? "Loading this device’s background image…"}</span>{themeImage.error && <button onClick={() => void themeImage.refresh()}><Icon name="refresh"/>Retry image</button>}</div>}
      {(desktop.error || desktop.cacheWarning || drafts.cacheWarning || submissions.cacheWarning || submissions.forceTools.cacheWarning) && <div className="connection-banner" role="status"><span>{desktop.error ?? desktop.cacheWarning ?? drafts.cacheWarning ?? submissions.cacheWarning ?? submissions.forceTools.cacheWarning}</span><button onClick={() => void refresh()}><Icon name="refresh"/>Reconnect</button></div>}
      {loading && !state ? <div className="center-state"><span className="spinner"/><h1>Connecting to your host</h1><p>Loading projects, models, and saved conversations.</p></div> : missingSession ? <div className="center-state"><h1>Conversation unavailable</h1><p>{connected ? "This conversation is not in the owning host’s catalog." : "This conversation is not in this device’s cached catalog. Its owning host is unavailable; the selected conversation is preserved."}</p><button className="secondary-button" onClick={() => navigate(null)}>New conversation</button></div> : <>
        {selectedId ? <div className="transcript-region"><div ref={transcriptReading.viewportRef} className="transcript-scroll" tabIndex={0} aria-label="Conversation transcript">
          <div className="transcript">
            {transcript.error && <div className="inline-error" role="alert"><span>{transcript.error}</span><button onClick={transcript.refresh}>Retry</button></div>}
            {transcript.cacheWarning && <p className="subtle-notice">{transcript.cacheWarning}</p>}
            {selected?.error && <div className="inline-error" role="alert">{selected.error}</div>}
            {!transcript.messages.length && <div className="empty-transcript"><Icon name="compose"/><h2>{transcript.loading ? "Loading conversation…" : !selected ? "Conversation unavailable" : "Start the conversation"}</h2><p>{connected ? "Send a prompt to begin working in this session." : "No transcript is cached on this device."}</p></div>}
            <TranscriptMessages onEdit={state?.tree?.version === 1 && nativeTree.view.fresh && !nativeTree.view.value?.busyReason && !nativeTree.view.pending && !nativeTree.view.uncertain ? editHistoryMessage : undefined} editing={treeEditContent && treeEdit ? { nativeId: treeEdit.targetId, content: treeEditContent } : undefined} messages={transcript.messages} contextKey={`${hostId}:${selectedId}`} connected={connected} linkActions={transcriptLinkActions} images={{ media: attachmentMedia, hostId, sessionId: selectedId }} onOpenArtifact={mcpCatalogue.snapshot?.canOpenApps ? openMcpArtifact : undefined} turnReview={openTurnReview && dockSession ? { conversationId: dockSession.sessionId, onOpen: openTurnReview } : undefined}/>
            {running && <div className="working-state" role="status"><span className="working-dot"/>Working…</div>}
          </div>
        </div>{!transcriptReading.following && <button className="transcript-latest" onClick={transcriptReading.latest} aria-label="Return to latest message"><Icon name="arrow"/><span>Return to latest</span></button>}</div> : <Welcome project={project} workspace={workspace} onSelectProject={anchor => composerContext.current?.openProjects(anchor)}/>}
        <div className={`composer-region ${selectedId ? "" : "home-composer"}`}>
          {selected && !selected.archived && <PendingMcpAuthorization key={`mcp:${hostId}:${selected.id}`} bridge={bridge} hostId={hostId} sessionId={selected.id} connected={connected}/>}
          {selected && <PendingDetachedQuestions bridge={bridge} hostId={hostId} sessionId={selected.id} localHostId={desktop.localHostId} connected={connected} archived={selected.archived} drafts={drafts} submissions={submissions}/>}
          {(selectedId || pendingSessionId) && state && <>
            {!selectedId && <p className="subtle-notice">Requests for {knownPendingSession?.title ?? "the session being started"} on {state.host.name}.</p>}
            <PendingInteractions bridge={bridge} hostId={hostId} sessionId={(selectedId ?? pendingSessionId)!} localHostId={desktop.localHostId} connected={connected}/>
          </>}
          {markdownCopy?.owner === markdownCopyRoute.current && <div className={markdownCopy.state === "failed" ? "inline-error" : "subtle-notice"} role={markdownCopy.state === "failed" ? "alert" : "status"}><span>{markdownCopy.message}</span>{markdownCopy.state !== "copying" && <button className="icon-button small" onClick={() => setMarkdownCopy(null)} aria-label="Dismiss copy status"><Icon name="close"/></button>}</div>}
          {nativeTree.view.pending && <div className="subtle-notice" role="status">Preparing native conversation history… <button type="button" disabled={!connected} onClick={() => { if (selectedId) void command({ type: "session.interrupt", sessionId: selectedId }); }}>Stop</button></div>}
          {nativeTree.view.uncertain && <div className="inline-error" role="alert">The history change needs inspection. <button type="button" onClick={openTreeHistory}>Check original command</button></div>}
          {actionError && <div className="inline-error" role="alert"><span>{actionError.message}</span><button className="icon-button small" onClick={() => setActionError(null)} aria-label="Dismiss error"><Icon name="close"/></button></div>}
          {modeView?.conflict && !sameModeConflict(modeView) && draft.projectId && <div className="draft-conflict" role="alert"><strong>Work in changed on another device.</strong><p>Your prompt and other selections are preserved. Choose which execution mode to use for this project.</p><dl><dt>My choice</dt><dd>{executionModeLabel(modeView.draft.execution)}</dd><dt>Host’s saved choice</dt><dd>{executionModeLabel(modeView.conflict.execution)}</dd></dl><div><button className="secondary-button" onClick={() => resolveProjectExecutionMode(drafts,draftId,draft.projectId!,"remote")}>Use saved mode</button><button className="primary-button" onClick={() => resolveProjectExecutionMode(drafts,draftId,draft.projectId!,"local")}>Keep my mode</button></div></div>}
          {modeView?.status === "error" && draft.projectId && <div className="inline-error" role="alert"><span>{modeView.error ?? "The Work in choice was not saved to the host."}</span><button disabled={!connected} onClick={() => void drafts.flush(projectExecutionModeDraftId(draft.projectId!)).catch(() => {})}>Retry mode save</button></div>}
          {pendingSubmission && (pendingSubmission.preparation || pendingSubmission.create?.command.type === "session.create" && pendingSubmission.create.command.environment !== undefined) && <EnvironmentPreparationCard key={`${hostId}:${pendingSubmission.preparation?.id ?? pendingSubmission.create?.id}`} bridge={bridge} hostId={hostId} pending={pendingSubmission} submissions={submissions} connected={connected} busy={busy} executionControls={state?.localEnvironments?.execution} resumeIssue={remoteWorktreeResumeIssue(pendingSubmission, state)} onResume={() => void resumeEnvironment()} onSettings={() => { if (pendingSubmission.draft.projectId) setEnvironmentProject({hostId,projectId:pendingSubmission.draft.projectId}); setSettingsPage("environments"); openSettings(); }}/>}
          {pendingSubmission && <div className="subtle-notice">{pendingSubmission.preparation ? "The original prompt and selections remain captured below." : pendingSubmission.uncertain ? "A submission is awaiting confirmation. Retry checks its original command; newer draft edits stay here." : pendingSessionId ? busy ? "Waiting for this session to accept the captured prompt." : "A session was created. Sending again continues that session." : "Creating this prompt’s session."}{pendingSessionId && <button onClick={() => navigate(pendingSessionId)}>Open {knownPendingSession?.title ?? "session"}</button>}<details><summary>View pending prompt and selections</summary><DraftSnapshot draft={pendingSubmission.draft} hostName={state?.host.name ?? hostId} projects={state?.projects ?? []} media={attachmentMedia} hostId={hostId} connected={connected}/>{knownPendingSession && <p>Bound session: {knownPendingSession.title} · {knownPendingSession.cwd}</p>}{pendingSubmission.draft.approvalMode && pendingSessionId && <p>The permission choice applies to this session before the prompt runs and remains if the prompt is rejected.</p>}</details></div>}
          {view.conflict && <div className="draft-conflict" role="alert"><strong>This draft changed on another device.</strong><p>Your text, images, and selections are preserved. Choose which version to continue with.</p><details><summary>View my draft</summary><DraftSnapshot draft={draft} hostName={state?.host.name ?? hostId} projects={state?.projects ?? []} media={attachmentMedia} hostId={hostId} connected={connected}/></details><details><summary>View host’s saved draft</summary><DraftSnapshot draft={view.conflict} hostName={state?.host.name ?? hostId} projects={state?.projects ?? []} media={attachmentMedia} hostId={hostId} connected={connected}/></details><div><button className="secondary-button" onClick={() => drafts.resolve(draftId, "remote")}>Use saved draft</button><button className="primary-button" onClick={() => drafts.resolve(draftId, "local")}>Keep my draft</button></div></div>}
          {view.status === "error" && <div className="inline-error" role="alert"><span>{view.error ?? "Draft could not be saved."}</span><button onClick={() => void drafts.flush(draftId).catch(cause => setActionError(errorMessage(cause)))}>Retry save</button></div>}
          {composer.loading && <p className="subtle-notice" role="status">Loading this workspace’s native models and defaults…</p>}
          {(composer.error || composer.controlsError) && <div className="inline-error" role="alert"><span>{composer.error ?? composer.controlsError}</span><button disabled={!connected} onClick={() => void composer.refresh(true)}>Refresh models</button></div>}
          {composer.catalog?.resolution === "legacy-capabilities" && <p className="subtle-notice" role="status">This older host provides workspace model controls, but does not report model availability or the new-chat default. Existing session selections are preserved. Update the owning host to resolve these details.</p>}
          {!connected && <p className="subtle-notice">Model details are {composer.catalog ? "from this workspace’s last loaded catalog" : "unavailable until this host reconnects"}. Your saved selections are preserved.</p>}
          {selection.differingDraftModel && <p className="subtle-notice">This draft selects {draft.model!.provider}/{draft.model!.id}; the session’s last reported model is {selection.current!.provider}/{selection.current!.id}.<button disabled={Boolean(selected?.archived) || running} onClick={() => drafts.update(draftId, { model: null, thinkingLevel: undefined })}>Follow session model and reasoning</button></p>}
          {composer.catalog && !permissionChoice.supported && <p className="subtle-notice">This host does not support saved composer permission choices yet. Update the owning host to enable this control; its native permissions continue to apply.</p>}
          {draft.approvalMode && <p className="subtle-notice">Draft permissions: {approvalModes[draft.approvalMode]?.label ?? draft.approvalMode}. Applied on send and retained across session restarts.{permissionChoice.differs && permissionChoice.current && <> {selected ? "Current session" : "Workspace default"}: {approvalModes[permissionChoice.current].label}.</>} Native per-tool policies still apply.<button disabled={Boolean(selected?.archived) || running} onClick={() => drafts.update(draftId, { approvalMode: undefined })}>{selected ? "Follow current session permissions" : "Follow native default permissions"}</button></p>}
          {selected && <GoalStrip key={`goal:${hostId}:${selected.id}`} bridge={bridge} hostId={hostId} sessionId={selected.id} snapshot={activity.value} stale={!connected ? "Offline goal snapshot" : activity.error} running={running} archived={Boolean(selected.archived)} refresh={activity.refresh} onEdit={() => dock.open("goal")}/>}
          {forkController && <SessionFork data={forkController} request={forkMenu?.owner === forkOwner ? forkMenu.request : undefined}
            onClose={restore => { forkMenu?.request.dismissQuery?.(); if (restore) forkMenu?.request.restoreFocus(); setForkMenu(undefined); }}
            onSelect={execution => void runFork(execution)} onResume={() => void runFork()} onOpenChild={() => void openForkedChat()}/>}
          {!selectedId && <ComposerContext onCheckoutBlocked={openBranchSwitch} ref={composerContext} hostId={hostId} hostName={state?.host.name ?? hostId} hosts={desktop.hosts} projects={state?.projects ?? []} projectId={draft.projectId} connected={connected} addingProject={addingProject} workspace={workspace}
            environment={draft.environment} environmentAvailable={environmentAvailable} environments={environmentCatalog ? {items:environmentCatalog.items,loading:environmentCatalog.loading,error:environmentCatalog.error ?? environmentCatalog.cacheWarning,refresh:() => { void environmentCatalog.refresh(); }} : undefined}
            onEnvironment={environment => drafts.update(draftId,{environment})} onOpenEnvironmentSettings={() => { if (draft.projectId) setEnvironmentProject({hostId,projectId:draft.projectId}); setSettingsPage("environments"); openSettings(); }}
            execution={draft.execution} worktreesAvailable={worktreesAvailable} onExecution={(execution: NewChatExecution) => drafts.update(draftId,{execution})}
            onExecutionMode={(execution: NewChatExecution) => {
              if (worktreesAvailable && draft.projectId) selectProjectExecutionMode(drafts,draftId,draft.projectId,execution);
              else if (execution.type === "local" && draft.execution?.type === "worktree") drafts.update(draftId,{execution});
            }}
            branchPrefix={preferences.get("git.branchPrefix") ?? "codex/"} onOpenGitSettings={() => { setSettingsPage("git"); openSettings(); }}
            onProject={projectId => { if (worktreesAvailable) selectProjectWithExecutionMode(drafts,draftId,projectId); else drafts.update(draftId,{projectId,...(projectId === null && draft.execution?.type === "worktree" ? {execution:{type:"local" as const}} : {})}); }} onHost={owner => navigate(null,owner)} onAddProject={() => void addProject()}/>}
          {selected && state?.queuedMessages?.version === 1 && bridge.getQueuedMessages && bridge.mutateQueuedMessages && <QueuedMessages key={`queued:${hostId}:${selected.id}`} bridge={bridge} hostId={hostId} sessionId={selected.id} connected={connected} archived={Boolean(selected.archived)}/>}
          {queuedSubmissionRecoveries.map(item => <div className="inline-error" role="alert" key={item.send.id}><span>{item.receipt?.outcome === "unknown"
            ? `Delivery of an earlier message is unknown. Inspect command ${item.send.id} before sending it again.`
            : item.receipt?.message ?? "An earlier queued message was not recorded."}</span>{item.receipt?.outcome === "not-recorded"
              ? <button type="button" disabled={hasDraftContent(draft) || item.draft.id !== draftId} onClick={() => { try {
                  submissions.restoreQueuedSubmission(item.send.id, restored => drafts.update(draftId, { text: restored.text, ...(restored.attachments === undefined ? {} : { attachments: restored.attachments }) })); textarea.current?.focus();
                } catch (cause) { setActionError(errorMessage(cause)); } }}>Restore message</button>
              : <button type="button" disabled={!connected} onClick={() => void submissions.reconcileQueuedSubmission(item.send.id).then(receipt => {
                  if (receipt.outcome === "unknown") setActionError(receipt.message ?? `Delivery of command ${item.send.id} remains unknown.`);
                }).catch(cause => setActionError(errorMessage(cause)))}>Check receipt</button>}</div>)}
          <ExtensionWidgets view={extensionUi} placement="aboveEditor" connected={connected}/>
          <form className={`composer ${selected?.archived ? "archived-composer" : ""}`} onSubmit={event => { event.preventDefault(); void submit(); }} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); if (!selected?.archived) void imageComposer.add([...event.dataTransfer.files], state?.imageAttachments); }} onPaste={event => { if (!event.clipboardData.files.length) return; event.preventDefault(); if (!selected?.archived) void imageComposer.add([...event.clipboardData.files], state?.imageAttachments); }}>
            {remoteExecutionIssue && <p className="attachment-notice" role="status">{remoteExecutionIssue}</p>}
            {wholeFileIssue && <p className="attachment-notice" role="status">{wholeFileIssue}</p>}
            <ComposerSelectedText attachments={draft.selectedTextAttachments} disabled={Boolean(selected?.archived)} onRemove={ids => { const remove = new Set(ids); drafts.update(draftId, { selectedTextAttachments: (drafts.get(draftId).draft.selectedTextAttachments ?? []).filter(item => !remove.has(item.id)) }); }} onFocusComposer={() => textarea.current?.focus()}/>
            {selectedTextIssue && <p className="attachment-notice" role="status">{selectedTextIssue}</p>}
            <ComposerImages key={`${hostId}:${draftId}:${workspaceOwner ?? ""}`} commandRef={composerImages} controller={imageComposer} attachments={draft.attachments} media={attachmentMedia} hostId={hostId} connected={connected} capabilities={state?.imageAttachments} disabled={Boolean(selected?.archived)} />
            {imageIssue && <p className="attachment-notice" role="status">{imageIssue}</p>}
            {imagesStaging && <p className="attachment-notice" role="status">Finish adding or remove the pending images before sending.</p>}
            <label className="sr-only" htmlFor="prompt">Message</label>
            <span id="prompt-keyboard-hint" className="sr-only">{running
              ? `${normalSendShortcut} to ${followUpQueueMode === "queue" ? "queue a follow-up" : "steer"}; ${oppositeSendShortcut} does the opposite for one message.`
              : `${normalSendShortcut} to send. Shift Enter for a new line.`}</span>
            <ComposerEditor inputRef={textarea} scope={routeKey+':'+draftId} text={draft.text} files={draft.wholeFileAttachments}
              clipboardHostId={hostId} canPasteFiles={state?.wholeFiles?.inlineMentions?.commandVersion===8} allowRepeatedFiles={state?.wholeFiles?.inlineMentions?.repeatedSources?.commandVersion===9} onPasteError={error=>setActionError(error.message)}
              onOpenFile={source=>{try {
                const file=wholeFileOpenTarget(source,hostId,selected?.cwd??project?.path);
                if("absolutePath" in file)dock.openHostFile(file.absolutePath,hostId);
                else void Promise.resolve(transcriptLinkActions.openFile?.(file)).catch(cause=>setActionError(errorMessage(cause)));
              }catch(cause){setActionError(errorMessage(cause));}}}
              onChange={({text,files})=>drafts.update(draftId,{text,...(files.length||draft.wholeFileAttachments!==undefined?{wholeFileAttachments:files}:{})})}
              onSelection={autocomplete.observeCaret} onFocus={autocomplete.inputProps.onFocus} onBlur={autocomplete.inputProps.onBlur}
              onCompositionStart={autocomplete.inputProps.onCompositionStart} onCompositionEnd={autocomplete.inputProps.onCompositionEnd}
              ariaControls={autocomplete.inputProps['aria-controls']} ariaExpanded={autocomplete.inputProps['aria-expanded']} ariaActiveDescendant={autocomplete.inputProps['aria-activedescendant']}
              placeholder={selected?.archived ? "Unarchive this conversation to continue" : draft.goal ? "Describe the goal…" : running ? "Add instructions while the agent works…" : "Ask anything, or describe a task"} disabled={Boolean(selected?.archived)}
              onKeyDown={event => { if (autocomplete.onKeyDown(event)) return;
                installedShortcuts.current?.handleKey(event.nativeEvent);
                if (event.defaultPrevented || event.nativeEvent.defaultPrevented) return;
                const selectedDelivery = running ? followUpQueueMode === "queue" ? "follow-up" : "steer" : null;
                const submission = submissionForEnter({ key: event.key, altKey: event.altKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey,
                  shiftKey: event.shiftKey, keyCode: event.keyCode, isComposing: event.nativeEvent.isComposing || autocomplete.composing.current },
                  effectiveSendMode(sendBehavior, drafts.get(draftId).draft.text), selectedDelivery);
                if (submission !== null) { event.preventDefault(); void submit(submission === "send" ? undefined : submission); } }}/>
            {autocomplete.popup}
            <div className="composer-toolbar">
              <div className="composer-selections">
                <ComposerSelections connection={{ bridge, hostId, localHostId: desktop.localHostId, connected }} key={`${hostId}:${draftId}:${workspaceOwner ?? ""}`} commandRef={composerSelections} data={composer} draft={draft} session={selected} disabled={Boolean(selected?.archived) || running} onChange={patch => drafts.update(draftId, patch)} />
                {draft.goal && <GoalComposerIntent key={`${hostId}:${draftId}`} intent={draft.goal} disabled={Boolean(selected?.archived || busy || pendingSubmission?.uncertain)} onChange={goal => drafts.update(draftId, { goal })} onClear={() => { drafts.update(draftId, { goal: null }); textarea.current?.focus(); }}/>}
              </div>
              <div className="composer-send-actions">{running && <button className="stop-button" type="button" disabled={!connected} onClick={interrupt} aria-label="Stop response" title="Stop response"><Icon name="stop"/></button>}<button className="send-button" type="submit" disabled={!canSend && !canRouteGoal} aria-label={pendingSubmission?.uncertain ? "Retry pending submission" : running && followUpQueueMode === "queue" ? "Queue follow-up" : running ? "Steer agent" : "Send message"} title={connected ? pendingSubmission?.uncertain ? "Retry pending submission" : running && followUpQueueMode === "queue" ? "Queue follow-up" : running ? "Steer agent" : `Send (${normalSendShortcut})` : "Reconnect to send"}>{busy ? <span className="spinner"/> : <Icon name="arrow"/>}</button></div>
            </div>
          </form>
          {forceSessionId && submissions.forceTools.pendingOperations(forceSessionId).map(operation => <div className="inline-error" role="status" key={operation.id}>
            <span>{operation.kind === "cancel" ? "Force cancellation" : "Remaining prompt delivery"} needs reconciliation.</span>
            <button type="button" disabled={!connected || busy} onClick={() => {
              setBusy(true); void submissions.checkForceOperation(forceSessionId, operation.id).then(settled => {
                if (settled) drafts.finishSubmission(settled.draft.id, settled.draft, false);
                if (settled && operation.kind === "recover") setActionErrorState(current => clearRecoveredForceError(current, {
                  hostId, sessionId: forceSessionId, commandId: settled.originalCommandId,
                }));
                void refresh();
              }).catch(cause => setActionError(errorMessage(cause))).finally(() => setBusy(false));
            }}>Check original operation</button>
          </div>)}
          {forceSessionId ? <ForceToolControl key={`force:${hostId}:${forceSessionId}`} owner={{hostId, sessionId:forceSessionId}}
            ownerLabel={`${selected?.title ?? knownPendingSession?.title ?? "Current conversation"} · ${state?.host.name ?? "Unavailable host"}`}
            ports={forceToolPorts} connected={connected && !selected?.archived} active={!contentOverlayOpen}
            draftText={draft.text} recovery={submissions.forceRecovery(forceSessionId)}/>
            : <p className="force-tool-help">Open a conversation to choose an active tool. Native /force can also be typed in this draft.</p>}
          <PlanExecutionContinuationControl view={nativePlan.view} connected={connected && !selected?.archived}
            retry={expected => nativePlan.state.retryExecution(expected)} refresh={() => nativePlan.state.refresh()}
            openOwner={expected => { try { nativePlan.state.openExecutionOwner(expected); } catch (cause) { setActionError(errorMessage(cause)); } }}/>
          <div className="plan-composer-controls" role="group" aria-label="Native Plan mode">
            <button type="button" className="composer-selection-trigger" aria-pressed={nativePlan.view.value?.mode === "active"}
              disabled={!nativePlan.view.fresh || !nativePlan.view.value?.canToggle || nativePlan.view.pending || nativePlan.view.uncertain}
              title={nativePlan.view.unavailable ?? nativePlan.view.value?.busyReason ?? "Native planning mode, separate from tool permissions"}
              onClick={() => { const value = nativePlan.view.value; if (value) void nativePlan.state.control(nativePlan.view.owner, { sessionId: nativePlan.view.owner.sessionId, ticket: value.ticket, action: "toggle" }).catch(() => {}); }}>
              <Icon name="check"/>Plan · {nativePlan.view.value?.mode ?? "unavailable"}
            </button>
            <button ref={planTrigger} type="button" className="composer-selection-trigger" aria-haspopup="dialog" aria-expanded={planOpen}
              disabled={!nativePlan.view.value || nativePlan.view.pending || (!nativePlan.view.value.review && (nativePlan.view.value.mode !== "active" || !nativePlan.view.fresh || nativePlan.view.uncertain))}
              title={nativePlan.view.value?.mode !== "active" && !nativePlan.view.value?.review ? "Enter Plan mode before opening its native plan artifact." : "Review the owning session’s native plan"}
              onClick={() => void openPlanReview()}>{nativePlan.view.value?.review ? "Review plan" : "Open plan"}</button>
            {nativePlan.view.loading && <span role="status">Refreshing Plan…</span>}
            {(nativePlan.view.unavailable || nativePlan.view.error || nativePlan.view.value?.warning) && <span role="status">{nativePlan.view.unavailable ?? nativePlan.view.error ?? nativePlan.view.value?.warning}</span>}
          </div>
          <ExtensionWidgets view={extensionUi} placement="belowEditor" connected={connected}/>
          <ExtensionStatuses view={extensionUi} connected={connected}/>
          <AdvancedStreamControls bridge={bridge} hostId={hostId} localHostId={desktop.localHostId} sessionId={selected?.id} connected={connected} disabled={Boolean(selected?.archived) || running}/>
          <div className="composer-footnote" aria-live="polite">{view.status === "saving" ? "Saving…" : view.status === "offline" ? "Draft saved on this device" : view.status === "conflict" ? "Draft conflict" : view.status === "unsaved" ? "Unsaved changes" : view.status === "error" ? "Draft not saved to host" : null}</div>
        </div>
      </>}
      </>}

    </main>
      {environmentOpen && workspace && !contentOverlayOpen && <div className="environment-overlay"><EnvironmentCard jobs={selected ? { content: <SessionJobsPanel key={`${hostId}:${selected.id}`} bridge={bridge} hostId={hostId} sessionId={selected.id} connected={connected} visible={!environmentCollapsed.includes("jobs")}/> } : undefined} onCheckoutBlocked={openBranchSwitch} taskLocation={selected ? taskLocation : undefined} compoundGit={state?.gitSubmissions?.commandVersion === 10} branchPrefix={preferences.get("git.branchPrefix") ?? "codex/"} onOpenGitSettings={() => { setSettingsPage("git"); openSettings(); }} collapsedSections={environmentCollapsed} onToggleSection={key => setEnvironmentCollapsed(previous => previous.includes(key) ? previous.filter(value => value !== key) : [...previous, key])} showEmptySources={!project} todos={selected ? { count: todosOpenCount, content: <SessionTodosPanel externalEditor={todoEditorPorts} model={todosModel} {...nativeTodos.view} connected={todosConnected} {...todosPanelPorts} copy={typeof navigator.clipboard?.writeText === "function" ? copyText : undefined}/> } : undefined} sideChats={dock.snapshot.tabs.filter(tab => tab.kind === "side-chat" && tab.hostId === hostId && tab.target === `session:${selectedId}`).map(tab => ({ id:tab.id,title:tab.title,unread:Boolean(tab.unread),onOpen:() => dock.open("side-chat") }))} actions={state?.localEnvironments?.actions ? <EnvironmentActions workspace={workspace} connected={connected} onTerminal={(terminal,title) => dock.bindTerminal(terminal.id,hostId,workspace.target,defaultTerminalLocation,title)} onSettings={() => { if(project?.id) setEnvironmentProject({hostId,projectId:project.id}); setSettingsPage("environments"); openSettings(); }}/> : undefined} key={workspaceOwner} hostName={state?.host.name ?? hostId} cwd={selected?.cwd ?? project?.path ?? ""} local={hostId === desktop.localHostId} connected={connected} workspace={workspace} activity={activity?.value} activityError={!connected ? "Reconnect to refresh native activity." : activity?.error} sources={selected ? transcriptSources(transcript.messages,selected.id).map(source => ({id:source.id,label:source.label,kind:source.kind,onOpen:() => {if(source.kind === "image") setSourcePreview({hostId,source});else {try {const link = resolveTranscriptLink(encodeURIComponent(source.path).replaceAll("%2F","/"),selected.cwd,true); if(link.kind !== "file") throw new Error(link.kind === "unavailable" ? link.reason : "This source is not a workspace file."); void transcriptLinkActions.openFile?.(link.file);} catch(cause){setActionError(errorMessage(cause));}}}})) : []} onReview={() => dock.open("review")} onCommit={() => { if (state?.gitSubmissions?.commandVersion === 10) openGitSubmission(workspace!); else { dock.open("review"); setCommitRequest({owner:workspaceOwner!,id:crypto.randomUUID()}); } }} onFiles={() => dock.open("files")} onTerminal={() => void dock.terminal(defaultTerminalLocation)} onHost={() => { setSidebarOpen(true); requestAnimationFrame(() => { const trigger = document.getElementById("active-host"); trigger?.focus(); trigger?.click(); }); }}/></div>}
    {!contentOverlayOpen && <div className="header-panel-actions no-drag" onContextMenu={headerContextMenu}>
      {taskLayoutAction && <button className="icon-button" aria-label={taskLayoutAction.label} title={taskLayoutAction.label === "Fullscreen" ? `Fullscreen content · ${navigator.platform.toLowerCase().includes("mac") ? "Option" : "Alt"}-click for Chat` : taskLayoutAction.label} onClick={event => taskLayoutAction.onSelect(readTaskLayoutActivation(event))}><Icon name={taskLayoutAction.label === "Restore split" ? "restoreSplit" : "fullWidth"}/></button>}
      {bottomPanelVisible && <button role="checkbox" aria-checked={terminalOpen} className={`icon-button ${terminalOpen ? "active" : ""}`} aria-label="Toggle bottom panel" title={terminalOpen ? "Hide bottom panel" : "Show bottom panel"} onClick={() => dock.toggle("bottom")}><Icon name="panelBottom"/></button>}
      <button role="checkbox" aria-checked={workspaceOpen} className={`icon-button ${workspaceOpen ? "active" : ""}`} aria-label="Toggle side panel" title={`${workspaceOpen ? "Hide" : "Show"} side panel (⌥⌘B)`} onClick={() => dock.toggle("right")}><Icon name={workspaceOpen ? "panelRightOpen" : "panelRight"}/></button>
    </div>}
    {(["right", "bottom"] as const).map(destination => <div className={`dock-slot dock-slot-${destination}`} key={destination} style={{display:!contentOverlayOpen && dock.snapshot.state[destination].open ? undefined : "none"}} inert={contentOverlayOpen || !dock.snapshot.state[destination].open || undefined}>
      <DockPanel commandRef={destination === "right" ? rightDockCommands : bottomDockCommands} presentationIds={dock.presentations.instances} dragEnabled={!contentOverlayOpen} dragOwner={`${hostId}:${selectedId ?? "draft"}`} leadingTab={destination === "right" && showUnifiedStrip ? { id:mainChatTabId,panelId:mainChatPanelId,title:selected?.title ?? (selectedId ? loading ? "Loading conversation…" : "Conversation unavailable" : "Chat"),selected:taskStrip?.active.kind === "chat",shortcutHint:taskHints?.chat,onSelect:() => selectMainTask(mainChat,false),onContextMenu:event=>void taskPlacementMenu(event,mainChat) } : undefined}
        shortcutHints={destination === "right" ? taskHints?.content : undefined}
        stripContainer={destination === "right" && showUnifiedStrip ? mainStripContainer : undefined}
        stripStart={destination === "right" && showUnifiedStrip && !sidebarOpen ? <button className="icon-button no-drag" aria-label="Show sidebar" onClick={() => setSidebarOpen(true)}><Icon name="sidebar"/></button> : undefined}
        stripActions={destination === "right" && showUnifiedStrip ? <>{selected && (selected.archived || selected.status !== "idle") && <span className={`status-label ${selected.status}`}>{selected.archived ? "Archived" : selected.status}</span>}{conversationActions}{environmentAction}</> : undefined}
        onStripContextMenu={destination === "right" && showUnifiedStrip ? headerContextMenu : undefined}
        onSwapSides={destination === "right" && workspaceOpen && !fullWidthContent && !contentOverlayOpen ? () => dock.change(setContentSide(dock.snapshot.state,contentSide === "left" ? "right" : "left")) : undefined}
        onEmpty={emptied => {if (emptied === "right") {mainTaskArea.current="chat";setMainTaskFocus({target:mainChat});}}}
        onPaneDrag={(task,point)=>{if(!contentOverlayOpen)setPaneDrag({target:dragTarget(task),point});}}
        onPaneDragEnd={()=>setPaneDrag(undefined)}
        onPaneDrop={(task,point)=>{
          if(contentOverlayOpen) return;
          const target=dragTarget(task),side=paneDropAt(taskDropGeometry(dock.snapshot,mainChat,target,dockViewport),point);
          if(!side) return;
          const change=placeTask(dock.snapshot,mainChat,target,side);if(change) applyPlacement(change);
        }}
        onTabContextMenu={(event,tab)=>void taskPlacementMenu(event,{kind:"content",tabId:tab.id,hostId:tab.hostId,target:tab.target})}
        onPinTab={dock.pinFile} onBeforeClose={tab => tab.kind === "mcp-app" ? (mcpPanels.get(tab.id)?.close() ?? Promise.resolve()).then(() => true, error => { setActionError(errorMessage(error)); return false; }) : tab.kind === "browser" ? browserCloseFocus.runClose(tab.id, dock.presentations.instances.get(tab.id), focusId => browserCloses.close(tab, dock.presentations.instances.get(tab.id), focusId)) : fileClose.onBeforeClose(tab)} destination={destination} state={dock.snapshot.state} tabs={dock.snapshot.tabs} viewport={dockViewport} layoutAction={destination === "right" ? taskLayoutAction : undefined} onChange={dock.change} onTabDrop={(id,_from,to,index) => {
          const tab=dock.snapshot.tabs.find(tab=>tab.id===id);if(!tab) return;
          if(to!==_from && !taskDropDestinations(dock.snapshot,mainChat,dragTarget(tab)).includes(to==="right"?contentSide:"bottom")) return;
          dock.change(moveDockTab(dock.snapshot.state,id,to,index));
        }} addActions={dockActions.filter(action => !action.destinations || action.destinations.includes(destination))} closeable={destination === "bottom"} renderTab={(tab, active) => renderDockTab(tab, active && !contentOverlayOpen && dock.snapshot.state[destination].open)}/>
      {!dock.snapshot.state[destination].tabIds.length && <DockEmptyActions actions={dockActions.filter(action => !action.destinations || action.destinations.includes(destination))} destination={destination} suggested={destination === "right" && selected && !reviewAction ? { owner: suggestedOutputs, images: { hostId, sessionId: selected.id, media: attachmentMedia }, onOpen: openSuggestedOutput, onSource: (output, current) => dock.openHostFile(output.path, hostId, "right", false, current) } : undefined}/>}
    </div>)}
    </div>
    {paneDrag && !contentOverlayOpen && <TaskPaneDropPreview geometry={taskDropGeometry(dock.snapshot,mainChat,paneDrag.target,dockViewport)} point={paneDrag.point}/>}
    {commandMenuMode && <CommandMenu bridge={bridge} hosts={commandMenuHosts} actions={commandMenuActions} recentChats={commandMenuRecentChats} mode={commandMenuMode} onModeChange={setCommandMenuMode}
      browserTabs={commandBrowserTabs.map(tab => ({ ...tab, ownerTitle: tab.sessionId === null ? "New conversation" : desktop.catalog.records.get(tab.hostId)?.state?.sessions.find(session => session.id === tab.sessionId)?.title }))}
      onSelectBrowserTab={tab => {
        const next = activateBrowserSearchTab(dock.snapshot, tab, dock.presentations, committedDraftSearchPages.current);
        if (!next) { setActionError("This browser tab is no longer open in this window."); return; }
        const id = dock.activateBrowserSearch(tab, () => committedDraftSearchPages.current);
        browserSearchSelection.begin(id, tab, { route, settingsOpen, pluginDirectoryOpen: pluginDirectoryOpen || automationsOpen || pullRequestsOpen });
      }}
      onRestoreFocus={commandMenuFileEditor.current?.restoreFocus}
      onClose={() => { commandMenuFileEditor.current = undefined; setCommandMenuMode(undefined); }} onSelectSession={(owner, sessionId) => navigate(sessionId, owner)}/>}
    {fileSearchOwner && fileSearchOwner === workspaceOwner && workspace && workspaceTarget && <WorkspaceFileSearch key={workspaceOwner} data={workspace} connected={connected}
      onClose={() => setFileSearchOwner(undefined)} onOpenFile={path => {
        setWorkspaceFileRequest({ owner: fileSearchOwner, request: { id: crypto.randomUUID(), path } });
        dock.openFile(path, hostId, workspaceTarget, "right", true);
      }}/>}
    {gitDialog && <GitSubmissionDialog key={gitDialog.id} data={gitDialog.data} supported={desktop.catalog.records.get(gitDialog.data.hostId)?.state?.gitSubmissions?.commandVersion === 10} branchPrefix={preferences.get("git.branchPrefix") ?? "codex/"}
      onOpenGitSettings={() => { setGitDialog(undefined); setSettingsPage("git"); openSettings(); }} onClose={() => setGitDialog(undefined)}
      onSubmit={intent => {
        const data = gitDialog.data, target = data.target, record = desktop.catalog.records.get(data.hostId);
        const label = "projectId" in target ? record?.state?.projects.find(project => project.id === target.projectId)?.name : "sessionId" in target ? record?.state?.sessions.find(session => session.id === target.sessionId)?.title : undefined;
        setGitDialog(undefined); setGitFeedback({ data, label: label ?? record?.state?.host.name ?? data.hostId });
        void data.submitGit(intent);
      }}/>} 
    {branchSwitch && workspace === branchSwitch.request.data && connected && !contentOverlayOpen && <BranchSwitchDialog
      key={branchSwitch.request.refusal.commandId} request={branchSwitch.request}
      isCurrent={() => branchSwitchOwner.current === branchSwitch.owner && branchSwitch.owner.enabled}
      supported={state?.gitSubmissions?.commandVersion === 10} branchPrefix={preferences.get("git.branchPrefix") ?? "codex/"}
      onOpenGitSettings={() => { setBranchSwitch(undefined); setSettingsPage("git"); openSettings(); }}
      onClose={() => setBranchSwitch(value => value === branchSwitch ? undefined : value)}/>}
    {gitFeedback && <GitSubmissionFeedback data={gitFeedback.data} ownerLabel={gitFeedback.label} onDismiss={() => setGitFeedback(undefined)}/>}
    {connectingDirectory && <McpDirectoryConnection owner={connectingDirectory.owner} closeWhenReady={connectingDirectory.connecting} hostLabel={desktop.catalog.records.get(connectingDirectory.owner.hostId)?.state?.host.name ?? connectingDirectory.owner.hostId} onClose={() => setConnectingDirectory(undefined)}/>}
    {fileClose.dialog}
    {sourcePreview && (!sourcePreview.current || sourcePreview.current()) && <ImagePreview key={`${sourcePreview.hostId}:${sourcePreview.source.id}`} dialogOnly media={attachmentMedia} source={sourcePreview.source.image} hostId={sourcePreview.hostId} connected={Boolean(desktop.catalog.records.get(sourcePreview.hostId)?.connected)} label={sourcePreview.source.label} onClose={() => setSourcePreview(undefined)}/>}
    <dialog ref={planDialog} className="app-dialog native-plan-dialog" aria-label="Native Plan review"
      onCancel={event => { event.preventDefault(); hidePlan(); }}>
      <div className="native-plan-dialog-tools"><button type="button" className="icon-button" aria-label="Hide Plan panel" onClick={hidePlan}><Icon name="close"/></button></div>
      {panelPlan && <PlanReviewPanel owner={panelPlan.owner} plan={panelPlan.value}
        ownerLabel={`${state?.host.name ?? panelPlan.owner.hostId} · ${selected?.title ?? "Conversation"}`}
        connected={connected && !selected?.archived && panelPlan.owner.hostId === hostId && panelPlan.owner.sessionId === selected?.id}
        fresh={nativePlan.view.fresh && !nativePlan.view.pending && !nativePlan.view.uncertain && panelPlan.value === nativePlan.view.value} open={planOpen}
        executionChoices={panelPlan.value.executionChoices} receipt={nativePlan.view.receipt} failure={nativePlan.view.failure} error={nativePlan.view.error}
        {...planReviewPorts} externalEditorPorts={planEditorPorts} copy={typeof navigator.clipboard?.writeText === "function" ? copyText : undefined}/>}
    </dialog>
    {treeHistoryOpen && selectedId && <SessionTreeHistory state={nativeTree.state} view={nativeTree.view} connected={connected} onClose={() => setTreeHistoryOpen(false)} onRestore={id => void restoreTreeEdit(id)} onNavigate={(id, summarize, instructions) => void navigateTree(id, summarize, instructions)}/>}
    {exportOwner && <SessionExportDialog key={`${exportOwner.hostId}:${exportOwner.sessionId}`} bridge={bridge} {...exportOwner} connected={connected && hostId === exportOwner.hostId && selected?.id === exportOwner.sessionId} onClose={() => setExportOwner(undefined)}/>}
    <dialog ref={dialogRef} className="app-dialog" onCancel={() => setDialog(null)} onClick={event => { if (event.target === event.currentTarget) setDialog(null); }}>
      <div className="dialog-header"><h2>{dialog === "rename" ? "Rename conversation" : dialog === "project" ? "Add remote project" : "Build status"}</h2><button className="icon-button" onClick={() => setDialog(null)} aria-label="Close dialog"><Icon name="close"/></button></div>
      {dialog === "project" ? <form onSubmit={addRemoteProject}><p className="subtle-notice">Enter an existing absolute folder path on {state?.host.name}. The project and its sessions stay on that machine.</p>{actionError && <p className="inline-error" role="alert">{actionError.message}</p>}<label className="field-label" htmlFor="remote-project-path">Folder path</label><input id="remote-project-path" className="text-field" value={remotePath} onChange={event => setRemotePath(event.target.value)} placeholder="/home/you/projects/example" autoFocus/><div className="dialog-footer"><button className="secondary-button" type="button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" type="submit" disabled={!remotePath.trim() || !connected || addingProject}>{addingProject ? "Adding…" : "Add project"}</button></div></form> : dialog === "rename" ? <form onSubmit={rename}>{actionError && <p className="inline-error" role="alert">{actionError.message}</p>}<label className="field-label" htmlFor="conversation-title">Name</label><input id="conversation-title" className="text-field" value={renameTitle} onChange={event => setRenameTitle(event.target.value)} autoFocus/><div className="dialog-footer"><button className="secondary-button" type="button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" type="submit" disabled={!renameTitle.trim() || !connected}>Save</button></div></form> : <div className="build-status"><p>This connected desktop flow includes host selection and an aggregate project sidebar: projects, revisioned drafts, sessions, model selection, streaming, steering, stopping, rename, and archive.</p><p>Accounts, native OMP settings and pending requests, file/editor/Git/worktree panels, and terminal sessions use the owning host’s APIs. Shared sidebar organization and the theme file are connected. Attachments, richer review, browser panels, plugins, automations, remain incomplete.</p><p>The layout uses the pinned package and measured colors from the supplied screenshot. Full visual parity and physical cross-device acceptance remain pending.</p><p>{desktop.networkError ?? desktop.network?.error ?? (desktop.network?.status === "connected" ? "Tailscale discovery is connected." : "Tailscale discovery is not connected.")}</p><button className="secondary-button" onClick={() => void desktop.refreshNetwork()}>Refresh machines</button><div className="build-host">{state?.host.name ?? "Host unavailable"} · {state?.host.platform ?? "Unknown platform"}</div></div>}
    </dialog>
  </div>{closeStatus}</>;
}
