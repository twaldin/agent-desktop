import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { Project } from "@agent-desktop/shared";
import type { HostOption } from "./host-catalog";
import { Icon } from "./Icons";
import type { WorkspaceState } from "./workspace-state";
import { retainWorkspace } from "./workspace-lease";
import "./composer-context.css";

type Menu = "projects" | "hosts" | "branches" | "create-branch";
export function ComposerContext({ hostId, hostName, hosts, projects, projectId, connected, addingProject, workspace, onProject, onHost, onAddProject, onCheckout }: {
  hostId: string; hostName: string; hosts: HostOption[]; projects: Project[]; projectId: string | null; connected: boolean; addingProject: boolean;
  workspace?: WorkspaceState; onProject(id: string | null): void; onHost(id: string): void; onAddProject(): void;
  onCheckout(branch: string, create: boolean): Promise<void>;
}) {
  const [open, setOpen] = useState<Menu>(), [query, setQuery] = useState(""), [newBranch, setNewBranch] = useState("");
  const [, redraw] = useReducer(value => value + 1, 0);
  const root = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null), anchor = useRef<HTMLButtonElement>(null);
  const currentContext = useRef({ workspace, open }); currentContext.current = { workspace, open };
  const [position, setPosition] = useState<CSSProperties>();
  const project = projects.find(item => item.id === projectId), host = hosts.find(item => item.hostId === hostId);
  const disabledGit = !connected || !workspace?.status || !workspace.restored || workspace.busy || Boolean(workspace.pending);
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
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const target = anchor.current;
    const measure = () => {
      const box = target.getBoundingClientRect(), width = Math.min(open === "projects" ? 261 : 297, innerWidth - 24), above = box.top >= Math.min(200, innerHeight / 2);
      setPosition({ width, left: Math.max(12, Math.min(box.left, innerWidth - width - 12)), ...(above
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
  function close() { setOpen(undefined); anchor.current?.focus({preventScroll:true}); }
  function toggle(value:Menu, button:HTMLButtonElement) {
    anchor.current = button; setQuery(""); setNewBranch(""); setOpen(open === value ? undefined : value);
    if (value === "branches" && connected) void workspace?.loadWorktrees();
  }
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
  const label = open === "projects" ? "Select project" : open === "hosts" ? "Select where to run the chat" : open === "create-branch" ? "Create and checkout new branch" : "Switch branch";
  return <div className="composer-context" ref={root}>
    <button type="button" aria-label="Select project" aria-haspopup="menu" aria-expanded={open === "projects"} title={project?.path ?? "Choose a project on this host"} onClick={event => toggle("projects",event.currentTarget)}><Icon name="folder"/><span>{project?.name ?? (projectId ? "Unavailable project" : "No project")}</span></button>
    <button type="button" aria-label="Select where to run the chat" aria-haspopup="menu" aria-expanded={open === "hosts"} title={`${hostName}${connected ? "" : " · Offline"}`} onClick={event => toggle("hosts",event.currentTarget)}><Icon name="laptop"/><span>{host?.local ? "Local" : hostName}</span>{!connected && <span className="context-offline">Offline</span>}</button>
    {project && <button type="button" aria-label="Switch branch" aria-haspopup="menu" aria-expanded={open === "branches" || open === "create-branch"} title={workspace?.errors.git ?? workspace?.status?.branch ?? "Repository branch"} onClick={event => toggle("branches",event.currentTarget)}><Icon name="branch"/><span>{workspace?.status ? workspace.status.branch ?? "Detached HEAD" : workspace?.loading.has("git") ? "Loading branch…" : "Branch unavailable"}</span></button>}
    {open && position && createPortal(<div ref={menu} role="menu" aria-label={label} className="composer-context-menu" style={position} onKeyDown={key}>
      {open !== "create-branch" && <label className="context-search"><Icon name="search"/><input type="search" aria-label={`Search ${open}`} placeholder={`Search ${open}`} value={query} onChange={event => setQuery(event.target.value)}/></label>}
      {open === "projects" && <><div className="context-options">{projects.filter(item => matches(`${item.name} ${item.path}`)).map(item => <button role="menuitemradio" aria-checked={item.id === projectId} key={item.id} type="button" title={item.path} onClick={() => { onProject(item.id); close(); }}><Icon name="folder"/><span>{item.name}</span>{item.id === projectId && <Icon name="check"/>}</button>)}{!projects.some(item => matches(`${item.name} ${item.path}`)) && <p>No matching projects.</p>}</div><hr/><button role="menuitem" type="button" disabled={!connected || addingProject} onClick={() => { close(); onAddProject(); }}><Icon name="plus"/><span>{addingProject ? "Adding project…" : "New project"}</span></button><button role="menuitem" type="button" onClick={() => { onProject(null); close(); }}><Icon name="close"/><span>Don’t work in a project</span></button></>}
      {open === "hosts" && <div className="context-options">{hosts.filter(item => matches(item.name)).map(item => <button role="menuitemradio" aria-checked={item.hostId === hostId} key={item.key} type="button" disabled={!item.hostId} title={item.error} onClick={() => { if (item.hostId) { close(); onHost(item.hostId); } }}><Icon name="laptop"/><span>{item.local ? "Local" : item.name}<small>{item.local ? item.name : item.availability === "available" ? "Connected" : item.cached ? "Offline · cached projects" : item.availability}</small></span>{item.hostId === hostId && <Icon name="check"/>}</button>)}{!hosts.some(item => matches(item.name)) && <p>No matching hosts.</p>}</div>}
      {(open === "branches" || open === "create-branch") && <>
        {workspace?.cacheWarning && <p role="alert">{workspace.cacheWarning}</p>}
        {workspace?.errors.git && <p role="alert">{workspace.errors.git}</p>}{workspace?.errors.worktrees && <p role="alert">{workspace.errors.worktrees}</p>}
        {!connected && <p>Reconnect to switch branches.</p>}
        {workspace?.errors.action && <p role="alert">{workspace.errors.action}</p>}
        {workspace?.pending && <button type="button" disabled={!connected || workspace.busy} onClick={() => void workspace.retry()}>Retry original workspace command</button>}
        {open === "branches" ? <><div className="context-options context-branches"><p className="context-menu-heading">Branches</p>{workspace?.branches.filter(item => !item.remote && !item.symbolicTarget && matches(item.name)).map(item => <button type="button" role="menuitemradio" aria-checked={item.current} disabled={disabledGit} key={item.ref} onClick={() => { if (item.current) close(); else void checkout(item.name); }}><Icon name="branch"/><span>{item.name}</span>{item.current && <Icon name="check"/>}</button>)}{workspace?.loading.has("worktrees") && <p>Loading branches…</p>}</div><hr/><button type="button" role="menuitem" disabled={disabledGit} onClick={() => setOpen("create-branch")}><Icon name="plus"/><span>Create and checkout new branch…</span></button></> : <form onSubmit={event => { event.preventDefault(); void checkout(newBranch.trim(),true); }}><label>Branch name<input aria-label="New branch name" value={newBranch} onChange={event => setNewBranch(event.target.value)} placeholder="feature/name"/></label><div className="context-form-actions"><button type="button" onClick={() => setOpen("branches")}>Back</button><button type="submit" disabled={disabledGit || !newBranch.trim()}>Create branch</button></div></form>}
      </>}
    </div>,document.body)}
  </div>;
}
