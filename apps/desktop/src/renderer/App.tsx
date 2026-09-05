import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Draft, Project, SessionSummary } from "../../../../packages/shared/src/protocol";
import { readWindowRestoration, useWindowViewPersistence } from "./window-view-state";
import type { WindowNavigation, WorkspaceTab } from "../window-state";
import { DraftController } from "./drafts";
import { SubmissionController } from "./submissions";
import { ComposerCatalogState, composerSelection, composerTargetKey } from "./composer-catalog";
import { ComposerSelections } from "./ComposerSelections";
import { errorMessage, useDesktop, useTranscript } from "./desktop-state";
import { Icon } from "./Icons";
import { TranscriptMessages } from "./Transcript";
import { useTranscriptScroll } from "./use-transcript-scroll";
import "./transcript-scroll.css";
import { AccountsSettings } from "./AccountsSettings";
import { PendingInteractions } from "./PendingInteractions";
import { WorkspacePanel } from "./WorkspacePanel";
import type { TranscriptLinkActions, WorkspaceFileRequest } from "./transcript-links";
import { WorkspaceState, workspaceKey } from "./workspace-state";
import { offlineCache } from "./offline-cache";
import { PreferencesState } from "./preferences-state";
import { OrganizedSidebar } from "./OrganizedSidebar";
import { NativeSettings } from "./NativeSettings";
import { ThemeSettings } from "./ThemeSettings";
import { ThemeEditor } from "./theme-state";
import { ThemeImageState } from "./theme-image-state";
import { applyTheme } from "./theme-application";
import { cssColorToRgba } from "./css-color";
import { TerminalPanel } from "./TerminalPanel";
import { DEFAULT_THEME } from "../../../../packages/shared/src/theme";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace-protocol";

export function App() {
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
  const [settingsOpen, setSettingsOpen] = useState(windowRestoration.state.settingsOpen);
  const [settingsPage, setSettingsPage] = useState<"accounts" | "omp" | "appearance">(windowRestoration.state.settingsPage);
  const [workspaceOpen, setWorkspaceOpen] = useState(windowRestoration.state.workspaceOpen);
  const [workspaceFileRequest, setWorkspaceFileRequest] = useState<{ owner: string; request: WorkspaceFileRequest }>();
  const [terminalOpen, setTerminalOpen] = useState(windowRestoration.state.terminalOpen);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(windowRestoration.state.workspaceTab);
  const windowWarning = useWindowViewPersistence({ route, sidebarOpen, workspaceOpen, workspaceTab, terminalOpen, showArchived,
    expandedProjects: [...expandedProjects], settingsOpen, settingsPage }, windowRestoration);
  const expandAfterNavigation = useRef<string | undefined>(undefined);
  const workspaces = useMemo(() => new Map<string, WorkspaceState>(), [bridge]);
  const textarea = useRef<HTMLTextAreaElement>(null);
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
  const stores = useMemo(() => new Map<string, { drafts: DraftController; submissions: SubmissionController; state?: typeof state; connected?: boolean }>(), [bridge]);
  function controllers(owner: string) {
    let pair = stores.get(owner);
    if (!pair) {
      const cache = { read: (key: string) => localStorage.getItem(key), write: (key: string, value: string) => localStorage.setItem(key, value) };
      pair = { drafts: new DraftController(envelope => bridge.command(envelope, owner), owner, cache), submissions: new SubmissionController(envelope => bridge.command(envelope, owner), owner, cache) };
      const record = desktop.catalog.records.get(owner);
      for (const draft of record?.state?.drafts ?? []) pair.drafts.ingest(draft);
      pair.drafts.setConnected(record?.connected ?? false); pair.state = record?.state; pair.connected = record?.connected ?? false;
      stores.set(owner, pair);
    }
    return pair;
  }
  const { drafts, submissions } = controllers(hostId);
  useEffect(() => drafts.subscribe(redraw), [drafts]);
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
  const workspaceTarget: WorkspaceTarget | undefined = selected ? { sessionId: selected.id } : project ? { projectId: project.id } : undefined;
  const composerTarget = composerTargetKey(workspaceTarget);
  const composer = useMemo(() => new ComposerCatalogState(bridge, hostId, workspaceTarget), [bridge, hostId, composerTarget]);
  useEffect(() => {
    const unsubscribe = composer.subscribe(redraw); composer.start(desktop.localHostId); composer.setConnected(connected);
    return () => { unsubscribe(); composer.stop(); };
  }, [composer, connected, desktop.localHostId]);
  const selection = composerSelection(draft, composer.catalog, selected, composer.controls);
  let workspace: WorkspaceState | undefined;
  if (workspaceTarget) {
    const key = `${hostId}:${workspaceKey(workspaceTarget)}`;
    workspace = workspaces.get(key);
    if (!workspace) { workspace = new WorkspaceState(bridge, hostId, workspaceTarget, offlineCache, desktop.localHostId); workspaces.set(key, workspace); }
  }
  const workspaceOwner = workspaceTarget ? `${hostId}:${workspaceKey(workspaceTarget)}` : undefined;
  const transcriptLinkActions: TranscriptLinkActions = {
    cwd: selected?.cwd,
    openExternal: url => bridge.openExternal(url),
    openFile: file => {
      if (!workspace || !workspaceOwner) throw new Error("This session has no owning workspace.");
      if (!connected) throw new Error("The owning host is disconnected. Reconnect before opening a file link.");
      setWorkspaceFileRequest({ owner: workspaceOwner, request: { ...file, id: crypto.randomUUID() } });
      setWorkspaceOpen(true);
    },
  };
  const transcript = useTranscript(bridge, selectedId, hostId === "unconnected" ? undefined : hostId, connected, desktop.localHostId);
  const transcriptReading = useTranscriptScroll(selectedId ? `${hostId}:${selectedId}` : undefined);
  const running = selected?.status === "running";
  const pendingSubmission = submissions.get(draftId);
  const pendingSessionId = pendingSubmission?.sessionId;
  const knownPendingSession = state?.sessions.find(session => session.id === pendingSessionId);
  const canSend = connected && Boolean(state) && !busy && !missingSession && Boolean(draft.text.trim() || pendingSubmission?.uncertain) && (view.status !== "conflict" || Boolean(pendingSubmission?.uncertain)) && !selected?.archived;

  const navigate = useCallback((id: string | null, owner = route.hostId ?? state?.host.id ?? desktop.localHostId, keepSettings = false) => {
    setRoute({ sessionId: id, hostId: owner }); setActionError(null); setMenuOpen(false); if (!keepSettings) setSettingsOpen(false); setAppMenuOpen(false);
    expandAfterNavigation.current = id ? `${owner ?? ""}:${id}` : undefined;
    requestAnimationFrame(() => textarea.current?.focus());
  }, [route.hostId, state?.host.id, desktop.localHostId]);
  // Bind legacy/new local routes once identity is known; never replace an
  // explicit unavailable remote owner with the local machine.
  useEffect(() => { if (!route.hostId && desktop.localHostId) setRoute(previous => previous.hostId ? previous : { ...previous, hostId: desktop.localHostId }); }, [route.hostId, desktop.localHostId]);
  const newConversation = useCallback((projectId?: string, owner = route.hostId ?? state?.host.id ?? desktop.localHostId) => {
    navigate(null, owner);
    if (projectId !== undefined && owner) controllers(owner).drafts.update("new-conversation", { projectId });
  }, [navigate, route.hostId, state?.host.id, desktop.localHostId, stores, desktop.catalog]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === ",") { event.preventDefault(); setSettingsOpen(true); setAppMenuOpen(false); }
      if (event.key.toLowerCase() === "n") { event.preventDefault(); newConversation(); }
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setSidebarOpen(true); setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); }
      if (event.key === "\\") { event.preventDefault(); setSidebarOpen(value => !value); }
    }
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [newConversation]);
  useEffect(() => {
    const element = textarea.current;
    if (element) { element.style.height = "0px"; element.style.height = `${Math.min(Math.max(element.scrollHeight, 56), 240)}px`; }
  }, [draft.text, selectedId]);
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
  async function addProject() {
    if (!bridge || !connected) return;
    if (hostId !== desktop.localHostId) { setRemotePath(""); setActionError(null); setDialog("project"); return; }
    setAddingProject(true); setActionError(null);
    try {
      const path = await bridge.chooseDirectory(); if (!path) return;
      const value = await command({ type: "project.add", path });
      if (value && "path" in value) { drafts.update("new-conversation", { projectId: value.id }); navigate(null); await refresh(); }
    } catch (cause) { setActionError(errorMessage(cause)); }
    finally { setAddingProject(false); }
  }
  async function addRemoteProject(event: React.FormEvent) {
    event.preventDefault(); if (!remotePath.trim() || !connected) return;
    setAddingProject(true); setActionError(null);
    try {
      const value = await command({ type: "project.add", path: remotePath.trim() });
      if (value && "path" in value) { drafts.update("new-conversation", { projectId: value.id }); navigate(null); setDialog(null); await refresh(); }
    } catch (cause) { setActionError(errorMessage(cause)); }
    finally { setAddingProject(false); }
  }
  async function submit() {
    if (!canSend || submitting.current) return;
    submitting.current = true;
    setBusy(true); setActionError(null);
    const sendingDraftId = draftId; const originalRoute = selectedRef.current;
    let snapshot: Draft | undefined;
    try {
      const pending = submissions.get(sendingDraftId);
      snapshot = pending?.uncertain ? pending.draft : await drafts.prepareSubmission(sendingDraftId);
      if (!snapshot.text.trim()) return;
      drafts.beginPendingSubmission(snapshot);
      const result = await submissions.submit(snapshot, selectedId ?? undefined, running ? "steer" : "prompt");
      drafts.finishSubmission(sendingDraftId, result.submitted, true);
      await refresh(); transcript.refresh();
      if (selectedRef.current === originalRoute && !drafts.get(sendingDraftId).draft.text) navigate(result.sessionId);
    } catch (cause) {
      if (snapshot) drafts.finishSubmission(sendingDraftId, snapshot, false, submissions.get(sendingDraftId)?.uncertain);
      setActionError(errorMessage(cause));
    } finally { submitting.current = false; setBusy(false); textarea.current?.focus(); }
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
  const hostGroups = desktop.hosts.flatMap(host => { const hostState = host.hostId ? desktop.catalog.records.get(host.hostId)?.state : undefined; return hostState ? [{ host, hostState }] : []; });

  return <div className={`app-shell ${sidebarOpen ? "" : "sidebar-hidden"} ${workspaceOpen && workspace && !settingsOpen ? "with-workspace" : ""}`}>
    <aside className="sidebar" aria-label="Projects and conversations" inert={!sidebarOpen}>
      <div className="sidebar-titlebar drag-region"><button className="icon-button no-drag" onClick={() => setSidebarOpen(false)} aria-label="Hide sidebar" title="Hide sidebar (⌘\\)"><Icon name="sidebar"/></button></div>
      <div className="sidebar-brand"><strong>Agent Desktop</strong><button className="icon-button small" aria-label="Search conversations" title="Search conversations (⌘ K)" aria-expanded={searchOpen} onClick={() => { setSearchOpen(value => !value); requestAnimationFrame(() => searchInput.current?.focus()); }}><Icon name="search"/></button></div>
      <nav className="sidebar-actions" aria-label="Main navigation">
        <button className="nav-action" onClick={() => newConversation()}><Icon name="compose"/><span>New chat</span><kbd>⌘ N</kbd></button>
        {(searchOpen || query) && <label className="sidebar-search"><Icon name="search"/><input ref={searchInput} type="search" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setQuery(""); setSearchOpen(false); } }} placeholder="Search conversations" aria-label="Search conversations"/></label>}
      </nav>
      <div className="sidebar-scroll"><OrganizedSidebar preferences={preferences} groups={hostGroups} activeHostId={hostId} selectedId={selectedId} query={query} showArchived={showArchived} expandedProjects={expandedProjects} onToggleProject={key => setExpandedProjects(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; })} onNavigate={navigate} onNew={newConversation} onAddProject={addProject} addingProject={addingProject} connected={connected} onToggleArchived={() => setShowArchived(value => !value)}/></div>
      <footer className="sidebar-footer"><span className={`connection-dot ${connected ? "online" : ""}`}/><div className="host-label"><label className="sr-only" htmlFor="active-host">Active machine</label><select id="active-host" value={state?.host.id ?? route.hostId ?? ""} onChange={event => navigate(null, event.target.value, true)}>{route.hostId && !desktop.hosts.some(host => host.hostId === route.hostId) && <option value={route.hostId}>Saved machine · {loading ? "Connecting" : "Unavailable"}</option>}{!desktop.hosts.length && !route.hostId && <option value="">Connecting to host…</option>}{desktop.hosts.map(host => <option key={host.key} value={host.hostId ?? host.key} disabled={!host.hostId}>{host.name}{host.local ? " · This machine" : ""}{host.availability !== "available" ? ` · ${host.availability}` : ""}</option>)}</select><span>{connected ? hostId === desktop.localHostId ? "Connected · This machine" : "Connected · Tailscale" : loading ? "Connecting…" : state ? "Offline · cached view" : "Host unavailable"}</span></div><div className="menu-anchor"><button className="icon-button" aria-label="App menu" title="App menu" aria-expanded={appMenuOpen} onClick={() => setAppMenuOpen(value => !value)}><Icon name="more"/></button>{appMenuOpen && <><button className="menu-dismiss" onClick={() => setAppMenuOpen(false)} tabIndex={-1} aria-label="Close app menu"/><div className="action-menu footer-menu"><button onClick={() => { setSettingsOpen(true); setAppMenuOpen(false); }}>Settings</button><button onClick={() => { setDialog("status"); setAppMenuOpen(false); }}>Build status</button></div></>}</div></footer>
    </aside>
    <main className={`main-panel ${terminalOpen ? "with-terminal" : ""}`}>
      {appliedTheme.background.kind === "asset" && themeImage.sha256 === imageHash && themeImage.dataUrl && <div className="theme-image-background" aria-hidden="true" style={{ backgroundImage: `url("${themeImage.dataUrl}")`, backgroundSize: appliedTheme.background.fit === "tile" ? "auto" : appliedTheme.background.fit, backgroundRepeat: appliedTheme.background.fit === "tile" ? "repeat" : "no-repeat", opacity: appliedTheme.background.opacity, filter: `blur(${appliedTheme.background.blur}px)` }}/> }
      {windowWarning && <div className="connection-banner" role="status"><span>{windowWarning}</span></div>}
      {settingsOpen ? <><nav className="settings-navigation" aria-label="Settings pages"><button aria-current={settingsPage === "accounts" ? "page" : undefined} onClick={() => setSettingsPage("accounts")}>Accounts</button><button aria-current={settingsPage === "omp" ? "page" : undefined} onClick={() => setSettingsPage("omp")}>OMP</button><button aria-current={settingsPage === "appearance" ? "page" : undefined} onClick={() => setSettingsPage("appearance")}>Appearance</button></nav>{settingsPage === "appearance" ? <ThemeSettings data={theme} preferences={preferences} fonts={localFonts} fontsError={fontsError} effectsError={themeEffectsError} image={themeImage} onImportImage={() => bridge.importThemeBackground()} onOpenFile={() => bridge.openThemeFile()} onRefreshFonts={refreshFonts} onClose={() => setSettingsOpen(false)}/> : settingsPage === "omp" ? <NativeSettings key={hostId} bridge={bridge} hostId={hostId} hostName={state?.host.name ?? "Unavailable host"} localHostId={desktop.localHostId} connected={connected} session={selected} target={workspaceTarget} onClose={() => setSettingsOpen(false)}/> : <AccountsSettings key={hostId} bridge={bridge} hostId={hostId} hostName={state?.host.name ?? "Unavailable host"} localHostId={desktop.localHostId} connected={connected} session={selected} onClose={() => setSettingsOpen(false)} onChanged={() => void refresh()}/>}</> : <>
      <header className="main-header drag-region">
        {!sidebarOpen && <button className="icon-button no-drag" onClick={() => setSidebarOpen(true)} aria-label="Show sidebar"><Icon name="sidebar"/></button>}
        <div className="header-breadcrumb" title={project?.path}>{selected && <Icon name="folder"/>}<strong className="truncate">{selected?.title ?? (selectedId ? loading ? "Loading conversation…" : "Conversation unavailable" : "New chat")}</strong></div>
        {workspace && <button className={`workspace-toggle no-drag ${workspaceOpen ? "active" : ""}`} aria-label={workspaceOpen ? "Hide files and Git" : "Show files and Git"} aria-expanded={workspaceOpen} onClick={() => setWorkspaceOpen(value => !value)}><Icon name="folder"/><span>Files & Git</span></button>}
        {workspaceTarget && <button className={`workspace-toggle terminal-toggle no-drag ${terminalOpen ? "active" : ""}`} aria-label={terminalOpen ? "Hide terminal panel" : "Show terminal panel"} aria-expanded={terminalOpen} onClick={() => setTerminalOpen(value => !value)}><Icon name="terminal"/><span>Terminal</span></button>}
        {selected && <div className="header-actions no-drag"><span className={`status-label ${selected.status}`}>{selected.archived ? "Archived" : selected.status === "idle" ? "Ready" : selected.status}</span><div className="menu-anchor"><button className="icon-button" onClick={() => setMenuOpen(value => !value)} aria-label="Conversation actions" aria-expanded={menuOpen} title="Conversation actions"><Icon name="more"/></button>{menuOpen && <><button className="menu-dismiss" onClick={() => setMenuOpen(false)} tabIndex={-1} aria-label="Close conversation actions"/><div className="action-menu"><button disabled={!connected} onClick={() => { setRenameTitle(selected.title); setDialog("rename"); setMenuOpen(false); }}>Rename</button><button disabled={!connected} onClick={archive}>{selected.archived ? "Unarchive" : "Archive"}</button><button onClick={() => { transcript.refresh(); setMenuOpen(false); }}>Refresh transcript</button></div></>}</div></div>}
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
            <TranscriptMessages messages={transcript.messages} contextKey={`${hostId}:${selectedId}`} connected={connected} linkActions={transcriptLinkActions}/>
            {running && <div className="working-state" role="status"><span className="working-dot"/>Working…</div>}
          </div>
        </div>{!transcriptReading.following && <button className="transcript-latest" onClick={transcriptReading.latest} aria-label="Return to latest message"><Icon name="arrow"/><span>Return to latest</span></button>}</div> : <div className="welcome"><div className="welcome-mark"><Icon name="terminal"/></div><h1>What would you like to work on?</h1><p>{project ? project.name : "Choose a project or start a conversation."}</p></div>}
        <div className={`composer-region ${selectedId ? "" : "home-composer"}`}>
          {selectedId && state && <PendingInteractions bridge={bridge} hostId={hostId} sessionId={selectedId} localHostId={desktop.localHostId} connected={connected}/>}
          {actionError && <div className="inline-error" role="alert"><span>{actionError}</span><button className="icon-button small" onClick={() => setActionError(null)} aria-label="Dismiss error"><Icon name="close"/></button></div>}
          {pendingSubmission && <div className="subtle-notice">{pendingSubmission.uncertain ? "A submission is awaiting confirmation. Retry checks its original command; newer draft edits stay here." : "A session was created. Sending again continues that session."}{pendingSessionId && <button onClick={() => navigate(pendingSessionId)}>Open {knownPendingSession?.title ?? "session"}</button>}{pendingSubmission.uncertain && <details><summary>View pending prompt</summary><pre>{pendingSubmission.draft.text}</pre></details>}</div>}
          {view.conflict && <div className="draft-conflict" role="alert"><strong>This draft changed on another device.</strong><p>Your text is preserved. Choose which version to continue with.</p><details><summary>View host’s saved draft</summary><pre>{view.conflict.text || "(Empty draft)"}</pre></details><div><button className="secondary-button" onClick={() => drafts.resolve(draftId, "remote")}>Use saved draft</button><button className="primary-button" onClick={() => drafts.resolve(draftId, "local")}>Keep my draft</button></div></div>}
          {view.status === "error" && <div className="inline-error" role="alert"><span>{view.error ?? "Draft could not be saved."}</span><button onClick={() => void drafts.flush(draftId).catch(cause => setActionError(errorMessage(cause)))}>Retry save</button></div>}
          {composer.loading && <p className="subtle-notice" role="status">Loading this workspace’s native models and defaults…</p>}
          {(composer.error || composer.controlsError) && <div className="inline-error" role="alert"><span>{composer.error ?? composer.controlsError}</span><button disabled={!connected} onClick={() => void composer.refresh(true)}>Refresh models</button></div>}
          {composer.catalog?.resolution === "legacy-capabilities" && <p className="subtle-notice" role="status">This older host provides workspace model controls, but does not report model availability or the new-chat default. Existing session selections are preserved. Update the owning host to resolve these details.</p>}
          {!connected && <p className="subtle-notice">Model details are {composer.catalog ? "from this workspace’s last loaded catalog" : "unavailable until this host reconnects"}. Your saved selections are preserved.</p>}
          {selection.differingDraftModel && <p className="subtle-notice">This draft selects {draft.model!.provider}/{draft.model!.id}; the session currently uses {selection.current!.provider}/{selection.current!.id}.<button disabled={Boolean(selected?.archived) || running} onClick={() => drafts.update(draftId, { model: null, thinkingLevel: undefined })}>Follow current session model and reasoning</button></p>}
          <form className={`composer ${selected?.archived ? "archived-composer" : ""}`} onSubmit={event => { event.preventDefault(); void submit(); }}>
            <label className="sr-only" htmlFor="prompt">Message</label>
            <textarea id="prompt" ref={textarea} value={draft.text} onChange={event => drafts.update(draftId, { text: event.target.value })} placeholder={selected?.archived ? "Unarchive this conversation to continue" : running ? "Add instructions while the agent works…" : "Ask anything, or describe a task"} disabled={Boolean(selected?.archived)} spellCheck rows={2} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && (sendBehavior === "enter" || event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}/>
            <div className="composer-toolbar">
              <div className="composer-selections">
                {!selectedId && <label className="select-control project-select" title="Project"><Icon name="folder"/><span className="sr-only">Project</span><select aria-label="Project" value={draft.projectId ?? ""} onChange={event => drafts.update(draftId, { projectId: event.target.value || null })}><option value="">No project</option>{state?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
                <ComposerSelections data={composer} draft={draft} session={selected} disabled={Boolean(selected?.archived) || running} onChange={patch => drafts.update(draftId, patch)}/>
              </div>
              <div className="composer-send-actions">{running && <button className="stop-button" type="button" disabled={!connected} onClick={interrupt} aria-label="Stop response" title="Stop response"><Icon name="stop"/></button>}<button className="send-button" type="submit" disabled={!canSend} aria-label={pendingSubmission?.uncertain ? "Retry pending submission" : running ? "Steer agent" : "Send message"} title={connected ? pendingSubmission?.uncertain ? "Retry pending submission" : running ? "Steer agent" : "Send (Enter)" : "Reconnect to send"}>{busy ? <span className="spinner"/> : <Icon name="arrow"/>}</button></div>
            </div>
          </form>
          <div className="composer-footnote"><span>{`${sendBehavior === "mod-enter" ? "⌘ Enter" : "Enter"} to ${running ? "steer" : "send"} · Shift Enter for a new line`}</span><span aria-live="polite">{view.status === "saving" ? "Saving…" : view.status === "offline" ? "Draft saved on this device" : view.status === "conflict" ? "Draft conflict" : view.status === "unsaved" ? "Unsaved changes" : view.status === "error" ? "Draft not saved to host" : draft.text ? "Draft saved" : ""}</span></div>
        </div>
      </>}
      </>}
      {terminalOpen && workspaceTarget && !settingsOpen && <div className="terminal-dock"><TerminalPanel key={`${hostId}:${workspaceKey(workspaceTarget)}`} target={workspaceTarget} hostId={hostId} connected={connected} onClose={() => setTerminalOpen(false)}/></div>}
    </main>
    {workspaceOpen && workspace && !settingsOpen && <WorkspacePanel key={`${hostId}:${workspaceKey(workspace.target)}`} data={workspace} connected={connected} tab={workspaceTab} onTabChange={setWorkspaceTab} fileRequest={workspaceFileRequest && workspaceFileRequest.owner === workspaceOwner ? workspaceFileRequest.request : undefined} name={project?.name ?? selected?.title ?? "Workspace"} path={selected?.cwd ?? project?.path ?? ""} onClose={() => setWorkspaceOpen(false)} onOpenProject={async path => { const result = await command({ type: "project.add", path }); if (!result || !("path" in result)) throw new Error("The host did not return the project."); await refresh(); newConversation(result.id, hostId); }}/>}
    <dialog ref={dialogRef} className="app-dialog" onCancel={() => setDialog(null)} onClick={event => { if (event.target === event.currentTarget) setDialog(null); }}>
      <div className="dialog-header"><h2>{dialog === "rename" ? "Rename conversation" : dialog === "project" ? "Add remote project" : "Build status"}</h2><button className="icon-button" onClick={() => setDialog(null)} aria-label="Close dialog"><Icon name="close"/></button></div>
      {dialog === "project" ? <form onSubmit={addRemoteProject}><p className="subtle-notice">Enter an existing absolute folder path on {state?.host.name}. The project and its sessions stay on that machine.</p>{actionError && <p className="inline-error" role="alert">{actionError}</p>}<label className="field-label" htmlFor="remote-project-path">Folder path</label><input id="remote-project-path" className="text-field" value={remotePath} onChange={event => setRemotePath(event.target.value)} placeholder="/home/you/projects/example" autoFocus/><div className="dialog-footer"><button className="secondary-button" type="button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" type="submit" disabled={!remotePath.trim() || !connected || addingProject}>{addingProject ? "Adding…" : "Add project"}</button></div></form> : dialog === "rename" ? <form onSubmit={rename}>{actionError && <p className="inline-error" role="alert">{actionError}</p>}<label className="field-label" htmlFor="conversation-title">Name</label><input id="conversation-title" className="text-field" value={renameTitle} onChange={event => setRenameTitle(event.target.value)} autoFocus/><div className="dialog-footer"><button className="secondary-button" type="button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" type="submit" disabled={!renameTitle.trim() || !connected}>Save</button></div></form> : <div className="build-status"><p>This connected desktop flow includes host selection and an aggregate project sidebar: projects, revisioned drafts, sessions, model selection, streaming, steering, stopping, rename, and archive.</p><p>Accounts, native OMP settings and pending requests, file/editor/Git/worktree panels, and terminal sessions use the owning host’s APIs. Shared sidebar organization and the theme file are connected. Attachments, richer review, browser panels, plugins, automations, remain incomplete.</p><p>The layout uses the pinned package and measured colors from the supplied screenshot. Full visual parity and physical cross-device acceptance remain pending.</p><p>{desktop.networkError ?? desktop.network?.error ?? (desktop.network?.status === "connected" ? "Tailscale discovery is connected." : "Tailscale discovery is not connected.")}</p><button className="secondary-button" onClick={() => void desktop.refreshNetwork()}>Refresh machines</button><div className="build-host">{state?.host.name ?? "Host unavailable"} · {state?.host.platform ?? "Unknown platform"}</div></div>}
    </dialog>
  </div>;
}
