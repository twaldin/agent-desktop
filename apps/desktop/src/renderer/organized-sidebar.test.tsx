import { expect, test } from "bun:test";
import { createElement, Fragment, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { HostState, Project, SessionSummary } from "@agent-desktop/shared";
import { sidebarItemKey, sidebarLayout } from "./sidebar-layout";
import type { PreferencesState } from "./preferences-state";
import type { SidebarSectionKey } from "../window-state";
import type { HostOption } from "./host-catalog";
import { PROJECT_APPEARANCE_COLORS, PROJECT_APPEARANCE_ICONS } from "../../../../packages/shared/src/preferences";
import { ProjectMarkerPicker } from "./ProjectMarkerPicker";

(globalThis as { window?: unknown; document?: unknown }).window = { innerWidth: 1_024, innerHeight: 768 };
(globalThis as { document?: unknown }).document = { body: {} };

// Whole maintained component with controlled React hook storage. Events below are
// the actual element callbacks; DOM effects, pointer timing and pixels need Electron.
const source = readFileSync(new URL("./OrganizedSidebar.tsx", import.meta.url), "utf8");
const compiled = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "createElement", jsxFragmentFactory: "Fragment" } } })
  .transformSync(source.replace(/^import .*;\n/gm, "").replace("export function OrganizedSidebar", "function OrganizedSidebar"));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...nodes(element.props.children)];
}
function label(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(label).join("");
  if (typeof node === "string") return node;
  return node && typeof node === "object" && "props" in node ? label((node as Element).props.children) : "";
}
function fixture() {
  const project = { hostId: "home", id: "project", name: "Example", path: "/example" } as Project;
  const chat = (hostId: string, projectId: string | null, status = "idle") => ({ hostId, id: "same", projectId, title: `${hostId} chat`, cwd: "/example", archived: false, status, updatedAt: 1_700_000_000_000 }) as SessionSummary;
  const groups = [
    { host: { hostId: "home", key: "home", name: "Home", availability: "available", local: true }, hostState: { host: { id: "home" }, projects: [project], sessions: [chat("home", "project", "running")] } },
    { host: { hostId: "work", key: "work", name: "Work", availability: "available", local: false }, hostState: { host: { id: "work" }, projects: [], sessions: [chat("work", null)] } },
  ] as { host: HostOption; hostState: HostState }[];
  const writes: unknown[] = [], navigations: unknown[] = [], archives: unknown[] = [], newChats: unknown[] = [], toggles: string[] = [], renamed: unknown[] = [], removed: unknown[] = [], revealed: unknown[] = [];
  const preferences = {
    connected: true, busy: false, pending: [],
    sections: () => [],
    sectionFor: (_kind: string, _id: string, hostId: string) => hostId === "work" ? "pinned" : null,
    entity: () => undefined,
    put: async (change: unknown) => { writes.push(change); },
    putMany: async (changes: unknown[]) => { writes.push(...changes); },
  } as unknown as PreferencesState;
  const expandedProjects = new Set(["home:project"]);
  const state: unknown[] = [], refs: { current: unknown }[] = []; let cursor = 0, refCursor = 0;
  const useState = (initial: any) => { const slot = cursor++; if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial; return [state[slot], (next: any) => { state[slot] = typeof next === "function" ? next(state[slot]) : next; }]; };
  const useRef = (initial: unknown) => refs[refCursor++] ??= { current: initial };
  const Component = new Function("sessionUnreadKey", "SidebarArchiveDialog", "createElement", "Fragment", "useState", "useRef", "useEffect", "useLayoutEffect", "createPortal", "sidebarItemKey", "Icon", "SidebarPinIcon", "ProjectMarker", "projectColor", "PROJECT_APPEARANCE_COLORS", "PROJECT_APPEARANCE_ICONS", "ProjectMarkerPicker", `${compiled}; return OrganizedSidebar;`)
    ((host: string, id: string) => JSON.stringify([host, id]), () => null, createElement, Fragment, useState, useRef, () => {}, () => {}, (node: ReactNode) => node, sidebarItemKey, () => null, () => null, () => null, () => "#000", PROJECT_APPEARANCE_COLORS, PROJECT_APPEARANCE_ICONS, ProjectMarkerPicker);
  const props = { preferences, groups, activeHostId: "home", selectedId: "same" as string | null, activeProjectId: undefined as string | undefined, query: "", showArchived: false, expandedProjects,
    onNavigate: (...args: unknown[]) => navigations.push(args), onNew: (...args: unknown[]) => newChats.push(args), onArchive: (...args: unknown[]) => archives.push(args),
    collapsedSections: new Set<SidebarSectionKey>(["recents"]), onToggleSection: (key: SidebarSectionKey) => { const next = new Set(props.collapsedSections); next.has(key) ? next.delete(key) : next.add(key); props.collapsedSections = next; },
    onToggleProject: (key: string) => toggles.push(key), onAddProject() {}, addingProject: false, connected: true, onToggleArchived() {}, localHostId: "home",
    onRenameProject: async (...args: unknown[]) => { renamed.push(args); }, onRemoveProject: async (...args: unknown[]) => { removed.push(args); }, onRevealProject: async (...args: unknown[]) => { revealed.push(args); },
  };
  const render = () => { cursor = refCursor = 0; return nodes(Component({ ...props, layout: sidebarLayout(preferences, groups, props.query, props.showArchived, expandedProjects) })); };
  const button = (name: string) => render().find(node => node.type === "button" && (node.props["aria-label"] ?? label(node.props.children)) === name)!;
  return { render, button, props, groups, writes, navigations, archives, newChats, toggles, renamed, removed, revealed };
}

function menuTrigger() { return { getBoundingClientRect: () => ({ right: 100, top: 20 }) } as unknown as DOMRect; }
function projectMenu(f: ReturnType<typeof fixture>) { const project = f.groups[0]!.hostState.projects.find(project => project.id === "project")!; f.button(`Project actions for ${project.name}`).props.onClick({ currentTarget: menuTrigger() }); }
function projectForm(f: ReturnType<typeof fixture>) { return f.render().find(node => node.type === "form" && nodes(node).some(child => child.props.id === "sidebar-project-name"))!; }
function markerPicker(f: ReturnType<typeof fixture>) { return f.render().find(node => node.type === ProjectMarkerPicker)!; }

test("unselected remote chat archive keeps the exact owner and does not navigate", () => {
  const f = fixture(), tree = f.render();
  const remoteRow = tree.find(node => node.props["data-host-id"] === "work")!;
  expect(remoteRow.props["aria-current"]).toBeUndefined();
  const container = tree.find(node => node.props.className === "organized-session ")!;
  const archive = nodes(container).find(node => node.props["aria-label"] === "Archive chat")!;
  archive.props.onClick();
  expect(f.archives).toEqual([["same", "work", true]]);
  expect(f.navigations).toEqual([]);
  expect(f.writes).toEqual([]);
});

test("pin action changes only organization, while row navigation preserves host identity", async () => {
  const f = fixture();
  f.button("Unpin chat").props.onClick();
  await Promise.resolve();
  expect(f.writes).toEqual([expect.objectContaining({ key: "sidebar.session.same", value: expect.objectContaining({ hostId: "work", sectionId: null }) })]);
  expect(f.navigations).toEqual([]);
  f.render().find(node => node.props["data-host-id"] === "work")!.props.onClick();
  expect(f.navigations).toEqual([["same", "work"]]);
});

test("section collapse hides its rows without moving chats or changing numbered slots", () => {
  const f = fixture();
  expect(f.button("Pinned").props["aria-expanded"]).toBe(true);
  expect(f.button("Recents").props["aria-expanded"]).toBe(false);
  f.button("Pinned").props.onClick();
  expect(f.button("Pinned").props["aria-expanded"]).toBe(false);
  expect(f.render().some(node => node.props["data-session-id"] === "same" && node.props["data-host-id"] === "work")).toBe(false);
  expect(f.render().some(node => node.props["data-session-id"] === "same" && node.props["data-host-id"] === "home")).toBe(true);
  expect(f.writes).toEqual([]);
  f.button("Pinned").props.onClick();
  expect(f.render().filter(node => node.props["data-session-id"] === "same")).toHaveLength(2);
});

test("a supplied sidebar query reveals matching rows without rewriting saved disclosure state", () => {
  const f = fixture(), sectionId = "9e9b7f1d-3261-4cad-8e66-fcaa78f14e76";
  f.props.preferences.sections = () => [{ id: sectionId, name: "Focus", position: 0 }];
  f.props.preferences.sectionFor = (_kind, id, hostId) => id === "custom" ? sectionId : hostId === "work" ? "pinned" : null;
  const original = f.groups[0]!.hostState.sessions[0]!;
  f.groups[0]!.hostState.sessions.push(
    { ...original, id: "loose", projectId: null, title: "Loose chat" },
    { ...original, id: "custom", projectId: null, title: "Custom chat" },
    { ...original, id: "other", projectId: null, title: "Unmatched notes" },
  );
  f.props.expandedProjects.clear();
  const saved: SidebarSectionKey[] = ["pinned", "projects", "recents", `custom:${sectionId}`];
  f.props.collapsedSections = new Set(saved);
  const targets = () => f.render().filter(node => node.props["data-session-id"])
    .map(node => [node.props["data-host-id"], node.props["data-session-id"]]);
  expect(targets()).toEqual([]);
  f.props.query = "chat";
  expect(targets()).toEqual([["work", "same"], ["home", "custom"], ["home", "same"], ["home", "loose"]]);
  expect([...f.props.collapsedSections]).toEqual(saved);
  expect([...f.props.expandedProjects]).toEqual([]);
  f.props.query = "";
  expect(targets()).toEqual([]);
  expect(f.writes).toEqual([]);
  expect(f.navigations).toEqual([]);
});

test("project label expands instead of creating, and unavailable hosts cannot create or archive", () => {
  const f = fixture();
  f.button("Example").props.onClick();
  expect(f.toggles).toEqual(["home:project"]);
  expect(f.newChats).toEqual([]);
  f.button("Start new chat in Example").props.onClick();
  expect(f.newChats).toEqual([["project", "home"]]);
  f.groups[0]!.host.availability = "offline";
  expect(f.button("Start new chat in Example").props.disabled).toBe(true);
  const home = f.render().find(node => node.props.className === "organized-session selected")!;
  expect(nodes(home).find(node => node.props["aria-label"] === "Archive chat")!.props.disabled).toBe(true);
});

test("row structure keeps age out of the idle row and exposes a trailing running status", () => {
  const f = fixture();
  expect(f.render().filter(node => node.type === "time")).toHaveLength(0);
  expect(f.render().filter(node => node.props.className === "sidebar-session-status running")).toHaveLength(1);
  expect(f.render().filter(node => node.props["aria-label"] === "Pin chat")).toHaveLength(1);
  expect(f.render().filter(node => node.props["aria-label"] === "Unpin chat")).toHaveLength(1);
});

test("project menu keeps pinned action order and captures the original owner for rename and removal", async () => {
  const f = fixture(); projectMenu(f);
  const labels = f.render().filter(node => node.type === "button").map(node => node.props["aria-label"] ?? label(node.props.children));
  expect(labels.indexOf("Pin")).toBeLessThan(labels.indexOf("Edit project"));
  expect(labels.indexOf("Edit project")).toBeLessThan(labels.indexOf("Reveal in Finder"));
  expect(labels.indexOf("Reveal in Finder")).toBeLessThan(labels.indexOf("Remove project"));
  f.groups[0]!.hostState.projects[0] = { ...f.groups[0]!.hostState.projects[0]!, name: "Replacement", path: "/replacement" };
  f.button("Edit project").props.onClick();
  f.render().find(node => node.props.id === "sidebar-project-name")!.props.onChange({ target: { value: "Renamed" } });
  await projectForm(f).props.onSubmit({ preventDefault() {} });
  expect(f.renamed).toEqual([[expect.objectContaining({ id: "project", hostId: "home", name: "Example" }), "Renamed"]]);
  projectMenu(f); f.button("Remove project").props.onClick();
  expect(f.render().filter(node => node.props.className === "sidebar-project-dialog-copy").map(node => label(node.props.children)).join(" ")).toContain("metadata only");
  await f.button("Remove project").props.onClick();
  expect(f.removed).toEqual([[expect.objectContaining({ id: "project", hostId: "home", name: "Replacement", path: "/replacement" })]]);
});

test("reveal is offered only for the local available host and rejected callbacks remain visible", async () => {
  const f = fixture(); projectMenu(f); await f.button("Reveal in Finder").props.onClick();
  expect(f.revealed).toEqual([[expect.objectContaining({ id: "project", hostId: "home" })]]);
  f.props.localHostId = "work"; projectMenu(f);
  expect(f.render().some(node => label(node.props.children) === "Reveal in Finder")).toBe(false);
  f.button("Project actions for Example").props.onClick({ currentTarget: menuTrigger() });
  f.props.localHostId = "home";
  f.props.onRevealProject = async () => { throw new Error("Finder is unavailable"); };
  projectMenu(f); await f.button("Reveal in Finder").props.onClick();
  expect(label(f.render().find(node => node.props.className === "sidebar-project-action-error")!.props.children)).toContain("Finder is unavailable");
});


test("new-chat project selection is host-bound and existing chat selection clears the project highlight", () => {
  const f = fixture();
  const remote = { ...f.groups[0]!.hostState.projects[0]!, hostId: "work", name: "Remote example" };
  f.groups[1]!.hostState.projects.push(remote);
  f.props.selectedId = null;
  f.props.activeProjectId = "project";
  expect(f.button("Example").props["aria-current"]).toBe("page");
  expect(f.button("Remote example").props["aria-current"]).toBeUndefined();
  f.props.activeHostId = "work";
  expect(f.button("Example").props["aria-current"]).toBeUndefined();
  expect(f.button("Remote example").props["aria-current"]).toBe("page");
  f.props.selectedId = "same";
  expect(f.button("Remote example").props["aria-current"]).toBeUndefined();
  expect(f.render().find(node => node.props["data-session-id"] === "same" && node.props["data-host-id"] === "work")!.props["aria-current"]).toBe("page");
  f.props.selectedId = null;
  f.props.activeProjectId = undefined;
  expect(f.button("Remote example").props["aria-current"]).toBeUndefined();
  expect(f.writes).toEqual([]);
  expect(f.navigations).toEqual([]);
});

test("project appearance picker preserves its owner and resets without moving the project", async () => {
  const f = fixture();
  f.groups[0]!.hostState.projects.unshift({ hostId: "home", id: "before", name: "Before", path: "/before" } as Project);
  const existing = { hostId: "home", sectionId: "pinned" as const, position: 2_048 };
  f.props.preferences.entity = (kind: string, id: string, hostId: string) => kind === "project" && id === "project" && hostId === "home" ? existing : undefined;
  projectMenu(f); f.button("Edit project").props.onClick();
  expect(f.render().some(node => node.type === "fieldset")).toBe(false);
  markerPicker(f).props.onChange({ kind: "color", color: "red" });
  markerPicker(f).props.onChange({ kind: "icon", icon: "terminal" });
  await projectForm(f).props.onSubmit({ preventDefault() {} });
  const appearance = { marker: { kind: "icon" as const, icon: "terminal" as const }, color: "red" as const };
  expect(f.writes[0]).toEqual({ key: "sidebar.project.project", value: { ...existing, appearance } });

  f.props.preferences.entity = (kind: string, id: string, hostId: string) => kind === "project" && id === "project" && hostId === "home" ? { ...existing, appearance } : undefined;
  projectMenu(f); f.button("Edit project").props.onClick();
  markerPicker(f).props.onChange({ kind: "reset" });
  await projectForm(f).props.onSubmit({ preventDefault() {} });
  expect(f.writes[1]).toEqual({ key: "sidebar.project.project", value: existing });

  f.props.preferences.entity = (kind: string, id: string, hostId: string) => kind === "project" && id === "project" && hostId === "home" ? existing : undefined;
  projectMenu(f); f.button("Edit project").props.onClick();
  markerPicker(f).props.onChange({ kind: "custom-color", value: "#" });
  expect(markerPicker(f).props.draft.customColor).toBe("#");
  markerPicker(f).props.onChange({ kind: "custom-color", value: "#3b82f6" });
  markerPicker(f).props.onChange({ kind: "icon", icon: "terminal" });
  await projectForm(f).props.onSubmit({ preventDefault() {} });
  expect(f.writes[2]).toEqual({ key: "sidebar.project.project", value: { ...existing, appearance: { marker: { kind: "icon", icon: "terminal" }, color: "#3B82F6" } } });

  f.props.preferences.entity = (kind: string, id: string, hostId: string) => kind === "project" && id === "before" && hostId === "home" ? { hostId, sectionId: "pinned", position: 0 } : undefined;
  f.props.preferences.sectionFor = (kind: string, id: string, hostId: string) => kind === "project" && id === "before" && hostId === "home" ? "pinned" : null;
  projectMenu(f); f.button("Edit project").props.onClick();
  markerPicker(f).props.onChange({ kind: "icon", icon: "terminal" });
  await projectForm(f).props.onSubmit({ preventDefault() {} });
  expect(f.writes[3]).toEqual({ key: "sidebar.project.project", value: { hostId: "home", sectionId: null, position: 0, appearance: { marker: { kind: "icon", icon: "terminal" }, color: "black" } } });
});

test("marker trigger owns a compact native popover with all project markers", () => {
  const html = renderToStaticMarkup(<ProjectMarkerPicker projectName="Example" draft={{ appearance: { marker: { kind: "icon", icon: "terminal" }, color: "#123456" }, color: "#123456", customColor: "#123456", emoji: "" }} onChange={() => {}}/>);
  expect(html).toContain('aria-label="Change icon and color for Example"');
  expect(html).toContain('popover="auto"');
  expect(html).toContain('popoverTargetAction="hide"');
  expect((html.match(/Use [a-z-]+ icon/g) ?? [])).toHaveLength(PROJECT_APPEARANCE_ICONS.length);
  expect((html.match(/Use [a-z]+ project color/g) ?? [])).toHaveLength(PROJECT_APPEARANCE_COLORS.length);
  expect((html.match(/#123456/g) ?? [])).toHaveLength(3); // trigger marker, trigger dot, and editable value; option glyphs stay neutral.
});


test("pinned options use their independent sort and Recents keeps new chat reachable", () => {
  const f = fixture();
  f.button("Pinned options").props.onClick({ currentTarget: menuTrigger() });
  const menuRows = f.render().filter(node => node.type === "button" && ["Priority", "Last updated", "Manual order"].some(name => label(node.props.children).startsWith(name)));
  expect(menuRows.filter(node => node.props["aria-checked"])).toHaveLength(1);
  expect(menuRows.find(node => label(node.props.children).startsWith("Manual order"))!.props.disabled).toBe(false);
  f.button("New chat").props.onClick();
  expect(f.newChats).toEqual([[undefined, "home"]]);
});

test("chat options retain archived filtering after Recents uses its reference new-chat action", () => {
  const f = fixture();
  f.button("Chat sidebar options").props.onClick({ currentTarget: menuTrigger() });
  expect(f.button("Show archived chats")).toBeDefined();
});
