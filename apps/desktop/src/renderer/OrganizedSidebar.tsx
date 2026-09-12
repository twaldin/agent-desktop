import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HostState } from "../../../../packages/shared/src/protocol";
import type { PreferenceChange } from "../../../../packages/shared/src/preferences";
import type { HostOption } from "./host-catalog";
import { PreferencesState } from "./preferences-state";
import { Icon } from "./Icons";

import type { SidebarItem as Item, SidebarLayout } from "./sidebar-layout";
interface Props {
  layout: SidebarLayout;
  preferences: PreferencesState; groups: { host: HostOption; hostState: HostState }[];
  activeHostId: string; selectedId: string | null; query: string; showArchived: boolean;
  expandedProjects: Set<string>; onToggleProject(key: string): void;
  onNavigate(id: string | null, hostId?: string): void; onNew(projectId?: string, hostId?: string): void;
  onAddProject(): void; addingProject: boolean; connected: boolean; onToggleArchived(): void;
}
export function OrganizedSidebar(props: Props) {
  const { preferences: data, groups, query, showArchived } = props;
  const [menu, setMenu] = useState<string>();
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState({left:0,top:0});
  function toggleMenu(id: string, button: HTMLButtonElement) { menuTrigger.current = button; const bounds = button.getBoundingClientRect(); setMenuPosition({left: Math.min(bounds.right + 4, window.innerWidth - 216), top: Math.max(8, Math.min(bounds.top, window.innerHeight - 248))}); setMenu(value => value === id ? undefined : id); }
  const [dialog, setDialog] = useState<{ id?: string; name: string }>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { sections, projects, sessions, allItems, sectionOf, position, pinned, custom, hostProjects, loose, projectChildren, projectExpanded } = props.layout;
  const writable = data.connected && !data.busy && !data.pending.length;
  useEffect(() => { if (!menu) return; const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setMenu(undefined); menuTrigger.current?.focus(); } }; const focus = requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".sidebar-organization-menu button:enabled")?.focus()); window.addEventListener("keydown", close); return () => { cancelAnimationFrame(focus); window.removeEventListener("keydown", close); }; }, [menu]);
  useEffect(() => { if (dialog) { if (!dialogRef.current?.open) dialogRef.current?.showModal(); dialogRef.current?.querySelector("input")?.focus(); } else dialogRef.current?.close(); }, [Boolean(dialog)]);
  async function move(item: Item, sectionId: string | null) {
    setMenu(undefined);
    const target = allItems.filter(candidate => sectionOf(candidate) === sectionId);
    const next = Math.min(1e12, Math.max(-1024, ...target.map(position)) + 1024);
    await data.put({ key: `sidebar.${item.kind}.${item.value.id}`, value: { hostId: item.value.hostId, sectionId, position: next } });
  }
  async function reorder(item: Item, list: Item[], direction: -1 | 1) {
    setMenu(undefined); const index = list.findIndex(row => row.kind === item.kind && row.value.id === item.value.id); const other = index + direction;
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
  function itemMenu(item: Item, list: Item[]) {
    const key = `${item.kind}:${item.value.id}`; const index = list.findIndex(row => row.kind === item.kind && row.value.id === item.value.id);
    return <div className="menu-anchor sidebar-item-menu"><button className="icon-button small" aria-label={`Organize ${item.kind === "project" ? item.value.name : item.value.title}`} aria-expanded={menu === key} onClick={event => toggleMenu(key, event.currentTarget)}><Icon name="more"/></button>{menu === key && createPortal(<><button className="menu-dismiss" aria-label="Close organization menu" tabIndex={-1} onClick={() => setMenu(undefined)}/><div className="action-menu sidebar-organization-menu" style={menuPosition}><button disabled={!writable} onClick={() => void move(item, sectionOf(item) === "pinned" ? null : "pinned")}>{sectionOf(item) === "pinned" ? "Unpin" : "Pin"}</button><label>Move to<select aria-label="Move item to section" value={sectionOf(item) ?? ""} disabled={!writable} onChange={event => void move(item, event.target.value || null)}><option value="">Default location</option><option value="pinned">Pinned</option>{sections.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label><button disabled={!writable || index <= 0} onClick={() => void reorder(item, list, -1)}>Move up</button><button disabled={!writable || index < 0 || index === list.length - 1} onClick={() => void reorder(item, list, 1)}>Move down</button></div></>, document.body)}</div>;
  }
  function sessionRow(item: Extract<Item, { kind: "session" }>, list: Item[]) {
    const session = item.value;
    return <div className="organized-session" key={`session:${session.id}`}><button data-session-id={session.id} data-host-id={session.hostId} className={`session-row ${props.selectedId === session.id && props.activeHostId === session.hostId ? "selected" : ""}`} onClick={() => props.onNavigate(session.id, session.hostId)} aria-current={props.selectedId === session.id && props.activeHostId === session.hostId ? "page" : undefined} title={`${session.title}\n${session.cwd}`}><span className={`session-dot ${session.status}`} aria-label={session.status}/><span className="truncate">{session.title || "Untitled conversation"}</span><time dateTime={new Date(session.updatedAt).toISOString()}>{relativeTime(session.updatedAt)}</time></button>{itemMenu(item, list)}</div>;
  }
  function projectRow(item: Extract<Item, { kind: "project" }>, list: Item[]) {
    const project = item.value; const key = `${project.hostId}:${project.id}`;
    const children = projectChildren(project);
    const expanded = projectExpanded(project);
    const host = groups.find(group => group.hostState.host.id === project.hostId)?.host;
    return <div className="project-group" data-project-id={project.id} data-host-id={project.hostId} key={`project:${project.id}`}><div className="project-row"><button className="project-toggle" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`} onClick={() => props.onToggleProject(key)}><Icon name="chevron" className={expanded ? "rotated" : ""}/></button><button className="project-label" title={`${project.path}\n${host?.name ?? project.hostId}`} onClick={() => props.onNew(project.id, project.hostId)}><Icon name="folder"/><span className="truncate">{project.name}</span></button><button className="icon-button small project-new" aria-label={`New conversation in ${project.name}`} title={`New conversation in ${project.name}`} onClick={() => props.onNew(project.id, project.hostId)}><Icon name="compose"/></button>{itemMenu(item, list)}</div>{expanded && <div className="project-sessions">{children.map(child => child.kind === "session" && sessionRow(child, children))}{!children.length && <p className="sidebar-empty nested">{query ? "No matching conversations" : showArchived ? "No archived conversations" : "No conversations yet"}</p>}</div>}</div>;
  }
  const render = (item: Item, list: Item[]) => item.kind === "project" ? projectRow(item, list) : sessionRow(item, list);
  return <>
    {(data.error || data.cacheWarning || data.pending.length > 0) && <div className="sidebar-preference-error" role="status"><p>{data.error ?? data.cacheWarning ?? "Shared organization has pending changes."}</p><button disabled={!data.connected || data.busy} onClick={() => data.pending.length ? void data.retry() : void data.refresh()}>{data.pending.length ? "Retry saved changes" : "Refresh preferences"}</button></div>}
    {pinned.length > 0 && <section aria-label="Pinned"><div className="section-heading"><span>Pinned</span></div>{pinned.map(item => render(item, pinned))}</section>}
    {custom.map(({ section, items }, index) => { return <section key={section.id} aria-label={section.name} className="custom-sidebar-section"><div className="section-heading"><span className="truncate">{section.name}</span><div className="menu-anchor"><button className="icon-button small" aria-label={`Organize section ${section.name}`} aria-expanded={menu === section.id} onClick={event => toggleMenu(section.id, event.currentTarget)}><Icon name="more"/></button>{menu === section.id && createPortal(<><button className="menu-dismiss" aria-label="Close section menu" tabIndex={-1} onClick={() => setMenu(undefined)}/><div className="action-menu sidebar-organization-menu" style={menuPosition}><button disabled={!writable} onClick={() => { setMenu(undefined); setDialog({ id: section.id, name: section.name }); }}>Rename section</button><button disabled={!writable || index === 0} onClick={() => void reorderSection(section.id, -1)}>Move up</button><button disabled={!writable || index === sections.length - 1} onClick={() => void reorderSection(section.id, 1)}>Move down</button><button disabled={!writable} onClick={() => { setMenu(undefined); void data.put({ key: `sidebar.section.${section.id}`, deleted: true }); }}>Delete section</button></div></>, document.body)}</div></div>{items.map(item => render(item, items))}{!items.length && <p className="sidebar-empty">Move projects or conversations here from their menus.</p>}</section>; })}
    <div className="section-heading"><span>Projects</span><div className="sidebar-section-actions"><button className="icon-button small" disabled={!writable} aria-label="Create sidebar section" title="Create sidebar section" onClick={() => setDialog({ name: "" })}><Icon name="compose"/></button><button className="icon-button small" onClick={props.onAddProject} disabled={!props.connected || props.addingProject} title="Add project folder" aria-label="Add project folder"><Icon name="plus"/></button></div></div>
    {!projects.length && <p className="sidebar-empty">Add a folder to start working in a project.</p>}
    {groups.map(({ host }, index) => { const items = hostProjects[index]!; return <section key={host.key} className="host-projects" aria-label={`Projects on ${host.name}`}>
      {groups.length > 1 && <button className={`host-section-label ${props.activeHostId === host.hostId ? "current" : ""}`} onClick={() => props.onNavigate(null, host.hostId)} title={host.error ?? `${host.name} · ${host.availability}`}><span className={`connection-dot ${host.availability === "available" ? "online" : ""}`}/><span className="truncate">{host.name}</span><span>{host.local ? "Local" : host.availability === "available" ? "" : host.availability === "offline" ? "Offline" : "Unavailable"}</span></button>}{items.map(item => render(item, items))}
    </section>; })}
    <div className="section-heading conversation-heading"><span>{showArchived ? "Archived" : "Conversations"}</span><button className={`icon-button small ${showArchived ? "active" : ""}`} onClick={props.onToggleArchived} aria-pressed={showArchived} title={showArchived ? "Show active conversations" : "Show archived conversations"} aria-label={showArchived ? "Show active conversations" : "Show archived conversations"}><Icon name="archive"/></button></div>{loose.map(item => render(item, loose))}{!sessions.length && <p className="sidebar-empty">{query ? "No conversations found." : showArchived ? "Nothing archived." : "Your conversations will appear here."}</p>}
    <dialog ref={dialogRef} className="app-dialog" onCancel={() => setDialog(undefined)}><div className="dialog-header"><h2>{dialog?.id ? "Rename section" : "New sidebar section"}</h2><button className="icon-button" aria-label="Close section dialog" onClick={() => setDialog(undefined)}><Icon name="close"/></button></div><form onSubmit={event => { event.preventDefault(); if (!dialog?.name.trim() || !writable) return; const id = dialog.id ?? crypto.randomUUID(); const name = dialog.name.trim(); void data.put({ key: `sidebar.section.${id}`, value: { name, position: sections.find(section => section.id === id)?.position ?? sections.length * 1024 } }).then(() => { if (!data.error && !data.pending.length) setDialog(current => current && current.name.trim() !== name ? { ...current, id } : undefined); }); }}><label className="field-label" htmlFor="sidebar-section-name">Name</label><input id="sidebar-section-name" className="text-field" value={dialog?.name ?? ""} maxLength={120} onChange={event => setDialog(value => value && { ...value, name: event.target.value })}/>{data.error && <p className="inline-error">{data.error}</p>}<div className="dialog-footer"><button type="button" className="secondary-button" onClick={() => setDialog(undefined)}>Cancel</button><button className="primary-button" disabled={!dialog?.name.trim() || !writable}>Save section</button></div></form></dialog>
  </>;
}
function relativeTime(timestamp: number) { const seconds = Math.max(0, (Date.now() - timestamp) / 1000); return seconds < 60 ? "now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`; }
