import { ComposerEditor, type ComposerEditorHandle } from "./ComposerEditor";
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
import { EnvironmentActions } from "./EnvironmentActions";
import { GoalStrip } from "./GoalStrip";
import { GoalPanel } from "./GoalPanel";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Draft, Project, SessionSummary } from "../../../../packages/shared/src/protocol";
import { readWindowRestoration, useWindowViewPersistence } from "./window-view-state";
import { defaultFileTreeView, type SettingsPage, type WindowNavigation, type WorkspaceTab } from "../window-state";
import { prepareSkillDraft } from "./skill-draft";
import type { ComposerAction } from "@agent-desktop/shared";
import { DraftController, hasDraftContent } from "./drafts";
import { EnvironmentPreparationPause, SubmissionController } from "./submissions";
import { EnvironmentCatalog } from "./environment-catalog";
import { EnvironmentPreparationCard } from "./EnvironmentPreparationCard";
import { ComposerCatalogState, composerSelection, composerTargetKey } from "./composer-catalog";
import { ComposerSelections } from "./ComposerSelections";
import { useComposerAutocomplete } from "./ComposerAutocomplete";
import { approvalModes, composerApproval } from "./ComposerPermissions";
import { DraftSnapshot } from "./DraftSnapshot";
import { createAttachmentCache } from "./attachment-cache";
import { AttachmentComposer, attachmentDraftSender, imageSendIssue } from "./attachment-composer";
import { ComposerImages } from "./ComposerImages";
import type { AttachmentMediaContext } from "./attachment-media";
import { installAppShortcuts } from "./app-shortcuts";
import { errorMessage, useDesktop, useTranscript } from "./desktop-state";
import { Icon } from "./Icons";
import { TranscriptMessages } from "./Transcript";
import { useTranscriptScroll } from "./use-transcript-scroll";
import "./transcript-scroll.css";
import { AccountsSettings } from "./AccountsSettings";
import { PendingInteractions } from "./PendingInteractions";
import { ComposerContext, type ComposerContextHandle } from "./ComposerContext";
import { PendingDetachedQuestions } from "./DetachedQuestionCard";
import { WorkspacePanel } from "./WorkspacePanel";
import { canReplaceFilePreview } from "./file-preview-tabs";
import { transcriptHostFileActions } from "./transcript-file-actions";
import { resolveTranscriptLink, type TranscriptLinkActions, type WorkspaceFileRequest } from "./transcript-links";
import { WorkspaceState, workspaceKey } from "./workspace-state";
import { offlineCache } from "./offline-cache";
import { PreferencesState } from "./preferences-state";
import { OrganizedSidebar } from "./OrganizedSidebar";
import { NativeSettings } from "./NativeSettings";
import { GeneralSettings } from "./GeneralSettings";
import { GitSettings } from "./GitSettings";
import { SettingsSidebar } from "./SettingsSidebar";
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
import { DockPanel } from "./DockPanel";
import { useWindowClose } from "./WindowClose";
import { useWorkspaceFileClose } from "./WorkspaceFileClose";
import { DockTerminal } from "./DockTerminal";
import { moveDockTab, type DockTab, type DockDestination } from "./dock-state";
import { useWorkbenchDock, targetFromDock } from "./use-workbench-dock";
import { EnvironmentCard } from "./EnvironmentCard";
import { SideChat } from "./SideChat";
import { BtwState } from "./btw-state";
import { nativeBtwQuestion } from "../../../../packages/shared/src/btw";
import { assertComposerOwner } from "./composer-autocomplete";
import { BrowserPanel } from "./BrowserPanel";
import { useSessionActivity } from "./use-session-activity";
import { retainWorkspace } from "./workspace-lease";
import "./dock-layout.css";
import { DEFAULT_THEME } from "../../../../packages/shared/src/theme";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace-protocol";
import type { NewChatExecution } from "../../../../packages/shared/src/new-chat";
import { Welcome } from "./Welcome";
import { applyProjectExecutionMode, executionModeLabel, projectExecutionModeDraftId, projectExecutionModeView, resolveProjectExecutionMode, sameModeConflict, selectProjectExecutionMode, selectProjectWithExecutionMode } from "./project-execution-mode";

export function App() {
  const composerContext = useRef<ComposerContextHandle>(null);
  const bridge = window.agentDesktop;
  const [windowRestoration] = useState(readWindowRestoration);
  const [route, setRoute] = useState<WindowNavigation>(windowRestoration.state.route);
  const selectedId = route.sessionId;
  const desktop = useDesktop(bridge, route.hostId);
  const { state, connected, loading, refresh, command } = desktop;
  const routeKey = `${route.hostId ?? desktop.localHostId ?? ""}:${selectedId ?? ""}`;
  const selectedRef = useRef(routeKey); selectedRef.current = routeKey;
  const [sidebarOpen, setSidebarOpen] = useState(windowRestoration.state.sidebarOpen);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(windowRestoration.state.showArchived);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set(windowRestoration.state.expandedProjects));
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [addingProject, setAddingProject] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "status" | "project" | null>(null);
  const [remotePath, setRemotePath] = useState("");
  const [renameTitle, setRenameTitle] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const [pluginDirectoryOpen,setPluginDirectoryOpen]=useState(windowRestoration.state.pluginDirectoryOpen??false);
  const [pluginDirectoryTab,setPluginDirectoryTab]=useState<"plugins"|"skills">(windowRestoration.state.pluginDirectoryTab??"plugins");
  const [integrationSelection,setIntegrationSelection]=useState<{hostId:string;pluginId?:string;marketplace?:{name?:string;add?:boolean}}>();
  const [settingsOpen, setSettingsOpen] = useState(windowRestoration.state.settingsOpen);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>(windowRestoration.state.settingsPage);
  const [environmentProject, setEnvironmentProject] = useState<{hostId:string;projectId:string}>();
  const projectAddContext = useRef<{hostId:string;environments:boolean} | undefined>(undefined);
  const settingsOriginLabel = useRef<string | null>(null);
  const settingsWasOpen = useRef(false);
  const skillFileFocusPending = useRef(false);
  const openSettings = useCallback(() => {
    settingsOriginLabel.current = document.activeElement?.getAttribute("aria-label") ?? null;
    setSettingsOpen(true);
  }, []);
  useEffect(() => {
    const closing = settingsWasOpen.current && !settingsOpen;
    settingsWasOpen.current = settingsOpen;
    if (!settingsOpen && !closing) return;
    const frame = requestAnimationFrame(() => {
      if (settingsOpen) document.querySelector<HTMLElement>(".settings-sidebar-back")?.focus();
      else {
        if(skillFileFocusPending.current){const panel=document.querySelector<HTMLElement>(".dock-panel-right .native-skill-file-panel");if(panel){skillFileFocusPending.current=false;panel.focus();return;}}
        const origin = settingsOriginLabel.current ? document.querySelector<HTMLElement>(`[aria-label="${CSS.escape(settingsOriginLabel.current)}"]`) : null;
        (origin ?? (settingsPage === "git" ? document.querySelector<HTMLElement>('[aria-label="Switch branch"]') : null) ?? textarea.current)?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [settingsOpen]);
  const [workspaceFileRequest, setWorkspaceFileRequest] = useState<{ owner: string; request: WorkspaceFileRequest }>();
  const [fileTree, setFileTree] = useState({ ...defaultFileTreeView(), open: windowRestoration.state.fileTreeOpen ?? false });
  const [environmentOpen, setEnvironmentOpen] = useState(windowRestoration.state.environmentOpen ?? false);
  const [sourcePreview, setSourcePreview] = useState<{hostId:string;source:Extract<RecordedSource,{kind:"image"}>}>();
  const [commitRequest, setCommitRequest] = useState<{owner:string;id:string}>();
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
  const searchInput = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [, redraw] = useReducer(value => value + 1, 0);
  const preferences = useMemo(() => new PreferencesState(bridge, offlineCache, { read: key => localStorage.getItem(key), write: (key, value) => localStorage.setItem(key, value) }), [bridge]);
  const localConnected = Boolean(desktop.localHostId && desktop.catalog.records.get(desktop.localHostId)?.connected);
  useEffect(() => { const off = preferences.subscribe(redraw); preferences.start(); void preferences.restore().then(() => preferences.refresh()); return () => { off(); preferences.stop(); }; }, [preferences]);
  useEffect(() => { preferences.setConnection(desktop.localHostId, localConnected); if (localConnected) void preferences.refresh(); }, [preferences, desktop.localHostId, localConnected]);
  const theme = useMemo(() => new ThemeEditor(bridge, { read: key => localStorage.getItem(key), write: (key, value) => localStorage.setItem(key, value) }), [bridge]);
  const [localFonts, setLocalFonts] = useState<string[]>([]);
  const [fontsError, setFontsError] = useState<string>();
  const [themeEffectsError, setThemeEffectsError] = useState<string>();
  const refreshFonts = useCallback(() => { setFontsError(undefined); void bridge.getLocalFonts().then(setLocalFonts, cause => setFontsError(errorMessage(cause))); }, [bridge]);
  useEffect(() => { const off = theme.subscribe(redraw); void theme.refresh(); refreshFonts(); return off; }, [theme, refreshFonts]);
  useEffect(() => { const off = bridge.subscribe(event => { if (event.type === "preferences" && (event.hostId ?? desktop.localHostId) === desktop.localHostId) void theme.refresh(); }); if (localConnected) void theme.refresh(); return off; }, [bridge, theme, desktop.localHostId, localConnected]);
  const themeImage = useMemo(() => new ThemeImageState(bridge), [bridge]);
  useEffect(() => themeImage.subscribe(redraw), [themeImage]);
  useEffect(() => bridge.subscribe(event => { if (event.type === "preferences" && (event.hostId ?? desktop.localHostId) === desktop.localHostId) void themeImage.refresh(); }), [bridge, themeImage, desktop.localHostId]);
  const appliedTheme = settingsOpen && settingsPage === "appearance" ? theme.preview : theme.current?.document ?? DEFAULT_THEME;
  const imageHash = appliedTheme.background.kind === "asset" ? appliedTheme.background.sha256 : undefined;
  useEffect(() => { themeImage.select(imageHash); }, [themeImage, imageHash]);
  useEffect(() => { if (localConnected) void themeImage.refresh(); }, [themeImage, localConnected]);
  useEffect(() => {
    let cancelled = false;
    const apply = () => {
      let backgroundColor: string;
      try { applyTheme(appliedTheme); backgroundColor = cssColorToRgba(getComputedStyle(document.documentElement).backgroundColor); }
      catch (cause) { setThemeEffectsError(errorMessage(cause)); return; }
      void bridge.applyWindowTheme({ material: appliedTheme.material, backgroundColor }).then(() => { if (!cancelled) setThemeEffectsError(undefined); }, cause => { if (!cancelled) setThemeEffectsError(errorMessage(cause)); });
    };
    apply(); const systemScheme = matchMedia("(prefers-color-scheme: dark)"); systemScheme.addEventListener("change", apply);
    return () => { cancelled = true; systemScheme.removeEventListener("change", apply); };
  }, [bridge, appliedTheme]);
  const sendBehavior = preferences.get("general.sendBehavior") ?? "enter";
  const reduceMotion = preferences.get("general.reduceMotion") ?? false;
  useEffect(() => { document.documentElement.dataset.reduceMotion = reduceMotion ? "true" : "false"; }, [reduceMotion]);
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
  function controllers(owner: string) {
    let pair = stores.get(owner);
    if (!pair) {
      const cache = { read: (key: string) => localStorage.getItem(key), write: (key: string, value: string) => localStorage.setItem(key, value) };
      pair = { drafts: new DraftController(attachmentDraftSender(owner, attachmentMedia, bridge), owner, cache), submissions: new SubmissionController(envelope => bridge.command(envelope, owner), owner, cache) };
      for (const pending of pair.submissions.entries()) {
        if (pending.send) pair.drafts.beginPendingSubmission(pending.draft, pending.send.id);
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
    for (const [owner, pair] of stores) {
      const record = desktop.catalog.records.get(owner);
      if (pair.state !== record?.state) { for (const draft of record?.state?.drafts ?? []) pair.drafts.ingest(draft); pair.state = record?.state; }
      if (pair.connected !== Boolean(record?.connected)) { pair.drafts.setConnected(Boolean(record?.connected)); pair.connected = Boolean(record?.connected); }
    }
  }, [stores, desktop.catalog, desktop.catalogRevision]);
  useEffect(() => () => { for (const pair of stores.values()) pair.drafts.dispose(); }, [stores]);
  const selected = state?.sessions.find(session => session.id === selectedId) ?? null;
  const missingSession = Boolean(selectedId && state && !selected);
  const draftId = selectedId ? `session:${selectedId}` : "new-conversation";
  // A fresh session draft follows native session controls. Only an explicit
  // selection writes a model override; legacy saved choices remain untouched.
  const view = drafts.get(draftId, selected ? { projectId: selected.projectId } : undefined);
  const draft = view.draft;
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
  const workspaceTarget: WorkspaceTarget | undefined = selected ? { sessionId: selected.id } : project ? { projectId: project.id } : undefined;
  const dock = useWorkbenchDock(bridge, windowRestoration.state, hostId, workspaceTarget, connected, setActionError, tab => Boolean(tab.filePath) && canReplaceFilePreview(workspaces.get(`${tab.hostId}:${tab.target}`),tab.filePath!));
  useEffect(()=>{
    const live=new Set(dock.snapshot.tabs.map(tab=>tab.id));
    for(const [id,controller] of skillFiles)if(!live.has(id)){controller.dispose();skillFiles.delete(id);}
  },[skillFiles,dock.snapshot.tabs]);
  const workspaceOpen = dock.snapshot.state.right.open;
  const terminalOpen = dock.snapshot.state.bottom.open;
  const windowWarning = useWindowViewPersistence({ route, sidebarOpen, workspaceOpen, workspaceTab: dock.workspaceTab, terminalOpen, showArchived,
    expandedProjects: [...expandedProjects], settingsOpen, settingsPage, dock: dock.persisted, fileTreeOpen: fileTree.open, environmentOpen, pluginDirectoryOpen, pluginDirectoryTab }, windowRestoration);
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
  useEffect(() => {
    if (!workspace) return;
    const release = retainWorkspace(workspace);
    workspace.setConnected(connected);
    void workspace.restore();
    return release;
  }, [workspace, connected]);
  const imageConnection = useRef(connected); imageConnection.current = connected;
  const transcriptImageResolver = useMemo(() => createTranscriptImageResolver(bridge, hostId, () => imageConnection.current), [bridge, hostId]);
  const transcriptLinkActions: TranscriptLinkActions = {
    ownerKey: `${workspaceOwner}:${connected}`,
    images: { ownerKey: `${hostId}:${selectedId}:${workspace?.imageGeneration ?? 0}`, resolve: transcriptImageResolver },
    ...(workspace ? transcriptHostFileActions(workspace) : {}),
    saveFileCopy: workspace?.canSaveCopy ? async file => { await workspace!.saveCopy(file.path); } : undefined,
    cwd: selected?.cwd,
    openExternal: url => bridge.openExternal(url),
    openFile: (file, options) => {
      if (!workspace || !workspaceOwner) throw new Error("This session has no owning workspace.");
      if (!connected) throw new Error("The owning host is disconnected. Reconnect before opening a file link.");
      setWorkspaceFileRequest({ owner: workspaceOwner, request: { ...file, id: crypto.randomUUID() } });
      dock.openFile(file.path, hostId, workspaceTarget!, "right", options?.preview ?? true);
    },
  };
  const transcript = useTranscript(bridge, selectedId, hostId === "unconnected" ? undefined : hostId, connected, desktop.localHostId);
  const activity = useSessionActivity(bridge, hostId, selected?.id, connected, !settingsOpen, desktop.localHostId);
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
  useEffect(() => {
    if (!selectedId && environmentAvailable && draft.execution?.type === 'worktree' && draft.environment === undefined && !pendingSubmission && !view.conflict)
      drafts.update(draftId, { environment: null });
  }, [drafts, draftId, selectedId, environmentAvailable, draft.execution?.type, draft.environment, Boolean(pendingSubmission), view.conflict]);
  const pendingSessionId = pendingSubmission?.sessionId;
  const knownPendingSession = state?.sessions.find(session => session.id === pendingSessionId);
  const wholeFileIssue = wholeFileSendIssue(draft, hostId, running, state?.wholeFiles);
  const selectedTextIssue = selectedTextSendIssue(draft, running, state?.selectedText);
  const imageIssue = imageSendIssue(draft, running, state?.imageAttachments, composer.catalog, selected, composer.controls);
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
  const executionBranch = draft.execution?.type === "worktree" && draft.execution.startingState.type === "branch" ? draft.execution.startingState.branchName : undefined;
  const executionReady = Boolean(selectedId || draft.execution?.type !== "worktree" || worktreesAvailable && project && workspace?.restored && workspace.status && !workspace.busy && !workspace.pending && (draft.execution.startingState.type === "working-tree"
    ? workspace.status.entries.length
    : executionBranch === workspace.status.branch || workspace.branches.some(branch => !branch.remote && !branch.symbolicTarget && branch.name === executionBranch)));
  const environmentReady = Boolean(selectedId || draft.execution?.type !== 'worktree' || (draft.environment === undefined ? !environmentAvailable : environmentAvailable && (draft.environment === null
    || environmentCatalog?.restored && !environmentCatalog.loading && !environmentCatalog.error && environmentCatalog.items.some(item => item.type === 'environment' && item.configPath === draft.environment?.configPath && item.revision === draft.environment?.revision))));
  const canSend = connected && Boolean(state) && !busy && !missingSession && !pendingSubmission?.preparation && Boolean(hasDraftContent(draft) || pendingSubmission?.uncertain) && (Boolean(pendingSubmission?.uncertain) || (!imageIssue && !selectedTextIssue && !wholeFileIssue && !imagesStaging && executionReady && environmentReady)) && (view.status !== "conflict" || Boolean(pendingSubmission?.uncertain)) && (!modeView?.conflict || Boolean(pendingSubmission?.uncertain)) && !selected?.archived;

  const navigate = useCallback((id: string | null, owner = route.hostId ?? state?.host.id ?? desktop.localHostId, keepSettings = false) => {
    settingsOriginLabel.current = null; setRoute({ sessionId: id, hostId: owner }); if(!keepSettings)setPluginDirectoryOpen(false);setIntegrationSelection(undefined); setActionError(null); setMenuOpen(false); if (!keepSettings) setSettingsOpen(false); setAppMenuOpen(false);
    expandAfterNavigation.current = id ? `${owner ?? ""}:${id}` : undefined;
    requestAnimationFrame(() => textarea.current?.focus());
  }, [route.hostId, state?.host.id, desktop.localHostId]);
  useEffect(() => bridge.subscribeNotificationNavigation?.(target => navigate(target.sessionId, target.hostId)), [bridge, navigate]);
  // Bind legacy/new local routes once identity is known; never replace an
  // explicit unavailable remote owner with the local machine.
  useEffect(() => { if (!route.hostId && desktop.localHostId) setRoute(previous => previous.hostId ? previous : { ...previous, hostId: desktop.localHostId }); }, [route.hostId, desktop.localHostId]);
  const newConversation = useCallback((projectId?: string, owner = route.hostId ?? state?.host.id ?? desktop.localHostId) => {
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
  useEffect(() => installAppShortcuts(window, {
    composer: () => textarea.current?.element ?? null,
    blocked: () => Boolean(dialog || menuOpen || appMenuOpen),
    actions: {
      "new-chat": () => newConversation(),
      search: () => { setSidebarOpen(true); setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); },
      sidebar: () => setSidebarOpen(value => !value),
      settings: () => { openSettings(); setAppMenuOpen(false); },
      "side-chat": () => { if (selectedId) dock.open("side-chat"); },
    },
  }), [newConversation, dialog, menuOpen, appMenuOpen]);
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
    if (!menuOpen && !appMenuOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenuOpen(false); setAppMenuOpen(false); } };
    window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close);
  }, [menuOpen, appMenuOpen]);
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
  async function submit() {
    if (!canSend || submitting.current) return;
    submitting.current = true;
    setBusy(true); setActionError(null);
    const sendingDraftId = draftId; const originalRoute = selectedRef.current;
    let snapshot: Draft | undefined;
    let sideHandled = false;
    try {
      const pending = submissions.get(sendingDraftId);
      snapshot = pending?.uncertain ? pending.draft : await drafts.prepareSubmission(sendingDraftId);
      if (!hasDraftContent(snapshot)) return;
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
      drafts.beginPendingSubmission(snapshot);
      const result = await submissions.submit(snapshot, selectedId ?? undefined, running ? "steer" : "prompt", (submitted, commandId) => drafts.beginPendingSubmission(submitted, commandId));
      drafts.finishSubmission(sendingDraftId, result.submitted, true, false, result.commandId);
      await refresh(); transcript.refresh();
      // The awaited catalog is authoritative before React runs its ingest effect.
      // Image-aware drafts cannot navigate based on an optimistic local clear.
      const savedDraft = desktop.catalog.records.get(hostId)?.state?.drafts.find(value => value.id === sendingDraftId);
      if (savedDraft) drafts.ingest(savedDraft);
      if (selectedRef.current === originalRoute && !hasDraftContent(drafts.get(sendingDraftId).draft)) navigate(result.sessionId);
    } catch (cause) {
      if (snapshot && !sideHandled) drafts.finishSubmission(sendingDraftId, snapshot, false, submissions.get(sendingDraftId)?.uncertain, submissions.get(sendingDraftId)?.send?.id);
      if (!(cause instanceof EnvironmentPreparationPause)) setActionError(errorMessage(cause));
    } finally { submitting.current = false; setBusy(false); if (!sideHandled) textarea.current?.focus(); }
  }
  async function resumeEnvironment() {
    if (submitting.current || !connected || !pendingSubmission?.preparation) return;
    const ownerDraftId = draftId, originalRoute = selectedRef.current, captured = pendingSubmission.draft;
    submitting.current = true; setBusy(true); setActionError(null);
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
  async function rename(event: React.FormEvent) {
    event.preventDefault(); if (!selected || !renameTitle.trim()) return;
    try { await command({ type: "session.rename", sessionId: selected.id, title: renameTitle.trim() }); setDialog(null); await refresh(); }
    catch (cause) { setActionError(errorMessage(cause)); }
  }
  const autocomplete = useComposerAutocomplete({
    bridge, hostId, target: workspaceTarget, draftId, text: draft.text, connected,
    disabled: Boolean(selected?.archived || missingSession || busy || pendingSubmission?.uncertain || settingsOpen),
    input: textarea, readText: () => drafts.get(draftId).draft.text,
    insertFile: state?.wholeFiles?.inlineMentions?.commandVersion===8 ? (source,range) => {
      if(!textarea.current)throw new Error('The composer is unavailable. Your draft is unchanged.');
      const file=appendWholeFile(drafts.get(draftId).draft,hostId,source,{textOffset:range.start,allowRepeated:state?.wholeFiles?.inlineMentions?.repeatedSources?.commandVersion===9}).findLast(item=>item.source.hostId===source.hostId&&item.source.path===source.path)!;
      textarea.current.insertFile(file,range);
    } : undefined,
    updateText: text => { if(textarea.current)textarea.current.replaceText(text); else drafts.update(draftId,{text,wholeFileAttachments:remapFileOffsets(drafts.get(draftId).draft.text,text,drafts.get(draftId).draft.wholeFileAttachments??[])}); },
    actions: [
      { id: "side-chat", name: "Side chat", description: "Ask a native OMP side question", icon: "sideChat", reason: !selected ? "Open a conversation to ask a side question." : undefined, run: () => dock.open("side-chat") },
      { id: "goal", name: "Goal", description: "Set or edit the native goal", icon: "compose", reason: !selected ? "Open a conversation to manage its goal." : undefined, run: () => dock.open("goal") },
      { id: "archive", name: "Archive", description: "Archive the current chat", icon: "archive", reason: !selected ? "Open a conversation to archive it." : !connected ? "Reconnect to archive this conversation." : undefined,
        run: async () => { if (!selected || !connected) throw new Error("The conversation is unavailable."); await command({ type: "session.archive", sessionId: selected.id, archived: true }); await refresh(); } },
      { id: "review", name: "Code review", description: "Review changes in this workspace", icon: "compose", reason: !workspace ? "Choose a project to review its changes." : undefined,
        run: () => dock.open("review") },
      { id: "files", name: "Files", description: "Open workspace files", icon: "folder", reason: !workspace ? "Choose a project to browse its files." : undefined,
        run: () => dock.open("files") },
      { id: "terminal", name: "Terminal", description: "Open the workspace terminal", icon: "terminal", reason: !workspace ? "Choose a project to open its terminal." : undefined,
        run: () => dock.terminal() },
      { id: "new-chat", name: "New chat", description: "Start a new conversation", icon: "compose", run: () => newConversation() },
      { id: "settings", name: "Settings", description: "Open native OMP settings", icon: "more", run: () => { setSettingsPage("omp"); openSettings(); } },
    ],
  });
  const hostGroups = desktop.hosts.flatMap(host => { const hostState = host.hostId ? desktop.catalog.records.get(host.hostId)?.state : undefined; return hostState ? [{ host, hostState }] : []; });

  const dockActions = workspaceTarget ? [
    {id:"review",label:"Review",onSelect:(destination:DockDestination) => dock.open("review",destination)},
    {id:"terminal",label:"Terminal",onSelect:(destination:DockDestination) => {void dock.terminal(destination);}},
    {id:"new-terminal",label:"New terminal",onSelect:(destination:DockDestination) => {void dock.terminal(destination,true);}},
    {id:"files",label:"Files",onSelect:(destination:DockDestination) => dock.open("files",destination)},
    {id:"worktrees",label:"Worktrees",onSelect:(destination:DockDestination) => dock.open("worktrees",destination)},
    ...("sessionId" in workspaceTarget ? [{id:"side-chat",label:"Side chat",onSelect:(destination:DockDestination) => dock.open("side-chat",destination)}, {id:"browser",label:"Browser",onSelect:(destination:DockDestination) => { void dock.browser(destination, true); }}, {id:"existing-browser",label:"Existing browser tabs",onSelect:(destination:DockDestination) => { void dock.browser(destination, false); }}] : []),
  ] : [];
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
    if (tab.kind === "skill-file") {
      if (!tab.skillFile) return <p>The saved skill file identity is unavailable.</p>;
      let controller = skillFiles.get(tab.id);
      if (!controller) { controller = new NativeSkillFileController(bridge,tab.hostId,tab.skillFile,offlineCache,tab.fileMode); skillFiles.set(tab.id,controller); }
      return <NativeSkillFilePanel onAddToChat={canAddSelection ? (path, selection) => addSelection(tab.hostId, path, selection) : undefined} controller={controller} fileMode={tab.fileMode??"markdown"} onFileModeChange={mode=>dock.setFileMode(tab.id,mode)} fileScroll={tab.fileScroll} onFileScrollChange={(mode,top)=>dock.setFileScroll(tab.id,mode,top)} connected={Boolean(desktop.catalog.records.get(tab.hostId)?.connected)} active={active} openExternal={url=>bridge.openExternal(url)}/>;
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
      return <GoalPanel key={owner} bridge={bridge} hostId={tab.hostId} sessionId={target.sessionId} connected={online} running={goalSession?.status === "running"} archived={Boolean(goalSession?.archived)} active={active} activity={tab.hostId === hostId && target.sessionId === selected?.id ? activity : undefined} localHostId={desktop.localHostId}/>;
    }
    if(tab.kind === "terminal") return tab.terminalId ? <DockTerminal bridge={bridge} hostId={tab.hostId} target={target} terminalId={tab.terminalId} connected={online}/> : <p>Saved terminal identity is unavailable.</p>;
    if (tab.kind === "browser") return "sessionId" in target ? (tab.browserTarget ? <BrowserPanel bridge={bridge} hostId={tab.hostId} sessionId={target.sessionId} nativeTarget={tab.browserTarget} onMetadata={value => dock.updateBrowserTitle(tab.id, value.title || value.url || tab.title)} active={active}/> : <p>Saved browser tab identity is unavailable. Open existing native browser tabs to select a live target.</p>) : <p>Browser previews require a native session.</p>;
    let data = workspaces.get(owner);
    if(!data) {data = new WorkspaceState(bridge,tab.hostId,target,offlineCache,desktop.localHostId);workspaces.set(owner,data);}
    const ownerSession = "sessionId" in target ? record?.state?.sessions.find(value => value.id === target.sessionId) : undefined;
    const ownerProject = record?.state?.projects.find(value => value.id === ("projectId" in target ? target.projectId : ownerSession?.projectId));
    const fileRoot = "filePath" in target ? target.filePath.slice(0,target.filePath.lastIndexOf("/")) || "/" : ownerSession?.cwd ?? ownerProject?.path;
    return <WorkspacePanel onAddFile={canAddWholeFile && tab.hostId === hostId && fileRoot ? relativePath => addWholeFile(tab.hostId, `${(fileRoot ?? "").replace(/\/$/, "")}/${relativePath}`) : undefined} onFileEdit={() => dock.pinFile(tab.id)} onAddToChat={canAddSelection && fileRoot ? (relativePath, selection) => addSelection(tab.hostId, `${(fileRoot ?? "").replace(/\/$/, "")}/${relativePath}`, selection) : undefined} embedded active={active} fileTree={fileTree} onFileTreeChange={setFileTree} data={data} connected={online} filePath={tab.kind === "file" ? tab.filePath : undefined} fileMode={tab.fileMode} onFileModeChange={mode => dock.setFileMode(tab.id, mode)} openExternal={url => bridge.openExternal(url)} onOpenFile={(path, location, options) => {
      if ("filePath" in target) {
        const absolutePath = path.startsWith("/") ? path : `${(fileRoot ?? "/").replace(/\/$/, "")}/${path}`;
        const targetOwner = `${tab.hostId}:${workspaceKey({ filePath: absolutePath })}`;
        setWorkspaceFileRequest({ owner: targetOwner, request: { ...location, id: crypto.randomUUID(), path: path.split("/").at(-1)! } });
        dock.openHostFile(absolutePath, tab.hostId, "right", options?.preview ?? true);
      } else {
        setWorkspaceFileRequest({ owner, request: { ...location, id: crypto.randomUUID(), path } });
        dock.openFile(path, tab.hostId, target, "right", options?.preview ?? true);
      }
    }} tab={tab.kind === "review" ? "changes" : tab.kind === "file" ? "files" : tab.kind} onTabChange={next => dock.open(next === "changes" ? "review" : next,"right",tab.hostId,target)} fileRequest={(tab.kind === "file" && tab.filePath === workspaceFileRequest?.request.path) && workspaceFileRequest?.owner === owner ? workspaceFileRequest.request : undefined} commitRequest={commitRequest?.owner === owner && tab.kind === "review" ? commitRequest.id : undefined} name={ownerProject?.name ?? ownerSession?.title ?? tab.title} path={fileRoot ?? ""} onClose={() => {}} onOpenProject={async path => { const result = await bridge.command({id:crypto.randomUUID(),command:{type:"project.add",path}},tab.hostId); if(!result.ok || !result.value || !("path" in result.value)) throw new Error("The host did not return the project.");await refresh();newConversation(result.value.id,tab.hostId); }}/>
  }
  const shell = useRef<HTMLDivElement>(null);
  const closeStatus = useWindowClose(bridge, shell, async signal => {
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
  return <><div ref={shell} className={`app-shell ${settingsOpen ? "settings-open" : sidebarOpen ? "" : "sidebar-hidden"}`}>
    {settingsOpen ? <SettingsSidebar page={settingsPage} onSelect={setSettingsPage} onBack={() => setSettingsOpen(false)} environmentAvailable={Boolean(state?.localEnvironments?.configuration)} hostControl={<label className="settings-host-picker"><span>Machine</span><select aria-label="Settings machine" value={state?.host.id ?? route.hostId ?? ""} onChange={event => navigate(null,event.target.value,true)}>{!desktop.hosts.length && <option value={route.hostId ?? ""}>{loading ? "Connecting…" : "Host unavailable"}</option>}{desktop.hosts.map(host => <option key={host.key} value={host.hostId ?? host.key} disabled={!host.hostId}>{host.name}{host.local ? " · This machine" : ""}{host.availability !== "available" ? ` · ${host.availability}` : ""}</option>)}</select></label>}/> : <aside className="sidebar" aria-label="Projects and conversations" inert={!sidebarOpen}>
      <div className="sidebar-titlebar drag-region"><button className="icon-button no-drag" onClick={() => setSidebarOpen(false)} aria-label="Hide sidebar" title="Hide sidebar (⌘\\)"><Icon name="sidebar"/></button></div>
      <div className="sidebar-brand"><strong>Agent Desktop</strong><button className="icon-button small" aria-label="Search conversations" title="Search conversations (⌘ K)" aria-expanded={searchOpen} onClick={() => { setSearchOpen(value => !value); requestAnimationFrame(() => searchInput.current?.focus()); }}><Icon name="search"/></button></div>
      <nav className="sidebar-actions" aria-label="Main navigation">
        <button className="nav-action" onClick={() => newConversation()}><Icon name="compose"/><span>New chat</span><kbd>⌘ N</kbd></button>
        <button aria-label="Plugins" className={`nav-action ${pluginDirectoryOpen?"selected":""}`} aria-current={pluginDirectoryOpen?"page":undefined} onClick={()=>{settingsOriginLabel.current=null;setPluginDirectoryOpen(true);setSettingsOpen(false);}}><Icon name="folder"/><span>Plugins</span></button>
        {(searchOpen || query) && <label className="sidebar-search"><Icon name="search"/><input ref={searchInput} type="search" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setQuery(""); setSearchOpen(false); } }} placeholder="Search conversations" aria-label="Search conversations"/></label>}
      </nav>
      <div className="sidebar-scroll"><OrganizedSidebar preferences={preferences} groups={hostGroups} activeHostId={hostId} selectedId={selectedId} query={query} showArchived={showArchived} expandedProjects={expandedProjects} onToggleProject={key => setExpandedProjects(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; })} onNavigate={navigate} onNew={newConversation} onAddProject={addProject} addingProject={addingProject} connected={connected} onToggleArchived={() => setShowArchived(value => !value)}/></div>
      <footer className="sidebar-footer"><span className={`connection-dot ${connected ? "online" : ""}`}/><div className="host-label"><label className="sr-only" htmlFor="active-host">Active machine</label><select id="active-host" value={state?.host.id ?? route.hostId ?? ""} onChange={event => navigate(null, event.target.value, true)}>{route.hostId && !desktop.hosts.some(host => host.hostId === route.hostId) && <option value={route.hostId}>Saved machine · {loading ? "Connecting" : "Unavailable"}</option>}{!desktop.hosts.length && !route.hostId && <option value="">Connecting to host…</option>}{desktop.hosts.map(host => <option key={host.key} value={host.hostId ?? host.key} disabled={!host.hostId}>{host.name}{host.local ? " · This machine" : ""}{host.availability !== "available" ? ` · ${host.availability}` : ""}</option>)}</select><span>{connected ? hostId === desktop.localHostId ? "Connected · This machine" : "Connected · Tailscale" : loading ? "Connecting…" : state ? "Offline · cached view" : "Host unavailable"}</span></div><div className="menu-anchor"><button className="icon-button" aria-label="App menu" title="App menu" aria-expanded={appMenuOpen} onClick={() => setAppMenuOpen(value => !value)}><Icon name="more"/></button>{appMenuOpen && <><button className="menu-dismiss" onClick={() => setAppMenuOpen(false)} tabIndex={-1} aria-label="Close app menu"/><div className="action-menu footer-menu"><button onClick={() => { openSettings(); setAppMenuOpen(false); }}>Settings</button><button onClick={() => { setDialog("status"); setAppMenuOpen(false); }}>Build status</button></div></>}</div></footer>
    </aside>}
    <div ref={workbenchElement} className={`workbench ${workspaceOpen && dockViewport.width < 672 ? "dock-narrow" : ""}`} style={{
      "--right-dock-size": !settingsOpen && workspaceOpen && dockViewport.width >= 672 ? `${Math.max(320,Math.min(dockViewport.width - 352,dock.snapshot.state.rightWidthRatio*dockViewport.width))}px` : "0px",
      "--bottom-dock-size": !settingsOpen && terminalOpen ? `${Math.min(dockViewport.height/2,Math.max(160,dock.snapshot.state.bottomHeight))}px` : "0px",
    } as React.CSSProperties}>
    <main className="main-panel">
      {appliedTheme.background.kind === "asset" && themeImage.sha256 === imageHash && themeImage.dataUrl && <div className="theme-image-background" aria-hidden="true" style={{ backgroundImage: `url("${themeImage.dataUrl}")`, backgroundSize: appliedTheme.background.fit === "tile" ? "auto" : appliedTheme.background.fit, backgroundRepeat: appliedTheme.background.fit === "tile" ? "repeat" : "no-repeat", opacity: appliedTheme.background.opacity, filter: `blur(${appliedTheme.background.blur}px)` }}/> }
      {windowWarning && <div className="connection-banner" role="status"><span>{windowWarning}</span></div>}
      {settingsOpen ? <>{settingsPage === "general" ? <GeneralSettings preferences={preferences} bridge={bridge} onClose={() => setSettingsOpen(false)}/> : settingsPage === "environments" ? state?.localEnvironments?.configuration ? <LocalEnvironmentSettings key={hostId} bridge={bridge} hostId={hostId} hostName={state.host.name} localHostId={desktop.localHostId} connected={connected} projects={state.projects} initialProjectId={environmentProject?.hostId === hostId ? environmentProject.projectId : project?.id} onSelectProject={projectId => setEnvironmentProject({hostId,projectId})} onAddProject={() => void addProject(true)} onClose={() => setSettingsOpen(false)}/> : <section className="settings-page"><header className="settings-header"><h1>Environments</h1></header><p className="settings-unavailable" role="status">{loading ? "Connecting to the owning host…" : "This host does not support environment configuration. Update its host service to edit environments here."}</p></section> : settingsPage === "plugins" || settingsPage === "mcp" ? <NativeIntegrations onOpenSkillFile={openSkillFile} onTrySkill={trySkill} key={`${hostId}:${JSON.stringify(workspaceTarget)}`} bridge={bridge} hostId={hostId} hostName={state?.host.name ?? "Unavailable host"} connected={connected} target={workspaceTarget} sessionIdle={Boolean(selected && selected.status === "idle" && !selected.archived)} page={settingsPage} onPageChange={page=>{setIntegrationSelection(undefined);setSettingsPage(page);}} onBrowse={tab=>{settingsOriginLabel.current=null;setPluginDirectoryTab(tab??"plugins");setIntegrationSelection(undefined);setPluginDirectoryOpen(true);setSettingsOpen(false);}} initialPluginId={integrationSelection?.hostId===hostId?integrationSelection.pluginId:undefined} initialMarketplace={integrationSelection?.hostId===hostId?integrationSelection.marketplace:undefined} onClose={() => setSettingsOpen(false)}/> : settingsPage === "appearance" ? <ThemeSettings data={theme} preferences={preferences} fonts={localFonts} fontsError={fontsError} effectsError={themeEffectsError} image={themeImage} onImportImage={() => bridge.importThemeBackground()} onOpenFile={() => bridge.openThemeFile()} onRefreshFonts={refreshFonts} onClose={() => setSettingsOpen(false)}/> : settingsPage === "omp" ? <NativeSettings key={hostId} bridge={bridge} hostId={hostId} hostName={state?.host.name ?? "Unavailable host"} localHostId={desktop.localHostId} connected={connected} session={selected} target={workspaceTarget} onClose={() => setSettingsOpen(false)}/> : settingsPage === "git" ? <GitSettings preferences={preferences} onClose={() => setSettingsOpen(false)}/> : <AccountsSettings key={hostId} bridge={bridge} hostId={hostId} hostName={state?.host.name ?? "Unavailable host"} localHostId={desktop.localHostId} connected={connected} session={selected} onClose={() => setSettingsOpen(false)} onChanged={() => void refresh()}/>}</> : pluginDirectoryOpen ? <NativePluginBrowser onOpenSkillFile={openSkillFile} onTrySkill={trySkill} restoreFocusLabel={settingsOriginLabel.current??undefined} initialTab={pluginDirectoryTab} onTabChange={setPluginDirectoryTab} key={`${hostId}:${JSON.stringify(workspaceTarget)}`} bridge={bridge} hostId={hostId} hostName={state?.host.name??"Unavailable host"} target={workspaceTarget} connected={connected} onClose={()=>{setPluginDirectoryOpen(false);requestAnimationFrame(()=>document.querySelector<HTMLElement>('.nav-action[aria-label="Plugins"]')?.focus());}} onManage={pluginId=>{setIntegrationSelection({hostId,pluginId});setSettingsPage("plugins");openSettings();}} onMarketplace={name=>{setIntegrationSelection({hostId,marketplace:{name,add:name===undefined}});setSettingsPage("plugins");openSettings();}}/> : <>
      <header className="main-header drag-region">
        {!sidebarOpen && <button className="icon-button no-drag" onClick={() => setSidebarOpen(true)} aria-label="Show sidebar"><Icon name="sidebar"/></button>}
        <div className="header-breadcrumb" title={project?.path}>{selected && <Icon name="folder"/>}<strong className="truncate">{selected?.title ?? (selectedId ? loading ? "Loading conversation…" : "Conversation unavailable" : "New chat")}</strong>{selected && <div className="no-drag"><div className="menu-anchor"><button className="icon-button" onClick={() => setMenuOpen(value => !value)} aria-label="Conversation actions" aria-expanded={menuOpen} title="Conversation actions"><Icon name="more"/></button>{menuOpen && <><button className="menu-dismiss" onClick={() => setMenuOpen(false)} tabIndex={-1} aria-label="Close conversation actions"/><div className="action-menu"><button disabled={!connected} onClick={() => { setRenameTitle(selected.title); setDialog("rename"); setMenuOpen(false); }}>Rename</button><button disabled={!connected} onClick={archive}>{selected.archived ? "Unarchive" : "Archive"}</button><button onClick={() => { dock.open("side-chat"); setMenuOpen(false); }}>Side chat</button><button onClick={() => { transcript.refresh(); setMenuOpen(false); }}>Refresh transcript</button></div></>}</div></div>}</div>
        <div className="header-panel-actions no-drag">
          {workspace && <button className={`icon-button ${environmentOpen ? "active" : ""}`} aria-label="Environment" title="Environment" aria-expanded={environmentOpen} onClick={() => setEnvironmentOpen(value => !value)}><Icon name="sliders"/></button>}
          {selected && (selected.archived || selected.status !== "idle") && <span className={`status-label ${selected.status}`}>{selected.archived ? "Archived" : selected.status}</span>}
          {workspaceTarget && <button className={`icon-button ${terminalOpen ? "active" : ""}`} aria-label={terminalOpen ? "Hide terminal panel" : "Show terminal panel"} title={terminalOpen ? "Hide terminal panel" : "Show terminal panel"} aria-expanded={terminalOpen} onClick={() => dock.toggle("bottom")}><Icon name="terminal"/></button>}
          {workspace && <button className={`icon-button ${workspaceOpen ? "active" : ""}`} aria-label={workspaceOpen ? "Hide side panel" : "Show side panel"} title={workspaceOpen ? "Hide side panel" : "Show side panel"} aria-expanded={workspaceOpen} onClick={() => dock.toggle("right")}><Icon name="folder"/></button>}
        </div>
      </header>
      {imageHash && themeImage.sha256 === imageHash && (themeImage.status === "loading" || themeImage.error) && <div className="connection-banner theme-image-status" role="status"><span>{themeImage.error ?? "Loading this device’s background image…"}</span>{themeImage.error && <button onClick={() => void themeImage.refresh()}><Icon name="refresh"/>Retry image</button>}</div>}
      {(desktop.error || desktop.cacheWarning || drafts.cacheWarning || submissions.cacheWarning) && <div className="connection-banner" role="status"><span>{desktop.error ?? desktop.cacheWarning ?? drafts.cacheWarning ?? submissions.cacheWarning}</span><button onClick={() => void refresh()}><Icon name="refresh"/>Reconnect</button></div>}
      {loading && !state ? <div className="center-state"><span className="spinner"/><h1>Connecting to your host</h1><p>Loading projects, models, and saved conversations.</p></div> : missingSession ? <div className="center-state"><h1>Conversation unavailable</h1><p>{connected ? "This conversation is not in the owning host’s catalog." : "This conversation is not in this device’s cached catalog. Its owning host is unavailable; the selected conversation is preserved."}</p><button className="secondary-button" onClick={() => navigate(null)}>New conversation</button></div> : <>
        {selectedId ? <div className="transcript-region"><div ref={transcriptReading.viewportRef} className="transcript-scroll" tabIndex={0} aria-label="Conversation transcript">
          <div className="transcript">
            {transcript.error && <div className="inline-error" role="alert"><span>{transcript.error}</span><button onClick={transcript.refresh}>Retry</button></div>}
            {transcript.cacheWarning && <p className="subtle-notice">{transcript.cacheWarning}</p>}
            {selected?.error && <div className="inline-error" role="alert">{selected.error}</div>}
            {!transcript.messages.length && <div className="empty-transcript"><Icon name="compose"/><h2>{transcript.loading ? "Loading conversation…" : !selected ? "Conversation unavailable" : "Start the conversation"}</h2><p>{connected ? "Send a prompt to begin working in this session." : "No transcript is cached on this device."}</p></div>}
            <TranscriptMessages messages={transcript.messages} contextKey={`${hostId}:${selectedId}`} connected={connected} linkActions={transcriptLinkActions} images={{ media: attachmentMedia, hostId, sessionId: selectedId }}/>
            {running && <div className="working-state" role="status"><span className="working-dot"/>Working…</div>}
          </div>
        </div>{!transcriptReading.following && <button className="transcript-latest" onClick={transcriptReading.latest} aria-label="Return to latest message"><Icon name="arrow"/><span>Return to latest</span></button>}</div> : <Welcome project={project} workspace={workspace} onSelectProject={anchor => composerContext.current?.openProjects(anchor)}/>}
        <div className={`composer-region ${selectedId ? "" : "home-composer"}`}>
          {selected && !selected.archived && <PendingMcpAuthorization key={`${hostId}:${selected.id}`} bridge={bridge} hostId={hostId} sessionId={selected.id} connected={connected}/>}
          {selected && <PendingDetachedQuestions bridge={bridge} hostId={hostId} sessionId={selected.id} localHostId={desktop.localHostId} connected={connected} archived={selected.archived} drafts={drafts} submissions={submissions}/>}
          {(selectedId || pendingSessionId) && state && <>
            {!selectedId && <p className="subtle-notice">Requests for {knownPendingSession?.title ?? "the session being started"} on {state.host.name}.</p>}
            <PendingInteractions bridge={bridge} hostId={hostId} sessionId={(selectedId ?? pendingSessionId)!} localHostId={desktop.localHostId} connected={connected}/>
          </>}
          {actionError && <div className="inline-error" role="alert"><span>{actionError}</span><button className="icon-button small" onClick={() => setActionError(null)} aria-label="Dismiss error"><Icon name="close"/></button></div>}
          {modeView?.conflict && !sameModeConflict(modeView) && draft.projectId && <div className="draft-conflict" role="alert"><strong>Work in changed on another device.</strong><p>Your prompt and other selections are preserved. Choose which execution mode to use for this project.</p><dl><dt>My choice</dt><dd>{executionModeLabel(modeView.draft.execution)}</dd><dt>Host’s saved choice</dt><dd>{executionModeLabel(modeView.conflict.execution)}</dd></dl><div><button className="secondary-button" onClick={() => resolveProjectExecutionMode(drafts,draftId,draft.projectId!,"remote")}>Use saved mode</button><button className="primary-button" onClick={() => resolveProjectExecutionMode(drafts,draftId,draft.projectId!,"local")}>Keep my mode</button></div></div>}
          {modeView?.status === "error" && draft.projectId && <div className="inline-error" role="alert"><span>{modeView.error ?? "The Work in choice was not saved to the host."}</span><button disabled={!connected} onClick={() => void drafts.flush(projectExecutionModeDraftId(draft.projectId!)).catch(() => {})}>Retry mode save</button></div>}
          {pendingSubmission && (pendingSubmission.preparation || pendingSubmission.create?.command.type === "session.create" && pendingSubmission.create.command.environment !== undefined) && <EnvironmentPreparationCard key={`${hostId}:${pendingSubmission.preparation?.id ?? pendingSubmission.create?.id}`} bridge={bridge} hostId={hostId} pending={pendingSubmission} submissions={submissions} connected={connected} busy={busy} executionControls={state?.localEnvironments?.execution} onResume={() => void resumeEnvironment()} onSettings={() => { if (pendingSubmission.draft.projectId) setEnvironmentProject({hostId,projectId:pendingSubmission.draft.projectId}); setSettingsPage("environments"); openSettings(); }}/>}
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
          {selected && <GoalStrip key={`${hostId}:${selected.id}`} bridge={bridge} hostId={hostId} sessionId={selected.id} snapshot={activity.value} stale={!connected ? "Offline goal snapshot" : activity.error} running={running} archived={Boolean(selected.archived)} refresh={activity.refresh} onEdit={() => dock.open("goal")}/>}
          {!selectedId && <ComposerContext ref={composerContext} hostId={hostId} hostName={state?.host.name ?? hostId} hosts={desktop.hosts} projects={state?.projects ?? []} projectId={draft.projectId} connected={connected} addingProject={addingProject} workspace={workspace}
            environment={draft.environment} environmentAvailable={environmentAvailable} environments={environmentCatalog ? {items:environmentCatalog.items,loading:environmentCatalog.loading,error:environmentCatalog.error ?? environmentCatalog.cacheWarning,refresh:() => { void environmentCatalog.refresh(); }} : undefined}
            onEnvironment={environment => drafts.update(draftId,{environment})} onOpenEnvironmentSettings={() => { if (draft.projectId) setEnvironmentProject({hostId,projectId:draft.projectId}); setSettingsPage("environments"); openSettings(); }}
            execution={draft.execution} worktreesAvailable={worktreesAvailable} onExecution={(execution: NewChatExecution) => drafts.update(draftId,{execution})}
            onExecutionMode={(execution: NewChatExecution) => {
              if (worktreesAvailable && draft.projectId) selectProjectExecutionMode(drafts,draftId,draft.projectId,execution);
              else if (execution.type === "local" && draft.execution?.type === "worktree") drafts.update(draftId,{execution});
            }}
            branchPrefix={preferences.get("git.branchPrefix") ?? "codex/"} onOpenGitSettings={() => { setSettingsPage("git"); openSettings(); }}
            onProject={projectId => { if (worktreesAvailable) selectProjectWithExecutionMode(drafts,draftId,projectId); else drafts.update(draftId,{projectId,...(projectId === null && draft.execution?.type === "worktree" ? {execution:{type:"local" as const}} : {})}); }} onHost={owner => navigate(null,owner)} onAddProject={() => void addProject()}
            onCheckout={async (branch,create) => { if (!workspace?.status || !connected) return; await workspace.mutate({type:"git.checkout",branch,expectedRevision:workspace.status.revision,...(create ? {create:true} : {})}); }}/>}
          <form className={`composer ${selected?.archived ? "archived-composer" : ""}`} onSubmit={event => { event.preventDefault(); void submit(); }} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); if (!selected?.archived) void imageComposer.add([...event.dataTransfer.files], state?.imageAttachments); }} onPaste={event => { if (!event.clipboardData.files.length) return; event.preventDefault(); if (!selected?.archived) void imageComposer.add([...event.clipboardData.files], state?.imageAttachments); }}>
            {wholeFileIssue && <p className="attachment-notice" role="status">{wholeFileIssue}</p>}
            <ComposerSelectedText attachments={draft.selectedTextAttachments} disabled={Boolean(selected?.archived)} onRemove={ids => { const remove = new Set(ids); drafts.update(draftId, { selectedTextAttachments: (drafts.get(draftId).draft.selectedTextAttachments ?? []).filter(item => !remove.has(item.id)) }); }} onFocusComposer={() => textarea.current?.focus()}/>
            {selectedTextIssue && <p className="attachment-notice" role="status">{selectedTextIssue}</p>}
            <ComposerImages controller={imageComposer} attachments={draft.attachments} media={attachmentMedia} hostId={hostId} connected={connected} capabilities={state?.imageAttachments} disabled={Boolean(selected?.archived)}/>
            {imageIssue && <p className="attachment-notice" role="status">{imageIssue}</p>}
            {imagesStaging && <p className="attachment-notice" role="status">Finish adding or remove the pending images before sending.</p>}
            <label className="sr-only" htmlFor="prompt">Message</label>
            <span id="prompt-keyboard-hint" className="sr-only">{`${sendBehavior === "mod-enter" ? "Command Enter" : "Enter"} to ${running ? "steer" : "send"}. Shift Enter for a new line.`}</span>
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
              placeholder={selected?.archived ? "Unarchive this conversation to continue" : running ? "Add instructions while the agent works…" : "Ask anything, or describe a task"} disabled={Boolean(selected?.archived)}
              onKeyDown={event => { if (autocomplete.onKeyDown(event)) return; if (event.key === "Enter" && !event.shiftKey && (sendBehavior === "enter" || event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && !autocomplete.composing.current && event.keyCode !== 229) { event.preventDefault(); void submit(); } }}/>
            {autocomplete.popup}
            <div className="composer-toolbar">
              <div className="composer-selections">
                <ComposerSelections data={composer} draft={draft} session={selected} disabled={Boolean(selected?.archived) || running} onChange={patch => drafts.update(draftId, patch)}/>
              </div>
              <div className="composer-send-actions">{running && <button className="stop-button" type="button" disabled={!connected} onClick={interrupt} aria-label="Stop response" title="Stop response"><Icon name="stop"/></button>}<button className="send-button" type="submit" disabled={!canSend} aria-label={pendingSubmission?.uncertain ? "Retry pending submission" : running ? "Steer agent" : "Send message"} title={connected ? pendingSubmission?.uncertain ? "Retry pending submission" : running ? "Steer agent" : "Send (Enter)" : "Reconnect to send"}>{busy ? <span className="spinner"/> : <Icon name="arrow"/>}</button></div>
            </div>
          </form>
          <div className="composer-footnote" aria-live="polite">{view.status === "saving" ? "Saving…" : view.status === "offline" ? "Draft saved on this device" : view.status === "conflict" ? "Draft conflict" : view.status === "unsaved" ? "Unsaved changes" : view.status === "error" ? "Draft not saved to host" : null}</div>
        </div>
      </>}
      </>}

    </main>
      {environmentOpen && workspace && !settingsOpen && !pluginDirectoryOpen && <div className="environment-overlay"><EnvironmentCard sideChats={dock.snapshot.tabs.filter(tab => tab.kind === "side-chat" && tab.hostId === hostId && tab.target === `session:${selectedId}`).map(tab => ({ id:tab.id,title:tab.title,unread:Boolean(tab.unread),onOpen:() => dock.open("side-chat") }))} actions={state?.localEnvironments?.actions ? <EnvironmentActions workspace={workspace} connected={connected} onTerminal={(terminal,title) => dock.bindTerminal(terminal.id,hostId,workspace.target,"bottom",title)} onSettings={() => { if(project?.id) setEnvironmentProject({hostId,projectId:project.id}); setSettingsPage("environments"); openSettings(); }}/> : undefined} key={workspaceOwner} hostName={state?.host.name ?? hostId} cwd={selected?.cwd ?? project?.path ?? ""} local={hostId === desktop.localHostId} connected={connected} workspace={workspace} activity={activity?.value} activityError={!connected ? "Reconnect to refresh native activity." : activity?.error} sources={selected ? transcriptSources(transcript.messages,selected.id).map(source => ({id:source.id,label:source.label,kind:source.kind,onOpen:() => {if(source.kind === "image") setSourcePreview({hostId,source});else {try {const link = resolveTranscriptLink(encodeURIComponent(source.path).replaceAll("%2F","/"),selected.cwd); if(link.kind !== "file") throw new Error(link.kind === "unavailable" ? link.reason : "This source is not a workspace file."); void transcriptLinkActions.openFile?.(link.file);} catch(cause){setActionError(errorMessage(cause));}}}})) : []} onReview={() => dock.open("review")} onCommit={() => { dock.open("review"); setCommitRequest({owner:workspaceOwner!,id:crypto.randomUUID()}); }} onFiles={() => dock.open("files")} onTerminal={() => void dock.terminal()} onHost={() => { setSidebarOpen(true);requestAnimationFrame(() => document.getElementById("active-host")?.focus()); }} onClose={() => setEnvironmentOpen(false)}/></div>}
    {(["right", "bottom"] as const).map(destination => <div className={`dock-slot dock-slot-${destination}`} key={destination} style={{display:!settingsOpen && !pluginDirectoryOpen && dock.snapshot.state[destination].open ? undefined : "none"}} inert={settingsOpen || pluginDirectoryOpen || !dock.snapshot.state[destination].open || undefined}>
      <DockPanel onPinTab={dock.pinFile} onBeforeClose={fileClose.onBeforeClose} destination={destination} state={dock.snapshot.state} tabs={dock.snapshot.tabs} viewport={dockViewport} onChange={dock.change} onTabDrop={(id,_from,to,index) => dock.change(moveDockTab(dock.snapshot.state,id,to,index))} addActions={dockActions} renderTab={(tab, active) => renderDockTab(tab, active && !settingsOpen && !pluginDirectoryOpen && dock.snapshot.state[destination].open)}/>
      {!dock.snapshot.state[destination].tabIds.length && <div className="dock-empty-actions">{dockActions.map(action => <button key={action.id} onClick={() => action.onSelect(destination)}><Icon name={(action.id === "browser" || action.id === "existing-browser") ? "globe" : action.id === "side-chat" ? "sideChat" : action.id === "terminal" ? "terminal" : "folder"}/>{action.label}</button>)}</div>}
    </div>)}
    </div>
    {fileClose.dialog}
    {sourcePreview && <ImagePreview key={`${sourcePreview.hostId}:${sourcePreview.source.id}`} dialogOnly media={attachmentMedia} source={sourcePreview.source.image} hostId={sourcePreview.hostId} connected={Boolean(desktop.catalog.records.get(sourcePreview.hostId)?.connected)} label={sourcePreview.source.label} onClose={() => setSourcePreview(undefined)}/>}
    <dialog ref={dialogRef} className="app-dialog" onCancel={() => setDialog(null)} onClick={event => { if (event.target === event.currentTarget) setDialog(null); }}>
      <div className="dialog-header"><h2>{dialog === "rename" ? "Rename conversation" : dialog === "project" ? "Add remote project" : "Build status"}</h2><button className="icon-button" onClick={() => setDialog(null)} aria-label="Close dialog"><Icon name="close"/></button></div>
      {dialog === "project" ? <form onSubmit={addRemoteProject}><p className="subtle-notice">Enter an existing absolute folder path on {state?.host.name}. The project and its sessions stay on that machine.</p>{actionError && <p className="inline-error" role="alert">{actionError}</p>}<label className="field-label" htmlFor="remote-project-path">Folder path</label><input id="remote-project-path" className="text-field" value={remotePath} onChange={event => setRemotePath(event.target.value)} placeholder="/home/you/projects/example" autoFocus/><div className="dialog-footer"><button className="secondary-button" type="button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" type="submit" disabled={!remotePath.trim() || !connected || addingProject}>{addingProject ? "Adding…" : "Add project"}</button></div></form> : dialog === "rename" ? <form onSubmit={rename}>{actionError && <p className="inline-error" role="alert">{actionError}</p>}<label className="field-label" htmlFor="conversation-title">Name</label><input id="conversation-title" className="text-field" value={renameTitle} onChange={event => setRenameTitle(event.target.value)} autoFocus/><div className="dialog-footer"><button className="secondary-button" type="button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" type="submit" disabled={!renameTitle.trim() || !connected}>Save</button></div></form> : <div className="build-status"><p>This connected desktop flow includes host selection and an aggregate project sidebar: projects, revisioned drafts, sessions, model selection, streaming, steering, stopping, rename, and archive.</p><p>Accounts, native OMP settings and pending requests, file/editor/Git/worktree panels, and terminal sessions use the owning host’s APIs. Shared sidebar organization and the theme file are connected. Attachments, richer review, browser panels, plugins, automations, remain incomplete.</p><p>The layout uses the pinned package and measured colors from the supplied screenshot. Full visual parity and physical cross-device acceptance remain pending.</p><p>{desktop.networkError ?? desktop.network?.error ?? (desktop.network?.status === "connected" ? "Tailscale discovery is connected." : "Tailscale discovery is not connected.")}</p><button className="secondary-button" onClick={() => void desktop.refreshNetwork()}>Refresh machines</button><div className="build-host">{state?.host.name ?? "Host unavailable"} · {state?.host.platform ?? "Unknown platform"}</div></div>}
    </dialog>
  </div>{closeStatus}</>;
}
