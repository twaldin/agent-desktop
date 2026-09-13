import { useId, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icons";
import { MarkdownText } from "./MarkdownText";
import { PierreSourceEditor } from "./PierreSourceEditor";
import { PlanDocumentReview } from "./PlanDocumentReview";
import { PlanReviewModel, type PlanReviewInput, type PlanReviewPorts, type PlanReviewView } from "./plan-review-model";
import "./plan-review-panel.css";

export interface PlanReviewPanelProps extends PlanReviewInput, PlanReviewPorts { ownerLabel?: string }

/** Root provides the actual owner bridge. Local edit state never constitutes a
 * successful write, approval, or transition to a new native session. */
export function PlanReviewPanel(props: PlanReviewPanelProps) {
  const [model] = useState(() => new PlanReviewModel(props, props));
  const id = useId();
  useLayoutEffect(() => model.configure(props, props), [model, props.owner.hostId, props.owner.sessionId, props.plan,
    props.connected, props.fresh, props.open, props.executionChoices, props.receipt, props.failure, props.error,
    props.mutate, props.dismiss, props.reopen, props.refresh, props.copy, props.openPlan, props.readDocumentSection]);
  const view = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  return <PlanReviewPanelView model={model} view={view} id={id} ownerLabel={props.ownerLabel}/>;
}

/** Shared rendering path for component event/prop tests; not a simulated bridge. */
export function PlanReviewPanelView({ model, view, id, ownerLabel }: {
  model: PlanReviewModel; view: PlanReviewView; id: string; ownerLabel?: string;
}) {
  const review = view.plan.review, draft = view.draft, closed = !view.open || review?.status === "dismissed";
  const disabled = !!view.blockedReason, deciding = disabled || view.dirty;
  const receipt = draft?.receipt ?? (!review || view.receipt?.reviewId === review.id ? view.receipt : undefined);
  return <section className="plan-review-panel" aria-labelledby={`${id}-title`} onKeyDown={event => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!closed && !disabled) { event.preventDefault(); event.stopPropagation(); void model.auxiliary("dismiss"); }
  }}>
    <header className="plan-review-heading">
      <div><span className="plan-review-eyebrow">Plan review{ownerLabel ? ` · ${ownerLabel}` : ""}</span>
        <h2 id={`${id}-title`}>{review?.title || "Plan"}</h2></div>
      <div className="plan-review-heading-actions">
        <button type="button" aria-label="Refresh plan status" title="Refresh plan status" aria-busy={view.refreshing} disabled={!view.connected || !!draft?.pending || view.refreshing} onClick={() => void model.auxiliary("refresh")}><Icon name="refresh"/></button>
        {!closed && review && <button type="button" aria-label="Dismiss plan review" disabled={disabled} onClick={() => void model.auxiliary("dismiss")}><Icon name="close"/></button>}
      </div>
    </header>
    {view.plan.warning && <p className="plan-review-note" role="status">{view.plan.warning}</p>}
    {view.refreshing && <p className="plan-review-note" role="status">Checking plan status…</p>}
    {view.blockedReason && <p className="plan-review-note" role="status">{view.blockedReason}</p>}
    {(draft?.error || view.error) && <p className="plan-review-error" role="alert">{draft?.error || view.error}</p>}
    {(view.plan.reconciliationRequired || review?.status === "unknown" || draft?.uncertain || receipt?.outcome === "unknown") &&
      <div className="plan-review-recovery"><button type="button" disabled={!view.connected || !!draft?.pending || view.refreshing} onClick={() => void model.auxiliary("refresh")}>Check original action status</button></div>}
    {receipt && <div className="plan-review-receipt" role="status">
      <strong>{receipt.outcome === "unknown" ? "Outcome not confirmed" : receipt.outcome === "cancelled" ? "Action cancelled" : "Host confirmed the action"}</strong>
      {receipt.message && <p>{receipt.message}</p>}
      {receipt.compaction && <>
        <p>{receipt.compaction.outcome === "failed" ? "Compaction failed." : receipt.compaction.outcome === "cancelled" ? "Compaction was cancelled." : "Context was compacted."}</p>
        {receipt.compaction.message && <p>{receipt.compaction.message}</p>}
        {receipt.compaction.outcome === "failed" && <p>The original context and Plan model were retained. The selected execution role was not applied.</p>}
      </>}
      {receipt.planExit === "completed" && <p>Plan mode exited and the review closed.</p>}
      {receipt.planExit === "unknown" && <p>Whether Plan mode exited and the review closed is unknown.</p>}
      {receipt.planExit === "unchanged" && <p>Plan mode was not exited by this action.</p>}
      {receipt.artifact === "written" && <p>{receipt.savedDestination ? `Plan saved to ${receipt.savedDestination}` : "Plan content was written."}</p>}
      {receipt.artifact === "unknown" && <p>Whether the plan was written is unknown.</p>}
      {receipt.transition === "new-session" && <p>A new session was created on the owning host.</p>}
      {receipt.transition === "unchanged" && <p>No replacement session was created.</p>}
      {receipt.transition === "unknown" && <p>The session transition is not confirmed.</p>}
      {receipt.execution === "entered" && <p>Execution was admitted. Follow its progress in the conversation.</p>}
      {receipt.execution === "not-entered" && <p>Execution was not admitted.</p>}
      {receipt.execution === "unknown" && <p>Execution admission is not confirmed. Check status; do not repeat the decision.</p>}
    </div>}
    {!review || !draft ? <p className="plan-review-empty">No plan is available to review.</p> : <>
      {closed && <div className="plan-review-reopen"><p>Review dismissed. Your local edits and feedback are retained in this panel.</p>
        <button type="button" disabled={disabled} onClick={() => void model.auxiliary("reopen")}>Reopen plan review</button></div>}
      <div className="plan-review-body" hidden={closed}>
        <div className="plan-review-toolbar">
          <div role="group" aria-label="Plan view">
            <button type="button" aria-pressed={!draft.editing} onClick={() => model.setEditing(false)}>Preview</button>
            <button type="button" aria-pressed={draft.editing} onClick={() => model.setEditing(true)}><Icon name="pencil"/>Edit Markdown</button>
          </div>
          <div>
            <button type="button" disabled={!view.canCopy || !!draft.pending} onClick={() => void model.auxiliary("copy")}>{view.canCopy ? "Copy plan" : "Copy unavailable"}</button>
            <button type="button" disabled={!view.canOpenPlan || disabled || view.dirty} onClick={() => void model.auxiliary("open")}>{view.canOpenPlan ? "Open in editor" : "External editor unavailable"}</button>
          </div>
        </div>
        <p className="plan-review-reference">{review.reference}</p>
        {review.document && <PlanDocumentReview document={review.document} model={model} disabled={deciding || closed}
          ownerKey={view.documentKey ?? ""}/>}
        {view.conflict && <div className="plan-review-conflict" role="alert"><p>The plan changed on the host. Your local edits are still here. Copy them before discarding if you need both versions.</p>
          <button type="button" disabled={!!draft.pending || draft.uncertain} onClick={() => model.discardEdits()}>Discard edits and load latest</button></div>}
        {view.dirty && <div className="plan-review-edit-actions"><span>Unsaved plan edits</span>
          <button type="button" disabled={disabled} onClick={() => void model.mutate("edit")}>{draft.pending === "edit" ? "Saving…" : "Save edits"}</button>
          <button type="button" disabled={!!draft.pending || draft.uncertain} onClick={() => model.discardEdits()}>Cancel edits</button></div>}
        <div className="plan-review-document">
          <div className="plan-review-preview" hidden={draft.editing}><MarkdownText text={draft.text} blockKey={`plan:${view.documentKey}`} allowWideBlocks/></div>
          <div className="plan-review-editor" hidden={!draft.editing}>
            <PierreSourceEditor documentKey={`plan:${view.documentKey}`} name="plan.md" label="Plan Markdown"
              value={draft.text} onChange={text => model.setText(text)} onSave={() => { void model.mutate("edit"); }} active={!closed && draft.editing}/>
          </div>
        </div>
        <div className="plan-review-decisions">
          <fieldset disabled={deciding}><legend>Approve and execute</legend>
            {view.executionChoices.length > 1 || draft.role && !view.executionChoices.some(choice => choice.role === draft.role) ? <label htmlFor={`${id}-role`}>Execution model
              <select id={`${id}-role`} value={draft.role} onChange={event => model.setRole(event.target.value)}>
                <option value="">Use native execution model</option>
                {draft.role && !view.executionChoices.some(choice => choice.role === draft.role) && <option value={draft.role} disabled>{draft.role} · no longer available</option>}
                {view.executionChoices.map(choice => <option key={choice.role} value={choice.role} disabled={!!choice.unavailableReason}>
                  {choice.label || `${choice.role} · ${choice.provider}/${choice.modelId}`}{choice.thinking ? ` · ${choice.thinking}` : ""}{choice.unavailableReason ? ` · ${choice.unavailableReason}` : ""}
                </option>)}
              </select></label> : <p className="plan-review-help">The native execution model and thinking selection are preserved.</p>}
            <div className="plan-review-approval-actions">
              <button type="button" className="plan-review-primary" onClick={() => void model.mutate("approve", "fresh")}>Approve · new context</button>
              <button type="button" onClick={() => void model.mutate("approve", "compact")}>Approve · compact context</button>
              <button type="button" disabled={!review.canKeepContext} aria-describedby={!review.canKeepContext ? `${id}-keep-reason` : undefined} onClick={() => void model.mutate("approve", "keep")}>Approve · keep context</button>
            </div>
            <p className="plan-review-help">New context starts a new session with the plan. Compact summarizes this conversation. Keep continues with the current context.</p>
            {!review.canKeepContext && <p id={`${id}-keep-reason`} className="plan-review-help">{review.keepContextReason}</p>}
          </fieldset>
          <div className="plan-review-refinement"><label htmlFor={`${id}-feedback`}>Refinement feedback</label>
            <textarea id={`${id}-feedback`} value={draft.feedback} placeholder="What should change in this plan?" onChange={event => model.setFeedback(event.target.value)}/>
            <button type="button" disabled={deciding} onClick={() => void model.mutate("refine")}>{draft.feedback.trim() ? "Refine plan" : "Continue planning"}</button>
            {!draft.feedback.trim() && <p className="plan-review-help">Return to planning and enter your next prompt. No feedback prompt is sent.</p>}
          </div>
          <details className="plan-review-save"><summary>Save plan and start a new session</summary>
            <label htmlFor={`${id}-destination`}>Destination on the owning host</label>
            <input id={`${id}-destination`} type="text" value={draft.destination} placeholder="Path for the saved Markdown file" onChange={event => model.setDestination(event.target.value)}/>
            <p className="plan-review-help">Saves the plan at this destination, then starts a new session. This does not quit the host.</p>
            <button type="button" disabled={deciding || !draft.destination.trim()} onClick={() => void model.mutate("save")}>Save plan and start new session</button>
          </details>
        </div>
      </div>
    </>}
  </section>;
}


/** Separate from the review: approval can close it before native admission.
 * The owning host supplies eligibility; this action never reconstructs a prompt. */
export function PlanExecutionContinuationControl({ view, connected, retry, refresh, openOwner }: {
  view: Pick<import("./use-session-plan").SessionPlanView, "owner" | "executionContinuation" | "executionRetryCommandId" | "fresh" | "pending" | "uncertain" | "loading" | "error">;
  connected: boolean; retry(expected: NonNullable<import("./use-session-plan").SessionPlanView["executionContinuation"]>): Promise<void>; refresh(): Promise<void>; openOwner(expected: NonNullable<import("./use-session-plan").SessionPlanView["executionContinuation"]>): void;
}) {
  const continuation = view.executionContinuation;
  if (!continuation && !view.executionRetryCommandId) return null;
  const ownsExecution = continuation?.executionOwnerId === view.owner.sessionId;
  const blocked = !connected || !view.fresh || view.pending || view.uncertain || continuation?.state !== "ready";
  return <section className="plan-execution-continuation" aria-label="Original Plan execution">
    <p role="status">{view.pending || continuation?.state === "pending" ? "The original Plan input is pending. Check its status before another attempt."
      : view.uncertain || continuation?.state === "unknown" ? "The original Plan input outcome is unknown. Check status without repeating it."
      : continuation?.state === "entered" ? "The native Plan input was admitted. Follow its progress in the conversation."
      : continuation?.state === "ready" ? "The native Plan input was not admitted. You can retry its original prepared input."
      : "Check the original Plan retry status."}</p>
    {view.error && <p role="alert">{view.error}</p>}
    <div>
      {continuation && !ownsExecution ? <button type="button" disabled={!connected || view.pending} onClick={() => openOwner(continuation)}>Open approved conversation</button>
        : continuation?.state === "ready" && <button type="button" disabled={blocked} onClick={() => { void retry(continuation).catch(() => {}); }}>Retry original Plan input</button>}
      <button type="button" disabled={!connected || view.loading || view.pending} onClick={() => { void refresh().catch(() => {}); }}>Check Plan execution status</button>
    </div>
  </section>;
}
