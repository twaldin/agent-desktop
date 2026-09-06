import { useEffect, useReducer, useState, type ReactNode } from "react";
import type { SessionActivitySnapshot } from "@agent-desktop/shared";
import { Icon } from "./Icons";
import type { WorkspaceState } from "./workspace-state";
import "./environment-card.css";

export interface EnvironmentSource { id: string; label: string; kind: "image" | "file"; onOpen(): void }
export interface EnvironmentCardProps { hostName: string; cwd: string; local: boolean; connected: boolean; workspace: WorkspaceState; activity?: SessionActivitySnapshot | null; activityError?: string; sources: readonly EnvironmentSource[]; onReview(): void; onCommit(): void; onFiles(): void; onTerminal(): void; onHost(): void; onClose(): void; actions?: ReactNode; sideChats?: readonly { id: string; title: string; unread: boolean; onOpen(): void }[] }

export function EnvironmentCard({ hostName, cwd, local, connected, workspace, activity, activityError, sources, onReview, onCommit, onFiles, onTerminal, onHost, onClose, actions, sideChats = [] }: EnvironmentCardProps) {
  const [, redraw] = useReducer(value => value + 1, 0);
  const [expandedSources, setExpandedSources] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  useEffect(() => workspace.subscribe(redraw), [workspace]);

  const status = workspace.status;
  const staged = status?.entries.filter(entry => ![".", " ", "?"].includes(entry.indexStatus)) ?? [];
  const changed = new Set(status?.entries.filter(entry => entry.kind === "untracked" || ![".", " "].includes(entry.indexStatus) || ![".", " "].includes(entry.worktreeStatus)).map(entry => entry.path) ?? []);
  const conflict = status?.entries.some(entry => entry.kind === "conflict") ?? false;
  const commitDisabled = !connected || !staged.length || conflict || workspace.busy || Boolean(workspace.pending);
  const shownSources = expandedSources ? sources : sources.slice(0, 3);
  const branch = status?.branch ?? "Detached HEAD";
  async function copyBranch() {
    if (!status?.branch) return;
    try { await navigator.clipboard.writeText(status.branch); setCopyError(undefined); }
    catch { setCopyError("Branch name could not be copied."); }
  }

  return <aside className="environment-card" aria-label="Environment summary">
    <header className="environment-card-header"><h2>Environment</h2>{actions}<button className="icon-button" aria-label="Close environment summary" onClick={onClose}><Icon name="close"/></button></header>
    <section className="environment-section environment-overview">
      <button className="environment-row" disabled={!status} onClick={onReview}><Icon name="sliders"/><span><strong>Changes</strong><small>{status ? `${changed.size} ${changed.size === 1 ? "file" : "files"}${staged.length ? ` · ${staged.length} staged` : ""}${conflict ? " · conflicts" : ""}` : "Unavailable"}</small></span><Icon name="chevron"/></button>
      <div className="environment-row environment-host"><button onClick={onHost} title={cwd || hostName}><Icon name="terminal"/><span><strong>{local ? "Local" : hostName}</strong><small>{connected ? cwd || "Connected" : "Offline"}</small></span></button><button className="environment-row-action" aria-label="Open terminal" title="Open terminal" disabled={!connected} onClick={onTerminal}><Icon name="terminal"/></button></div>
      <button className="environment-row" disabled={!status?.branch} onClick={() => void copyBranch()} title="Copy branch name"><Icon name="folder"/><span><strong>Copy branch</strong><small>{branch}</small></span><Icon name="chevron"/></button>
      {copyError && <p className="environment-note" role="alert">{copyError}</p>}
      <button className="environment-row" disabled={commitDisabled} onClick={onCommit}><Icon name="check"/><span><strong>Commit</strong><small>{commitDisabled ? (conflict ? "Resolve conflicts first" : !connected ? "Offline" : !staged.length ? "Nothing staged" : "Unavailable") : `${staged.length} staged ${staged.length === 1 ? "file" : "files"}`}</small></span><Icon name="chevron"/></button>
    </section>
    {sideChats.length > 0 && <section className="environment-section"><h3>Side chats</h3>{sideChats.map(chat => <button className="environment-row" key={chat.id} onClick={chat.onOpen}><Icon name="sideChat"/><span>{chat.title}</span>{chat.unread && <i className="dock-unread" aria-label="Unread answer"/>}</button>)}</section>}
    <NativeActivity activity={activity} error={activityError}/>
    <section className="environment-section environment-sources"><h3>Sources</h3>{shownSources.length ? <ul>{shownSources.map(source => <li key={source.id}><button onClick={source.onOpen}><Icon name={source.kind === "image" ? "compose" : "folder"}/><span>{source.label}</span><small>{source.kind === "image" ? "Image" : "File"}</small></button></li>)}</ul> : <p className="environment-note">No consumed sources are available.</p>}{sources.length > 3 && <button className="environment-link" onClick={() => setExpandedSources(value => !value)}>{expandedSources ? "Show less" : "View all"}</button>}<button className="environment-link" title={cwd || "Browse files"} onClick={onFiles}>Browse files</button></section>
  </aside>;
}

function NativeActivity({ activity, error }: { activity?: SessionActivitySnapshot | null; error?: string }) {
  if (error) return <section className="environment-section"><h3>Subagents</h3><p className="environment-note" role="alert">{error}</p></section>;
  if (!activity) return <section className="environment-section"><h3>Subagents</h3><p className="environment-note">Native activity is unavailable.</p></section>;
  const agents = activity.agents;
  const jobs = activity.jobs;
  if (agents.availability !== "available") return <section className="environment-section"><h3>Subagents</h3><p className="environment-note">{agents.reason}</p></section>;
  const runningAgents = agents.value.filter(agent => agent.running).length;
  const jobsAvailable = jobs.availability === "available";
  const runningJobs = jobsAvailable ? jobs.value.running : [];
  return <>
    <section className="environment-section"><h3>Subagents</h3><details><summary>{runningAgents ? `${runningAgents} working` : `${agents.value.length} available`}</summary>{agents.value.length ? <ul className="environment-native-list">{agents.value.map(agent => <li key={agent.id}><span>{agent.displayName} · {agent.status}</span><code>{agent.id}</code></li>)}</ul> : <p className="environment-note">No native subagents.</p>}</details></section>
    {!jobsAvailable ? <section className="environment-section"><h3>Jobs</h3><p className="environment-note">{jobs.reason}</p></section> : (runningJobs.length > 0 || jobs.value.recent.length > 0) && <section className="environment-section"><h3>Jobs</h3><details><summary>{runningJobs.length ? `${runningJobs.length} running` : `${jobs.value.recent.length} recent`}</summary><ul className="environment-native-list">{[...runningJobs, ...jobs.value.recent].map(job => <li key={job.id}><span>{job.label} · {job.status}</span><code>{job.id}</code></li>)}</ul></details></section>}
  </>;
}
