import { useEffect, useId, useReducer, useState, type ReactNode } from "react";
import type { SessionActivitySnapshot } from "@agent-desktop/shared";
import type { EnvironmentSectionKey } from "../window-state";
import { Icon } from "./Icons";
import type { WorkspaceState } from "./workspace-state";
import type { BranchSwitchRequest } from "./BranchSwitchDialog";
import { BranchSelector } from "./BranchSelector";
import { GitSubmissionButton } from "./GitSubmissionDialog";
import "./environment-card.css";

export interface EnvironmentSource { id: string; label: string; kind: "image" | "file"; onOpen(): void }
export interface EnvironmentCardProps {
  hostName: string; cwd: string; local: boolean; connected: boolean; workspace: WorkspaceState;
  activity?: SessionActivitySnapshot | null; activityError?: string; sources: readonly EnvironmentSource[];
  onReview(): void; onCommit(): void; onFiles(): void; onTerminal(): void; onHost(): void;
  branchPrefix: string; onOpenGitSettings(): void; onCheckoutBlocked?(request: BranchSwitchRequest): void;
  collapsedSections: readonly EnvironmentSectionKey[]; onToggleSection(key: EnvironmentSectionKey): void;
  showEmptySources?: boolean; actions?: ReactNode; compoundGit?: boolean;
  sideChats?: readonly { id: string; title: string; unread: boolean; onOpen(): void }[];
}

export function EnvironmentCard({ hostName, cwd, local, connected, workspace, activity, activityError, sources, onReview, onCommit, onFiles, onTerminal, onHost, branchPrefix, onOpenGitSettings, onCheckoutBlocked, collapsedSections, onToggleSection, showEmptySources = false, actions, compoundGit, sideChats = [] }: EnvironmentCardProps) {
  const [, redraw] = useReducer(value => value + 1, 0);
  const [expandedSources, setExpandedSources] = useState(false);
  useEffect(() => workspace.subscribe(redraw), [workspace]);
  const status = workspace.status;
  const staged = status?.entries.filter(entry => ![".", " ", "?"].includes(entry.indexStatus)) ?? [];
  const changed = new Set(status?.entries.filter(entry => entry.kind === "untracked" || ![".", " "].includes(entry.indexStatus) || ![".", " "].includes(entry.worktreeStatus)).map(entry => entry.path) ?? []);
  const conflict = status?.entries.some(entry => entry.kind === "conflict") ?? false;
  const commitDisabled = !connected || !staged.length || conflict || workspace.busy || Boolean(workspace.pending);
  const commitReason = conflict ? "Resolve conflicts first" : !connected ? "Offline" : !staged.length ? "Nothing staged" : "Unavailable";
  const shownSources = expandedSources ? sources : sources.slice(0, 3);
  const section = (key: EnvironmentSectionKey) => ({ sectionKey: key, collapsed: collapsedSections.includes(key), onToggle: () => onToggleSection(key) });
  return <aside className="environment-card" aria-label="Environment summary">
    <SummarySection {...section("environment")} title="Environment" actions={actions}>
      <button className="environment-row" disabled={!status} onClick={onReview} title={status ? `${changed.size} files${staged.length ? ` · ${staged.length} staged` : ""}${conflict ? " · conflicts" : ""}` : "Changes unavailable"}><Icon name="sliders"/><span>Changes</span></button>
      <div className="environment-row environment-host"><button onClick={onHost} title={`${connected ? "" : "Offline · "}${cwd || hostName}`}><Icon name="laptop"/><span>{local ? "Local" : hostName}</span></button><button className="environment-row-action" aria-label="Open terminal" title="Open terminal" disabled={!connected} onClick={onTerminal}><Icon name="terminal"/></button></div>
      <BranchSelector onCheckoutBlocked={onCheckoutBlocked} workspace={workspace} connected={connected} branchPrefix={branchPrefix} onOpenGitSettings={onOpenGitSettings} variant="environment" repositoryName={cwd.split(/[\\/]/).filter(Boolean).at(-1)}/>
      {compoundGit ? <GitSubmissionButton data={workspace} className="environment-row" onOpen={onCommit}/> : <button className="environment-row" disabled={commitDisabled} onClick={onCommit} title={commitDisabled ? commitReason : `Commit ${staged.length} staged ${staged.length === 1 ? "file" : "files"}`}><Icon name="check"/><span>Commit</span></button>}
    </SummarySection>
    {sideChats.length > 0 && <SummarySection {...section("side-chats")} title="Side chats" count={sideChats.length}>{sideChats.map(chat => <button className="environment-row" key={chat.id} onClick={chat.onOpen}><Icon name="sideChat"/><span>{chat.title}</span>{chat.unread && <i className="dock-unread" aria-label="Unread answer"/>}</button>)}</SummarySection>}
    <NativeActivity activity={activity} error={activityError} collapsedSections={collapsedSections} onToggleSection={onToggleSection}/>
    {(sources.length > 0 || showEmptySources) && <SummarySection {...section("sources")} title="Sources" count={sources.length} actions={<button type="button" className="icon-button" aria-label="Browse source files" title="Browse files" onClick={onFiles}><Icon name="plus"/></button>}>
      {shownSources.length ? <ul className="environment-sources">{shownSources.map(source => <li key={source.id}><button onClick={source.onOpen} title={source.label}><Icon name={source.kind === "image" ? "compose" : "folder"}/><span>{source.label}</span></button></li>)}</ul> : <p className="environment-note">No consumed sources are available.</p>}
      {sources.length > 3 && <button className="environment-link" onClick={() => setExpandedSources(value => !value)}>{expandedSources ? "Show less" : "View all"}</button>}
    </SummarySection>}
  </aside>;
}

function SummarySection({ sectionKey, title, count, collapsed, onToggle, actions, children }: {
  sectionKey: EnvironmentSectionKey; title: string; count?: number; collapsed: boolean; onToggle(): void; actions?: ReactNode; children: ReactNode;
}) {
  const id = useId();
  return <section className="environment-section" data-section={sectionKey}>
    <header className="environment-section-header"><button type="button" className="environment-section-toggle" aria-expanded={!collapsed} aria-controls={id} onClick={onToggle}><span>{title}</span>{collapsed && Boolean(count) && <span className="environment-section-count">{count}</span>}<Icon name="chevron"/></button>{actions && <div className="environment-section-actions">{actions}</div>}</header>
    <div id={id} className="environment-section-body" hidden={collapsed}>{children}</div>
  </section>;
}

function NativeActivity({ activity, error, collapsedSections, onToggleSection }: Pick<EnvironmentCardProps, "activity" | "collapsedSections" | "onToggleSection"> & { error?: string }) {
  const section = (key: EnvironmentSectionKey) => ({ sectionKey: key, collapsed: collapsedSections.includes(key), onToggle: () => onToggleSection(key) });
  if (error) return <SummarySection {...section("subagents")} title="Subagents"><p className="environment-note" role="alert">{error}</p></SummarySection>;
  if (!activity) return null;
  const { agents, jobs } = activity;
  const agentRows = agents.availability === "available" ? agents.value : [];
  const jobRows = jobs.availability === "available" ? [...jobs.value.running, ...jobs.value.recent] : [];
  return <>
    {(agents.availability !== "available" || agentRows.length > 0) && <SummarySection {...section("subagents")} title="Subagents" count={agentRows.length}>
      {agents.availability !== "available" ? <p className="environment-note" role="status">{agents.reason}</p> : <ul className="environment-native-list">{agentRows.map(agent => <li key={agent.id}><span>{agent.displayName} · {agent.status}</span><code>{agent.id}</code></li>)}</ul>}
    </SummarySection>}
    {(jobs.availability !== "available" || jobRows.length > 0) && <SummarySection {...section("jobs")} title="Jobs" count={jobRows.length}>
      {jobs.availability !== "available" ? <p className="environment-note" role="status">{jobs.reason}</p> : <ul className="environment-native-list">{jobRows.map(job => <li key={job.id}><span>{job.label} · {job.status}</span><code>{job.id}</code></li>)}</ul>}
    </SummarySection>}
  </>;
}
