import { TodoExternalEditor } from "./TodoExternalEditor";
import type { TodoEditorPorts } from "./todo-external-editor-state";
import { useId, useLayoutEffect, useSyncExternalStore } from "react";
import { Icon } from "./Icons";
import { SessionTodosModel, todoStatusLabels, type SessionTodosPanelInput, type SessionTodosPanelPorts, type SessionTodosPanelView } from "./session-todos-model";
import "./session-todos.css";

export interface SessionTodosPanelProps extends SessionTodosPanelInput, SessionTodosPanelPorts { model: SessionTodosModel; externalEditor?: TodoEditorPorts }

/** Root provides the actual owner bridge. Local selection and edit text never
 * constitute a native change; the owning host confirms every mutation. */
export function SessionTodosPanel(props: SessionTodosPanelProps) {
  const { model } = props, id = useId();
  useLayoutEffect(() => model.configure(props, props), [model, props.owner.hostId, props.owner.sessionId, props.value, props.connected,
    props.fresh, props.loading, props.pending, props.uncertain, props.error, props.readError, props.unavailable, props.original, props.receipt,
    props.output, props.mutate, props.refresh, props.copy]);
  const view = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  return <SessionTodosPanelContent model={model} view={view} id={id} externalEditor={props.externalEditor}/>;
}

const receiptLabels = { absent: "No host record", pending: "Pending on host", unknown: "Outcome unknown", failed: "Refused by host", succeeded: "Confirmed by host" } as const;
const statusGlyphs = { pending: "○", in_progress: "◐", completed: "●", abandoned: "⊘", blocked: "■" } as const;

/** Shared rendering path for component event/prop tests; not a simulated bridge. */
export function SessionTodosPanelContent({ model, view, id, externalEditor }: { model: SessionTodosModel; view: SessionTodosPanelView; id: string; externalEditor?: TodoEditorPorts }) {
  const { local, value, selected } = view, edit = local.edit, busy = !!local.pending || view.pending;
  const blocked = !!view.blockedReason, commandBlocked = !!view.commandReason;
  const error = local.error ?? view.error ?? view.readError;
  return <div className="session-todos" aria-busy={view.loading || busy}>
    <div className="session-todos-toolbar" role="toolbar" aria-label="Todo actions">
      <button type="button" aria-pressed={local.form === "append"} disabled={commandBlocked} onClick={() => model.openForm("append")}><Icon name="plus"/>Add</button>
      <button type="button" aria-pressed={!!edit} disabled={!value || (!edit && blocked)} onClick={() => model.setEditing(!edit)}><Icon name="pencil"/>Edit</button>
      <button type="button" disabled={!view.canCopy || !!local.pending} onClick={() => void model.copy()}>Copy</button>
      <button type="button" aria-pressed={local.form === "export"} disabled={commandBlocked || !value?.phases.length} onClick={() => model.openForm("export")}>Export</button>
      <button type="button" aria-pressed={local.form === "import"} disabled={commandBlocked} onClick={() => model.openForm("import")}>Import</button>
      <button type="button" className="icon-button" aria-label="Refresh todos" title="Refresh todos" aria-busy={local.refreshing || view.loading}
        disabled={!view.connected || local.refreshing || busy} onClick={() => void model.refresh()}><Icon name="refresh"/></button>
    </div>
    {externalEditor && <TodoExternalEditor view={view} ports={externalEditor}/>}
    {view.loading && !value && <p className="environment-note" role="status">Loading todos…</p>}
    {view.unavailable && <p className="environment-note" role="status">{view.unavailable}</p>}
    {!view.unavailable && !view.original && view.blockedReason && value && <p className="environment-note" role="status">{view.blockedReason}</p>}
    {error && <p className="session-todos-error" role="alert">{error}</p>}
    {view.original && <div className="session-todos-recovery" role="status">
      <strong>{receiptLabels[view.receipt?.state ?? "pending"]}</strong>
      <p>Original command <code>{view.original.commandId}</code>{view.original.request.mutation.action === "command" ? <> · <code>{view.original.request.mutation.text}</code></> : " · Markdown edit"}. It is inspected, never resent.</p>
      <button type="button" disabled={!view.connected || local.refreshing || busy} onClick={() => void model.refresh()}>Check original command status</button>
    </div>}
    {view.output && !view.original && <pre className="session-todos-output" role="status">{view.output}</pre>}
    {local.form === "append" && <form className="session-todos-form" onSubmit={event => { event.preventDefault(); void model.append(); }}>
      <label htmlFor={`${id}-phase`}>Phase <small>optional · last phase when empty</small></label>
      <input id={`${id}-phase`} type="text" list={`${id}-phases`} value={local.appendPhase} onChange={event => model.setAppend({ phase: event.target.value })}/>
      <datalist id={`${id}-phases`}>{value?.phases.map((phase, index) => <option key={index} value={phase.name}/>)}</datalist>
      <label htmlFor={`${id}-task`}>Task</label>
      <input id={`${id}-task`} type="text" value={local.appendText} onChange={event => model.setAppend({ text: event.target.value })}/>
      <div><button type="submit" disabled={commandBlocked || !local.appendText.trim()}>Append task</button><button type="button" onClick={() => model.openForm(undefined)}>Cancel</button></div>
    </form>}
    {(local.form === "export" || local.form === "import") && <form className="session-todos-form" onSubmit={event => { event.preventDefault(); void model.transfer(local.form === "export" ? "export" : "import"); }}>
      <label htmlFor={`${id}-path`}>{local.form === "export" ? "Export to" : "Import from"} <small>resolved on the owning host against the session directory · TODO.md when empty</small></label>
      <input id={`${id}-path`} type="text" value={local.path} placeholder="TODO.md" onChange={event => model.setPath(event.target.value)}/>
      {local.form === "import" && <p className="environment-note">Importing replaces every current todo with the file contents.</p>}
      <div><button type="submit" disabled={commandBlocked}>{local.form === "export" ? "Write Markdown file" : "Replace todos from file"}</button><button type="button" onClick={() => model.openForm(undefined)}>Cancel</button></div>
    </form>}
    {edit && <div className="session-todos-editor">
      {view.conflict && <div className="session-todos-conflict" role="alert"><p>The todos changed on the host. Your edits are kept here.</p></div>}
      <label htmlFor={`${id}-markdown`}>Todo Markdown</label>
      <textarea id={`${id}-markdown`} value={edit.text} spellCheck={false} onChange={event => model.setText(event.target.value)}
        onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void model.saveEdits(); } }}/>
      <div>
        {view.conflict
          ? <button type="button" disabled={blocked || !view.dirty} onClick={() => void model.saveEdits(true)}>Save over latest</button>
          : <button type="button" disabled={blocked || !view.dirty} onClick={() => void model.saveEdits()}>{local.pending === "edit" ? "Saving…" : "Save edits"}</button>}
        <button type="button" disabled={!!local.pending} onClick={() => model.discardEdits()}>{view.dirty ? "Discard edits" : "Close editor"}</button>
      </div>
    </div>}
    {value && !value.phases.length && !edit && <p className="environment-note">No todos yet. Add a task or let the agent create a plan.</p>}
    {value && value.phases.length > 0 && <div className="session-todos-phases">
      {value.phases.map((phase, phaseIndex) => <section key={`${phaseIndex}:${phase.name}`} className="session-todos-phase" aria-label={phase.name || "Unnamed phase"}>
        <h4><span>{phase.name || "Unnamed phase"}</span><small>{phase.tasks.filter(task => task.status === "completed").length}/{phase.tasks.length}</small></h4>
        <ul>{phase.tasks.map((task, taskIndex) => {
          const active = selected?.phase === phase && selected.task === task;
          return <li key={`${taskIndex}:${task.content}`} data-status={task.status}>
            <button type="button" aria-pressed={active} onClick={() => model.select({ phase: phase.name, task: task.content })}>
              <span className="session-todos-glyph" aria-hidden="true">{statusGlyphs[task.status]}</span>
              <span className="session-todos-content">{task.content}</span>
              <span className="session-todos-status">{todoStatusLabels[task.status]}</span>
            </button>
            {task.status === "blocked" && task.blocker && <p className="session-todos-blocker">Blocked: {task.blocker}</p>}
          </li>;
        })}</ul>
      </section>)}
    </div>}
    {selected && <div className="session-todos-actions" role="group" aria-label={`Actions for ${selected.task.content}`}>
      <button type="button" disabled={commandBlocked || selected.task.status === "in_progress"} onClick={() => void model.taskAction("start", selected.task)}>Start</button>
      <button type="button" disabled={commandBlocked || selected.task.status === "completed"} onClick={() => void model.taskAction("done", selected.task)}>Done</button>
      <button type="button" disabled={commandBlocked || selected.task.status === "abandoned"} onClick={() => void model.taskAction("drop", selected.task)}>Drop</button>
      <button type="button" disabled={commandBlocked} onClick={() => void model.taskAction("rm", selected.task)}>Remove</button>
    </div>}
  </div>;
}
