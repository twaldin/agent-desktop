import { admitBrowserClose, type BrowserClosePresentations } from "./browser-close-focus";
import type { DockPresentationRef } from "./dock-presentations";
import { admitBrowserSearch, type BrowserSearchPresentations } from "./browser-search-activation";
import type { DraftBrowserPageIntent } from "../draft-browser-page-intent";
import { type CommandBrowserTab } from "./command-browser-tabs";
import { createDraftBrowserDockTab } from "./draft-browser-dock";
import type { TerminalWindowOwner } from "./terminal-window-owner";
import type { TerminalWindowIntent } from "../terminal-window-intent";
import type { TerminalCreationOptions } from "./terminal-creation-controller";
import { resolveContentSide } from "./content-side-placement";
import { parseStandaloneFilePath, type NativeSkillFileRef } from "@agent-desktop/shared";
import { useEffect, useRef, useState } from "react";
import { reconcileDockPresentations, type DockPresentations } from "./dock-presentations";
import type { BrowserReplacementOrigin, BrowserReplacementDestination } from "./browser-workspace-replacement";
import { admitBrowserReplacement, acknowledgeBrowserAdmissions } from "./browser-replacement-admission";
import type {
  BrowserFrameTarget,
  DesktopBridge,
  WorkspaceTarget,
} from "../../../../packages/shared/src/protocol";
import { type WindowViewState, type WorkspaceTab } from "../window-state";
import {
  createDockState,
  showDock,
  hideDock,
  dockTabId,
  insertDockTab,
  isWorkspaceFilePath,
  standaloneFileDockTarget,
  standaloneFilePathFromDock,
  type DockDestination,
  type DockState,
  type DockTab,
  type DockTarget,
} from "./dock-state";
import { openFileTab, selectBrowserFile, pinFileTab, persistentFileTabs, changeFileDock } from "./file-preview-tabs";
import { workspaceKey } from "./workspace-state";
import { BrowserNewTabController, createBrowserNewTab, type BrowserNewTabState } from "./browser-new-tab";
import { stepWorkspaceLayout } from "./workspace-layout-step";
import type { MainChatTarget } from "./main-task-targets";
import { cleanupPreviousBrowserConversation } from "./browser-conversation-cleanup";

/** One explicit acquisition attempt; unknown/cancelled results are not retry authority. */
export type TerminalPreparation =
  | { status: "ready"; tab: DockTab }
  | { status: "busy" }
  | { status: "cancelled"; creationMayHaveRun: boolean; tab?: DockTab }
  | { status: "error"; outcome: "not-submitted" | "unknown"; message: string };

export type DockSnapshot = NonNullable<WindowViewState["dock"]>;
const dockTargetForWorkspace = (target: WorkspaceTarget): DockTarget =>
  "filePath" in target ? standaloneFileDockTarget(target.filePath) : workspaceKey(target) as DockTarget;
export function targetFromDock(target: Exclude<DockTarget, "host">): WorkspaceTarget {
  return target.startsWith("session:")
    ? { sessionId: target.slice(8) }
    : target.startsWith("project:")
      ? { projectId: target.slice(8) }
      : (() => {
          const filePath = standaloneFilePathFromDock(target);
          if (!filePath) throw new Error("The dock file target is invalid.");
          return { filePath };
        })();
}
export function useWorkbenchDock(
  bridge: DesktopBridge,
  initial: WindowViewState,
  hostId: string,
  target: WorkspaceTarget | undefined,
  connected: boolean,
  onError: (message: string) => void,
  canReplacePreview: (tab: DockTab) => boolean = () => false,
  direction: "ltr" | "rtl" = "ltr",
  browserCheckpoint: (tab: DockTab, state: BrowserNewTabState, signal: AbortSignal) => Promise<void> = async () => { throw new Error("Window save acknowledgement is unavailable for browser creation."); },
  browserCleanupProtected: (presentations: DockPresentations, tabId: string) => boolean = () => false,
  terminalOwner?: TerminalWindowOwner,
) {
  const [presentations, updatePresentations] = useState<BrowserClosePresentations>(
    () => reconcileDockPresentations(undefined, initial.dock ? { ...initial.dock, state: { ...initial.dock.state, contentSide: resolveContentSide(initial.dock.state,direction) }, tabs: initial.dock.tabs.map(tab => tab.kind === "files" ? { ...tab, title: "Open file" } : tab) } : { state: createDockState(resolveContentSide(undefined,direction)), tabs: [] }, crypto.randomUUID()),
  );
  const { snapshot } = presentations;
  function setSnapshot(value: DockSnapshot | ((snapshot: DockSnapshot, presentations: DockPresentations) => DockSnapshot)) {
    const seed = crypto.randomUUID();
    updatePresentations(previous => {
      const next = reconcileDockPresentations(previous, typeof value === "function" ? value(previous.snapshot, previous) : value, seed);
      return next === previous ? previous : { ...previous, ...next };
    });
  }
  const [ready, setReady] = useState(
    Boolean(initial.dock) || (!initial.workspaceOpen && !initial.terminalOpen),
  );
  const pending = useRef(new Set<string>());
  useEffect(() => {
    for (const destination of ["right", "bottom"] as const) {
      const region = snapshot.state[destination];
      const tab = region.open ? snapshot.tabs.find(value => value.id === region.activeTabId) : undefined;
      if (tab?.kind === "terminal" && tab.terminalId) {
        try { localStorage.setItem(`terminal.native.selected.${tab.hostId}.${tab.target}`, tab.terminalId); } catch { /* Window state retains the identity. */ }
      }
    }
  }, [snapshot]);
  const outputWebsites = useRef(new Map<string, { tab: DockTab; retained: () => boolean; settle(accepted: boolean): void }>());
  const browserLaunchers = useRef(new Map<string, BrowserNewTabController>());
  const browserLaunchersMounted = useRef(false);
  useEffect(() => {
    browserLaunchersMounted.current = true;
    return () => {
      browserLaunchersMounted.current = false;
      queueMicrotask(() => { if (!browserLaunchersMounted.current) { for (const controller of browserLaunchers.current.values()) controller.dispose(); browserLaunchers.current.clear(); for (const output of outputWebsites.current.values()) output.settle(false); outputWebsites.current.clear(); } });
    };
  }, []);
  useEffect(() => {
    const used = new Set([...snapshot.state.right.tabIds, ...snapshot.state.bottom.tabIds]);
    for (const [id, controller] of browserLaunchers.current) if (!used.has(id)) {
      controller.dispose(); browserLaunchers.current.delete(id);
    }
  }, [snapshot]);
  function browserLauncher(tab: DockTab, online: boolean) {
    let controller = browserLaunchers.current.get(tab.id);
    if (!controller) {
      controller = new BrowserNewTabController(bridge, tab,
        browserNewTab => setSnapshot(previous => ({ ...previous,
          tabs: previous.tabs.map(item => item.id === tab.id && item.browserNewTab ? { ...item, browserNewTab } : item) })),
        (browserTarget, title) => {
          setSnapshot(previous => ({ ...previous, tabs: previous.tabs.map(item => {
            if (item.id !== tab.id || !item.browserNewTab) return item;
            const { browserNewTab: _launcher, ...materialized } = item;
            return { ...materialized, browserTarget, title };
          }) }));
          browserLaunchers.current.delete(tab.id);
        }, browserCheckpoint);
      browserLaunchers.current.set(tab.id, controller);
    }
    controller.connected = online;
    return controller;
  }
  useEffect(() => {
    for (const [id, output] of outputWebsites.current) {
      outputWebsites.current.delete(id);
      const tab = snapshot.tabs.find(tab => tab.id === id && tab.browserInstanceId === output.tab.browserInstanceId && tab.browserNewTab);
      if (!tab || !snapshot.state.right.tabIds.includes(id) || !output.retained()) { output.settle(false); continue; }
      output.settle(true);
      const controller = browserLauncher(tab, true);
      controller.observePresentation();
      void controller.submit(output.retained);
    }
  }, [snapshot]);
  function openOutputWebsite(url: string, owner: string, sessionId: string, admitted: () => boolean, retained: () => boolean, preview?: BrowserNewTabState["preview"]) {
    if (!admitted()) return;
    const tab = createBrowserNewTab(owner, sessionId);
    tab.browserNewTab = { status: "idle", draft: url, ...(preview ? { preview } : {}) };
    const queued = new Promise<boolean>(settle => outputWebsites.current.set(tab.id, { tab, retained, settle }));
    setReady(previous => admitted() ? true : previous);
    // Even a refused addition commits a receipt so a prepared preview can release its lease.
    setSnapshot(previous => admitted() ? { tabs: [...previous.tabs, tab], state: insertDockTab(previous.state, tab, "right") } : { ...previous });
    return { tabId: tab.id, queued };
  }
  const add = (tab: DockTab, destination: DockDestination, guard: () => boolean = () => true) => {
    setReady(previous => guard() ? true : previous);
    setSnapshot((previous) => guard() ? ({
      tabs: previous.tabs.some((value) => value.id === tab.id)
        ? previous.tabs
        : [...previous.tabs, tab],
      state: insertDockTab(previous.state, tab, destination),
    }) : previous);
  };
  function prepareOpen(
    kind: Exclude<DockTab["kind"], "terminal" | "skill-file" | "file" | "mcp-app">,
    owner = hostId,
    workspace = target,
  ): TerminalPreparation {
    if (!workspace) return { status: "error", outcome: "not-submitted", message: "Choose a workspace to open a panel." };
    if ("filePath" in workspace) return { status: "error", outcome: "not-submitted", message: "Standalone files support only file tabs." };
    if ((kind === "browser" || kind === "side-chat") && !("sessionId" in workspace))
      return { status: "error", outcome: "not-submitted", message: `${kind === "browser" ? "Browser tabs" : "Side chat"} require a native session.` };
    if (kind === "browser" && "sessionId" in workspace)
      return { status: "ready", tab: createBrowserNewTab(owner, workspace.sessionId) };
    const descriptor = {
      kind, hostId: owner, target: workspaceKey(workspace) as DockTarget,
      title: kind === "side-chat" ? "Side chat" : kind === "goal" ? "Edit goal" : kind === "review" ? "Review" : kind === "worktrees" ? "Worktrees" : "Open file",
    };
    return { status: "ready", tab: { ...descriptor, id: dockTabId(descriptor) } };
  }
  function open(
    kind: Exclude<DockTab["kind"], "terminal" | "skill-file" | "file" | "mcp-app">,
    destination: DockDestination = "right", owner = hostId, workspace = target,
  ) {
    if (!workspace || (kind === "side-chat" && !("sessionId" in workspace))) return;
    const result = prepareOpen(kind, owner, workspace);
    if (result.status === "error") onError(result.message);
    else if (result.status === "ready") add(result.tab, destination);
  }

  function openDraftBrowser(owner: string, draftId: string, destination: DockDestination, guard: () => boolean) {
    if (!guard()) return;
    add(createDraftBrowserDockTab(owner, draftId), destination, guard);
  }
  function updateDraftBrowserAddress(tabId: string, presentationId: string, browserNewTab: BrowserNewTabState, guard: () => boolean) {
    setSnapshot((previous, presentations) => {
      if (!guard() || presentations.instances.get(tabId) !== presentationId) return previous;
      return { ...previous, tabs: previous.tabs.map(tab => tab.id === tabId && tab.kind === "browser" && tab.target.startsWith("draft:") && tab.browserNewTab && !tab.browserTarget
        ? { ...tab, browserNewTab } : tab) };
    });
  }
  function updateDraftBrowserTitle(tabId: string, presentationId: string, title: string, guard: () => boolean) {
    setSnapshot((previous, presentations) => !guard() || presentations.instances.get(tabId) !== presentationId ? previous
      : { ...previous, tabs: previous.tabs.map(tab => tab.id === tabId && tab.kind === "browser" && tab.target.startsWith("draft:")
        ? { ...tab, title } : tab) });
  }
  function openFile(
    path: string,
    owner: string,
    workspace: WorkspaceTarget,
    destination: DockDestination = "right",
    preview = true,
    guard: () => boolean = () => true,
  ) {
    if ("filePath" in workspace) {
      let absolutePath: string;
      try { absolutePath = parseStandaloneFilePath(workspace.filePath); }
      catch { onError("Use a canonical absolute file path."); return; }
      if (path !== absolutePath.split("/").at(-1)) {
        onError("Standalone file tabs may read only their own basename.");
        return;
      }
    } else if (!isWorkspaceFilePath(path)) { onError("Use a relative file path within this workspace."); return; }
    const descriptor: Omit<DockTab, "id"> = {
      kind: "file",
      hostId: owner,
      target: dockTargetForWorkspace(workspace),
      filePath: path,
      title: path.split("/").at(-1)!.slice(0, 1000),
    };
    if (!guard()) return;
    setReady(previous => guard() ? true : previous);
    setSnapshot(previous => guard() ? openFileTab(previous, { ...descriptor, id: dockTabId(descriptor) }, destination, preview, canReplacePreview) : previous);
  }
  function openHostFile(
    absolutePath: string,
    owner: string,
    destination: DockDestination = "right",
    preview = true,
    guard: () => boolean = () => true,
  ) {
    let path: string;
    try { path = parseStandaloneFilePath(absolutePath); }
    catch { onError("Use a canonical absolute file path."); return; }
    openFile(path.split("/").at(-1)!, owner, { filePath: path }, destination, preview, guard);
  }
  const destinationForTab = (id: string): DockDestination | undefined =>
    snapshot.state.right.tabIds.includes(id) ? "right" : snapshot.state.bottom.tabIds.includes(id) ? "bottom" : undefined;
  const selectFile = (browserId: string, path: string) => setSnapshot(previous => selectBrowserFile(previous, browserId, path));
  const pinFile = (id: string) => setSnapshot(previous => pinFileTab(previous,id));

  function openSkillFile(ref: NativeSkillFileRef, owner: string) {
    const descriptor: Omit<DockTab, "id"> = {kind:"skill-file", hostId:owner,
      target:ref.target ? workspaceKey(ref.target) as DockTarget : "host",
      skillFile:ref, title:ref.sourcePath.split("/").at(-1) || "SKILL.md"};
    add({...descriptor,id:dockTabId(descriptor)}, "right");
  }

  // Native titles/URLs can exceed the durable presentation-label limit.
  const browserTitle = (title: string) => (title === "about:blank" ? "New tab" : title).slice(0, 1000);
  const updateBrowserTitle = (id: string, title: string) =>
    setSnapshot(previous => {
      const bounded = browserTitle(title);
      if (!previous.tabs.some(tab => tab.id === id && tab.title !== bounded)) return previous;
      return { ...previous, tabs: previous.tabs.map(tab => tab.id === id ? { ...tab, title: bounded } : tab) };
    });
  const updateTitle = (id: string, title: string) => setSnapshot(previous => {
    const bounded = title.slice(0, 1000);
    if (!previous.tabs.some(tab => tab.id === id && tab.title !== bounded)) return previous;
    return { ...previous, tabs: previous.tabs.map(tab => tab.id === id ? { ...tab, title: bounded } : tab) };
  });
  const setUnread = (id: string, unread: boolean) => setSnapshot(previous => previous.tabs.some(tab => tab.id === id && Boolean(tab.unread) !== unread) ? { ...previous, tabs: previous.tabs.map(tab => tab.id === id ? { ...tab, unread } : tab) } : previous);
  const setFileMode = (id: string, fileMode: "markdown" | "source") => setSnapshot(previous => ({ ...previous,
    tabs: previous.tabs.map(tab => tab.id === id && (tab.kind === "file" || tab.kind === "skill-file") ? { ...tab, fileMode } : tab) }));
  const setFileScroll = (id: string, mode: "markdown" | "source", top: number) => setSnapshot(previous => {
    if (!Number.isFinite(top) || top < 0 || top > 100_000_000) return previous;
    const tab = previous.tabs.find(tab => tab.id === id && (tab.kind === "file" || tab.kind === "skill-file"));
    if (!tab || tab.fileScroll?.[mode] === top) return previous;
    return { ...previous, tabs: previous.tabs.map(item => item === tab ? { ...item, fileScroll: { ...item.fileScroll, [mode]: top } } : item) };
  });
  const bindBrowser = (
    browserTarget: BrowserFrameTarget,
    title: string,
    owner: string,
    sessionId: string,
    destination: DockDestination,
  ) => {
    const descriptor: Omit<DockTab, "id"> = {
      kind: "browser",
      hostId: owner,
      target: `session:${sessionId}`,
      browserTarget,
      title: browserTitle(title),
    };
    setReady(true);
    setSnapshot(previous => {
      const existing = previous.tabs.find(tab => tab.kind === "browser" && tab.hostId === owner && tab.target === descriptor.target
        && tab.browserTarget?.workerPid === browserTarget.workerPid && tab.browserTarget.name === browserTarget.name && tab.browserTarget.targetId === browserTarget.targetId);
      const tab = existing ?? { ...descriptor, id: dockTabId(descriptor) };
      return { tabs: existing ? previous.tabs : [...previous.tabs, tab], state: insertDockTab(previous.state, tab, destination) };
    });
  };
  async function browser(destination: DockDestination = "right", create = true) {
    if (!target || !("sessionId" in target)) return;
    const sessionId = target.sessionId, owner = hostId;
    if (create) { open("browser", destination, owner, target); return; }
    const key = `browser:${owner}:${sessionId}`;
    if (!connected) { onError("Reconnect to the owning host to inspect native browser tabs."); return; }
    if (pending.current.has(key)) return;
    if (!bridge.getBrowserMetadata) { onError("Update this desktop to inspect native browser tabs."); return; }
    pending.current.add(key);
    try {
      const metadata = await bridge.getBrowserMetadata(sessionId, owner);
      if (!metadata || metadata.hostId !== owner || metadata.sessionId !== sessionId) throw new Error("Native browser metadata belongs to a different session.");
      if (metadata.availability !== "running") throw new Error(metadata.reason);
      const alive = metadata.tabs.filter(tab => tab.state === "alive");
      if (!alive.length) throw new Error("This session has no live native browser tabs.");
      for (const tab of alive) bindBrowser({ workerPid: metadata.workerPid, name: tab.name, targetId: tab.targetId },
        tab.title || tab.url || "Browser", owner, sessionId, destination);
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current.delete(key); }
  }
  const bindTerminal = (
    id: string,
    owner: string,
    workspace: WorkspaceTarget,
    destination: DockDestination,
    title = "Terminal",
  ) => {
    if ("filePath" in workspace) {
      onError("Standalone files cannot host terminals.");
      return;
    }
    const descriptor = {
      kind: "terminal" as const,
      hostId: owner,
      target: workspaceKey(workspace) as DockTarget,
      terminalId: id,
      title,
    };
    add({ ...descriptor, id: dockTabId(descriptor) }, destination);
  };
  function terminalOptions(source: TerminalWindowIntent["source"]): TerminalCreationOptions | undefined {
    return target && !("filePath" in target) ? { hostId, target, source, cols: 120, rows: 30 } : undefined;
  }
  async function prepareTerminal(create = false, signal?: AbortSignal, source: TerminalWindowIntent["source"] = { kind: "dock", destination: "bottom" }, settled?: () => void): Promise<TerminalPreparation> {
    const options = terminalOptions(source);
    if (!options) return { status: "error", outcome: "not-submitted", message: "Choose a workspace to open a terminal." };
    if (!terminalOwner) return { status: "error", outcome: "not-submitted", message: "Window request ownership is unavailable. Terminal creation was not sent." };
    return terminalOwner.prepare(options, signal, create ? "validate" : "reuse", settled);
  }
  function publishTerminal(tab: DockTab, destination: DockDestination, guard: () => boolean) {
    add(tab, destination, guard);
  }
  async function terminal(destination: DockDestination = "bottom", create = false) {
    const source = { kind: "dock" as const, destination }, options = terminalOptions(source);
    if (!options || !terminalOwner) { onError("Window request ownership is unavailable. Choose a workspace before opening a terminal."); return; }
    const guard = terminalOwner.attachmentGuard(options);
    const result = await prepareTerminal(create, undefined, source);
    if (result.status === "error") { onError(result.message); return; }
    if (result.status === "ready") publishTerminal(result.tab, destination, guard);
  }
  useEffect(() => {
    if (ready || !target || hostId === "unconnected") return;
    let next = createDockState(resolveContentSide(undefined,direction));
    const tabs: DockTab[] = [];
    const insert = (
      kind: DockTab["kind"],
      destination: DockDestination,
      terminalId?: string,
    ) => {
      const descriptor = {
        kind,
        hostId,
        target: workspaceKey(target) as DockTarget,
        terminalId,
        title:
          kind === "review"
            ? "Review"
            : kind === "worktrees"
              ? "Worktrees"
              : kind === "files"
                ? "Open file"
                : kind === "browser"
                  ? "Browser"
                  : "Terminal",
      };
      const tab = { ...descriptor, id: dockTabId(descriptor) };
      tabs.push(tab);
      next = insertDockTab(next, tab, destination);
    };
    if (initial.workspaceOpen)
      insert(
        initial.workspaceTab === "changes" ? "review" : initial.workspaceTab,
        "right",
      );
    if (initial.terminalOpen) {
      let id: string | null = null;
      try {
        id = localStorage.getItem(
          `terminal.native.selected.${hostId}.${workspaceKey(target)}`,
        );
      } catch {
        /* Empty dock offers an explicit open action. */
      }
      if (id && /^[a-zA-Z0-9_-]{1,200}$/.test(id))
        insert("terminal", "bottom", id);
      else next.bottom.open = true;
    }
    setSnapshot({ state: next, tabs });
    setReady(true);
  }, [ready, hostId, target && workspaceKey(target)]);
  function change(state: DockState) {
    const used = new Set([...state.right.tabIds, ...state.bottom.tabIds]);
    for (const [id, controller] of browserLaunchers.current) if (!used.has(id)) { controller.dispose(); browserLaunchers.current.delete(id); }
    setReady(true);
    setSnapshot(previous => changeFileDock(previous,state,canReplacePreview));
  }
  function toggle(destination: DockDestination) {
    setReady(true);
    setSnapshot((previous) => ({
      ...previous,
      state: previous.state[destination].open ? hideDock(previous.state, destination) : showDock(previous.state, destination),
    }));
  }
  function activateBrowserSearch(entry: CommandBrowserTab, readDraftPages: () => readonly DraftBrowserPageIntent[] = () => []) {
    const id = crypto.randomUUID(), selected = structuredClone(entry);
    setReady(true);
    updatePresentations(previous => ({ ...previous, ...admitBrowserSearch(previous, selected, readDraftPages(), id) }));
    return id;
  }

  function stepLayout(chat: MainChatTarget, canOpenBrowser: boolean, draftOwner?: {
    draftId: string; isCurrent(): boolean; canDispose(tab: DockTab, presentations: DockPresentations): boolean;
  }) {
    if (chat.hostId !== hostId || draftOwner && (chat.sessionId !== null || !draftOwner.isCurrent())) return;
    // Retained content can still change layout while its session is unavailable.
    // New draft launchers are local descriptors, guarded by their committed owner.
    const newTab = canOpenBrowser && chat.sessionId && target && "sessionId" in target && target.sessionId === chat.sessionId
      ? createBrowserNewTab(chat.hostId, chat.sessionId)
      : canOpenBrowser && draftOwner ? createDraftBrowserDockTab(chat.hostId, draftOwner.draftId) : undefined;
    const layoutOwner = draftOwner ? { ...chat, draftId: draftOwner.draftId } : chat;
    setReady(true);
    setSnapshot((previous, owner) => draftOwner && !draftOwner.isCurrent() ? previous
      : stepWorkspaceLayout(previous, layoutOwner, newTab, tab => !browserCleanupProtected(owner, tab.id)
        && (!draftOwner || canOpenBrowser && draftOwner.canDispose(tab, owner))));
  }
  function leaveBrowserConversation(previous: MainChatTarget, current: MainChatTarget) {
    const observed = new Set([...browserLaunchers.current].filter(([, controller]) => controller.hasObservedPristinePresentation).map(([id]) => id));
    if (!observed.size) return;
    setSnapshot((snapshot, owner) => cleanupPreviousBrowserConversation(snapshot, previous, current, observed, tab => !browserCleanupProtected(owner, tab.id)));
  }
  /** Selection callers supply a read-only committed-owner lookup. Re-read inside
   * the queued update so a route change cannot authorize an old selection. */
  function replaceBrowserDestination(origin: BrowserReplacementOrigin, destination: BrowserReplacementDestination, readCurrentOwner: () => MainChatTarget | undefined) {
    const seed = crypto.randomUUID();
    updatePresentations(previous => ({ ...previous, ...admitBrowserReplacement(previous, origin, destination, readCurrentOwner(), seed), browserSearchAdmission: previous.browserSearchAdmission }));
    return seed;
  }
  const workspaceTab: WorkspaceTab = initial.workspaceTab;
  return {
    snapshot,
    presentations,
    persisted: ready ? persistentFileTabs(snapshot) : undefined,
    change,
    closeBrowser: (source: DockPresentationRef, tab: DockTab, allowed: () => boolean, focusId: string = crypto.randomUUID()) => updatePresentations(previous => admitBrowserClose(previous, source, tab, allowed, focusId)),
    browserCloseState: (tab: DockTab) => browserLaunchers.current.get(tab.id)?.state ?? tab.browserNewTab,
    toggle,
    stepLayout,
    activateBrowserSearch,
    leaveBrowserConversation,
    replaceBrowserDestination,
    acknowledgeBrowserReplacements: (ids: readonly string[]) => updatePresentations(previous => ({ ...acknowledgeBrowserAdmissions(previous, ids), browserSearchAdmission: previous.browserSearchAdmission })),
    addMcpFileViewer: (tab: DockTab, guard: (presentations?: DockPresentations) => boolean) => {
      const source = tab.mcpApp?.source;
      if (tab.kind !== "mcp-app" || source?.type !== "file") throw new Error("Invalid MCP file viewer.");
      setReady(previous => guard() ? true : previous);
      setSnapshot((previous, presentations) => {
        if (!guard(presentations)) return previous;
        const existing = previous.tabs.find(value => value.kind === "mcp-app" && value.hostId === tab.hostId && value.target === tab.target
          && value.mcpApp?.source?.type === "file" && value.mcpApp.source.path === source.path);
        return { tabs: existing ? previous.tabs : [...previous.tabs, tab], state: insertDockTab(previous.state, existing ?? tab, "right") };
      });
    },
    addMcpApp: (tab: DockTab, guard: () => boolean) => { if (tab.kind !== "mcp-app" || !tab.mcpApp) throw new Error("Invalid MCP app panel."); add(tab, "right", guard); },
    open, prepareOpen, openDraftBrowser, updateDraftBrowserAddress, updateDraftBrowserTitle,
    openFile, openHostFile, destinationForTab, pinFile, selectFile,
    openSkillFile,
    terminal, prepareTerminal, publishTerminal,
    bindTerminal,
    browser, browserLauncher, openOutputWebsite,
    updateBrowserTitle,
    updateTitle,
    setUnread,
    setFileMode, setFileScroll,
    workspaceTab,
  };
}
