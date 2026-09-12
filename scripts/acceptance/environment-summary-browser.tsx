import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { SessionActivitySnapshot } from "../../packages/shared/src/session-activity";
import { EnvironmentCard } from "../../apps/desktop/src/renderer/EnvironmentCard";
import type { EnvironmentSectionKey } from "../../apps/desktop/src/window-state";
import type { WorkspaceState } from "../../apps/desktop/src/renderer/workspace-state";
import "../../apps/desktop/src/renderer/styles.css";

const calls: string[] = [];
const listeners = new Set<() => void>();
const workspace = {
  status: { branch: "main", entries: [], revision: "fixture", ahead: 0, behind: 0 },
  busy: false,
  pending: undefined,
  loading: new Set(),
  branches: [], errors: {}, restored: true, connected: true,
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
} as unknown as WorkspaceState;
const emptyActivity = (): SessionActivitySnapshot => ({
  protocolVersion: 1, hostId: "fixture-host", sessionId: "fixture-session",
  goal: { availability: "available", value: null },
  agents: { availability: "available", value: [] },
  jobs: { availability: "available", value: { running: [], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } } },
  sources: { availability: "available", value: [] },
});
const activeActivity = (): SessionActivitySnapshot => ({
  ...emptyActivity(),
  agents: { availability: "available", value: [{ id: "agent-1", displayName: "Scout", status: "running", running: true, createdAt: 1, lastActivity: 2 }] },
  jobs: { availability: "available", value: { running: [{ id: "job-1", type: "task", status: "running", label: "Index files", startTime: 1 }], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } } },
});
const unavailableActivity = (): SessionActivitySnapshot => ({
  ...emptyActivity(),
  agents: { availability: "unavailable", reason: "Agents are unavailable" },
  jobs: { availability: "unsupported", reason: "Jobs are unsupported" },
});
const sources = [{ id: "source-1", label: "design.png", kind: "image" as const, onOpen: () => calls.push("source") }];
const chats = [{ id: "chat-1", title: "Planning", unread: true, onOpen: () => calls.push("side-chat") }];

function Fixture() {
  const [mode, setMode] = useState<"empty" | "unavailable" | "active">("empty");
  const [collapsed, setCollapsed] = useState<readonly EnvironmentSectionKey[]>([]);
  const activity = mode === "active" ? activeActivity() : mode === "unavailable" ? unavailableActivity() : emptyActivity();
  const toggle = (key: EnvironmentSectionKey) => setCollapsed(current => current.includes(key) ? current.filter(value => value !== key) : [...current, key]);
  const unrelatedRedraw = () => listeners.forEach(listener => listener());
  return <main>
    <button id="external-trigger" type="button">External</button>
    <button id="mode-empty" type="button" onClick={() => setMode("empty")}>Empty</button>
    <button id="mode-unavailable" type="button" onClick={() => setMode("unavailable")}>Unavailable</button>
    <button id="mode-active" type="button" onClick={() => setMode("active")}>Active</button>
    <button id="unrelated-redraw" type="button" onClick={unrelatedRedraw}>Unrelated redraw</button>
    <EnvironmentCard branchPrefix="codex/" onOpenGitSettings={() => calls.push("git-settings")} hostName="Fixture" cwd="/fixture" local connected workspace={workspace} activity={activity} sources={mode === "active" ? sources : []} sideChats={mode === "active" ? chats : []} collapsedSections={collapsed} onToggleSection={toggle} showEmptySources={false}
      onReview={() => calls.push("review")} onCommit={() => calls.push("commit")} onFiles={() => calls.push("files")} onTerminal={() => calls.push("terminal")} onHost={() => calls.push("host")}/>
  </main>;
}

createRoot(document.querySelector("#root")!).render(<Fixture />);

function section(name: string) { return document.querySelector<HTMLElement>(`.environment-section[data-section="${name}"]`); }
function snapshot() {
  const card = document.querySelector<HTMLElement>(".environment-card")!;
  const rect = card.getBoundingClientRect();
  return {
    calls: [...calls], active: (document.activeElement as HTMLElement | null)?.id ?? (document.activeElement as HTMLElement | null)?.getAttribute("aria-controls") ?? null,
    sections: [...document.querySelectorAll<HTMLElement>(".environment-section")].map(value => ({ key: value.dataset.section, expanded: value.querySelector<HTMLButtonElement>(".environment-section-toggle")?.getAttribute("aria-expanded"), hidden: value.querySelector<HTMLElement>(".environment-section-body")?.hidden })),
    viewport: { card: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, width: innerWidth, height: innerHeight },
  };
}
Object.assign(window, {
  environmentSummaryState: snapshot,
  environmentSummaryTarget(selector: string) { const item = document.querySelector<HTMLElement>(selector); if (!item) throw new Error(`Missing ${selector}`); const rect = item.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; },
  environmentSummarySection(name: string) { const item = section(name); if (!item) throw new Error(`Missing section ${name}`); return item.querySelector<HTMLButtonElement>(".environment-section-toggle")!.getBoundingClientRect(); },
});
