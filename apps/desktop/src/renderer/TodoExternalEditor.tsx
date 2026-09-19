import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { SessionTodosPanelView } from "./session-todos-model";
import { TodoExternalEditorState, type TodoEditorInput, type TodoEditorPorts, type TodoEditorView } from "./todo-external-editor-state";
import "./plan-external-editor.css";

/** Unmounting or hiding these controls never cancels the host-owned process. */
export function TodoExternalEditor({ view, ports }: { view: SessionTodosPanelView; ports: TodoEditorPorts }) {
  const input: TodoEditorInput = { ...view.owner, todos: view.value, connected: view.connected, fresh: view.fresh && !view.blockedReason,
    open: true, dirty: view.dirty };
  const [editor] = useState(() => new TodoExternalEditorState(input, ports));
  useLayoutEffect(() => editor.configure(input, ports), [editor, view.owner.hostId, view.owner.sessionId, view.value,
    view.connected, view.fresh, view.blockedReason, view.dirty, ports]);
  useLayoutEffect(() => () => editor.hide(), [editor]);
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  useEffect(() => {
    if (!view.connected) return;
    void editor.refresh();
    const timer = setInterval(() => { void editor.refresh(); }, 5_000);
    return () => clearInterval(timer);
  }, [editor, view.owner.hostId, view.owner.sessionId, view.connected]);
  return <TodoExternalEditorControls editor={editor} state={state} connected={view.connected}/>;
}
export function TodoExternalEditorControls({ editor, state, connected }: {
  editor: TodoExternalEditorState; state: TodoEditorView; connected: boolean;
}) {
  return <section className="plan-external-editor" aria-label="Configured Todos editor">
    <div className="plan-external-editor-actions">
      <button type="button" disabled={!state.available} title={state.reason} onClick={() => void editor.start()}>Edit in configured editor</button>
      <button type="button" disabled={!connected || state.busy} onClick={() => void editor.refresh()}>Refresh editor status</button>
    </div>
    {state.reason && <p className="plan-review-help">{state.reason}</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.jobs.length > 0 && <ul aria-label="Original editor jobs">{state.jobs.map(job => <li key={job.request.requestId}>
      <span>Todo edit · {job.state === "pending" ? "Editor running"
        : job.state === "absent" ? "Not received by host" : job.result?.outcome === "applied" ? "Saved to Todos"
        : job.result?.outcome === "cancelled" ? "Cancelled" : job.result?.outcome === "not-submitted" ? "Not started" : "Outcome unknown"}</span>
      {job.result?.message && <p>{job.result.message}</p>}
      <div className="plan-external-editor-actions">
        {job.terminalId && <button type="button" disabled={!connected || state.busy} onClick={() => void editor.act(job.request.requestId, "terminal")}>Open editor terminal</button>}
        <button type="button" disabled={!connected || state.busy} onClick={() => void editor.act(job.request.requestId, "status")}>Check original job</button>
        {(job.state === "pending" || job.result?.outcome === "unknown") && <button type="button" disabled={!connected || state.busy} onClick={() => void editor.act(job.request.requestId, "cancel")}>Cancel original editor</button>}
        {job.result?.outcome === "unknown" && <button type="button" disabled={!connected || state.busy} onClick={() => void editor.act(job.request.requestId, "recover")}>Recover edited text</button>}
      </div>
    </li>)}</ul>}
    {state.nextCursor && <button type="button" disabled={!connected || state.busy} onClick={() => void editor.refresh(true)}>Load earlier editor jobs</button>}
    {state.recovery && <div className="plan-external-editor-recovery">
      <p>{state.recovery.source === "completed-output" ? "Completed editor output is retained." : "Only the original input is available; no completed editor output was recorded."} Copy it before making a fresh edit; recovery does not apply it automatically.</p>
      <textarea aria-label="Recovered editor text" readOnly value={state.recovery.content}/>
      <button type="button" disabled={state.busy} onClick={() => void editor.act(state.recovery!.requestId, "copy")}>Copy recovered text</button>
    </div>}
  </section>;
}
