import { createRoot } from "react-dom/client";
import { useMemo, useState } from "react";
import type { HostState, Project } from "../../packages/shared/src/protocol";
import { OrganizedSidebar } from "../../apps/desktop/src/renderer/OrganizedSidebar";
import { sidebarLayout } from "../../apps/desktop/src/renderer/sidebar-layout";

const original: Project = { id: "home-project", hostId: "home", name: "Original", path: "/fixture/original", createdAt: 1 };
const remote: Project = { id: "remote-project", hostId: "work", name: "Remote", path: "/fixture/remote", createdAt: 1 };
const calls: Array<{ kind: string; project: Project; name?: string }> = [];
let releaseRename: ((failure?: string) => void) | undefined;
let replaceHome: ((project: Project) => void) | undefined;

function Fixture() {
  const [home, setHome] = useState(original), [expanded, setExpanded] = useState(new Set<string>());
  replaceHome = setHome;
  const groups = useMemo(() => [
    { host: { hostId: "home", key: "home", name: "Home", availability: "available" as const, local: true }, hostState: { host: { id: "home", name: "Home", platform: "darwin", architecture: "arm64" }, projects: [home], sessions: [] } },
    { host: { hostId: "work", key: "work", name: "Work", availability: "available" as const, local: false }, hostState: { host: { id: "work", name: "Work", platform: "darwin", architecture: "arm64" }, projects: [remote], sessions: [] } },
  ] as { host: { hostId: string; key: string; name: string; availability: "available"; local: boolean }; hostState: HostState }[], [home]);
  const preferences = useMemo(() => ({ connected: true, busy: false, pending: [], sections: () => [], sectionFor: () => null, entity: () => undefined, put: async () => {}, putMany: async () => {} }), []);
  return <OrganizedSidebar layout={sidebarLayout(preferences, groups, "", false, expanded)} preferences={preferences as any} groups={groups} activeHostId="home" selectedId={null} query="" showArchived={false} collapsedSections={new Set()} onToggleSection={() => {}} expandedProjects={expanded} onToggleProject={key => setExpanded(value => { const next = new Set(value); next.has(key) ? next.delete(key) : next.add(key); return next; })} onNavigate={() => {}} onNew={() => {}} onAddProject={() => {}} addingProject={false} connected onToggleArchived={() => {}} localHostId="home" onRenameProject={(project, name) => new Promise((resolve, reject) => { calls.push({ kind: "rename", project, name }); releaseRename = failure => failure ? reject(new Error(failure)) : resolve(); })} onRemoveProject={async project => { calls.push({ kind: "remove", project }); }} onRevealProject={async project => { calls.push({ kind: "reveal", project }); }}/>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
const text = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].map(node => node.textContent?.trim() ?? "").join(" ");
Object.assign(window, {
  sidebarProjectTarget: (selector: string) => { const node = document.querySelector<HTMLElement>(selector); if (!node) throw new Error(`Missing ${selector}`); const box = node.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; },
  sidebarProjectTextTarget: (value: string) => { const node = [...document.querySelectorAll<HTMLElement>("button")].find(candidate => candidate.textContent?.trim() === value); if (!node) throw new Error(`Missing button ${value}`); const box = node.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; },
  sidebarProjectReplace: () => replaceHome?.({ ...original, name: "Replacement", path: "/fixture/replacement" }),
  sidebarProjectRestore: () => replaceHome?.(original),
  sidebarProjectReleaseRename: (failure?: string) => releaseRename?.(failure),
  sidebarProjectState: () => ({ dialog: document.querySelector("dialog[open]")?.textContent?.replace(/\s+/g, " ").trim() ?? "", menu: text(".sidebar-organization-menu"), calls: calls.map(call => ({ ...call, project: { ...call.project } })), active: (document.activeElement as HTMLElement | null)?.getAttribute("aria-label") ?? "", revealVisible: text(".sidebar-organization-menu").includes("Reveal in Finder") }),
});
