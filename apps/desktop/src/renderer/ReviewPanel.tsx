import { isWorkspaceFilePath } from "./dock-state";
import { BranchReviewControls, ReviewSourceControl } from "./BranchReviewControls";
import { branchReviewState, TurnReviewState, type ReviewSource, type TurnReviewView } from "./branch-review-state";
import { commitReviewState } from "./commit-review-state";
import { CommitReviewFiles, CommitReviewHeader } from "./CommitReviewControls";
import { useRepositoryWatch } from "./use-repository-watch";
import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icons";
import { GitSubmissionButton } from "./GitSubmissionDialog";
import { ReviewDiff, ReviewDiffs } from "./ReviewDiff";
import { DEFAULT_REVIEW_OPTIONS, parseReviewPatch, parseTurnReviewFile, readReviewOptions, reviewEntries, reviewMutationPaths, turnReviewMatches, turnReviewRelativePath, type ReviewOptions, type ReviewPatch, type TurnReviewFileSections } from "./review-model";
import type { WorkspaceState } from "./workspace-state";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import type { TurnReviewFile, TurnReviewOpenRequest, TurnReviewOutcome } from "../../../../packages/shared/src/turn-review";
import "./review-panel.css";

const OPTIONS_KEY = "agent-desktop:review-options:v1";
/** Session-owned Last-turn access for one workspace. The owning host selects the turn. */
export interface ReviewTurnPorts {
  bridge: Pick<DesktopBridge, "getTurnReview" | "subscribe">;
  hostId: string;
  /** Host events for the local machine may omit their host ID. */
  localHostId?: string;
  /** Conversation currently owning this workspace; absent when no conversation does. */
  conversationId?: string;
  /** Historical Transcript open request, a fresh id per request; conversation and optional path only. */
  request?: TurnReviewOpenRequest & { id: string };
}
export function ReviewPanel({ data, disabled, onEdit, commitRequest, onCommit, turn }: { data: WorkspaceState; disabled: boolean; onEdit(path: string): void; commitRequest?: string; onCommit?(): void; turn?: ReviewTurnPorts }) {
  const [, redraw] = useReducer(value => value + 1, 0);
  const branchState = useMemo(() => branchReviewState(data), [data]);
  const branchView = useSyncExternalStore(branchState.subscribe, branchState.getSnapshot, branchState.getSnapshot);
  const commitState = useMemo(() => commitReviewState(data, () => branchState.selectSource("branch")), [data, branchState]);
  const commitView = useSyncExternalStore(commitState.subscribe, commitState.getSnapshot, commitState.getSnapshot);
  const [commitPickerOpen, setCommitPickerOpen] = useState(false);
  const branch = branchView.source === "branch", committed = branchView.source === "commit", lastTurn = branchView.source === "last-turn";
  const local = !branch && !committed && !lastTurn;
  const turnBridge = turn?.bridge, turnEnabled = Boolean(turnBridge?.getTurnReview);
  const turnState = useMemo(() => new TurnReviewState((sessionId, hostId) => turnBridge?.getTurnReview ? turnBridge.getTurnReview(sessionId, hostId) : Promise.reject(new Error("This build cannot read recorded turns."))), [data, turnBridge]);
  const turnView = useSyncExternalStore(turnState.subscribe, turnState.getSnapshot, turnState.getSnapshot);
  useRepositoryWatch(data, branch || committed || commitPickerOpen);
  useLayoutEffect(() => {
    turnState.configure({ active: true, sourceActive: lastTurn && turnEnabled, connected: data.connected, current: turn?.conversationId ? { hostId: turn.hostId, conversationId: turn.conversationId } : undefined });
  }, [turnState, lastTurn, turnEnabled, data.connected, turn?.hostId, turn?.conversationId]);
  useLayoutEffect(() => () => turnState.configure({ active: false, sourceActive: false, connected: false, current: undefined }), [turnState]);
  // The owning host announces a persisted capture; the recorded read is never polled or derived from live Git.
  useEffect(() => {
    if (!lastTurn || !turnEnabled || !turnBridge) return;
    const localHostId = turn?.localHostId;
    return turnBridge.subscribe(event => turnState.observe(event, localHostId));
  }, [lastTurn, turnEnabled, turnBridge, turnState, turn?.localHostId]);
  useLayoutEffect(() => {
    commitState.configure({ active: true, sourceActive: committed, pickerOpen: commitPickerOpen, baseBranch: branchView.baseBranch });
  }, [commitState, committed, commitPickerOpen, branchView.baseBranch]);
  useLayoutEffect(() => () => commitState.configure({ active: false, sourceActive: false, pickerOpen: false }), [commitState]);
  useLayoutEffect(() => { branchState.configure(true); return () => branchState.configure(false); }, [branchState]);
  const branchResult = branchView.result?.state === "available" ? branchView.result : undefined;
  const [options, setOptions] = useState<ReviewOptions>({ ...DEFAULT_REVIEW_OPTIONS });
  const [preferenceError, setPreferenceError] = useState<string>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useLayoutEffect(() => { setCollapsed(new Set()); }, [branchView.source, commitView.selection?.commit, turnView.owner]);
  const openedTurnRequest = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const request = turn?.request;
    if (!request || !turnEnabled || openedTurnRequest.current === request.id) return;
    openedTurnRequest.current = request.id;
    setCollapsed(new Set());
    turnState.open({ conversationId: request.conversationId, ...(request.path === undefined ? {} : { path: request.path }) }, turn.hostId);
    branchState.selectSource("last-turn");
  }, [turn?.request, turn?.hostId, turnEnabled, turnState, branchState]);
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
  const displayedDiff = committed || lastTurn ? undefined : branch ? branchResult : data.diff;
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
  const commitFiles = useMemo(() => {
    const path = commitView.path;
    return commitView.review?.files.filter(file => !path || file.path === path || file.previousPath === path || file.path.startsWith(`${path}/`)) ?? [];
  }, [commitView.review, commitView.path]);
  const turnReview = lastTurn ? turnView.review : undefined;
  const turnPath = turnView.path === undefined ? undefined : turnReviewRelativePath(turnView.path, turnReview?.selected?.cwd);
  const turnFiles = useMemo(() => turnReview?.files.map((file, index) => ({ file, ...parseTurnReviewFile(file, `${turnReview.sessionId}:${turnReview.revision}:${index}`) })) ?? [], [turnReview]);
  const shownTurnFiles = useMemo(() => turnFiles.filter(entry => turnReviewMatches(entry.file, turnPath)), [turnFiles, turnPath]);
  const totals = useMemo(() => committed && commitView.review
    ? { files: commitFiles.length, additions: commitFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0), deletions: commitFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0), binaryFiles: commitFiles.filter(file => file.additions === null).length }
    : lastTurn ? turnReview && (turnReview.state === "available" || turnReview.state === "partial") ? { files: shownTurnFiles.length, additions: shownTurnFiles.reduce((sum, entry) => sum + (entry.file.additions ?? 0), 0), deletions: shownTurnFiles.reduce((sum, entry) => sum + (entry.file.deletions ?? 0), 0), binaryFiles: shownTurnFiles.filter(entry => entry.file.binary).length } : undefined
    : patch ? { files: patch.files.length, additions: patch.additions, deletions: patch.deletions, binaryFiles: patch.binaryFiles } : undefined, [committed, commitView.review, commitFiles, lastTurn, turnReview, shownTurnFiles, patch]);
  const collapsePaths = useMemo(() => committed ? commitFiles.map(file => file.path) : lastTurn ? shownTurnFiles.map(entry => entry.file.path) : patch?.files.map(file => file.metadata.name) ?? [], [committed, commitFiles, lastTurn, shownTurnFiles, patch]);
  const loading = committed ? commitView.loading : branch ? branchView.loading : lastTurn ? turnView.loading : data.loading.has("diff");
  const allCollapsed = collapsePaths.length > 0 && collapsePaths.every(path => collapsed.has(path));
  const untracked = local && !staged && !data.diffSelection.path ? entries.filter(entry => entry.kind === "untracked") : [];
  const turnIndex = turnPath === undefined ? -1 : turnFiles.findIndex(entry => entry.file.path === turnPath);
  function select(path: string | undefined, nextStaged = staged) { setCollapsed(new Set()); if (committed) commitState.selectPath(path); else if (branch) branchState.selectPath(path); else if (lastTurn) turnState.selectPath(path); else void data.showDiff(path, nextStaged); }
  function selectSource(source: ReviewSource) { setCollapsed(new Set()); branchState.selectSource(source); if (source === "last-turn") turnState.useCurrent(); if (source === "staged" || source === "unstaged") void data.showDiff(undefined, source === "staged"); }
  const stageAll = () => { if (data.status) void data.mutate(staged ? { type: "git.unstage", paths: entries.flatMap(reviewMutationPaths), expectedRevision: data.status.revision } : { type: "git.stage", paths: entries.flatMap(reviewMutationPaths) }); };
  return <section className="review-panel" aria-label="Review changes">
    <div className="review-toolbar">
      <ReviewSourceControl source={branchView.source} disabled={!data.connected} lastTurn={turnEnabled} onSelect={selectSource} commitView={commitView}
        onCommitSelect={commit => { commitState.selectCommit(commit); selectSource("commit"); }} onCommitRetry={() => commitState.retryCommits()} onCommitOpenChange={setCommitPickerOpen}/>
      <span className="review-totals" aria-label={totals ? `${totals.files} files in patch, ${totals.additions} additions, ${totals.deletions} deletions${totals.binaryFiles ? `, ${totals.binaryFiles} binary files` : ""}` : "Diff totals unavailable"}>
        {loading ? <span className="review-spinner" aria-label="Loading diff"/> : totals ? <><span className="review-added">+{totals.additions.toLocaleString()}</span><span className="review-deleted">−{totals.deletions.toLocaleString()}</span></> : "—"}
      </span>
      <div className="review-toolbar-actions">
        <button className="review-icon-button" aria-label={options.split ? "Switch to unified diff" : "Switch to split diff"} title={options.split ? "Switch to unified diff" : "Switch to split diff"} aria-pressed={options.split} onClick={() => changeOptions({ split: !options.split })}><LayoutIcon split={options.split}/></button>
        <button className="review-icon-button" aria-label="Refresh diff" title="Refresh" disabled={!data.connected || loading} onClick={() => { void data.loadGit(); if (committed) commitState.refresh(); else if (branch) branchState.refresh(); else if (lastTurn) turnState.refresh(); }}><Icon name="refresh"/></button>
        <details ref={optionsMenu} className="review-options" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); optionsMenu.current?.removeAttribute("open"); optionsMenu.current?.querySelector("summary")?.focus(); } }}>
          <summary className="review-icon-button" aria-label="Review options" title="Review options"><Icon name="more"/></summary>
          <div className="review-options-menu">
            <label><input type="checkbox" checked={options.wrap} onChange={event => changeOptions({ wrap: event.target.checked })}/>Word wrap</label>
            <label><input type="checkbox" checked={options.wordDiffs} onChange={event => changeOptions({ wordDiffs: event.target.checked })}/>Word differences</label>
            <label><input type="checkbox" checked={options.lineNumbers} onChange={event => changeOptions({ lineNumbers: event.target.checked })}/>Line numbers</label>
            <label><input type="checkbox" checked={options.indicators === "classic"} onChange={event => changeOptions({ indicators: event.target.checked ? "classic" : "bars" })}/>Plus/minus indicators</label>
            <button disabled={!collapsePaths.length} onClick={() => { setCollapsed(allCollapsed ? new Set() : new Set(collapsePaths)); optionsMenu.current?.removeAttribute("open"); }}>{allCollapsed ? "Expand all diffs" : "Collapse all diffs"}</button>
          </div>
        </details>
        {onCommit ? <GitSubmissionButton data={data} className="review-commit-trigger" onOpen={onCommit}/> : <button ref={commitTrigger} className="review-commit-trigger" disabled={disabled || !stagedEntries.length || !data.status || data.status.entries.some(entry => entry.kind === "conflict")} onClick={() => { if (data.status) setCommit({ revision: data.status.revision, paths: stagedEntries.map(entry => entry.path) }); }} title="Commit staged changes">Commit<Icon name="chevron"/></button>}
      </div>
    </div>
    {branch && <BranchReviewControls key={data.cacheKey} workspace={data} state={branchState} view={branchView}/>}
    {committed && <CommitReviewHeader view={commitView}/>}
    {lastTurn && <TurnReviewHeader view={turnView} current={turn?.conversationId} onUseCurrent={() => selectSource("last-turn")}/>}
    <div className="review-navigation">
      <select aria-label="Jump to file" value={(committed ? commitView.path : branch ? branchView.path : lastTurn ? turnPath : data.diffSelection.path) ?? ""} onChange={event => select(event.target.value || undefined)} disabled={!data.connected}>
        <option value="">{committed ? "All commit changes" : branch ? "All branch changes" : lastTurn ? "All files changed in the turn" : staged ? "All staged changes" : "All tracked changes"}</option>
        {local && data.diffSelection.path && !entries.some(entry => entry.path === data.diffSelection.path) && <option value={data.diffSelection.path}>{data.diffSelection.path}</option>}
        {branch && branchView.path && !branchResult?.files.some(file => file.path === branchView.path) && <option value={branchView.path}>{branchView.path}</option>}
        {lastTurn && turnPath !== undefined && turnIndex < 0 && <option value={turnPath}>{turnPath}</option>}
        {committed ? commitView.review?.files.map(file => <option key={file.path} value={file.path}>{file.path}</option>) : branch ? branchResult?.files.map(file => <option key={file.path} value={file.path}>{file.path}{file.untracked ? " (untracked)" : ""}</option>) : lastTurn ? turnFiles.map(entry => <option key={entry.file.path} value={entry.file.path}>{entry.file.path}{entry.file.binary ? " (binary)" : ""}</option>) : entries.map(entry => <option value={entry.path} key={entry.path}>{entry.path}{entry.kind === "untracked" ? " (untracked)" : entry.kind === "conflict" ? " (conflict)" : ""}</option>)}
      </select>
      {lastTurn && <><button type="button" aria-label="Previous file" title="Previous file" disabled={turnIndex <= 0} onClick={() => select(turnFiles[turnIndex - 1]?.file.path)}>‹ Prev</button><button type="button" aria-label="Next file" title="Next file" disabled={!turnFiles.length || turnIndex >= turnFiles.length - 1} onClick={() => select(turnFiles[turnIndex + 1]?.file.path)}>Next ›</button></>}
      {local && <button disabled={disabled || !entries.length || !data.status} onClick={stageAll}>{staged ? "Unstage all" : "Stage all"}</button>}
    </div>
    {preferenceError && <p className="review-message" role="status">{preferenceError}</p>}
    {data.errors.git && <p className="review-message" role="alert">{data.errors.git}</p>}
    {local && data.errors.diff && <p className="review-message" role="alert">{data.errors.diff}</p>}
    {branchView.source === "branch" && branchView.error && <p className="review-message" role="alert">{branchView.error}</p>}
    {branchView.source === "branch" && branchView.result?.state === "unavailable" && <div className="review-branch-unavailable" role="status"><p>{({ default_branch_unavailable: "No default base branch is available. Select a base branch above.", head_unavailable: "This repository has no commit history to compare yet.", base_ref_unavailable: "The selected base reference is unavailable. Choose another base or refresh after it is restored.", merge_base_unavailable: "The current branch and selected base have no available merge base." })[branchView.result.reason]}</p><button onClick={() => branchState.refresh()} disabled={!data.connected}>Refresh branch comparison</button></div>}
    {parsed.error && <p className="review-message" role="alert">Diff could not be parsed: {parsed.error}</p>}
    {!committed && !lastTurn && loading && !patch && <div className="review-loading" role="status" aria-label="Loading diff"><span>Loading diff…</span></div>}
    {committed && <CommitReviewFiles view={commitView} state={commitState} options={options} onEdit={onEdit} onCopyError={setPreferenceError} collapsed={collapsed} onToggle={path => setCollapsed(old => { const next = new Set(old); if (!next.delete(path)) next.add(path); return next; })}/>}
    {lastTurn && <TurnReviewFiles view={turnView} files={shownTurnFiles} path={turnPath} options={options} connected={data.connected} onRetry={() => turnState.refresh()} onEdit={onEdit} onCopyError={setPreferenceError} collapsed={collapsed} onToggle={path => setCollapsed(old => { const next = new Set(old); if (!next.delete(path)) next.add(path); return next; })}/>}
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
    {local && !patch && !loading && !parsed.error && !data.errors.diff && <p className="review-empty">{data.connected ? "Select a source to review changes." : "Reconnect to load a diff."}</p>}
    {commit && <CommitDialog data={data} snapshot={commit} disabled={disabled} onClose={() => { setCommit(undefined); commitTrigger.current?.focus({ preventScroll: true }); }}/>} 
  </section>;
}

const OUTCOME_LABEL: Record<TurnReviewOutcome, string> = { running: "Still running", completed: "Completed", aborted: "Interrupted", error: "Ended with an error" };
const KIND_LABEL: Record<TurnReviewFile["kind"], string> = { A: "Added", D: "Deleted", M: "Modified", R: "Renamed" };
/** Recorded turn identity as the host reported it; nothing here is inferred by this window. */
function TurnReviewHeader({ view, current, onUseCurrent }: { view: TurnReviewView; current: string | undefined; onUseCurrent(): void }) {
  const { owner, review } = view;
  const selected = review?.selected;
  const historical = view.override && owner && owner.conversationId !== current;
  return <div className="commit-review-header">
    <span className="commit-review-subject" title={selected ? `Turn ${selected.turnId} · ${selected.inputEntryIds.length} input ${selected.inputEntryIds.length === 1 ? "entry" : "entries"} · cwd ${selected.cwd}` : owner ? `Conversation ${owner.conversationId}` : undefined}>
      {selected ? <>{selected.source === "recorded" ? "Recorded turn" : "Derived turn"} · {OUTCOME_LABEL[selected.outcome]} · foreground cwd{review?.state === "partial" ? " · partial capture" : ""}</> : review ? review.state === "pending" ? "Capturing the last turn…" : "No recorded turn" : owner ? "Last turn" : "No conversation"}
    </span>
    {selected && <code className="commit-review-sha" title={`Turn ${selected.turnId} in conversation ${selected.originSessionId}`}><span aria-hidden="true">{selected.turnId.slice(0, 7)}</span><span className="sr-only">Turn {selected.turnId}</span></code>}
    {historical && <span className="commit-review-root" title={`Conversation ${owner.conversationId}`}>From transcript</span>}
    {historical && current && <button type="button" className="review-commit-trigger" onClick={onUseCurrent}>Use current conversation</button>}
  </div>;
}
const copyIcon = <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M10.5 3H4.5A1.5 1.5 0 0 0 3 4.5v6"/></svg>;
/** Recorded per-file sections only; the working tree is never read for this source. */
function TurnReviewFiles({ view, files, path, options, connected, onRetry, onEdit, onCopyError, collapsed, onToggle }: { view: TurnReviewView; files: readonly ({ file: TurnReviewFile } & TurnReviewFileSections)[]; path: string | undefined; options: ReviewOptions; connected: boolean; onRetry(): void; onEdit(path: string): void; onCopyError(message: string): void; collapsed: ReadonlySet<string>; onToggle(path: string): void }) {
  const { owner, review, error, loading } = view;
  if (error) return <div className="review-branch-unavailable" role="alert"><p>{error}</p><button type="button" onClick={onRetry} disabled={!connected}>Retry</button></div>;
  if (!owner) return <p className="review-empty">Select a conversation to review its last turn.</p>;
  if (!review) return loading ? <div className="review-loading" role="status" aria-label="Loading recorded turn"><span>Loading recorded turn…</span></div> : null;
  const notice = review.state === "unavailable" ? <div className="review-branch-unavailable" role="status"><p>No recorded turn review is available for this conversation.{review.reason ? ` ${review.reason}` : ""}</p><button type="button" onClick={onRetry} disabled={!connected}>Check again</button></div>
    : review.state === "pending" ? <div className="review-branch-unavailable" role="status"><p>The last turn is still being captured{review.reason ? `: ${review.reason}` : "."}</p><button type="button" onClick={onRetry} disabled={!connected}>Check again</button></div>
    : review.state === "partial" ? <p className="review-message" role="alert">Capture is incomplete{review.reason ? `: ${review.reason}` : "."} Files below are the recorded portion only.</p>
    : null;
  if (review.state === "unavailable" || review.state === "pending" && !review.files.length) return notice;
  return <ReviewDiffs options={options}>
    {notice}
    {files.map(({ file, sections, error: parseError }) => {
      const target = file.path, folded = collapsed.has(target), rename = file.previousPath !== null && file.previousPath !== target;
      const openable = file.kind !== "D" && isWorkspaceFilePath(target);
      return <article key={target} className="review-file" data-review-path={target}>
        <header className="review-file-header">
          <button className="review-file-title" aria-label={`${folded ? "Expand" : "Collapse"} ${target}`} aria-expanded={!folded} onClick={() => onToggle(target)}>
            <Icon name="chevron" className={folded ? "" : "open"}/><span title={`${KIND_LABEL[file.kind]}: ${rename ? `${file.previousPath} → ${target}` : target}`}>{rename && <span className="review-old-name">{file.previousPath} → </span>}{target}</span>
          </button>
          <span className="review-file-counts">{file.binary ? "Binary" : file.additions === null && file.deletions === null ? KIND_LABEL[file.kind] : <><span className="review-added">+{file.additions ?? 0}</span><span className="review-deleted">−{file.deletions ?? 0}</span></>}</span>
          <div className="review-file-actions">
            <button className="review-icon-button" title="Copy path" aria-label={`Copy path ${target}`} onClick={() => { void navigator.clipboard.writeText(target).catch(() => onCopyError("The file path could not be copied.")); }}>{copyIcon}</button>
            {file.kind !== "D" && <button className="review-icon-button" disabled={!openable} title={openable ? "Open the current working tree file" : "This filename can be reviewed and copied, but cannot be opened in a file tab."} aria-label={`Open ${target}`} onClick={() => onEdit(target)}><Icon name="compose"/></button>}
          </div>
        </header>
        {!folded && (parseError ? <p className="review-message" role="alert">Recorded patch could not be parsed: {parseError}</p>
          : sections.length ? sections.map(section => <ReviewDiff key={section.key} file={section} options={options}/>)
          : <p className="review-file-note">{file.binary ? `Binary file ${KIND_LABEL[file.kind].toLowerCase()}${file.additions === null ? "; no line counts are recorded." : "."}` : `${KIND_LABEL[file.kind]} without a recorded text patch.`}</p>)}
      </article>;
    })}
    {!files.length && <p className="review-empty">{review.files.length ? `No recorded changes to ${path} in this turn.` : review.state === "pending" ? "No files have been recorded for this turn yet." : "The last turn changed no files in its working directory."}</p>}
  </ReviewDiffs>;
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
