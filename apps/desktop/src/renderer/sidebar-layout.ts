import type { HostState, Project, SessionSummary } from "@agent-desktop/shared";
import { positionOrder, type PreferencesState } from "./preferences-state";

export type SidebarItem = { kind: "project"; value: Project } | { kind: "session"; value: SessionSummary };
type Organization = Pick<PreferencesState, "sections" | "sectionFor" | "entity">;
export interface SidebarChatTarget { hostId: string; sessionId: string }

/** One logical ordering for rendered rows and numbered chat navigation. Sidebar
 * collapse, project collapse and scroll position do not change logical slots. */
export function sidebarLayout(data: Organization, groups: readonly { hostState: Pick<HostState, "host" | "projects" | "sessions"> }[],
  query: string, showArchived: boolean, expandedProjects: ReadonlySet<string>) {
  const sections = data.sections();
  const projects = groups.flatMap(group => group.hostState.projects);
  const sessions = groups.flatMap(group => group.hostState.sessions)
    .filter(session => session.archived === showArchived && (!query.trim() || `${session.title} ${session.cwd}`.toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const allItems: SidebarItem[] = [...projects.map(value => ({ kind: "project" as const, value })), ...sessions.map(value => ({ kind: "session" as const, value }))];
  const sectionOf = (item: SidebarItem) => data.sectionFor(item.kind, item.value.id, item.value.hostId);
  const position = (item: SidebarItem) => data.entity(item.kind, item.value.id, item.value.hostId)?.position ?? allItems.indexOf(item) * 1024;
  const ordered = (items: SidebarItem[]) => items.map((item, index) => ({ item, id: item.value.id, position: data.entity(item.kind, item.value.id, item.value.hostId)?.position ?? index * 1024 }))
    .sort(positionOrder).map(row => row.item);
  const grouped = (id: string) => ordered(allItems.filter(item => sectionOf(item) === id));
  const pinned = grouped("pinned");
  const custom = sections.map(section => ({ section, items: grouped(section.id) }));
  const hostProjects = groups.map(group => ordered(allItems.filter(item => item.kind === "project" && item.value.hostId === group.hostState.host.id && sectionOf(item) === null)));
  const loose = ordered(allItems.filter(item => item.kind === "session" && sectionOf(item) === null
    && (!item.value.projectId || !projects.some(project => project.id === item.value.projectId && project.hostId === item.value.hostId))));
  const projectChildren = (project: Project) => ordered(allItems.filter(item => item.kind === "session" && item.value.hostId === project.hostId
    && item.value.projectId === project.id && sectionOf(item) === null));
  const projectExpanded = (project: Project) => expandedProjects.has(`${project.hostId}:${project.id}`) || Boolean(query);
  const chatSlots: SidebarChatTarget[] = [];
  const visit = (items: SidebarItem[]) => {
    for (const item of items) {
      if (item.kind === "session") chatSlots.push({ hostId: item.value.hostId, sessionId: item.value.id });
      else visit(projectChildren(item.value));
    }
  };
  visit(pinned);
  for (const group of custom) visit(group.items);
  for (const items of hostProjects) visit(items);
  visit(loose);
  return { sections, projects, sessions, allItems, sectionOf, position, ordered, pinned, custom, hostProjects, loose,
    projectChildren, projectExpanded, chatSlots: chatSlots.slice(0, 9) };
}

export type SidebarLayout = ReturnType<typeof sidebarLayout>;

/** Missing slots have no callback, so the dispatcher leaves their keys unhandled. */
export function sidebarChatActions(slots: readonly SidebarChatTarget[], navigate: (sessionId: string, hostId: string) => void) {
  const actions: Partial<Record<import("./app-shortcuts").NumberedChatShortcut, () => void>> = {};
  slots.slice(0, 9).forEach((target, index) => {
    actions[`thread-${index + 1}` as import("./app-shortcuts").NumberedChatShortcut] = () => navigate(target.sessionId, target.hostId);
  });
  return actions;
}
