import type { HostState, Project, SessionSummary } from "@agent-desktop/shared";
import { LEGACY_SIDEBAR_ORGANIZATION, type SidebarOrganization, type SidebarSort } from "../../../../packages/shared/src/preferences";
import { positionOrder, type PreferencesState } from "./preferences-state";

import { sessionUnreadKey } from "./session-read-state";

export type SidebarItem = { kind: "project"; value: Project } | { kind: "session"; value: SessionSummary };
export const sidebarItemKey = (item: SidebarItem) => JSON.stringify([item.kind, item.value.hostId, item.value.id]);

type Organization = Pick<PreferencesState, "sections" | "sectionFor" | "entity"> & { sidebarOrganization?: () => SidebarOrganization; pinnedSort?: () => SidebarSort; get?: (key: "sidebar.organization" | "sidebar.pinnedSort") => SidebarOrganization | SidebarSort | undefined };
export interface SidebarChatTarget { hostId: string; sessionId: string }

/** One logical ordering for rendered rows and numbered chat navigation. Sidebar
 * collapse, project collapse and scroll position do not change logical slots. */
export function sidebarLayout(data: Organization, groups: readonly { hostState: Pick<HostState, "host" | "projects" | "sessions" | "notifications"> }[],
  query: string, showArchived: boolean, expandedProjects: ReadonlySet<string>, unread: ReadonlySet<string> = new Set()) {
  const organization = data.sidebarOrganization?.() ?? data.get?.("sidebar.organization") as SidebarOrganization | undefined ?? LEGACY_SIDEBAR_ORGANIZATION;
  const pinnedSort = data.pinnedSort?.() ?? data.get?.("sidebar.pinnedSort") as SidebarSort | undefined ?? "manual";
  const sections = data.sections();
  const projects = groups.flatMap(group => group.hostState.projects);
  const sessions = groups.flatMap(group => group.hostState.sessions)
    .filter(session => session.archived === showArchived && (!query.trim() || `${session.title} ${session.cwd}`.toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const allItems: SidebarItem[] = [...projects.map(value => ({ kind: "project" as const, value })), ...sessions.map(value => ({ kind: "session" as const, value }))];
  const sectionOf = (item: SidebarItem) => data.sectionFor(item.kind, item.value.id, item.value.hostId);
  const position = (item: SidebarItem) => data.entity(item.kind, item.value.id, item.value.hostId)?.position ?? allItems.indexOf(item) * 1024;
  const ordered = (items: SidebarItem[]) => {
    const lastSaved = Math.max(-1024, ...items.map(item => data.entity(item.kind, item.value.id, item.value.hostId)?.position ?? -1024));
    return items.map((item, index) => ({ item, id: sidebarItemKey(item), position: data.entity(item.kind, item.value.id, item.value.hostId)?.position ?? lastSaved + (index + 1) * 1024 }))
      .sort(positionOrder).map(row => row.item);
  };
  const grouped = (id: string) => ordered(allItems.filter(item => sectionOf(item) === id));
  let pinned = grouped("pinned");
  const custom = sections.map(section => ({ section, items: grouped(section.id) }));
  const waiting = new Set(groups.flatMap(group => (group.hostState.notifications ?? []).filter(notice => notice.state === "open" && (notice.kind === "permission" || notice.kind === "question"))
    .map(notice => sessionUnreadKey(group.hostState.host.id, notice.sessionId))));
  const metrics = new Map<string, { updated: number; priority: number }>();
  for (const item of allItems) {
    const members = item.kind === "session" ? [item.value] : sessions.filter(session => session.hostId === item.value.hostId && session.projectId === item.value.id);
    metrics.set(sidebarItemKey(item), { updated: Math.max(0, ...members.map(session => session.updatedAt)),
      priority: Math.min(3, ...members.map(session => waiting.has(sessionUnreadKey(session.hostId, session.id)) ? 0 : unread.has(sessionUnreadKey(session.hostId, session.id)) ? 1 : session.status === "running" ? 2 : 3)) });
  }
  const sorted = (items: SidebarItem[], mode: SidebarSort) => mode === "manual" ? ordered(items) : [...items].sort((a, b) => {
    const left = metrics.get(sidebarItemKey(a))!, right = metrics.get(sidebarItemKey(b))!;
    return (mode === "priority" ? left.priority - right.priority : 0) || right.updated - left.updated;
  });
  pinned = sorted(pinned, pinnedSort);
  const hostProjects = groups.map(group => sorted(allItems.filter(item => item.kind === "project" && item.value.hostId === group.hostState.host.id && sectionOf(item) === null), organization.projectSort));
  const defaultProjects = sorted(allItems.filter(item => item.kind === "project" && sectionOf(item) === null), organization.projectSort);
  const loose = sorted(allItems.filter(item => item.kind === "session" && sectionOf(item) === null
    && (!item.value.projectId || !projects.some(project => project.id === item.value.projectId && project.hostId === item.value.hostId)
      || organization.grouping === "list" && projects.some(project => project.id === item.value.projectId && project.hostId === item.value.hostId && data.sectionFor("project", project.id, project.hostId) === null))), organization.chatSort);
  const projectChildren = (project: Project) => sorted(allItems.filter(item => item.kind === "session" && item.value.hostId === project.hostId
    && item.value.projectId === project.id && sectionOf(item) === null), organization.projectSort);
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
  if (organization.grouping === "connection") for (const items of hostProjects) visit(items);
  else if (organization.grouping === "project") visit(defaultProjects);
  visit(loose);
  return { unread, organization, defaultProjects, sections, projects, sessions, allItems, sectionOf, position, ordered, pinned, custom, hostProjects, loose,
    projectChildren, projectExpanded, allChatSlots: chatSlots, chatSlots: chatSlots.slice(0, 9) };
}

export type SidebarLayout = ReturnType<typeof sidebarLayout>;

export async function moveSidebarItem(data: PreferencesState, layout: SidebarLayout, item: SidebarItem, sectionId: string | null) {
  const target = layout.allItems.filter(candidate => layout.sectionOf(candidate) === sectionId);
  const next = Math.min(1e12, Math.max(-1024, ...target.map(layout.position)) + 1024);
  const current = data.entity(item.kind, item.value.id, item.value.hostId);
  await data.put({ key: `sidebar.${item.kind}.${item.value.id}`, value: { hostId: item.value.hostId, sectionId, position: next, ...(current?.appearance ? { appearance: current.appearance } : {}) } });
}

/** Missing slots have no callback, so the dispatcher leaves their keys unhandled. */
export function sidebarChatActions(slots: readonly SidebarChatTarget[], navigate: (sessionId: string, hostId: string) => void) {
  const actions: Partial<Record<import("./app-shortcuts").NumberedChatShortcut, () => void>> = {};
  slots.slice(0, 9).forEach((target, index) => {
    actions[`thread-${index + 1}` as import("./app-shortcuts").NumberedChatShortcut] = () => navigate(target.sessionId, target.hostId);
  });
  return actions;
}
