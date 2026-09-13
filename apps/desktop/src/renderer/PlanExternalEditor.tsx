import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { PlanReviewModel, PlanReviewView } from "./plan-review-model";
import { PlanReviewPanelView } from "./PlanReviewPanel";
import { PlanExternalEditorState, type PlanEditorInput, type PlanEditorPorts } from "./plan-external-editor-state";
import "./plan-external-editor.css";

/** This mounted controller survives hiding the Plan dialog. The owning host,
 * not React cleanup, decides process completion and explicit cancellation. */
export function PlanReviewWithExternalEditor({ model, view, id, ownerLabel, ports }: {
  model: PlanReviewModel; view: PlanReviewView; id: string; ownerLabel?: string; ports: PlanEditorPorts;
}) {
  const input: PlanEditorInput = { ...view.owner, plan: view.plan, connected: view.connected, fresh: view.fresh,
    open: view.open, dirty: view.dirty };
  const [editor] = useState(() => new PlanExternalEditorState(input, ports));
  useLayoutEffect(() => editor.configure(input, ports), [editor, view.owner.hostId, view.owner.sessionId, view.plan,
    view.connected, view.fresh, view.open, view.dirty, ports]);
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  useEffect(() => {
    if (!view.connected) return;
    void editor.refresh();
    const timer = setInterval(() => { void editor.refresh(); }, 5_000);
    return () => clearInterval(timer);
  }, [editor, view.owner.hostId, view.owner.sessionId, view.connected]);
  const controls = <section className="plan-external-editor" aria-label="Configured Plan editor">
    <div className="plan-external-editor-actions">
      <button type="button" disabled={!state.available} title={state.reason} onClick={() => void editor.start({ kind: "plan" })}>Edit in configured editor</button>
      <button type="button" disabled={!view.connected || state.busy} onClick={() => void editor.refresh()}>Refresh editor status</button>
    </div>
    {state.reason && <p className="plan-review-help">{state.reason}</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.jobs.length > 0 && <ul aria-label="Original editor jobs">{state.jobs.map(job => <li key={job.request.requestId}>
      <span>{job.request.edit.kind === "plan" ? "Plan edit" : "Annotation edit"} · {job.state === "pending" ? "Editor running"
        : job.state === "absent" ? "Not received by host" : job.result?.outcome === "applied" ? "Saved to Plan"
        : job.result?.outcome === "cancelled" ? "Cancelled" : job.result?.outcome === "not-submitted" ? "Not started" : "Outcome unknown"}</span>
      {job.result?.message && <p>{job.result.message}</p>}
      <div className="plan-external-editor-actions">
        {job.terminalId && <button type="button" disabled={!view.connected || state.busy} onClick={() => void editor.act(job.request.requestId, "terminal")}>Open editor terminal</button>}
        <button type="button" disabled={!view.connected || state.busy} onClick={() => void editor.act(job.request.requestId, "status")}>Check original job</button>
        {(job.state === "pending" || job.result?.outcome === "unknown") && <button type="button" disabled={!view.connected || state.busy} onClick={() => void editor.act(job.request.requestId, "cancel")}>Cancel original editor</button>}
        {job.result?.outcome === "unknown" && <button type="button" disabled={!view.connected || state.busy} onClick={() => void editor.act(job.request.requestId, "recover")}>Recover edited text</button>}
      </div>
    </li>)}</ul>}
    {state.nextCursor && <button type="button" disabled={!view.connected || state.busy} onClick={() => void editor.refresh(true)}>Load earlier editor jobs</button>}
    {state.recovery && <div className="plan-external-editor-recovery">
      <p>The original edited text is retained. Copy it before making a fresh edit; recovery does not apply it automatically.</p>
      <textarea aria-label="Recovered editor text" readOnly value={state.recovery.content}/>
      <button type="button" disabled={state.busy} onClick={() => void editor.act(state.recovery!.requestId, "copy")}>Copy recovered text</button>
    </div>}
  </section>;
  return <PlanReviewPanelView model={model} view={view} id={id} ownerLabel={ownerLabel} externalTools={controls}
    annotationEditor={{ available: state.available, reason: state.reason, start: edit => editor.start(edit) }}/>;
}
