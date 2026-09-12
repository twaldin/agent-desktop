import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Command } from "cmdk";
import type { GitSubmissionIntent } from "../../../../packages/shared/src/git-submissions";
import { BranchSelector } from "./BranchSelector";
import { retainWorkspace } from "./workspace-lease";
import { Icon } from "./Icons";
import type { WorkspaceState } from "./workspace-state";
import { destinationKey, gitActionReasons, gitDestinations, readGitSelectionSummary, type GitAction, type GitSelectionSummary } from "./git-submission-view";
import "./git-submission-dialog.css";

/** Both entry points supply the same owner-scoped WorkspaceState. Browsing only
 * reads; the parent admits the captured intent after an explicit action. */
export function GitSubmissionDialog({ data, supported, branchPrefix, onOpenGitSettings, onSubmit, onClose }: {
  data: WorkspaceState; supported: boolean; branchPrefix: string;
  onOpenGitSettings(): void; onSubmit(intent: GitSubmissionIntent): void; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), branchName = useRef<HTMLInputElement>(null);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const composing = useRef(false), dispatched = useRef(false);
  const [, redraw] = useReducer(value => value + 1, 0);
  const [newBranch, setNewBranch] = useState(false), [name, setName] = useState(branchPrefix);
  const [destinationChoice, setDestinationChoice] = useState<string>();
  const [selected, setSelected] = useState("commit");
  const [retry, setRetry] = useState(0);
  const [summary, setSummary] = useState<{ context: typeof data.gitActionContext; include: boolean; value?: GitSelectionSummary; error?: string }>();
  const [portal, setPortal] = useState<HTMLElement>();
  const title = useId(), includeId = useId();
  useEffect(() => data.subscribe(redraw), [data]);
  useEffect(() => {
    if (!supported || !data.connected) return;
    void data.restore().then(() => { if (data.restored) { void data.loadGit(); void data.loadGitActionContext(); void data.loadGitSubmission(); void data.loadWorktrees(); } });
  }, [data, supported, data.connected, retry]);
  useLayoutEffect(() => {
    const node = dialog.current!; setPortal(node); node.showModal();
    node.querySelector<HTMLButtonElement>(".branch-selector-trigger")?.focus({ preventScroll: true });
    return () => { node.close(); if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { if (newBranch) branchName.current?.focus({ preventScroll: true }); }, [newBranch]);
  const context = data.gitActionContext, include = data.includeUnstaged;
  const displayedStatusMatches = Boolean(context && data.status?.revision === context.status.revision);
  useEffect(() => {
    let active = true; const abort = new AbortController(); setSummary(undefined);
    if (!supported || !data.connected || !context) return;
    void readGitSelectionSummary(data, context, include, abort.signal).then(value => {
      if (active) setSummary({ context, include, value });
    }, cause => { if (active) setSummary({ context, include, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { active = false; abort.abort(); };
  }, [data, context, include, data.connected, supported, retry]);
  const destinations = gitDestinations(context);
  const destination = destinationChoice === undefined ? context?.push.state === "available" ? context.push.destination : undefined : destinations.find(value => destinationKey(value) === destinationChoice);
  const pending = data.busy || Boolean(data.pending) || data.gitSubmission?.outcome === "pending";
  const uncertain = data.gitSubmission?.outcome === "unknown" && !data.gitSubmission.acknowledgedAt;
  const summaryHere = summary && summary.context === context && summary.include === include ? summary : undefined;
  const changed = !context || context.status.entries.length > 0;
  const trimmed = name.trim();
  const branchError = newBranch ? !trimmed ? "Enter a branch name." : trimmed.endsWith("/") ? "Branch name cannot end with “/”." : data.branches.some(value => !value.remote && value.name === trimmed) ? "Branch already exists." : undefined : undefined;
  const blocked = !supported ? "Update the owning host to use Commit or push." : !data.connected ? "Reconnect to this host." : !data.restored ? "Loading saved Git state…" : data.cacheWarning ?? (pending ? "A workspace operation is already pending." : uncertain ? "Inspect and acknowledge the previous outcome first." : data.errors["git-action-context"] ?? data.errors.git ?? (data.loading.has("git-action-context") || data.loading.has("git") ? "Loading Git state…" : !displayedStatusMatches ? "Git state changed. Refresh before continuing." : undefined));
  const reasons = gitActionReasons({ context, destination, includeUnstaged: include, blocked, branchError,
    ...(newBranch ? { newBranch: trimmed } : {}), selectionUnavailable: changed ? summaryHere?.error ?? (!summaryHere?.value ? "Loading diff…" : summaryHere.value.files === 0 ? "No changes to commit." : undefined) : undefined });
  function submit(action: GitAction) {
    if (dispatched.current || reasons[action] || !context || context !== data.gitActionContext || context.status.revision !== data.status?.revision) return;
    dispatched.current = true;
    onSubmit({ operation: action, contextRevision: context.revision, selectionMode: include ? "include-unstaged" : "staged", message: data.commitMessage,
      ...(newBranch ? { branch: { name: trimmed, create: true } } : {}),
      ...(action !== "commit" && destination ? { destination: { remote: destination.remote, revision: destination.revision,
        targetRef: newBranch ? `refs/heads/${trimmed}` : destination.targetRef, requiresUpstreamSetup: newBranch || destination.requiresUpstreamSetup } } : {}),
    });
  }
  function close() { if (!pending && !composing.current) onClose(); }
  return <dialog ref={dialog} className="git-submission-dialog" aria-labelledby={title}
    onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } }}>
    <h2 id={title} className="sr-only">Commit or push</h2>
    <Command label="Commit or push" shouldFilter={false} loop value={selected} onValueChange={setSelected}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDownCapture={event => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); if (["commit", "commit-and-push", "push"].includes(selected)) submit(selected as GitAction); }
        else if (event.target instanceof HTMLTextAreaElement && event.key === "Enter") event.stopPropagation();
      }}>
      <div className="git-submission-branch"><BranchSelector workspace={data} connected={data.connected} branchPrefix={branchPrefix}
        onOpenGitSettings={onOpenGitSettings} variant="commit" portalContainer={portal}
        destination={{ newBranch, onChange: value => { setNewBranch(value); } }}/></div>
      {newBranch && <div className="git-submission-new-branch"><input ref={branchName} aria-label="Branch name" maxLength={200} value={name} placeholder={branchPrefix} disabled={pending} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) event.stopPropagation(); }}/>{branchError && <p role="status">{branchError}</p>}</div>}
      {changed && <>
        <textarea className="git-submission-message" aria-label="Commit message" placeholder="Commit message (leave blank to generate)…" rows={3} value={data.commitMessage} disabled={pending} onChange={event => data.setCommitMessage(event.target.value)}/>
        <div className="git-submission-selection"><input id={includeId} type="checkbox" checked={include} disabled={pending} onChange={event => data.setIncludeUnstaged(event.target.checked)}/><label htmlFor={includeId}>Include unstaged changes</label>
          <span className="git-submission-totals" aria-label={summaryHere?.value ? `${summaryHere.value.additions} additions, ${summaryHere.value.deletions} deletions` : "Change totals unavailable"}>
            {!summaryHere && data.connected ? <span className="spinner" aria-label="Loading diff"/> : summaryHere?.value ? summaryHere.value.files === 0 ? <span>No changes</span> : <><span className="review-added">+{summaryHere.value.additions}</span><span className="review-deleted">−{summaryHere.value.deletions}</span></> : null}
          </span>
        </div>
      </>}
      {(destinations.length > 1 || context?.push.state === "unavailable" && destinations.length > 0) && <label className="git-submission-destination">Push to<select aria-label="Push destination" disabled={pending} value={destination ? destinationKey(destination) : ""} onChange={event => setDestinationChoice(event.target.value)}><option value="">Choose destination</option>{destinations.map(value => <option key={destinationKey(value)} value={destinationKey(value)}>{value.remote}/{newBranch ? trimmed : value.targetRef.replace(/^refs\/heads\//, "")}</option>)}</select></label>}
      {(blocked || summaryHere?.error) && <div className="git-submission-error"><p role="status">{blocked ?? summaryHere?.error}</p>{!pending && supported && data.connected && <button type="button" onClick={() => setRetry(value => value + 1)}>Refresh Git state</button>}</div>}
      {(uncertain || data.pending?.uncertain || data.gitSubmission?.outcome === "failed" && (data.gitSubmission.commit || data.gitSubmission.push || data.gitSubmission.branch)) && <GitSubmissionReceiptView data={data}/>}
      <div className="git-submission-action-region"><Command.List label="Suggestions"><div className="git-submission-actions">{(["commit", "commit-and-push", "push"] as const).map(action => <div key={action} title={reasons[action]}>
        <Command.Item className="git-submission-action" value={action} disabled={Boolean(reasons[action])} onSelect={() => submit(action)}><Icon name={action === "commit" ? "commit" : "push"}/><span>{action === "commit" ? "Commit" : action === "commit-and-push" ? "Commit and push" : "Push"}</span><kbd>{navigator.platform.includes("Mac") ? "⌘⏎" : "Ctrl+Enter"}</kbd></Command.Item>
      </div>)}</div></Command.List></div>
    </Command>
  </dialog>;
}

const phaseLabels = { queued: "Waiting…", branch: "Creating branch…", preparing: "Preparing changes…", generating: "Generating message…", committing: "Committing…", pushing: "Pushing…", completed: "Completed" };

export function GitSubmissionButton({ data, className, onOpen }: { data: WorkspaceState; className: string; onOpen(): void }) {
  const [, redraw] = useReducer(value => value + 1, 0);
  useEffect(() => data.subscribe(redraw), [data]);
  const receipt = data.gitSubmission;
  const active = receipt?.outcome === "pending";
  const canCancel = active && ["queued", "preparing", "generating"].includes(receipt.phase) && !receipt.cancelRequested;
  const label = active ? phaseLabels[receipt.phase] : receipt?.outcome === "unknown" && !receipt.acknowledgedAt ? "Check Git outcome" : "Commit or push";
  return <><button type="button" className={className} disabled={!data.connected || !data.restored || active || data.busy} onClick={onOpen} title={label}>
    {active ? <span className="spinner"/> : <Icon name="commit"/>}<span>{label}</span><Icon name="chevron"/>
  </button>{canCancel && <button type="button" className="git-submission-cancel" aria-label="Cancel Git operation" title="Cancel Git operation" disabled={!data.connected || data.gitSubmissionControlInFlight} onClick={() => void data.cancelGitSubmission()}><Icon name="close"/></button>}</>;
}

/** Durable partials remain inspectable even after the command dialog closes. */
export function GitSubmissionReceiptView({ data }: { data: WorkspaceState }) {
  const [, redraw] = useReducer(value => value + 1, 0);
  useEffect(() => data.subscribe(redraw), [data]);
  const receipt = data.gitSubmission;
  const canCancel = receipt?.outcome === "pending" && ["queued", "preparing", "generating"].includes(receipt.phase) && !receipt.cancelRequested;
  return <div className="git-submission-receipt" role="status">
    <p>{receipt?.outcome === "pending" ? phaseLabels[receipt.phase] : receipt?.outcome === "succeeded" ? receipt.commit ? receipt.branch ? `Committed to ${receipt.branch.after}` : "Commit completed" : "Push completed" : receipt?.error?.message ?? data.errors.action ?? "Checking the original Git operation…"}</p>
    {receipt?.commit && <p>Commit <code>{receipt.commit.commit.slice(0, 12)}</code> completed.</p>}
    {receipt?.push && <p>{receipt.push.remote}/{receipt.push.targetRef.replace(/^refs\/heads\//, "")}: {receipt.push.applied.remote === "confirmed" ? "push confirmed" : receipt.push.applied.remote === "rejected" ? "push rejected" : "push outcome unknown"}{receipt.push.applied.upstream !== "not-requested" ? ` · upstream ${receipt.push.applied.upstream}` : ""}</p>}
    {receipt?.progress && receipt.outcome === "pending" && <p>{receipt.progress}</p>}
    <div className="git-submission-receipt-actions">
      {canCancel && <button type="button" disabled={!data.connected || data.gitSubmissionControlInFlight} onClick={() => void data.cancelGitSubmission()}>Cancel</button>}
      {(data.pending || receipt?.outcome === "unknown") && <button type="button" disabled={!data.connected} onClick={() => void data.loadGitSubmission()}>Check original outcome</button>}
      {data.pending?.uncertain && <button type="button" disabled={!data.connected || data.busy} onClick={() => void data.retry()}>Retry original command</button>}
      {receipt?.outcome === "unknown" && !receipt.acknowledgedAt && <button type="button" disabled={!data.connected || data.gitSubmissionControlInFlight} onClick={() => void data.acknowledgeGitSubmission()}>I’ve inspected this outcome</button>}
    </div>
  </div>;
}

export function GitSubmissionFeedback({ data, ownerLabel, onDismiss }: { data: WorkspaceState; ownerLabel: string; onDismiss(): void }) {
  useEffect(() => { const release = retainWorkspace(data); return release; }, [data]);
  return <section className="git-submission-feedback" aria-label={`Git operation · ${ownerLabel}`}><header><span>{ownerLabel}</span><button type="button" className="icon-button" aria-label="Hide Git feedback" onClick={onDismiss}><Icon name="close"/></button></header><GitSubmissionReceiptView data={data}/></section>;
}
