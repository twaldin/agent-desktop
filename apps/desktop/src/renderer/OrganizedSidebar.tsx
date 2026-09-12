import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { HostState, Project } from "../../../../packages/shared/src/protocol";
import type { PreferenceChange } from "../../../../packages/shared/src/preferences";
import type { HostOption } from "./host-catalog";
import { PreferencesState } from "./preferences-state";
import { Icon } from "./Icons";

import { sidebarItemKey, type SidebarItem as Item, type SidebarLayout } from "./sidebar-layout";
import { SidebarPinIcon } from "./sidebar-icons";
import "./organized-sidebar.css";
import type { SidebarSectionKey } from "../window-state";
interface Props {
  layout: SidebarLayout;
  preferences: PreferencesState; groups: { host: HostOption; hostState: HostState }[];
  activeHostId: string; selectedId: string | null; activeProjectId?: string; query: string; showArchived: boolean;
  collapsedSections: ReadonlySet<SidebarSectionKey>; onToggleSection(key: SidebarSectionKey): void;
  expandedProjects: Set<string>; onToggleProject(key: string): void;
  onNavigate(id: string | null, hostId?: string): void; onNew(projectId?: string, hostId?: string): void;
  onArchive?(sessionId: string, hostId: string, archived: boolean): void;
  onAddProject(): void; addingProject: boolean; connected: boolean; onToggleArchived(): void;
  localHostId: string | null;
  onRenameProject(project: Project, name: string): Promise<void>;
  onRemoveProject(project: Project): Promise<void>;
  onRevealProject(project: Project): Promise<void>;
}
export function OrganizedSidebar(props: Props) {
  const { preferences: data, groups, query, showArchived } = props;
  const [menu, setMenu] = useState<string>();
  const [menuProject, setMenuProject] = useState<{ key: string; project: Project }>();
  const collapsed = props.collapsedSections;
  const [hovered, setHovered] = useState<{ key: string; left: number; top: number }>();
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const menuRef = useRef<HTMLDivElement>(null);
  const clearHover = () => { clearTimeout(hoverTimer.current); setHovered(undefined); };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  function beginHover(item: Item, element: HTMLDivElement) {
    clearHover();
    const bounds = element.getBoundingClientRect();
    hoverTimer.current = setTimeout(() => setHovered({ key: sidebarItemKey(item), left: Math.min(bounds.right + 8, window.innerWidth - 328), top: Math.max(8, Math.min(bounds.top, window.innerHeight - 150)) }), 700);
  }
  const isCollapsed = (id: SidebarSectionKey) => !query.trim() && collapsed.has(id);
  function sectionHeading(id: SidebarSectionKey, label: string, actions?: ReactNode) {
    return <div className="section-heading"><button className="sidebar-section-toggle" aria-expanded={!isCollapsed(id)} onClick={() => { clearHover(); props.onToggleSection(id); }}><span className="truncate">{label}</span><Icon name="chevron" className={isCollapsed(id) ? "" : "rotated"}/></button>{actions}</div>;
  }
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState({left:0,top:0});
  function toggleMenu(id: string, button: HTMLButtonElement, project?: Project) { clearHover(); menuTrigger.current = button; const bounds = button.getBoundingClientRect(); setMenuPosition({left: Math.min(bounds.right + 4, window.innerWidth - 216), top: Math.max(8, Math.min(bounds.top, window.innerHeight - 248))}); const opening = menu !== id; setMenu(opening ? id : undefined); setMenuProject(opening && project ? { key: id, project: { ...project } } : undefined); }
  const [dialog, setDialog] = useState<{ id?: string; name: string }>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  type ProjectDialog = { token: number; kind: "edit" | "remove"; project: Project; name: string; pending: boolean; error?: string };
  const [projectDialog, setProjectDialog] = useState<ProjectDialog>();
  const projectDialogRef = useRef<HTMLDialogElement>(null);
  const projectDialogOpener = useRef<HTMLElement | null>(null);
  const projectDialogToken = useRef(0);
  const [projectAction, setProjectAction] = useState<{ token: number; error?: string }>();
  const { sections, projects, allItems, sectionOf, position, pinned, custom, hostProjects, loose, projectChildren, projectExpanded } = props.layout;
  const writable = data.connected && !data.busy && !data.pending.length;
  useEffect(() => { if (!menu) return; const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setMenu(undefined); menuTrigger.current?.focus(); } }; const focus = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("button:enabled")?.focus()); window.addEventListener("keydown", close); return () => { cancelAnimationFrame(focus); window.removeEventListener("keydown", close); }; }, [menu]);
  useEffect(() => { if (dialog) { if (!dialogRef.current?.open) dialogRef.current?.showModal(); dialogRef.current?.querySelector("input")?.focus(); } else dialogRef.current?.close(); }, [Boolean(dialog)]);
  useEffect(() => {
    const element = projectDialogRef.current;
    if (projectDialog) {
      if (!element?.open) element?.showModal();
      element?.querySelector<HTMLInputElement>(projectDialog.kind === "edit" ? "input" : "button.primary-button")?.focus();
      return;
    }
    element?.close();
    const opener = projectDialogOpener.current;
    projectDialogOpener.current = null;
    if (opener?.isConnected) requestAnimationFrame(() => opener.focus({ preventScroll: true }));
  }, [projectDialog?.token]);
  function openProjectDialog(kind: ProjectDialog["kind"], project: Project) {
    projectDialogOpener.current = menuTrigger.current;
    const token = ++projectDialogToken.current;
    setMenu(undefined);
    setProjectDialog({ token, kind, project: { ...project }, name: project.name, pending: false });
  }
  function projectError(error: unknown) { return error instanceof Error ? error.message : "The project action could not be completed."; }
  async function renameProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const current = projectDialog;
    if (!current || current.kind !== "edit" || current.pending || !current.name.trim()) return;
    const name = current.name.trim();
    setProjectDialog(value => value?.token === current.token ? { ...value, pending: true, error: undefined } : value);
    try { await props.onRenameProject(current.project, name); setProjectDialog(value => value?.token === current.token ? undefined : value); }
    catch (error) { setProjectDialog(value => value?.token === current.token ? { ...value, pending: false, error: projectError(error) } : value); }
  }
  async function removeProject() {
    const current = projectDialog;
    if (!current || current.kind !== "remove" || current.pending) return;
    setProjectDialog(value => value?.token === current.token ? { ...value, pending: true, error: undefined } : value);
    try { await props.onRemoveProject(current.project); setProjectDialog(value => value?.token === current.token ? undefined : value); }
    catch (error) { setProjectDialog(value => value?.token === current.token ? { ...value, pending: false, error: projectError(error) } : value); }
  }
  async function revealProject(project: Project) {
    if (projectAction) return;
    const token = ++projectDialogToken.current;
    setMenu(undefined); setProjectAction({ token });
    try { await props.onRevealProject({ ...project }); }
    catch (error) { setProjectAction(value => value?.token === token ? { token, error: projectError(error) } : value); return; }
    setProjectAction(value => value?.token === token ? undefined : value);
  }
  async function move(item: Item, sectionId: string | null) {
    setMenu(undefined);
    const target = allItems.filter(candidate => sectionOf(candidate) === sectionId);
    const next = Math.min(1e12, Math.max(-1024, ...target.map(position)) + 1024);
    await data.put({ key: `sidebar.${item.kind}.${item.value.id}`, value: { hostId: item.value.hostId, sectionId, position: next } });
  }
  async function reorder(item: Item, list: Item[], direction: -1 | 1) {
    setMenu(undefined); const index = list.findIndex(row => sidebarItemKey(row) === sidebarItemKey(item)); const other = index + direction;
    if (index < 0 || other < 0 || other >= list.length) return;
    const next = [...list]; [next[index], next[other]] = [next[other]!, next[index]!];
    await data.putMany(next.map((row, index): PreferenceChange => ({ key: `sidebar.${row.kind}.${row.value.id}`, value: { hostId: row.value.hostId, sectionId: sectionOf(row), position: index * 1024 } })));
  }
  async function reorderSection(id: string, direction: -1 | 1) {
    setMenu(undefined); const index = sections.findIndex(section => section.id === id); const other = index + direction;
    if (other < 0 || other >= sections.length) return;
    const next = [...sections]; [next[index], next[other]] = [next[other]!, next[index]!];
    await data.putMany(next.map((section, index) => ({ key: `sidebar.section.${section.id}`, value: { name: section.name, position: index * 1024 } })));
  }
  function itemMenu(item: Item, list: Item[], showTrigger = true) {
    const key = sidebarItemKey(item); const index = list.findIndex(row => sidebarItemKey(row) === sidebarItemKey(item));
    const project = item.kind === "project" ? item.value : undefined;
    const capturedProject = menuProject?.key === key ? menuProject.project : project;
    const canReveal = capturedProject !== undefined && capturedProject.hostId === props.localHostId && groups.find(group => group.hostState.host.id === capturedProject.hostId)?.host.availability === "available";
    const busy = Boolean(projectAction && !projectAction.error) || Boolean(projectDialog?.pending);
    return <div className="menu-anchor sidebar-item-menu">{showTrigger && <button className="icon-button small" aria-label={item.kind === "project" ? `Project actions for ${item.value.name}` : `Chat actions for ${item.value.title}`} aria-expanded={menu === key} onClick={event => toggleMenu(key, event.currentTarget, project)}><Icon name="more"/></button>}{menu === key && createPortal(<><button className="menu-dismiss" aria-label="Close organization menu" tabIndex={-1} onClick={() => setMenu(undefined)}/><div ref={menuRef} className="action-menu sidebar-organization-menu" style={menuPosition} onKeyDown={menuKeys}><button disabled={!writable || busy} onClick={() => void move(item, sectionOf(item) === "pinned" ? null : "pinned")}>{sectionOf(item) === "pinned" ? "Unpin" : "Pin"}</button>{capturedProject && <button disabled={busy} onClick={() => openProjectDialog("edit", capturedProject)}>Edit project</button>}<label>{capturedProject ? "Section" : "Move to"}<select aria-label={capturedProject ? "Project section" : "Move item to section"} value={sectionOf(item) ?? ""} disabled={!writable || busy} onChange={event => void move(item, event.target.value || null)}><option value="">Default location</option><option value="pinned">Pinned</option>{sections.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label>{capturedProject && canReveal && <button disabled={busy} onClick={() => void revealProject(capturedProject)}>Reveal in Finder</button>}<button disabled={!writable || busy || index <= 0} onClick={() => void reorder(item, list, -1)}>Move up</button><button disabled={!writable || busy || index < 0 || index === list.length - 1} onClick={() => void reorder(item, list, 1)}>Move down</button>{capturedProject && <button className="danger-menu-action" disabled={busy} onClick={() => openProjectDialog("remove", capturedProject)}>Remove project</button>}</div></>, document.body)}</div>;
  }
  function menuKeys(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.target instanceof HTMLSelectElement) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next]?.focus();
  }
  function sessionRow(item: Extract<Item, { kind: "session" }>, list: Item[]) {
    const session = item.value, key = sidebarItemKey(item), isPinned = sectionOf(item) === "pinned";
    const selected = props.selectedId === session.id && props.activeHostId === session.hostId;
    const host = groups.find(group => group.hostState.host.id === session.hostId)?.host;
    const project = projects.find(project => project.id === session.projectId && project.hostId === session.hostId);
    const pinLabel = isPinned ? "Unpin chat" : "Pin chat";
    const archiveLabel = session.archived ? "Unarchive chat" : "Archive chat";
    return <div className={`organized-session ${selected ? "selected" : ""}`} key={key} onMouseEnter={event => beginHover(item, event.currentTarget)} onMouseLeave={clearHover} onFocus={event => { if (event.target.matches(":focus-visible")) clearHover(); }} onContextMenu={event => { event.preventDefault(); const button = event.currentTarget.querySelector<HTMLButtonElement>(".session-row"); if (button) toggleMenu(key, button); }}>
      <button data-session-id={session.id} data-host-id={session.hostId} className={`session-row ${selected ? "selected" : ""}`} onClick={() => { clearHover(); props.onNavigate(session.id, session.hostId); }} aria-current={selected ? "page" : undefined}>
        <span className="sidebar-session-title">{session.title || "Untitled conversation"}</span>
        {session.status !== "idle" && <span className={`sidebar-session-status ${session.status}`} aria-label={session.status}/>}
      </button>
      <div className="sidebar-chat-actions">
        <button className="icon-button small" disabled={!writable} aria-label={pinLabel} title={pinLabel} onClick={() => { clearHover(); void move(item, isPinned ? null : "pinned"); }}><SidebarPinIcon pinned={isPinned}/></button>
        {props.onArchive && <button className="icon-button small" disabled={host?.availability !== "available"} aria-label={archiveLabel} title={archiveLabel} onClick={() => { clearHover(); props.onArchive?.(session.id, session.hostId, !session.archived); }}><Icon name="archive"/></button>}
      </div>
      {itemMenu(item, list, false)}
      {hovered?.key === key && !menu && createPortal(<div className="sidebar-chat-card" role="tooltip" style={{ left: hovered.left, top: hovered.top }}><div className="sidebar-chat-card-title"><strong>{session.title || "Untitled conversation"}</strong><span title={host?.name ?? session.hostId}><Icon name="laptop"/></span><time dateTime={new Date(session.updatedAt).toISOString()}>{relativeTime(session.updatedAt)}</time></div>{project && <div><Icon name="folder"/><span>{project.name}</span></div>}<div title={session.cwd}><Icon name="folder"/><span>{session.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? session.cwd}</span></div></div>, document.body)}
    </div>;
  }
  function projectRow(item: Extract<Item, { kind: "project" }>, list: Item[]) {
    const project = item.value; const key = `${project.hostId}:${project.id}`;
    const selected = props.selectedId === null && props.activeHostId === project.hostId && props.activeProjectId === project.id;
    const children = projectChildren(project);
    const expanded = projectExpanded(project);
    const host = groups.find(group => group.hostState.host.id === project.hostId)?.host;
    return <div className="project-group" data-project-id={project.id} data-host-id={project.hostId} key={sidebarItemKey(item)}><div className={`project-row ${selected ? "selected" : ""}`}><button className="project-label" aria-current={selected ? "page" : undefined} title={`${project.path}\n${host?.name ?? project.hostId}`} onClick={() => props.onToggleProject(key)} aria-expanded={expanded}><span className="sidebar-project-glyph"><Icon name="folder"/><Icon name="chevron" className={expanded ? "rotated" : ""}/></span><span className="truncate">{project.name}</span></button>{itemMenu(item, list)}<button className="icon-button small project-new" disabled={host?.availability !== "available"} aria-label={`Start new chat in ${project.name}`} title={`Start new chat in ${project.name}`} onClick={() => props.onNew(project.id, project.hostId)}><Icon name="compose"/></button></div>{expanded && <div className="project-sessions">{children.map(child => child.kind === "session" && sessionRow(child, children))}{!children.length && <p className="sidebar-empty nested">{query ? "No matching conversations" : showArchived ? "No archived conversations" : "No chats"}</p>}</div>}</div>;
  }
  const render = (item: Item, list: Item[]) => item.kind === "project" ? projectRow(item, list) : sessionRow(item, list);
  return <div className="organized-sidebar">
    {(data.error || data.cacheWarning || data.pending.length > 0) && <div className="sidebar-preference-error" role="status"><p>{data.error ?? data.cacheWarning ?? "Shared organization has pending changes."}</p><button disabled={!data.connected || data.busy} onClick={() => data.pending.length ? void data.retry() : void data.refresh()}>{data.pending.length ? "Retry saved changes" : "Refresh preferences"}</button></div>}
    {projectAction?.error && <div className="sidebar-project-action-error" role="alert"><span>{projectAction.error}</span><button className="icon-button small" aria-label="Dismiss project action error" onClick={() => setProjectAction(undefined)}><Icon name="close"/></button></div>}
    {pinned.length > 0 && <section aria-label="Pinned">{sectionHeading("pinned", "Pinned")}{!isCollapsed("pinned") && pinned.map(item => render(item, pinned))}</section>}
    {custom.map(({ section, items }, index) => { return <section key={section.id} aria-label={section.name} className="custom-sidebar-section">{sectionHeading(`custom:${section.id}`, section.name, <div className="menu-anchor"><button className="icon-button small" aria-label={`Options for ${section.name}`} aria-expanded={menu === `section:${section.id}`} onClick={event => toggleMenu(`section:${section.id}`, event.currentTarget)}><Icon name="more"/></button>{menu === `section:${section.id}` && createPortal(<><button className="menu-dismiss" aria-label="Close section menu" tabIndex={-1} onClick={() => setMenu(undefined)}/><div ref={menuRef} className="action-menu sidebar-organization-menu" style={menuPosition} onKeyDown={menuKeys}><button disabled={!writable} onClick={() => { setMenu(undefined); setDialog({ id: section.id, name: section.name }); }}>Edit section</button><button disabled={!writable || index === 0} onClick={() => void reorderSection(section.id, -1)}>Move up</button><button disabled={!writable || index === sections.length - 1} onClick={() => void reorderSection(section.id, 1)}>Move down</button><button disabled={!writable} onClick={() => { setMenu(undefined); void data.put({ key: `sidebar.section.${section.id}`, deleted: true }); }}>Delete section</button></div></>, document.body)}</div>)}{!isCollapsed(`custom:${section.id}`) && <>{items.map(item => render(item, items))}{!items.length && <p className="sidebar-empty">Move chats or projects here from their menus.</p>}</>}</section>; })}
    {sectionHeading("projects", "Projects", <div className="sidebar-section-actions"><button className="icon-button small" disabled={!writable} aria-label="New section" title="New section" onClick={() => setDialog({ name: "" })}><Icon name="compose"/></button><button className="icon-button small" onClick={props.onAddProject} disabled={!props.connected || props.addingProject} title="Add new project" aria-label="Add new project"><Icon name="plus"/></button></div>)}
    {!isCollapsed("projects") && <>
    {!projects.length && <p className="sidebar-empty">Add a folder to start working in a project.</p>}
    {groups.map(({ host }, index) => { const items = hostProjects[index]!; return <section key={host.key} className="host-projects" aria-label={`Projects on ${host.name}`}>
      {groups.length > 1 && <button className={`host-section-label ${props.activeHostId === host.hostId ? "current" : ""}`} onClick={() => props.onNavigate(null, host.hostId)} title={host.error ?? `${host.name} · ${host.availability}`}><span className={`connection-dot ${host.availability === "available" ? "online" : ""}`}/><span className="truncate">{host.name}</span><span>{host.local ? "Local" : host.availability === "available" ? "" : host.availability === "offline" ? "Offline" : "Unavailable"}</span></button>}{items.map(item => render(item, items))}
    </section>; })}</> }
    <div className="conversation-heading">{sectionHeading("recents", showArchived ? "Archived chats" : "Recents", <button className={`icon-button small ${showArchived ? "active" : ""}`} onClick={props.onToggleArchived} aria-pressed={showArchived} title={showArchived ? "Show active chats" : "Show archived chats"} aria-label={showArchived ? "Show active chats" : "Show archived chats"}><Icon name="archive"/></button>)}</div>
    {!isCollapsed("recents") && <>{loose.map(item => render(item, loose))}{!loose.length && <p className="sidebar-empty">{query ? "No chats found." : showArchived ? "No archived chats." : "No chats"}</p>}</>}
    <dialog ref={dialogRef} className="app-dialog" onCancel={() => setDialog(undefined)}><div className="dialog-header"><h2>{dialog?.id ? "Edit section" : "New section"}</h2><button className="icon-button" aria-label="Close dialog" onClick={() => setDialog(undefined)}><Icon name="close"/></button></div>{!dialog?.id && <p className="sidebar-section-description">Group chats and projects however you like</p>}<form onSubmit={event => { event.preventDefault(); if (!dialog?.name.trim() || !writable) return; const id = dialog.id ?? crypto.randomUUID(); const name = dialog.name.trim(); void data.put({ key: `sidebar.section.${id}`, value: { name, position: sections.find(section => section.id === id)?.position ?? sections.length * 1024 } }).then(() => { if (!data.error && !data.pending.length) setDialog(current => current && current.name.trim() !== name ? { ...current, id } : undefined); }); }}><label className="field-label" htmlFor="sidebar-section-name">Section name</label><input id="sidebar-section-name" className="text-field" value={dialog?.name ?? ""} maxLength={120} onChange={event => setDialog(value => value && { ...value, name: event.target.value })}/>{data.error && <p className="inline-error">{data.error}</p>}<div className="dialog-footer"><button type="button" className="secondary-button" onClick={() => setDialog(undefined)}>Cancel</button><button className="primary-button" disabled={!dialog?.name.trim() || !writable}>{dialog?.id ? "Save section" : "Create section"}</button></div></form></dialog>
    <dialog ref={projectDialogRef} className="app-dialog sidebar-project-dialog" onCancel={event => { event.preventDefault(); if (!projectDialog?.pending) setProjectDialog(undefined); }} onClick={event => { if (event.target === event.currentTarget && !projectDialog?.pending) setProjectDialog(undefined); }}>
      <div className="dialog-header"><h2>{projectDialog?.kind === "edit" ? "Edit project" : "Remove project"}</h2><button className="icon-button" aria-label="Close project dialog" disabled={projectDialog?.pending} onClick={() => setProjectDialog(undefined)}><Icon name="close"/></button></div>
      {projectDialog?.kind === "edit" ? <form onSubmit={renameProject}><label className="field-label" htmlFor="sidebar-project-name">Project name</label><input id="sidebar-project-name" className="text-field" value={projectDialog.name} maxLength={120} disabled={projectDialog.pending} onChange={event => setProjectDialog(value => value?.token === projectDialog.token ? { ...value, name: event.target.value } : value)}/>{projectDialog.error && <p className="inline-error" role="alert">{projectDialog.error}</p>}<div className="dialog-footer"><button type="button" className="secondary-button" disabled={projectDialog.pending} onClick={() => setProjectDialog(undefined)}>Cancel</button><button className="primary-button" disabled={projectDialog.pending || !projectDialog.name.trim()}>{projectDialog.pending ? "Saving…" : "Save project"}</button></div></form> : projectDialog && <><p className="sidebar-project-dialog-copy">Remove <strong>{projectDialog.project.name}</strong> from the project catalog?</p><p className="sidebar-project-dialog-copy">This removes project metadata only. Files and existing chats are not deleted.</p>{projectDialog.error && <p className="inline-error" role="alert">{projectDialog.error}</p>}<div className="dialog-footer"><button type="button" className="secondary-button" disabled={projectDialog.pending} onClick={() => setProjectDialog(undefined)}>Cancel</button><button className="primary-button danger-button" disabled={projectDialog.pending} onClick={() => void removeProject()}>{projectDialog.pending ? "Removing…" : "Remove project"}</button></div></>}
    </dialog>
  </div>;
}
function relativeTime(timestamp: number) { const seconds = Math.max(0, (Date.now() - timestamp) / 1000); return seconds < 60 ? "now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`; }
