import { isWorkspaceFilePath } from "./dock-state";
import { BranchReviewControls, ReviewSourceControl } from "./BranchReviewControls";
import { branchReviewState, type ReviewSource } from "./branch-review-state";
import { useRepositoryWatch } from "./use-repository-watch";
import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icons";
import { GitSubmissionButton } from "./GitSubmissionDialog";
import { ReviewDiff, ReviewDiffs } from "./ReviewDiff";
import { DEFAULT_REVIEW_OPTIONS, parseReviewPatch, readReviewOptions, reviewEntries, reviewMutationPaths, type ReviewOptions, type ReviewPatch } from "./review-model";
import type { WorkspaceState } from "./workspace-state";
import "./review-panel.css";

const OPTIONS_KEY = "agent-desktop:review-options:v1";
export function ReviewPanel({ data, disabled, onEdit, commitRequest, onCommit }: { data: WorkspaceState; disabled: boolean; onEdit(path: string): void; commitRequest?: string; onCommit?(): void }) {
  const [, redraw] = useReducer(value => value + 1, 0);
  const branchState = useMemo(() => branchReviewState(data), [data]);
  const branchView = useSyncExternalStore(branchState.subscribe, branchState.getSnapshot, branchState.getSnapshot);
  const branch = branchView.source === "branch";
  useRepositoryWatch(data, branch);
  useLayoutEffect(() => { branchState.configure(true); return () => branchState.configure(false); }, [branchState]);
  const branchResult = branchView.result?.state === "available" ? branchView.result : undefined;
  const [options, setOptions] = useState<ReviewOptions>({ ...DEFAULT_REVIEW_OPTIONS });
  const [preferenceError, setPreferenceError] = useState<string>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [commit, setCommit] = useState<{ revision: string; paths: string[] }>();
  const commitTrigger = useRef<HTMLButtonElement>(null);
  const optionsMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => data.subscribe(redraw), [data]);
  useEffect(() => {
    try { setOptions(readReviewOptions(localStorage.getItem(OPTIONS_KEY))); }
    catch { setPreferenceError("Review preferences could not be read. Defaults are shown."); }
  }, []);
  useEffect(() => { if (data.connected) void data.showDiff(data.diffSelection.path, data.diffSelection.staged); }, [data]);
  function changeOptions(update: Partial<ReviewOptions>) {
    const next = { ...options, ...update }; setOptions(next);
    try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(next)); setPreferenceError(undefined); }
    catch { setPreferenceError("Review preferences could not be saved on this device."); }
  }
  const staged = data.diffSelection.staged;
  const entries = reviewEntries(data.status?.entries ?? [], staged);
  const stagedEntries = reviewEntries(data.status?.entries ?? [], true);
  const openedCommitRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!commitRequest || openedCommitRequest.current === commitRequest || !data.status || disabled) return;
    openedCommitRequest.current = commitRequest;
    if (stagedEntries.length && !data.status.entries.some(entry => entry.kind === "conflict")) setCommit({ revision: data.status.revision, paths: stagedEntries.map(entry => entry.path) });
  }, [commitRequest, data.status, disabled]);
  const displayedDiff = branch ? branchResult : data.diff;
  const parsed = useMemo((): { value?: ReviewPatch; error?: string } => {
    if (!displayedDiff) return {};
    try { return { value: parseReviewPatch(displayedDiff.patch, crypto.randomUUID(), displayedDiff.path) }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, [displayedDiff]);
  const patch = parsed.value;
  const missingNativePatches = branchResult?.files.filter(file => {
    const selected = branchView.path;
    return (!selected || selected === "." || file.path === selected || file.previousPath === selected || file.path.startsWith(`${selected}/`))
      && !patch?.files.some(parsed => parsed.metadata.name === file.path || parsed.metadata.prevName === file.path);
  }) ?? [];
  const loading = branch ? branchView.loading : data.loading.has("diff");
  const allCollapsed = Boolean(patch?.files.length) && patch!.files.every(file => collapsed.has(file.metadata.name));
  const untracked = !branch && !staged && !data.diffSelection.path ? entries.filter(entry => entry.kind === "untracked") : [];
  function select(path: string | undefined, nextStaged = staged) { setCollapsed(new Set()); if (branch) branchState.selectPath(path); else void data.showDiff(path, nextStaged); }
  function selectSource(source: ReviewSource) { setCollapsed(new Set()); branchState.selectSource(source); if (source !== "branch") void data.showDiff(undefined, source === "staged"); }
  const stageAll = () => { if (data.status) void data.mutate(staged ? { type: "git.unstage", paths: entries.flatMap(reviewMutationPaths), expectedRevision: data.status.revision } : { type: "git.stage", paths: entries.flatMap(reviewMutationPaths) }); };
  return <section className="review-panel" aria-label="Review changes">
    <div className="review-toolbar">
      <ReviewSourceControl source={branchView.source} disabled={!data.connected} onSelect={selectSource}/>
      <span className="review-totals" aria-label={patch ? `${patch.files.length} files in patch, ${patch.additions} additions, ${patch.deletions} deletions${patch.binaryFiles ? `, ${patch.binaryFiles} binary files` : ""}` : "Diff totals unavailable"}>
        {loading ? <span className="review-spinner" aria-label="Loading diff"/> : patch ? <><span className="review-added">+{patch.additions.toLocaleString()}</span><span className="review-deleted">−{patch.deletions.toLocaleString()}</span></> : "—"}
      </span>
      <div className="review-toolbar-actions">
        <button className="review-icon-button" aria-label={options.split ? "Switch to unified diff" : "Switch to split diff"} title={options.split ? "Switch to unified diff" : "Switch to split diff"} aria-pressed={options.split} onClick={() => changeOptions({ split: !options.split })}><LayoutIcon split={options.split}/></button>
        <button className="review-icon-button" aria-label="Refresh diff" title="Refresh" disabled={!data.connected || loading} onClick={() => { void data.loadGit(); if (branch) branchState.refresh(); }}><Icon name="refresh"/></button>
        <details ref={optionsMenu} className="review-options" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); optionsMenu.current?.removeAttribute("open"); optionsMenu.current?.querySelector("summary")?.focus(); } }}>
          <summary className="review-icon-button" aria-label="Review options" title="Review options"><Icon name="more"/></summary>
          <div className="review-options-menu">
            <label><input type="checkbox" checked={options.wrap} onChange={event => changeOptions({ wrap: event.target.checked })}/>Word wrap</label>
            <label><input type="checkbox" checked={options.wordDiffs} onChange={event => changeOptions({ wordDiffs: event.target.checked })}/>Word differences</label>
            <label><input type="checkbox" checked={options.lineNumbers} onChange={event => changeOptions({ lineNumbers: event.target.checked })}/>Line numbers</label>
            <label><input type="checkbox" checked={options.indicators === "classic"} onChange={event => changeOptions({ indicators: event.target.checked ? "classic" : "bars" })}/>Plus/minus indicators</label>
            <button disabled={!patch?.files.length} onClick={() => { setCollapsed(allCollapsed ? new Set() : new Set(patch!.files.map(file => file.metadata.name))); optionsMenu.current?.removeAttribute("open"); }}>{allCollapsed ? "Expand all diffs" : "Collapse all diffs"}</button>
          </div>
        </details>
        {onCommit ? <GitSubmissionButton data={data} className="review-commit-trigger" onOpen={onCommit}/> : <button ref={commitTrigger} className="review-commit-trigger" disabled={disabled || !stagedEntries.length || !data.status || data.status.entries.some(entry => entry.kind === "conflict")} onClick={() => { if (data.status) setCommit({ revision: data.status.revision, paths: stagedEntries.map(entry => entry.path) }); }} title="Commit staged changes">Commit<Icon name="chevron"/></button>}
      </div>
    </div>
    {branch && <BranchReviewControls key={data.cacheKey} workspace={data} state={branchState} view={branchView}/>}
    <div className="review-navigation">
      <select aria-label="Jump to file" value={(branch ? branchView.path : data.diffSelection.path) ?? ""} onChange={event => select(event.target.value || undefined)} disabled={!data.connected}>
        <option value="">{branch ? "All branch changes" : staged ? "All staged changes" : "All tracked changes"}</option>
        {!branch && data.diffSelection.path && !entries.some(entry => entry.path === data.diffSelection.path) && <option value={data.diffSelection.path}>{data.diffSelection.path}</option>}
        {branch && branchView.path && !branchResult?.files.some(file => file.path === branchView.path) && <option value={branchView.path}>{branchView.path}</option>}
        {branch ? branchResult?.files.map(file => <option key={file.path} value={file.path}>{file.path}{file.untracked ? " (untracked)" : ""}</option>) : entries.map(entry => <option value={entry.path} key={entry.path}>{entry.path}{entry.kind === "untracked" ? " (untracked)" : entry.kind === "conflict" ? " (conflict)" : ""}</option>)}
      </select>
      {!branch && <button disabled={disabled || !entries.length || !data.status} onClick={stageAll}>{staged ? "Unstage all" : "Stage all"}</button>}
    </div>
    {preferenceError && <p className="review-message" role="status">{preferenceError}</p>}
    {data.errors.git && <p className="review-message" role="alert">{data.errors.git}</p>}
    {!branch && data.errors.diff && <p className="review-message" role="alert">{data.errors.diff}</p>}
    {branchView.source === "branch" && branchView.error && <p className="review-message" role="alert">{branchView.error}</p>}
    {branchView.source === "branch" && branchView.result?.state === "unavailable" && <div className="review-branch-unavailable" role="status"><p>{({ default_branch_unavailable: "No default base branch is available. Select a base branch above.", head_unavailable: "This repository has no commit history to compare yet.", base_ref_unavailable: "The selected base reference is unavailable. Choose another base or refresh after it is restored.", merge_base_unavailable: "The current branch and selected base have no available merge base." })[branchView.result.reason]}</p><button onClick={() => branchState.refresh()} disabled={!data.connected}>Refresh branch comparison</button></div>}
    {parsed.error && <p className="review-message" role="alert">Diff could not be parsed: {parsed.error}</p>}
    {loading && !patch && <div className="review-loading" role="status" aria-label="Loading diff"><span>Loading diff…</span></div>}
    {patch && !parsed.error && <ReviewDiffs options={options}>
      {patch.files.map(file => {
        const path = file.metadata.name, entry = entries.find(entry => entry.path === path || entry.originalPath === path);
        const folded = collapsed.has(path);
        return <article key={file.key} className="review-file" data-review-path={path}>
          <header className="review-file-header">
            <button className="review-file-title" aria-label={`${folded ? "Expand" : "Collapse"} ${path}`} aria-expanded={!folded} onClick={() => setCollapsed(old => { const next = new Set(old); if (next.has(path)) next.delete(path); else next.add(path); return next; })}>
              <Icon name="chevron" className={folded ? "" : "open"}/><span title={file.metadata.prevName && file.metadata.prevName !== path ? `${file.metadata.prevName} → ${path}` : path}>{file.metadata.prevName && file.metadata.prevName !== path && <span className="review-old-name">{file.metadata.prevName} → </span>}{path}</span>
            </button>
            <span className="review-file-counts">{file.binary ? "Binary" : <><span className="review-added">+{file.additions}</span><span className="review-deleted">−{file.deletions}</span></>}</span>
            {entry?.kind === "conflict" && <span className="review-conflict">Conflict</span>}
            <div className="review-file-actions">
              {branch && <button className="review-icon-button" title="Copy path" aria-label={`Copy path ${path}`} onClick={() => { void navigator.clipboard.writeText(path).catch(() => setPreferenceError("The file path could not be copied.")); }}><svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M10.5 3H4.5A1.5 1.5 0 0 0 3 4.5v6"/></svg></button>}
              {(branch || entry) && file.metadata.type !== "deleted" && <button className="review-icon-button" disabled={branch && !isWorkspaceFilePath(path)} title={branch && !isWorkspaceFilePath(path) ? "This filename can be reviewed and copied, but cannot be opened in a file tab." : "Open file"} aria-label={`Open ${path}`} onClick={() => onEdit(path)}><Icon name="compose"/></button>}
              {!branch && entry && <button className="review-icon-button" disabled={disabled || !data.status} title={staged ? "Unstage file" : "Stage file"} aria-label={`${staged ? "Unstage" : "Stage"} ${entry.path}`} onClick={() => { if (data.status) void data.mutate(staged ? { type: "git.unstage", paths: reviewMutationPaths(entry), expectedRevision: data.status.revision } : { type: "git.stage", paths: reviewMutationPaths(entry) }); }}>{staged ? <span aria-hidden="true">−</span> : <Icon name="plus"/>}</button>}
            </div>
          </header>
          {!folded && <ReviewDiff file={file} options={options}/>}
        </article>;
      })}
      {missingNativePatches.map(file => <article className="review-file" data-review-path={file.path} key={`native:${file.path}`}>
        <header className="review-file-header"><span className="review-file-title">{file.path}</span><div className="review-file-actions">
          <button className="review-icon-button" title="Copy path" aria-label={`Copy path ${file.path}`} onClick={() => { void navigator.clipboard.writeText(file.path).catch(() => setPreferenceError("The file path could not be copied.")); }}>⧉</button>
          {file.status !== "D" && <button className="review-icon-button" disabled={!isWorkspaceFilePath(file.path)} title={!isWorkspaceFilePath(file.path) ? "This filename can be reviewed and copied, but cannot be opened in a file tab." : "Open file"} aria-label={`Open ${file.path}`} onClick={() => onEdit(file.path)}><Icon name="compose"/></button>}
        </div></header><p className="review-file-note">Git returned no text patch for this path.</p>
      </article>)}
      {!patch.files.length && !missingNativePatches.length && !loading && <p className="review-empty">No {branch ? "branch" : staged ? "staged" : "tracked unstaged"} changes.</p>}
      {untracked.length > 0 && <section className="review-untracked" aria-label="Untracked files"><header>Untracked files <span>{untracked.length}</span></header>{untracked.map(entry => <button key={entry.path} onClick={() => select(entry.path)}><Icon name="compose"/><span>{entry.path}</span><span>Review</span></button>)}</section>}
    </ReviewDiffs>}
    {!branch && !patch && !loading && !parsed.error && !data.errors.diff && <p className="review-empty">{data.connected ? "Select a source to review changes." : "Reconnect to load a diff."}</p>}
    {commit && <CommitDialog data={data} snapshot={commit} disabled={disabled} onClose={() => { setCommit(undefined); commitTrigger.current?.focus({ preventScroll: true }); }}/>} 
  </section>;
}

function CommitDialog({ data, snapshot, disabled, onClose }: { data: WorkspaceState; snapshot: { revision: string; paths: string[] }; disabled: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), text = useRef<HTMLTextAreaElement>(null); const id = useId();
  const [submitting, setSubmitting] = useState(false);
  useLayoutEffect(() => { const node = dialog.current!; node.showModal(); text.current?.focus(); return () => node.close(); }, []);
  async function submit() {
    if (disabled || submitting || !data.commitMessage.trim()) return;
    setSubmitting(true);
    try { await data.mutate({ type: "git.commit", message: data.commitMessage, expectedRevision: snapshot.revision }); if (!data.pending && !data.errors.action && !data.cacheWarning) onClose(); }
    finally { setSubmitting(false); }
  }
  return <dialog className="review-commit-dialog" ref={dialog} aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <header><h2 id={id}>Commit staged changes</h2><button type="button" className="review-icon-button" aria-label="Close commit" onClick={onClose}><Icon name="close"/></button></header>
      <p>{snapshot.paths.length} {snapshot.paths.length === 1 ? "file" : "files"} · {data.status?.branch ?? "Detached HEAD"}</p>
      <details><summary>Staged files</summary><ul>{snapshot.paths.map(path => <li key={path}>{path}</li>)}</ul></details>
      <textarea ref={text} aria-label="Commit message" placeholder="Commit message" value={data.commitMessage} onChange={event => data.setCommitMessage(event.target.value)} rows={4} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}/>
      {snapshot.revision !== data.status?.revision && <p className="review-message" role="status">The staged snapshot changed. Close and review it before committing.</p>}
      {data.errors.action && <p className="review-message" role="alert">{data.errors.action}</p>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={disabled || submitting || !data.commitMessage.trim() || snapshot.revision !== data.status?.revision}>{submitting ? "Committing…" : "Commit"}</button></footer>
    </form>
  </dialog>;
}
function LayoutIcon({ split }: { split: boolean }) { return <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/>{split ? <path d="M8 3v10"/> : <path d="M2.5 8h11"/>}</svg>; }
