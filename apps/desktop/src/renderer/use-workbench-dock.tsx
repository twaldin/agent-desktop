import type { NativeSkillFileRef } from "@agent-desktop/shared";
import { useEffect, useRef, useState } from "react";
import type {
  BrowserFrameTarget,
  DesktopBridge,
  WorkspaceTarget,
} from "../../../../packages/shared/src/protocol";
import type { WindowViewState, WorkspaceTab } from "../window-state";
import {
  createDockState,
  dockTabId,
  insertDockTab,
  isWorkspaceFilePath,
  type DockDestination,
  type DockState,
  type DockTab,
  type DockTarget,
} from "./dock-state";
import { hasNativeTerminalBridge } from "./native-terminal-state";
import { nativeTerminalClient } from "./native-terminal-bridge";
import { workspaceKey } from "./workspace-state";

export type DockSnapshot = NonNullable<WindowViewState["dock"]>;
export function targetFromDock(target: Exclude<DockTarget, "host">): WorkspaceTarget {
  return target.startsWith("session:")
    ? { sessionId: target.slice(8) }
    : { projectId: target.slice(8) };
}
export function useWorkbenchDock(
  bridge: DesktopBridge,
  initial: WindowViewState,
  hostId: string,
  target: WorkspaceTarget | undefined,
  connected: boolean,
  onError: (message: string) => void,
) {
  const [snapshot, setSnapshot] = useState<DockSnapshot>(
    () => initial.dock ?? { state: createDockState(), tabs: [] },
  );
  const [ready, setReady] = useState(
    Boolean(initial.dock) || (!initial.workspaceOpen && !initial.terminalOpen),
  );
  const pending = useRef(new Set<string>());
  const add = (tab: DockTab, destination: DockDestination) => {
    setReady(true);
    setSnapshot((previous) => ({
      tabs: previous.tabs.some((value) => value.id === tab.id)
        ? previous.tabs
        : [...previous.tabs, tab],
      state: insertDockTab(previous.state, tab, destination),
    }));
  };
  function open(
    kind: Exclude<DockTab["kind"], "terminal" | "skill-file" | "file">,
    destination: DockDestination = "right",
    owner = hostId,
    workspace = target,
  ) {
    if (!workspace || (kind === "side-chat" && !("sessionId" in workspace))) return;
    const descriptor = {
      kind,
      hostId: owner,
      target: workspaceKey(workspace) as DockTarget,
      title:
        kind === "side-chat" ? "Side chat" : kind === "goal" ? "Edit goal" : kind === "review"
          ? "Review"
          : kind === "worktrees"
            ? "Worktrees"
            : kind === "browser"
              ? "Browser"
              : "Files",
    };
    add({ ...descriptor, id: dockTabId(descriptor) }, destination);
  }

  function openFile(
    path: string,
    owner: string,
    workspace: WorkspaceTarget,
    destination: DockDestination = "right",
  ) {
    if (!isWorkspaceFilePath(path)) {
      onError("Use a relative file path within this workspace.");
      return;
    }
    const descriptor: Omit<DockTab, "id"> = {
      kind: "file",
      hostId: owner,
      target: workspaceKey(workspace) as DockTarget,
      filePath: path,
      title: path.split("/").at(-1)!.slice(0, 1000),
    };
    add({ ...descriptor, id: dockTabId(descriptor) }, destination);
  }

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
    add({ ...descriptor, id: dockTabId(descriptor) }, destination);
  };
  async function browser(
    destination: DockDestination = "right",
    create = true,
  ) {
    if (!target || !("sessionId" in target)) return;
    const sessionId = target.sessionId,
      owner = hostId,
      key = `browser:${owner}:${sessionId}`;
    if (!connected) {
      onError("Reconnect to the owning host to open native browser tabs.");
      return;
    }
    if (pending.current.has(key)) return;
    if (!bridge.getBrowserMetadata) {
      onError("Update this desktop to inspect native browser tabs.");
      return;
    }
    pending.current.add(key);
    try {
      const metadata = await bridge.getBrowserMetadata(sessionId, owner);
      if (
        !metadata ||
        metadata.hostId !== owner ||
        metadata.sessionId !== sessionId
      ) {
        onError("Native browser metadata belongs to a different session.");
        return;
      }
      if (!create && metadata.availability !== "running") {
        onError(metadata.reason);
        return;
      }
      const running =
        metadata.availability === "running" ? metadata : undefined;
      const alive = running?.tabs.filter((tab) => tab.state === "alive") ?? [];
      if (!create) {
        if (!alive.length) {
          onError("This session has no live native browser tabs.");
          return;
        }
        for (const tab of alive)
          bindBrowser(
            {
              workerPid: running!.workerPid,
              name: tab.name,
              targetId: tab.targetId,
            },
            tab.title || tab.url || "Browser",
            owner,
            sessionId,
            destination,
          );
        return;
      }
      if (!bridge.createBrowserTab || !metadata.creationTicket) {
        onError("Update this host to create native browser tabs.");
        return;
      }
      const receipt = await bridge.createBrowserTab(
        sessionId,
        {
          requestId: crypto.randomUUID(),
          controlEpoch: metadata.creationTicket.controlEpoch,
          observedAt: metadata.creationTicket.observedAt,
        },
        owner,
      );
      if (
        receipt.hostId !== owner ||
        receipt.sessionId !== sessionId ||
        receipt.outcome !== "completed"
      ) {
        const message =
          receipt.outcome === "completed"
            ? "Browser tab creation returned a different owner."
            : receipt.message;
        onError(
          message ||
            (receipt.outcome === "unknown"
              ? "Browser tab creation outcome is unknown. Refresh existing tabs before trying again."
              : "Browser tab creation was rejected."),
        );
        return;
      }
      const tab = receipt.tab;
      if (!tab)
        throw new Error(
          "Browser tab creation returned an invalid native target.",
        );
      bindBrowser(
        {
          workerPid: receipt.workerPid,
          name: tab.name,
          targetId: tab.targetId,
        },
        tab.title || tab.url || "New tab",
        owner,
        sessionId,
        destination,
      );
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current.delete(key);
    }
  }
  const bindTerminal = (
    id: string,
    owner: string,
    workspace: WorkspaceTarget,
    destination: DockDestination,
    title = "Terminal",
  ) => {
    const descriptor = {
      kind: "terminal" as const,
      hostId: owner,
      target: workspaceKey(workspace) as DockTarget,
      terminalId: id,
      title,
    };
    add({ ...descriptor, id: dockTabId(descriptor) }, destination);
  };
  async function terminal(
    destination: DockDestination = "bottom",
    create = false,
  ) {
    if (!target) return;
    const owner = hostId,
      workspace = target,
      key = `${owner}:${workspaceKey(workspace)}`;
    if (pending.current.has(key)) return;
    if (!connected) {
      onError("Reconnect to the owning host to open its terminals.");
      return;
    }
    if (!hasNativeTerminalBridge(bridge)) {
      onError("Update this desktop to open native terminal tabs.");
      return;
    }
    pending.current.add(key);
    try {
      const client = nativeTerminalClient(bridge);
      // Always refresh before a possible creation, including after an uncertain prior result.
      const catalog = await client.nativeTerminalQuery(
        { type: "list", target: workspace },
        owner,
      );
      if (catalog.type !== "list")
        throw new Error("The host returned an invalid terminal catalog.");
      const available = catalog.terminals.filter(
        (value) => workspaceKey(value.target) === workspaceKey(workspace),
      );
      let selected: string | null = null;
      try {
        selected = localStorage.getItem(
          `terminal.native.selected.${owner}.${workspaceKey(workspace)}`,
        );
      } catch {
        /* In-memory selection is sufficient. */
      }
      let pane = create
        ? undefined
        : (available.find((value) => value.id === selected) ?? available[0]);
      if (!pane) {
        const result = await client.nativeTerminalAction(
          {
            type: "create",
            options: { target: workspace, cols: 120, rows: 30 },
          },
          owner,
        );
        pane = result.terminal;
        if (!pane || workspaceKey(pane.target) !== workspaceKey(workspace))
          throw new Error(
            "Terminal creation was not confirmed. Refresh the catalog before starting another shell.",
          );
      }
      bindTerminal(
        pane.id,
        owner,
        workspace,
        destination,
        pane.cwd.split("/").filter(Boolean).at(-1) ?? "Terminal",
      );
      try {
        localStorage.setItem(
          `terminal.native.selected.${owner}.${workspaceKey(workspace)}`,
          pane.id,
        );
      } catch {
        /* Window state still persists the identity. */
      }
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current.delete(key);
    }
  }
  useEffect(() => {
    if (ready || !target || hostId === "unconnected") return;
    let next = createDockState();
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
                ? "Files"
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
    setReady(true);
    const used = new Set([...state.right.tabIds, ...state.bottom.tabIds]);
    setSnapshot((previous) => ({
      state,
      tabs: previous.tabs.filter((tab) => used.has(tab.id)),
    }));
  }
  function toggle(destination: DockDestination) {
    setReady(true);
    setSnapshot((previous) => ({
      ...previous,
      state: {
        ...previous.state,
        [destination]: {
          ...previous.state[destination],
          open: !previous.state[destination].open,
        },
      },
    }));
  }
  const workspaceTab: WorkspaceTab = initial.workspaceTab;
  return {
    snapshot,
    persisted: ready ? snapshot : undefined,
    change,
    toggle,
    open,
    openFile,
    openSkillFile,
    terminal,
    bindTerminal,
    browser,
    updateBrowserTitle,
    updateTitle,
    setUnread,
    setFileMode,
    workspaceTab,
  };
}
