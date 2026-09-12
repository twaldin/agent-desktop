import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { LocalEnvironmentSelection, NewChatExecution, Project } from "@agent-desktop/shared";
import type { EnvironmentCatalogItem } from "./environment-catalog";
import type { HostOption } from "./host-catalog";
import { Icon } from "./Icons";
import type { BranchSwitchRequest } from "./BranchSwitchDialog";
import { BranchSelector } from "./BranchSelector";
import { StartingStateMenu } from "./StartingStateMenu";
import { useStartingStateInventory } from "./use-starting-state-inventory";
import { startingStateLabel } from "./starting-state-options";
import type { WorkspaceState } from "./workspace-state";
import { retainWorkspace } from "./workspace-lease";
import "./composer-context.css";

type Menu = "projects" | "hosts" | "environments" | "starting-state";
export interface ComposerContextHandle { openProjects(anchor: HTMLButtonElement): void; }
export const ComposerContext = forwardRef<ComposerContextHandle, {
  hostId: string; hostName: string; hosts: HostOption[]; projects: Project[]; projectId: string | null; connected: boolean; addingProject: boolean;
  workspace?: WorkspaceState; onProject(id: string | null): void; onHost(id: string): void; onAddProject(): void;
  execution?: NewChatExecution; worktreesAvailable: boolean; onExecution(execution: NewChatExecution): void; onExecutionMode?(execution: NewChatExecution): void;
  branchPrefix?: string; onOpenGitSettings(): void; onCheckoutBlocked?(request: BranchSwitchRequest): void;
  environment?: LocalEnvironmentSelection; environments?: { items: EnvironmentCatalogItem[]; loading: boolean; error?: string; refresh(): void };
  environmentAvailable?: boolean; onEnvironment?(value: LocalEnvironmentSelection): void; onOpenEnvironmentSettings?(): void;
}>(function ComposerContext({ hostId, hostName, hosts, projects, projectId, connected, addingProject, workspace, execution, worktreesAvailable, onExecution, onExecutionMode = onExecution, onProject, onHost, onAddProject, branchPrefix = "codex/", onOpenGitSettings, onCheckoutBlocked, environment, environments, environmentAvailable = false, onEnvironment, onOpenEnvironmentSettings }, ref) {
  const [open, setOpen] = useState<Menu>(), [query, setQuery] = useState("");
  const [startingInventoryOwner, setStartingInventoryOwner] = useState<{ workspace: WorkspaceState; hostId: string; projectId: string | null }>();
  const [, redraw] = useReducer(value => value + 1, 0);
  const root = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null), anchor = useRef<HTMLButtonElement>(null), anchorAlign = useRef<"start" | "center">("start");
  const [position, setPosition] = useState<CSSProperties>();
  const project = projects.find(item => item.id === projectId);
  const disabledGit = !connected || !workspace?.status || !workspace.restored || workspace.busy || Boolean(workspace.pending);
  const localBranches = workspace?.branches.filter(item => !item.remote && !item.symbolicTarget) ?? [];
  const currentBranch = workspace?.status?.branch ?? localBranches.find(item => item.current)?.name;
  const dirty = Boolean(workspace?.status?.entries.length);
  const fallbackStartingState = currentBranch ? { type: "branch" as const, branchName: currentBranch }
    : dirty ? { type: "working-tree" as const }
    : localBranches[0] ? { type: "branch" as const, branchName: localBranches[0].name }
    : undefined;
  const worktreeSelected = execution?.type === "worktree";
  const startingInventory = useStartingStateInventory(worktreeSelected && project ? workspace : undefined,
    Boolean(worktreeSelected && project && worktreesAvailable && startingInventoryOwner?.workspace === workspace && startingInventoryOwner?.hostId === hostId && startingInventoryOwner?.projectId === projectId), open === "starting-state");
  useLayoutEffect(() => {
    setStartingInventoryOwner(owner => owner && (!worktreeSelected || !project || !worktreesAvailable || owner.workspace !== workspace || owner.hostId !== hostId || owner.projectId !== projectId) ? undefined : owner);
  }, [worktreeSelected, Boolean(project), worktreesAvailable, workspace, hostId, projectId]);
  const worktreeDisabled = !project || !worktreesAvailable || disabledGit || !fallbackStartingState;
  const resolvedExecutionProject = useRef(projectId);
  useEffect(() => { setOpen(undefined); setQuery(""); }, [hostId, projectId]);
  useEffect(() => {
    if (!workspace) return;
    let disposed = false;
    const off = workspace.subscribe(redraw), release = retainWorkspace(workspace);
    workspace.setConnected(connected);
    void workspace.restore().then(() => {
      if (disposed || !workspace.connected) return;
      void workspace.loadGit().then(() => {
        if (!disposed && workspace.connected && worktreeSelected && workspace.gitAvailability !== "not-repository") void workspace.loadWorktrees();
      });
    });
    const timer = setInterval(() => { if (workspace.connected) void workspace.loadGit(); }, 5000);
    return () => { disposed = true; off(); release(); clearInterval(timer); };
  }, [workspace, connected, worktreeSelected]);
  useEffect(() => {
    if (!worktreeSelected) { resolvedExecutionProject.current = projectId; return; }
    if (!project || !connected || !workspace?.restored || !workspace.status || !fallbackStartingState) return;
    const changedProject = resolvedExecutionProject.current !== projectId;
    resolvedExecutionProject.current = projectId;
    // Missing or late Git data must not replace an authored starting state.
    // Only switching projects initializes the existing project fallback.
    if (changedProject) onExecution({ type: "worktree", startingState: fallbackStartingState });
  }, [projectId, project, connected, workspace?.restored, workspace?.status?.revision, dirty, worktreeSelected, execution, localBranches, fallbackStartingState, onExecution]);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const target = anchor.current;
    const measure = () => {
      const box = target.getBoundingClientRect(), width = Math.min(open === "projects" ? 261 : open === "starting-state" ? 288 : 297, innerWidth - 24), above = anchorAlign.current === "center" || box.top >= Math.min(200, innerHeight / 2);
      const desiredLeft = anchorAlign.current === "center" ? box.left + (box.width - width) / 2 : box.left;
      setPosition({ width, left: Math.max(12, Math.min(desiredLeft, innerWidth - width - 12)), ...(above
        ? { bottom:innerHeight - box.top + 4, top:"auto", maxHeight:Math.max(40,Math.min(420,box.top - 16)) }
        : { top:box.bottom + 4, bottom:"auto", maxHeight:Math.max(40,Math.min(420,innerHeight - box.bottom - 16)) }) });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(target);
    window.addEventListener("resize",measure); window.addEventListener("scroll",measure,true);
    return () => { observer.disconnect(); window.removeEventListener("resize",measure); window.removeEventListener("scroll",measure,true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>("input,button:not(:disabled)")?.focus({preventScroll:true}));
    const outside = (event:PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(undefined); };
    window.addEventListener("pointerdown",outside);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("pointerdown",outside); };
  }, [open]);
  function close() {
    const restore = anchor.current; setOpen(undefined); restore?.focus({preventScroll:true});
  }
  function toggle(value:Menu, button:HTMLButtonElement, align: "start" | "center" = "start") {
    anchor.current = button; anchorAlign.current = align; setQuery(""); setOpen(open === value ? undefined : value);
    if (value === "starting-state" && workspace) setStartingInventoryOwner({ workspace, hostId, projectId });
    if ((value === "hosts" || value === "starting-state") && connected && workspace?.gitAvailability !== "not-repository") void workspace?.loadWorktrees();
    if (value === "environments" && connected && environmentAvailable) environments?.refresh();
  }
  useImperativeHandle(ref, () => ({ openProjects(button) { toggle("projects", button, "center"); } }), [open]);
  function key(event:KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (!["ArrowDown","ArrowUp","Home","End"].includes(event.key)) return;
    if (event.target instanceof HTMLInputElement && !["ArrowDown","ArrowUp"].includes(event.key)) return;
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (!buttons.length) return; event.preventDefault();
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length-1 : index < 0 ? event.key === "ArrowUp" ? buttons.length-1 : 0 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus({preventScroll:true});
    buttons[next]?.scrollIntoView({block:"nearest"});
  }
  const needle = query.trim().toLocaleLowerCase();
  const matches = (value:string) => value.toLocaleLowerCase().includes(needle);
  const selectedEnvironmentName = environment && environments?.items.find(item => item.type === "environment" && item.configPath === environment.configPath);
  const label = open === "projects" ? "Select project" : open === "hosts" ? "Select where to run the chat" : open === "environments" ? "Select a local environment" : "What branch should this chat start from?";
  return <div className="composer-context" ref={root}>
    <button type="button" aria-label="Select project" aria-haspopup="menu" aria-expanded={open === "projects"} title={project?.path ?? "Choose a project on this host"} onClick={event => toggle("projects",event.currentTarget)}><Icon name="folder"/><span>{project?.name ?? (projectId ? "Unavailable project" : "No project")}</span></button>
    <button type="button" aria-label="Select where to run the chat" aria-haspopup="menu" aria-expanded={open === "hosts"} title={`${worktreeSelected ? "New local worktree" : "Local"} · ${hostName}${connected ? "" : " · Offline"}`} onClick={event => toggle("hosts",event.currentTarget)}><Icon name={worktreeSelected ? "branch" : "laptop"}/><span>{worktreeSelected ? "New local worktree" : "Local"}</span>{!connected && <span className="context-offline">Offline</span>}</button>
    {worktreeSelected && project && environmentAvailable && <button type="button" aria-label="Select a local environment" aria-haspopup="menu" aria-expanded={open === "environments"} title="Select a local environment" onClick={event => toggle("environments",event.currentTarget)}><Icon name="folder"/><span>{environment ? selectedEnvironmentName?.type === "environment" ? selectedEnvironmentName.environment.name : "Environment unavailable" : "No environment"}</span></button>}
    {worktreeSelected && project && workspace?.gitAvailability !== "not-repository" && <button type="button" aria-label="What branch should this chat start from?" aria-haspopup="menu" aria-expanded={open === "starting-state"} disabled={disabledGit || !worktreesAvailable} title={disabledGit || !worktreesAvailable ? "Reconnect to the owning host and wait for Git status." : "What branch should this chat start from?"} onClick={event => toggle("starting-state",event.currentTarget)}><Icon name="branch"/><span>{startingStateLabel(execution.startingState, workspace?.status?.branch, startingInventory.snapshot)}</span></button>}
    {project && !worktreeSelected && workspace && workspace.gitAvailability !== "not-repository" && <BranchSelector onCheckoutBlocked={onCheckoutBlocked} workspace={workspace} connected={connected} branchPrefix={branchPrefix} onOpenGitSettings={onOpenGitSettings} variant="composer" repositoryName={project.name} onOpen={() => setOpen(undefined)}/>}
    {open && position && createPortal(<div ref={menu} role="menu" aria-label={label} className="composer-context-menu" style={position} onKeyDown={key}>
      {open !== "starting-state" && open !== "environments" && <label className="context-search"><Icon name="search"/><input type="search" aria-label={`Search ${open}`} placeholder={`Search ${open}`} value={query} onChange={event => setQuery(event.target.value)}/></label>}
      {open === "projects" && <><div className="context-options">{projects.filter(item => matches(`${item.name} ${item.path}`)).map(item => <button role="menuitemradio" aria-checked={item.id === projectId} key={item.id} type="button" title={item.path} onClick={() => { onProject(item.id); close(); }}><Icon name="folder"/><span>{item.name}</span>{item.id === projectId && <Icon name="check"/>}</button>)}{!projects.some(item => matches(`${item.name} ${item.path}`)) && <p>No matching projects.</p>}</div><hr/><button role="menuitem" type="button" disabled={!connected || addingProject} onClick={() => { close(); onAddProject(); }}><Icon name="plus"/><span>{addingProject ? "Adding project…" : "New project"}</span></button><button role="menuitem" type="button" onClick={() => { onProject(null); close(); }}><Icon name="close"/><span>Don’t work in a project</span></button></>}
      {open === "hosts" && <><div className="context-options"><p className="context-menu-heading">Work in</p><button role="menuitemradio" aria-label="Local" aria-checked={!worktreeSelected} type="button" onClick={() => { onExecutionMode({type:"local"}); close(); }}><Icon name="laptop"/><span>Local</span>{!worktreeSelected && <Icon name="check"/>}</button><button role="menuitemradio" aria-label="New local worktree" aria-checked={worktreeSelected} type="button" disabled={worktreeDisabled} title={!worktreesAvailable ? "Update the owning host to create local worktrees." : !project ? "Choose a project first." : undefined} onClick={() => { if (fallbackStartingState) { onExecutionMode({type:"worktree",startingState:fallbackStartingState}); close(); } }}><Icon name="branch"/><span>New local worktree<small>{worktreeDisabled ? "Unavailable for this project" : fallbackStartingState?.type === "working-tree" ? "Start from local file state" : `Start from ${fallbackStartingState?.branchName}`}</small></span>{worktreeSelected && <Icon name="check"/>}</button></div><hr/><div className="context-options"><p className="context-menu-heading">Run on</p>{hosts.filter(item => matches(item.name)).map(item => <button role="menuitemradio" aria-checked={item.hostId === hostId} key={item.key} type="button" disabled={!item.hostId} title={item.error} onClick={() => { if (item.hostId) { close(); onHost(item.hostId); } }}><Icon name="laptop"/><span>{item.local ? "Local host" : item.name}<small>{item.local ? item.name : item.availability === "available" ? "Connected" : item.cached ? "Offline · cached projects" : item.availability}</small></span>{item.hostId === hostId && <Icon name="check"/>}</button>)}{!hosts.some(item => matches(item.name)) && <p>No matching hosts.</p>}</div></>}
      {open === "environments" && <>
        <p className="context-menu-heading">Environment</p>
        {environments?.loading && <p role="status">Loading environments…</p>}
        {environments?.error && <p role="alert">{environments.error}<button type="button" disabled={!connected} onClick={() => environments.refresh()}>Retry</button></p>}
        {!connected && <p>Offline · saved environments</p>}
        {environment && !environments?.loading && !environments?.error && (selectedEnvironmentName?.type !== "environment" || selectedEnvironmentName.revision !== environment.revision) && <p role="status">The selected environment changed or is unavailable. Choose an environment before sending.</p>}
        <div className="context-options">
          <button role="menuitemradio" aria-checked={environment === null} type="button" onClick={() => { onEnvironment?.(null); close(); }}>
            <Icon name="close"/><span>Work without environment</span>{environment === null && <Icon name="check"/>}
          </button>
          {environments?.items.map(item => item.type === "environment" ? <button key={item.configPath} role="menuitemradio" title={item.configPath} aria-checked={environment?.configPath === item.configPath && environment?.revision === item.revision} type="button" onClick={() => { if (projectId) onEnvironment?.({ projectId, configPath: item.configPath, revision: item.revision }); close(); }}>
            <Icon name="folder"/><span>{item.environment.name}</span>{environment?.configPath === item.configPath && environment?.revision === item.revision && <Icon name="check"/>}
          </button> : <button role="menuitem" key={item.configPath} type="button" onClick={() => { close(); onOpenEnvironmentSettings?.(); }}>
            <Icon name="refresh"/><span>Unreadable environment<small>{item.error}</small></span>
          </button>)}
          <button role="menuitem" type="button" onClick={() => { close(); onOpenEnvironmentSettings?.(); }}><Icon name="plus"/><span>Set up project</span></button>
        </div>
      </>}
      {open === "starting-state" && workspace && startingInventory.controller && execution?.type === "worktree" && <StartingStateMenu key={`${hostId}:${projectId}`} workspace={workspace} connected={connected} disabled={disabledGit || !worktreesAvailable}
        inventory={{ controller: startingInventory.controller, snapshot: startingInventory.snapshot }} projectName={project?.name ?? "project"} query={query} onQuery={setQuery} selected={execution.startingState}
        onSelect={startingState => onExecution({ type: "worktree", startingState })} onClose={close}/>}

    </div>,document.body)}
  </div>;
});
