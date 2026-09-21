import { useEffect, useMemo, useRef, useState, type RefCallback } from "react";
import type { GitCommitReviewFile, GitCommitReviewSnapshot, GitReviewCommit } from "../../../../packages/shared/src/git-commit-review";
import { isWorkspaceFilePath } from "./dock-state";
import { Icon } from "./Icons";
import { ReviewDiff, ReviewDiffs } from "./ReviewDiff";
import { parseReviewPatch, type ReviewOptions, type ReviewPatch } from "./review-model";
import type { CommitReviewFileView, CommitReviewState, CommitReviewView } from "./commit-review-state";
import "./commit-review.css";

const shortSha = (commit: string) => commit.slice(0, 7);
const committedDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
function committedLabel(committedAt: string): string {
  const time = Date.parse(committedAt);
  if (!Number.isFinite(time)) return committedAt;
  const seconds = Math.max(0, (Date.now() - time) / 1000);
  return seconds < 60 ? "now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : seconds < 30 * 86400 ? `${Math.floor(seconds / 86400)}d` : committedDate.format(time);
}
/** The snapshot is only authoritative for the selection it was read for; anything else is stale. */
function currentSnapshot(view: CommitReviewView): GitCommitReviewSnapshot | undefined {
  const { selection, review } = view;
  return selection && review && review.selection.commit === selection.commit && review.selection.repositoryId === selection.repositoryId ? review : undefined;
}

/** Rows for the existing review source menu's Commit submenu; the parent owns the dropdown and closes it after onSelect. */
export function CommitReviewItems({ view, onSelect, onRetry }: { view: CommitReviewView; onSelect(commit: GitReviewCommit): void; onRetry(): void }) {
  const { list, listLoading, listError, selection } = view;
  return <>
    {listLoading && <p role="status">Loading commits…</p>}
    {listError && <><p role="alert">{listError}</p><button type="button" onClick={onRetry}>Retry</button></>}
    {list && !list.commits.length && !listLoading && !listError && <p>{list.head === null ? "This repository has no commit history yet." : list.mergeBase === null ? "The current branch and base branch have no merge base." : "No commits ahead of the base branch."}</p>}
    {list?.commits.map(commit => {
      const checked = selection?.commit === commit.commit;
      return <button key={commit.commit} type="button" role="menuitemradio" aria-checked={checked} title={commit.message} onClick={() => onSelect(commit)}>
        <span>{commit.subject || "(No commit message)"}<small><code>{shortSha(commit.commit)}</code> · <time dateTime={commit.committedAt}>{committedLabel(commit.committedAt)}</time></small></span>{checked && <Icon name="check"/>}
      </button>;
    })}
  </>;
}

export function CommitReviewHeader({ view }: { view: CommitReviewView }) {
  const { selection } = view;
  if (!selection) return null;
  const snapshot = currentSnapshot(view);
  const commit = snapshot?.commit ?? view.list?.commits.find(row => row.commit === selection.commit);
  return <div className="commit-review-header">
    <span className="commit-review-subject" title={commit?.message}>{commit ? commit.subject || "(No commit message)" : view.loading ? "Loading commit…" : "Selected commit"}</span>
    <code className="commit-review-sha" title={selection.commit}><span aria-hidden="true">{shortSha(selection.commit)}</span><span className="sr-only">Commit {selection.commit}</span></code>
    {snapshot?.parent === null && <span className="commit-review-root">Root commit</span>}
  </div>;
}

export function CommitReviewFiles({ view, state, options, onEdit, onCopyError, collapsed, onToggle }: { view: CommitReviewView; state: CommitReviewState; options: ReviewOptions; onEdit(path: string): void; onCopyError(message: string): void; collapsed: ReadonlySet<string>; onToggle(path: string): void }) {
  if (!view.selection) return <p className="review-empty">Select a commit to review its changes.</p>;
  if (view.error) return <div className="review-branch-unavailable" role="alert"><p>{view.error}</p><button type="button" onClick={() => state.refresh()}>Retry</button></div>;
  const snapshot = currentSnapshot(view);
  if (!snapshot) return view.loading ? <div className="review-loading" role="status" aria-label="Loading commit"><span>Loading commit…</span></div> : null;
  return <SnapshotFiles key={`${snapshot.selection.repositoryId}:${snapshot.selection.commit}`} snapshot={snapshot} path={view.path} diffs={view.diffs} state={state} options={options} onEdit={onEdit} onCopyError={onCopyError} collapsed={collapsed} onToggle={onToggle}/>;
}

const copyIcon = <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M10.5 3H4.5A1.5 1.5 0 0 0 3 4.5v6"/></svg>;
function openState(file: GitCommitReviewFile): { enabled: boolean; title: string } {
  if (!isWorkspaceFilePath(file.path)) return { enabled: false, title: "This filename can be reviewed and copied, but cannot be opened in a file tab." };
  if (file.newMode === "120000") return { enabled: false, title: "This commit records a symbolic link. The diff shows its historical target; the current link is not opened as that content." };
  if (file.newMode === "160000") return { enabled: false, title: "This path is a submodule commit reference, not a file." };
  return { enabled: true, title: "Open the current working tree file" };
}
function emptyPatchNote(file: GitCommitReviewFile): string {
  if (file.additions === null) return "Binary file changed.";
  if (file.oldOid === file.newOid) return file.oldMode !== file.newMode ? `Mode changed: ${file.oldMode} → ${file.newMode}` : file.change === "R" ? "Renamed without content changes." : "Git returned no text patch for this path.";
  return file.change === "T" ? "File type changed." : "Git returned no text patch for this path.";
}

/** Remounted per selected commit, so collapsed state, visibility and observed elements never carry across commits. */
function SnapshotFiles({ snapshot, path, diffs, state, options, onEdit, onCopyError, collapsed, onToggle }: { snapshot: GitCommitReviewSnapshot; path: string | undefined; diffs: ReadonlyMap<string, CommitReviewFileView>; state: CommitReviewState; options: ReviewOptions; onEdit(path: string): void; onCopyError(message: string): void; collapsed: ReadonlySet<string>; onToggle(path: string): void }) {
  const files = useMemo(() => !path || path === "." ? snapshot.files : snapshot.files.filter(file => file.path === path || file.previousPath === path || file.path.startsWith(`${path}/`)), [snapshot, path]);
  const byPath = useMemo(() => new Map(snapshot.files.map(file => [file.path, file])), [snapshot]);
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());
  const elements = useRef(new Map<Element, string>());
  const observer = useRef<IntersectionObserver>(null);
  const refs = useRef(new Map<string, RefCallback<HTMLElement>>());
  useEffect(() => () => observer.current?.disconnect(), []);
  function observe(element: HTMLElement): IntersectionObserver {
    return observer.current ??= new IntersectionObserver(entries => setVisible(old => {
      const next = new Set(old); let changed = false;
      for (const entry of entries) {
        const target = elements.current.get(entry.target); if (target === undefined) continue;
        if (entry.isIntersecting ? !next.has(target) && next.add(target) : next.delete(target)) changed = true;
      }
      return changed ? next : old;
    }), { root: element.closest(".review-scroll"), rootMargin: "300px 0px" });
  }
  function refFor(target: string): RefCallback<HTMLElement> {
    let ref = refs.current.get(target);
    if (!ref) {
      ref = element => {
        if (!element) return;
        elements.current.set(element, target); observe(element).observe(element);
        return () => { elements.current.delete(element); observer.current?.unobserve(element); setVisible(old => { if (!old.has(target)) return old; const next = new Set(old); next.delete(target); return next; }); };
      };
      refs.current.set(target, ref);
    }
    return ref;
  }
  // Only visible, expanded and never-requested files are read; failures wait for an explicit retry.
  useEffect(() => {
    for (const target of visible) {
      if (collapsed.has(target) || diffs.has(target)) continue;
      const file = byPath.get(target); if (file) state.requestFile(file);
    }
  }, [visible, collapsed, diffs, byPath, state]);
  return <ReviewDiffs options={options}>
    {files.map(file => {
      const target = file.path, folded = collapsed.has(target), rename = file.previousPath !== null && file.previousPath !== target;
      const open = file.change === "D" ? undefined : openState(file);
      return <article key={target} ref={refFor(target)} className="review-file" data-review-path={target}>
        <header className="review-file-header">
          <button className="review-file-title" aria-label={`${folded ? "Expand" : "Collapse"} ${target}`} aria-expanded={!folded} onClick={() => onToggle(target)}>
            <Icon name="chevron" className={folded ? "" : "open"}/><span title={rename ? `${file.previousPath} → ${target}` : target}>{rename && <span className="review-old-name">{file.previousPath} → </span>}{target}</span>
          </button>
          <span className="review-file-counts">{file.additions === null ? "Binary" : <><span className="review-added">+{file.additions}</span><span className="review-deleted">−{file.deletions}</span></>}</span>
          <div className="review-file-actions">
            <button className="review-icon-button" title="Copy path" aria-label={`Copy path ${target}`} onClick={() => { void navigator.clipboard.writeText(target).catch(() => onCopyError("The file path could not be copied.")); }}>{copyIcon}</button>
            {open && <button className="review-icon-button" disabled={!open.enabled} title={open.title} aria-label={`Open ${target}`} onClick={() => onEdit(target)}><Icon name="compose"/></button>}
          </div>
        </header>
        {!folded && <FileBody file={file} entry={diffs.get(target)} identity={`${snapshot.selection.commit}:${file.oldOid}:${file.newOid}:${target}`} options={options} onRetry={() => state.requestFile(file)}/>}
      </article>;
    })}
    {!files.length && <p className="review-empty">{snapshot.files.length ? `No changes to ${path} in this commit.` : "This commit changes no files."}</p>}
  </ReviewDiffs>;
}

function FileBody({ file, entry, identity, options, onRetry }: { file: GitCommitReviewFile; entry: CommitReviewFileView | undefined; identity: string; options: ReviewOptions; onRetry(): void }) {
  const patch = entry?.patch;
  const parsed = useMemo((): { value?: ReviewPatch; error?: string } | undefined => {
    if (patch === undefined) return undefined;
    try { return { value: parseReviewPatch(patch, identity, file.path) }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, [patch, identity, file.path]);
  if (parsed?.error) return <p className="review-message" role="alert">Diff could not be parsed: {parsed.error}</p>;
  if (parsed?.value) return parsed.value.files.length ? <>{parsed.value.files.map(part => <ReviewDiff key={part.key} file={part} options={options}/>)}</> : <p className="review-file-note">{emptyPatchNote(file)}</p>;
  if (entry?.error && !entry.loading) return <div className="review-file-note commit-review-file-error"><p role="alert">{entry.error}</p><button type="button" onClick={onRetry}>Retry</button></div>;
  return <div className="review-loading commit-review-file-loading" role="status" aria-label={`Loading diff for ${file.path}`}><span>Loading diff…</span></div>;
}
