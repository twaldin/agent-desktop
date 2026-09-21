import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { parseGitRevisionExpression } from "@agent-desktop/shared";
import { Icon } from "./Icons";
import { useBranchInventory } from "./use-branch-inventory";
import { useBranchSearch } from "./use-branch-search";
import type { WorkspaceState } from "./workspace-state";
import type { BranchReviewState, BranchReviewView, ReviewSource } from "./branch-review-state";
import { CommitReviewItems } from "./CommitReviewControls";
import type { CommitReviewView } from "./commit-review-state";
import type { GitReviewCommit } from "../../../../packages/shared/src/git-commit-review";
import "./branch-selector.css";
import "./branch-review.css";

function ReviewMenu({ label, value, disabled, children, onClose }: { label: string; value: ReactNode; disabled?: boolean; children(close: () => void): ReactNode; onClose?(): void }) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState<CSSProperties>();
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { if (!open) onClose?.(); }, [open, onClose]);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const measure = () => {
      const box = trigger.current!.getBoundingClientRect(), width = Math.min(320, innerWidth - 24);
      const top = Math.min(box.bottom + 4, innerHeight - 96);
      setPosition({ width, left: Math.max(12, Math.min(box.left, innerWidth - width - 12)), top, maxHeight: Math.max(80, innerHeight - top - 12) });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(trigger.current);
    window.addEventListener("resize", measure); window.addEventListener("scroll", measure, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>("input,button:not(:disabled)")?.focus());
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", outside);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("pointerdown", outside); };
  }, [open]);
  function key(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (event.target instanceof HTMLInputElement && ["Home", "End"].includes(event.key)) return;
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (!buttons.length) return;
    event.preventDefault(); const index = buttons.indexOf(event.target as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index < 0 ? event.key === "ArrowUp" ? buttons.length - 1 : 0 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus(); buttons[next]?.scrollIntoView({ block: "nearest" });
  }
  return <><button ref={trigger} type="button" className="review-source-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(value => !value)}><span>{value}</span><Icon name="chevron"/></button>{open && createPortal(<div ref={menu} style={position} role="menu" aria-label={`${label} menu`} className="branch-selector-menu review-source-menu" onKeyDown={key}>{children(close)}</div>, document.body)}</>;
}
export function ReviewSourceControl({ source, disabled, onSelect, commitView, onCommitSelect, onCommitRetry, onCommitOpenChange }: {
  source: ReviewSource; disabled: boolean; onSelect(source: ReviewSource): void; commitView: CommitReviewView;
  onCommitSelect(commit: GitReviewCommit): void; onCommitRetry(): void; onCommitOpenChange(open: boolean): void;
}) {
  const choices = [{ id: "branch", label: "Branch" }, { id: "unstaged", label: "Unstaged" }, { id: "staged", label: "Staged" }] as const;
  const [commitsOpen, setCommitsOpen] = useState(false);
  const commitTrigger = useRef<HTMLButtonElement>(null), submenu = useRef<HTMLDivElement>(null);
  const reset = useCallback(() => { setCommitsOpen(false); onCommitOpenChange(false); }, [onCommitOpenChange]);
  const openCommits = () => { setCommitsOpen(true); onCommitOpenChange(true); };
  const back = () => { reset(); requestAnimationFrame(() => commitTrigger.current?.focus()); };
  useLayoutEffect(() => {
    if (commitsOpen) submenu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [commitsOpen]);
  return <ReviewMenu label="Review source" value={source === "commit" ? "Commit" : choices.find(item => item.id === source)!.label} disabled={disabled} onClose={reset}>{close => commitsOpen
    ? <div ref={submenu} className="commit-review-menu" onKeyDown={event => { if (event.key === "ArrowLeft" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); back(); } }}>
      <button type="button" role="menuitem" onClick={back}><span>Review sources</span></button>
      <CommitReviewItems view={commitView} onRetry={onCommitRetry} onSelect={commit => { onCommitSelect(commit); close(); }}/>
    </div>
    : <>{choices.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={source === item.id} onClick={() => { onSelect(item.id); close(); }}><span>{item.label}</span>{source === item.id && <Icon name="check"/>}</button>)}
      <button ref={commitTrigger} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={false} onClick={openCommits} onKeyDown={event => { if (event.key === "ArrowRight" && !event.nativeEvent.isComposing) { event.preventDefault(); openCommits(); } }}><span>Commits</span><Icon name="chevron"/></button>
    </>}</ReviewMenu>;
}
export function BranchReviewControls({ workspace, state, view }: { workspace: WorkspaceState; state: BranchReviewState; view: BranchReviewView }) {
  const inventory = useBranchInventory(workspace, workspace.connected, "starting-state");
  const [query, setQuery] = useState("");
  const search = useBranchSearch(workspace, query, workspace.connected);
  const [error, setError] = useState<string>();
  const current = view.result?.currentBranch ?? workspace.status?.branch ?? "HEAD";
  const nativeDefault = inventory.snapshot.baseBranch;
  const defaultBase = nativeDefault ? `${nativeDefault.remote}/${nativeDefault.local}` : undefined;
  const selected = view.baseBranch ?? view.result?.baseBranch ?? defaultBase;
  const names = [...new Set([selected, defaultBase, ...inventory.snapshot.recent].filter((item): item is string => !!item && item !== current))];
  const choose = (value: string | undefined, close: () => void) => {
    try { state.selectBase(value === undefined ? undefined : parseGitRevisionExpression(value)); setError(undefined); setQuery(""); close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Enter a valid base branch."); }
  };
  return <div className="review-base-row"><span className="review-current-branch" title={current}>{current}</span><span aria-hidden="true">→</span><ReviewMenu label="Review base branch" disabled={!workspace.connected} value={selected ?? "Select branch"}>{close => <>
    <label className="branch-selector-search"><Icon name="search"/><input aria-label="Search review base branches" value={query} placeholder="Search branches" onChange={event => { setQuery(event.target.value); setError(undefined); }} onKeyDown={event => { if (event.key === "Enter" && query.trim() && !event.nativeEvent.isComposing) { event.preventDefault(); choose(query, close); } }}/></label>
    {error && <p role="alert">{error}</p>}
    {query.trim() ? <>{search.snapshot.loading && <p role="status">Loading branches…</p>}{search.snapshot.error && <><p role="alert">{search.snapshot.error}</p><button onClick={() => search.controller.retry()}>Retry</button></>}{search.snapshot.branches.filter(branch => !branch.current && !branch.symbolicTarget).map(branch => <button type="button" role="menuitemradio" aria-checked={selected === branch.ref || selected === branch.name} key={branch.ref} onClick={() => choose(branch.ref, close)}><span>{branch.name}<small>{branch.remote ? "Remote branch" : "Local branch"}</small></span></button>)}{search.snapshot.limitReached && <p>Refine the search to see more branches.</p>}<button type="button" role="menuitem" onClick={() => choose(query, close)}><span>Use “{query.trim()}”</span></button></> : <>
      {(inventory.snapshot.loading || !inventory.snapshot.loaded) && !inventory.snapshot.error && <p role="status">Loading branches…</p>}
      {(inventory.snapshot.error || inventory.snapshot.defaultError) && <><p role="alert">{inventory.snapshot.error ?? inventory.snapshot.defaultError}</p><button onClick={() => inventory.controller.retry()}>Retry</button></>}
      {defaultBase && <button type="button" role="menuitemradio" aria-checked={view.baseBranch === undefined} onClick={() => choose(undefined, close)}><span>{defaultBase}<small>Default base branch</small></span></button>}
      {names.filter(name => name !== defaultBase).map(name => <button type="button" role="menuitemradio" aria-checked={selected === name} key={name} onClick={() => choose(name, close)}><span>{name}</span></button>)}
      {inventory.snapshot.loaded && !names.length && <p>No base branches found. Enter a branch or reference above.</p>}
    </>}
  </>}</ReviewMenu></div>;
}
