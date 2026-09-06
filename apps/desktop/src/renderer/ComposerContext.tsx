import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { NewChatExecution, Project } from "@agent-desktop/shared";
import type { HostOption } from "./host-catalog";
import { Icon } from "./Icons";
import type { WorkspaceState } from "./workspace-state";
import { retainWorkspace } from "./workspace-lease";
import "./composer-context.css";

type Menu = "projects" | "hosts" | "starting-state" | "branches" | "create-branch";
export interface ComposerContextHandle { openProjects(anchor: HTMLButtonElement): void; }
export const ComposerContext = forwardRef<ComposerContextHandle, {
  hostId: string; hostName: string; hosts: HostOption[]; projects: Project[]; projectId: string | null; connected: boolean; addingProject: boolean;
  workspace?: WorkspaceState; onProject(id: string | null): void; onHost(id: string): void; onAddProject(): void;
  execution?: NewChatExecution; worktreesAvailable: boolean; onExecution(execution: NewChatExecution): void;
  branchPrefix?: string; onOpenGitSettings?(): void;
  onCheckout(branch: string, create: boolean): Promise<void>;
}>(function ComposerContext({ hostId, hostName, hosts, projects, projectId, connected, addingProject, workspace, execution, worktreesAvailable, onExecution, onProject, onHost, onAddProject, branchPrefix = "codex/", onOpenGitSettings, onCheckout }, ref) {
  const [open, setOpen] = useState<Menu>(), [query, setQuery] = useState(""), [newBranch, setNewBranch] = useState("");
  const [, redraw] = useReducer(value => value + 1, 0);
  const root = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null), branchDialog = useRef<HTMLDialogElement>(null), branchInput = useRef<HTMLInputElement>(null), anchor = useRef<HTMLButtonElement>(null), anchorAlign = useRef<"start" | "center">("start");
  const currentContext = useRef({ workspace, open }); currentContext.current = { workspace, open };
  const [position, setPosition] = useState<CSSProperties>();
  const project = projects.find(item => item.id === projectId);
  const disabledGit = !connected || !workspace?.status || !workspace.restored || workspace.busy || Boolean(workspace.pending);
  const localBranches = workspace?.branches.filter(item => !item.remote && !item.symbolicTarget) ?? [];
  const currentBranch = workspace?.status?.branch ?? localBranches.find(item => item.current)?.name;
  const dirty = Boolean(workspace?.status?.entries.length);
  const worktreeSelected = execution?.type === "worktree";
  const worktreeDisabled = !project || !worktreesAvailable || disabledGit || !currentBranch;
  const resolvedExecutionProject = useRef(projectId);
  useEffect(() => { setOpen(undefined); setQuery(""); setNewBranch(""); }, [hostId, projectId]);
  useEffect(() => {
    if (!workspace) return;
    let disposed = false;
    const off = workspace.subscribe(redraw), release = retainWorkspace(workspace);
    workspace.setConnected(connected);
    void workspace.restore().then(() => { if (!disposed && workspace.connected) void workspace.loadGit(); });
    const timer = setInterval(() => { if (workspace.connected) void workspace.loadGit(); }, 5000);
    return () => { disposed = true; off(); release(); clearInterval(timer); };
  }, [workspace, connected]);
  useEffect(() => {
    if (!worktreeSelected) { resolvedExecutionProject.current = projectId; return; }
    if (!project || !connected || !workspace?.restored || !workspace.status || !currentBranch) return;
    const changedProject = resolvedExecutionProject.current !== projectId;
    resolvedExecutionProject.current = projectId;
    const selected = execution.startingState;
    const valid = selected.type === "branch" ? localBranches.some(item => item.name === selected.branchName) : dirty;
    if (changedProject || !valid) onExecution({ type: "worktree", startingState: { type: "branch", branchName: currentBranch } });
  }, [projectId, project, connected, workspace?.restored, workspace?.status?.revision, currentBranch, dirty, worktreeSelected, execution, localBranches, onExecution]);
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
    if (!open || open === "create-branch") return;
    const frame = requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>("input,button:not(:disabled)")?.focus({preventScroll:true}));
    const outside = (event:PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(undefined); };
    window.addEventListener("pointerdown",outside);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("pointerdown",outside); };
  }, [open]);
  useLayoutEffect(() => {
    const dialog = branchDialog.current;
    if (open !== "create-branch" || !dialog) return;
    if (!dialog.open) dialog.showModal();
    const frame = requestAnimationFrame(() => branchInput.current?.focus({preventScroll:true}));
    return () => { cancelAnimationFrame(frame); if (dialog.open) dialog.close(); };
  }, [open]);
  function close() {
    const restore = anchor.current, modal = Boolean(branchDialog.current?.open);
    setOpen(undefined);
    if (!modal) restore?.focus({preventScroll:true});
    else requestAnimationFrame(() => { if (currentContext.current.open == null) restore?.focus({preventScroll:true}); });
  }
  function toggle(value:Menu, button:HTMLButtonElement, align: "start" | "center" = "start") {
    anchor.current = button; anchorAlign.current = align; setQuery(""); setNewBranch(""); setOpen(open === value ? undefined : value);
    if ((value === "branches" || value === "starting-state") && connected) void workspace?.loadWorktrees();
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
  async function checkout(branch:string, create=false) {
    if (disabledGit) return;
    await onCheckout(branch,create);
    // A completed command for an old project cannot dismiss the new context's menu.
    if (currentContext.current.workspace !== workspace || !["branches","create-branch"].includes(currentContext.current.open ?? "")) return;
    // WorkspaceState retains rejected/uncertain receipts and exposes Retry.
    if (!workspace?.errors.action && !workspace?.pending) close();
  }
  async function retryCheckout() {
    await workspace?.retry();
    if (currentContext.current.workspace !== workspace || currentContext.current.open !== "create-branch") return;
    if (!workspace?.errors.action && !workspace?.pending) close();
  }
  const trimmedBranch = newBranch.trim(), branchExists = workspace?.branches.some(item => !item.remote && item.name === trimmedBranch), branchEndsWithSlash = trimmedBranch.endsWith("/");
  const canCreateBranch = !disabledGit && Boolean(trimmedBranch) && !branchEndsWithSlash && !branchExists;
  const label = open === "projects" ? "Select project" : open === "hosts" ? "Select where to run the chat" : open === "starting-state" ? "What branch should this chat start from?" : "Switch branch";
  return <div className="composer-context" ref={root}>
    <button type="button" aria-label="Select project" aria-haspopup="menu" aria-expanded={open === "projects"} title={project?.path ?? "Choose a project on this host"} onClick={event => toggle("projects",event.currentTarget)}><Icon name="folder"/><span>{project?.name ?? (projectId ? "Unavailable project" : "No project")}</span></button>
    <button type="button" aria-label="Select where to run the chat" aria-haspopup="menu" aria-expanded={open === "hosts"} title={`${worktreeSelected ? "New local worktree" : "Local"} · ${hostName}${connected ? "" : " · Offline"}`} onClick={event => toggle("hosts",event.currentTarget)}><Icon name={worktreeSelected ? "branch" : "laptop"}/><span>{worktreeSelected ? "New local worktree" : "Local"}</span>{!connected && <span className="context-offline">Offline</span>}</button>
    {worktreeSelected && project && <button type="button" aria-label="What branch should this chat start from?" aria-haspopup="menu" aria-expanded={open === "starting-state"} disabled={worktreeDisabled} title={worktreeDisabled ? "Reconnect to the owning host and wait for Git status." : "What branch should this chat start from?"} onClick={event => toggle("starting-state",event.currentTarget)}><Icon name="branch"/><span>{execution.startingState.type === "working-tree" ? "Local file state" : execution.startingState.branchName}</span></button>}
    {project && <button type="button" aria-label="Switch branch" aria-haspopup="menu" aria-expanded={open === "branches" || open === "create-branch"} title={workspace?.errors.git ?? workspace?.status?.branch ?? "Repository branch"} onClick={event => toggle("branches",event.currentTarget)}><Icon name="branch"/><span>{workspace?.status ? workspace.status.branch ?? "Detached HEAD" : workspace?.loading.has("git") ? "Loading branch…" : "Branch unavailable"}</span></button>}
    {open && open !== "create-branch" && position && createPortal(<div ref={menu} role="menu" aria-label={label} className="composer-context-menu" style={position} onKeyDown={key}>
      {open !== "starting-state" && <label className="context-search"><Icon name="search"/><input type="search" aria-label={`Search ${open}`} placeholder={`Search ${open}`} value={query} onChange={event => setQuery(event.target.value)}/></label>}
      {open === "projects" && <><div className="context-options">{projects.filter(item => matches(`${item.name} ${item.path}`)).map(item => <button role="menuitemradio" aria-checked={item.id === projectId} key={item.id} type="button" title={item.path} onClick={() => { onProject(item.id); close(); }}><Icon name="folder"/><span>{item.name}</span>{item.id === projectId && <Icon name="check"/>}</button>)}{!projects.some(item => matches(`${item.name} ${item.path}`)) && <p>No matching projects.</p>}</div><hr/><button role="menuitem" type="button" disabled={!connected || addingProject} onClick={() => { close(); onAddProject(); }}><Icon name="plus"/><span>{addingProject ? "Adding project…" : "New project"}</span></button><button role="menuitem" type="button" onClick={() => { onProject(null); close(); }}><Icon name="close"/><span>Don’t work in a project</span></button></>}
      {open === "hosts" && <><div className="context-options"><p className="context-menu-heading">Work in</p><button role="menuitemradio" aria-label="Local" aria-checked={!worktreeSelected} type="button" onClick={() => { onExecution({type:"local"}); close(); }}><Icon name="laptop"/><span>Local</span>{!worktreeSelected && <Icon name="check"/>}</button><button role="menuitemradio" aria-label="New local worktree" aria-checked={worktreeSelected} type="button" disabled={worktreeDisabled} title={!worktreesAvailable ? "Update the owning host to create local worktrees." : !project ? "Choose a project first." : undefined} onClick={() => { if (currentBranch) { onExecution({type:"worktree",startingState:{type:"branch",branchName:currentBranch}}); close(); } }}><Icon name="branch"/><span>New local worktree<small>{worktreeDisabled ? "Unavailable for this project" : `Start from ${currentBranch}`}</small></span>{worktreeSelected && <Icon name="check"/>}</button></div><hr/><div className="context-options"><p className="context-menu-heading">Run on</p>{hosts.filter(item => matches(item.name)).map(item => <button role="menuitemradio" aria-checked={item.hostId === hostId} key={item.key} type="button" disabled={!item.hostId} title={item.error} onClick={() => { if (item.hostId) { close(); onHost(item.hostId); } }}><Icon name="laptop"/><span>{item.local ? "Local host" : item.name}<small>{item.local ? item.name : item.availability === "available" ? "Connected" : item.cached ? "Offline · cached projects" : item.availability}</small></span>{item.hostId === hostId && <Icon name="check"/>}</button>)}{!hosts.some(item => matches(item.name)) && <p>No matching hosts.</p>}</div></>}
      {open === "starting-state" && <><label className="context-search"><Icon name="search"/><input type="search" aria-label={`Search ${project?.name ?? "project"} branches`} placeholder={`Search ${project?.name ?? "project"} branches`} value={query} onChange={event => setQuery(event.target.value)}/></label><div className="context-options context-starting-states">{workspace?.loading.has("worktrees") && <p>Loading branches…</p>}{dirty && matches(`Local file state ${currentBranch ?? ""}`) && <button type="button" role="menuitemradio" aria-label="Local file state" aria-checked={execution?.type === "worktree" && execution.startingState.type === "working-tree"} onClick={() => { onExecution({type:"worktree",startingState:{type:"working-tree"}}); close(); }}><Icon name="folder"/><span>Local file state<small>{currentBranch ?? "Detached HEAD"} with local code changes</small></span>{execution?.type === "worktree" && execution.startingState.type === "working-tree" && <Icon name="check"/>}</button>}{localBranches.filter(item => matches(item.name)).map(item => <button type="button" role="menuitemradio" aria-checked={execution?.type === "worktree" && execution.startingState.type === "branch" && execution.startingState.branchName === item.name} key={item.ref} onClick={() => { onExecution({type:"worktree",startingState:{type:"branch",branchName:item.name}}); close(); }}><Icon name="branch"/><span>{item.name}</span>{execution?.type === "worktree" && execution.startingState.type === "branch" && execution.startingState.branchName === item.name && <Icon name="check"/>}</button>)}</div></>}
      {open === "branches" && <>
        {workspace?.cacheWarning && <p role="alert">{workspace.cacheWarning}</p>}
        {workspace?.errors.git && <p role="alert">{workspace.errors.git}</p>}{workspace?.errors.worktrees && <p role="alert">{workspace.errors.worktrees}</p>}
        {!connected && <p>Reconnect to switch branches.</p>}
        {workspace?.errors.action && <p role="alert">{workspace.errors.action}</p>}
        {workspace?.pending && <button type="button" disabled={!connected || workspace.busy} onClick={() => void workspace.retry()}>Retry original workspace command</button>}
        <div className="context-options context-branches"><p className="context-menu-heading">Branches</p>{workspace?.branches.filter(item => !item.remote && !item.symbolicTarget && matches(item.name)).map(item => <button type="button" role="menuitemradio" aria-checked={item.current} disabled={disabledGit} key={item.ref} onClick={() => { if (item.current) close(); else void checkout(item.name); }}><Icon name="branch"/><span>{item.name}</span>{item.current && <Icon name="check"/>}</button>)}{workspace?.loading.has("worktrees") && <p>Loading branches…</p>}</div><hr/><button type="button" role="menuitem" disabled={disabledGit} onClick={() => { setNewBranch(branchPrefix); setOpen("create-branch"); }}><Icon name="plus"/><span>Create and checkout new branch…</span></button>
      </>}
    </div>,document.body)}
    {open === "create-branch" && createPortal(<dialog ref={branchDialog} className="composer-branch-dialog" aria-labelledby="composer-branch-dialog-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <form onSubmit={event => { event.preventDefault(); if (canCreateBranch) void checkout(trimmedBranch,true); }}>
        <div className="context-dialog-header"><h2 id="composer-branch-dialog-title">Create and checkout branch</h2><button type="button" className="context-dialog-close" aria-label="Close dialog" onClick={close}><Icon name="close"/></button></div>
        <div className="context-branch-label"><label htmlFor="composer-new-branch">Branch name</label><button type="button" onClick={() => { close(); onOpenGitSettings?.(); }}>Set prefix</button></div>
        <input ref={branchInput} id="composer-new-branch" aria-label="Branch name" value={newBranch} onChange={event => setNewBranch(event.target.value)} placeholder="new-branch" autoFocus aria-invalid={branchEndsWithSlash || branchExists || undefined}/>
        {branchEndsWithSlash ? <p className="context-branch-error" role="alert">Branch name cannot end with “/”.</p> : branchExists && !workspace?.busy ? <p className="context-branch-error" role="alert">Branch already exists.</p> : null}
        {workspace?.cacheWarning && <p className="context-branch-error" role="alert">{workspace.cacheWarning}</p>}
        {workspace?.errors.action && <p className="context-branch-error" role="alert">{workspace.errors.action}</p>}
        {workspace?.pending && <button className="context-retry" type="button" disabled={!connected || workspace.busy} onClick={() => void retryCheckout()}>Retry original workspace command</button>}
        <div className="context-dialog-actions"><button className="secondary-button" type="button" onClick={close}>Close</button><button className="primary-button" type="submit" disabled={!canCreateBranch}>{workspace?.busy ? <><span className="spinner"/> Create and checkout</> : "Create and checkout"}</button></div>
      </form>
    </dialog>,document.body)}
  </div>;
});
