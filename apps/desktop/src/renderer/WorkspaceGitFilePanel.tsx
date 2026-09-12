import { useState } from "react";
import { PierreSourceEditor } from "./PierreSourceEditor";
import type { GitFileHistoryState } from "./git-file-history-state";
import "./workspace-git-file.css";

/** Command-menu adapter: caller supplies its captured originating file surface, never a global fallback. */
export function toggleWorkspaceGitBlame(surface: HTMLElement): boolean {
  const buttons = [...surface.querySelectorAll<HTMLButtonElement>("[data-git-blame-toggle]")].filter(button => button.getClientRects().length && !button.closest("[hidden]"));
  if (buttons.length !== 1 || buttons[0]!.disabled) return false;
  buttons[0]!.click();
  return true;
}

/** Lives inside the original file host; immutable content is never a working editor document. */
export function WorkspaceGitFilePanel({ state, active }: { state: GitFileHistoryState; active: boolean }) {
  const [expression, setExpression] = useState("HEAD");
  const selected = state.selected, inspection = state.inspection, origin = inspection?.origin;
  const source = selected?.content;
  return <section className="workspace-git-file" aria-label={`Git history for ${state.path}`} aria-busy={state.busy} data-repository-watch={state.data.repositoryWatchView?.phase} hidden={!active}>
    <div className="workspace-git-file-actions">
      <button type="button" data-git-blame-toggle aria-pressed={state.enabled} onClick={() => state.toggle()}>{state.enabled ? "Hide Git blame and history" : "Git blame and history"}</button>
      {state.enabled && <form onSubmit={event => { event.preventDefault(); void state.refresh(expression.trim()); }}>
        <label>Revision<input aria-label="Git file revision" value={expression} maxLength={512} onChange={event => setExpression(event.target.value)} /></label>
        <button disabled={!state.data.connected || state.busy || !expression.trim()}>Refresh</button>
      </form>}
    </div>
    {state.enabled && <>
      {state.busy && <p className="workspace-notice" role="status">Reading Git file history…</p>}
      {state.error && <p className="workspace-notice" role="alert">{state.error}</p>}
      {state.data.repositoryWatchWarning && <p className="workspace-notice" role="status">{state.data.repositoryWatchWarning}</p>}
      {!state.data.connected && <p className="workspace-notice" role="status">Offline · cached immutable revisions remain readable. Uncached revisions require the original host.</p>}
      {state.stale && <p className="workspace-notice" role="status">Repository changed · these results are pinned to the original commit. Refresh for current blame.</p>}
      {inspection?.unavailable && <p className="workspace-notice">{inspection.unavailable === "unborn-head" ? "This repository has no commits yet." : "This reference is not available among local Git objects."}</p>}
      {origin && <details className="workspace-git-file-history" open>
        <summary>File history · first-parent · {origin.expression} at {origin.commit.slice(0, 8)}</summary>
        <p className="workspace-notice">{state.workingMatches ? "Blame matches the current editor text." : "Working/editor text differs or is unavailable. Blame below belongs only to the committed snapshot; your editor buffer is retained."}</p>
        <button type="button" disabled={state.busy} onClick={() => void state.openRevision(inspection?.revision?.location ?? origin)}>Inspect committed snapshot</button>
        {!state.commits.length && <p className="workspace-notice">No commits for this path at the selected reference. It may be untracked or absent from this history.</p>}
        <ol>{state.commits.map(commit => <li key={`${commit.commit}:${commit.path}`}>
          <button type="button" disabled={state.busy} title={`${commit.commit}\n${commit.path}\n${commit.email}`} onClick={() => void state.openRevision(commit)}>
            <strong>{commit.summary || commit.commit.slice(0, 8)}</strong>
            <span>{commit.author} · {new Date(commit.authorTime * 1000).toLocaleDateString()} · {commit.commit.slice(0, 8)} · {commit.change}</span>
            <span>{commit.path}</span>
          </button>
          {commit.previous && <button type="button" disabled={state.busy} aria-label={`Open parent before ${commit.commit.slice(0, 8)}`} onClick={() => void state.openRevision(commit.previous!)}>Before this change</button>}
        </li>)}</ol>
        {state.next && <button type="button" disabled={state.busy || !state.data.connected} onClick={() => void state.loadOlder()}>Load older file history</button>}
      </details>}
      {selected && <section className="workspace-git-revision" aria-label="Immutable Git revision" data-symbol-navigation="unavailable">
        <header><strong>{selected.location.path} @ {selected.location.commit.slice(0, 8)}</strong><button type="button" onClick={() => state.closeRevision()}>Return to working file</button></header>
        <p className="workspace-notice">Read-only commit {selected.location.commit}. Original file: {selected.origin.workspacePath} at {selected.origin.expression}. Symbol navigation is unavailable for historical Git content.</p>
        {selected.blameUnavailable && <p className="workspace-notice">{selected.blameUnavailable}</p>}
        {source?.kind === "text" && <>
          <details className="workspace-git-revision-blame"><summary>Line blame ({selected.blame.length} lines)</summary>
            {!selected.blame.length && <p className="workspace-notice">This is an empty committed file.</p>}
            <ol>{selected.blame.map(line => <li key={line.line}><button type="button" disabled={state.busy} onClick={() => void state.openRevision({ commit: line.commit, path: line.path }, line.originalLine)} title={`${line.path}:${line.originalLine}\n${line.email}`}>Line {line.line} · {line.author} · {line.commit.slice(0, 8)} · {line.summary}</button></li>)}</ol>
          </details>
          <PierreSourceEditor documentKey={`${state.data.cacheKey}:git:${selected.origin.repositoryId}:${selected.location.commit}:${selected.location.path}`} name={selected.location.path}
            value={source.text} label={`Read-only ${selected.location.path} at ${selected.location.commit}`} readOnly active={active}
            revealRequest={state.reveal} onChange={() => { throw new Error("An immutable Git file cannot be edited."); }} onSave={() => { throw new Error("An immutable Git file cannot be saved over the working tree."); }}/>
        </>}
      </section>}
    </>}
  </section>;
}
