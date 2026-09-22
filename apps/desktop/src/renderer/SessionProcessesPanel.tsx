import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  parseSessionProcessTarget, sameSessionProcessTarget, SESSION_PROCESSES_MAX_INPUT_CHARS,
  type SessionProcessesSnapshot, type SessionProcessRow, type SessionProcessState, type SessionProcessTarget,
} from "../../../../packages/shared/src/session-processes";
import { Icon } from "./Icons";
import {
  findProcessRow, initialSessionProcessesView, processMutationRefusal, processRowKey, SessionProcessesState,
  type SessionProcessesBridge, type SessionProcessesJournal, type SessionProcessesLogs, type SessionProcessesView, type SessionProcessOperationView,
} from "./session-processes-state";
import "./session-processes.css";

export interface SessionProcessesPanelProps {
  bridge: SessionProcessesBridge; journal?: SessionProcessesJournal; hostId: string; sessionId: string; connected: boolean; visible: boolean;
}
type Controls = Pick<SessionProcessesState, "refresh" | "inspect" | "closeLogs" | "mutate" | "lookupReceipt" | "retryJournal" | "dismissOperation">;

/** Renders the OMP broker's supervised project processes inside the Processes section Root supplies.
 * Reads and every guarded operation stay pinned to the original host, session and native owner;
 * hiding or unmounting only stops reading and never touches a running process. */
export function SessionProcessesPanel({ bridge, journal, hostId, sessionId, connected, visible }: SessionProcessesPanelProps) {
  const state = useMemo(() => new SessionProcessesState(bridge, journal), [bridge, journal]);
  const store = useMemo(() => ({
    subscribe: (listener: () => void) => state.subscribe(listener),
    snapshot: () => state.getSnapshot(),
  }), [state]);
  useLayoutEffect(() => { state.configure({ hostId, sessionId, connected, visible }); }, [state, hostId, sessionId, connected, visible]);
  useEffect(() => () => state.stop(), [state]);
  const stored = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  // A host/session change must not paint the previous owner's processes even for one frame; the layout effect reconfigures after this render.
  const view = stored.hostId === hostId && stored.sessionId === sessionId ? stored : initialSessionProcessesView(hostId, sessionId, state.supported, connected);
  return <SessionProcessesPanelContent view={view} state={state}/>;
}

const stateLabels: Record<SessionProcessState, string> = {
  starting: "Starting", running: "Running", ready: "Ready", restarting: "Restarting", stopping: "Stopping", exited: "Exited", failed: "Failed",
};
const stateOrder: SessionProcessState[] = ["ready", "running", "starting", "restarting", "stopping", "failed", "exited"];
const actionLabels = { stop: "Stop", restart: "Restart", input: "Standard input" } as const;
const readinessLabels = { log: "a matching log line", port: "an accepting port" } as const;
const NO_NEWLINE = "Sent exactly as typed; OMP appends no newline. Type one yourself if the process expects it.";

/** Root accepts any safe integer timestamp, including values outside the Date range; an
 * unrepresentable instant is shown as the raw number instead of throwing the panel away. */
function clock(ms: number) {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? `timestamp ${ms}` : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function isoStamp(ms: number) {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
/** Percent-style escaping keyed on `_`, so distinct broker, name, id and generation tuples can
 * never share a DOM id; every escape starts with `_` and no literal `_` survives unescaped. */
const idPart = (value: string) => value.replace(/[^A-Za-z0-9]/g, character => `_${character.codePointAt(0)!.toString(16)}_`);
const elementId = (target: SessionProcessTarget) =>
  `session-process-${idPart(target.brokerId)}-${idPart(target.name)}-${idPart(target.id)}-${target.generation}`;

/** Empty or overlong standard input never reaches the bridge. */
export function processInputIssue(draft: string): string | undefined {
  if (!draft.length) return "Type the bytes to send before sending.";
  if (draft.length > SESSION_PROCESSES_MAX_INPUT_CHARS) return `Standard input is limited to ${SESSION_PROCESSES_MAX_INPUT_CHARS} characters; ${draft.length} typed.`;
  return undefined;
}

/** Copies the exact target and bytes through the shared validator before the first await, so a
 * refresh that replaces the row cannot redirect an operation to a newer process. */
export function captureProcessMutation(state: Pick<Controls, "mutate">, row: SessionProcessRow, action: "stop" | "restart" | "input", draft?: string) {
  const target = parseSessionProcessTarget(row.target);
  return action === "input" ? state.mutate(target, "input", String(draft ?? "")) : state.mutate(target, action);
}

/** What a send captured: the exact bytes and target, plus every operation id that already existed,
 * so a receipt for an older send can never clear a newer draft. Held in component memory only. */
export interface ProcessInputSubmission { text: string; target: SessionProcessTarget; known: readonly string[] }

/** Resolves a submitted send against the current view: `settled` is the durable completed receipt
 * created by that send, and `clear` says whether the draft the user is still holding is the exact
 * text that was confirmed. An edited draft is kept. */
export function resolveInputDraft(view: SessionProcessesView, submission: ProcessInputSubmission, draft: string):
{ settled: SessionProcessOperationView; clear: boolean } | undefined {
  const settled = view.operations.find(operation => operation.action === "input" && operation.status === "completed"
    && sameSessionProcessTarget(operation.target, submission.target) && !submission.known.includes(operation.operationId));
  return settled ? { settled, clear: draft === submission.text } : undefined;
}

/** Shared rendering path for prop-driven tests; `state` supplies the controls. */
export function SessionProcessesPanelContent({ view, state }: { view: SessionProcessesView; state: Controls }) {
  const snapshot = view.snapshot, rows = snapshot?.rows ?? [];
  // A hidden section performs no reads either; the state machine stops polling while invisible.
  const canRead = view.supported && view.connected && view.visible;
  const logs = view.logs, orphanLogs = logs && !findProcessRow(snapshot, logs.target) ? logs : undefined;
  // An operation belongs to the process name it was sent against; a restart that bumped the generation
  // keeps its notice on that row, and only a process the broker no longer lists becomes an orphan.
  const listed = new Set(rows.map(row => `${row.target.brokerId}\u0000${row.target.name}`));
  const orphanOperations = view.operations.filter(operation => !listed.has(`${operation.target.brokerId}\u0000${operation.target.name}`));
  return <div className="session-processes" data-stale={view.stale} data-supported={view.supported} data-connected={view.connected} data-visible={view.visible}
    aria-busy={view.reading || view.busy}>
    <div className="session-processes-toolbar" role="toolbar" aria-label="OMP project process actions">
      <span className="session-processes-summary" role="status">{summary(view, snapshot)}</span>
      <button type="button" className="icon-button" aria-label="Refresh OMP project processes" aria-busy={view.reading}
        title={canRead ? "Read the OMP broker's process list again" : !view.supported ? "Unavailable" : !view.connected ? "Offline" : "The Processes section is hidden"}
        disabled={!canRead} onClick={() => void state.refresh()}><Icon name="refresh"/></button>
    </div>
    <p className="session-processes-qualifier">Supervised processes in this project.</p>
    {!view.supported && <p className="environment-note session-processes-note" data-kind="unsupported" role="status">OMP project processes are unavailable through this desktop bridge.</p>}
    {view.supported && !view.connected && !snapshot && <p className="environment-note session-processes-note" data-kind="offline" role="status">Offline · project processes cannot be read until this host reconnects.</p>}
    {view.loading && <p className="environment-note session-processes-note" data-kind="loading" role="status">Loading OMP project processes…</p>}
    {view.error && <p className="session-processes-error session-processes-note" data-kind="error" role="alert">{view.error}</p>}
    {view.stale && snapshot && <div className="session-processes-stale session-processes-note" data-kind="stale" role="status">
      <p><strong>Stale.</strong> Showing the last processes read from the original OMP broker{view.error ? "; the latest read failed" : view.connected ? "; a fresh read is pending" : " while this host is offline"}.
        {" "}Stop, Restart and standard input stay disabled until a fresh read of the same broker succeeds.</p>
    </div>}
    {view.journalState === "unavailable" && <p className="environment-note session-processes-note" data-kind="journal-unavailable" role="status">
      No durable operation journal is available here, so Stop, Restart and standard input are disabled. Reading processes and their output still works.</p>}
    {view.journalState === "loading" && <p className="environment-note session-processes-note" data-kind="journal-loading" role="status">
      Preparing the operation journal; process controls stay disabled until operations can be recorded durably.</p>}
    {view.journalState === "failed" && <div className="session-processes-stale session-processes-note" data-kind="journal-failed">
      <p role="alert"><strong>Operation journal unavailable.</strong> {view.journalError ?? "The operation journal could not be persisted."}
        {" "}No new Stop, Restart or standard input can be started until it recovers; an operation that was already dispatched keeps the status shown on its own notice.</p>
      <button type="button" title="Retries reading the operation journal only; no process operation is sent" onClick={() => void state.retryJournal()}>Retry operation journal</button>
    </div>}
    {snapshot && !rows.length && <p className="environment-note session-processes-note" data-kind="empty">No supervised processes in this project.</p>}
    {rows.length > 0 && <ul className="session-processes-list">{rows.map(row => processRow(row, view, state))}</ul>}
    {(orphanOperations.length > 0 || orphanLogs) && <section className="session-processes-orphans" aria-label="Operations and output without a listed process">
      {orphanOperations.map(operation => operationNote(operation, view, state, undefined, true))}
      {orphanLogs && processLogs(orphanLogs, state, undefined, true)}
    </section>}
  </div>;
}

function summary(view: SessionProcessesView, snapshot: SessionProcessesSnapshot | undefined) {
  if (!view.supported) return "Unavailable";
  if (snapshot) {
    if (!snapshot.rows.length) return "No processes";
    const counts = new Map<SessionProcessState, number>();
    for (const row of snapshot.rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
    return stateOrder.filter(state => counts.has(state)).map(state => `${counts.get(state)} ${stateLabels[state].toLowerCase()}`).join(" · ");
  }
  return view.loading ? "Loading" : view.connected ? "Not read yet" : "Offline";
}

/** Plain function rather than a component: the row itself holds no state, so the whole list is one
 * render pass and every control is reachable from the returned tree. */
function processRow(row: SessionProcessRow, view: SessionProcessesView, state: Controls): ReactNode {
  const target = row.target, slug = elementId(target);
  const toggleId = `${slug}-output-toggle`, logsId = `${slug}-output`, canRead = view.supported && view.connected && view.visible;
  const logs = view.logs && sameSessionProcessTarget(view.logs.target, target) ? view.logs : undefined;
  const operations = view.operations.filter(operation => operation.target.brokerId === target.brokerId && operation.target.name === target.name);
  // Any unsettled operation for this process name blocks new ones, whatever generation it was sent against.
  const unresolved = operations.find(operation => operation.status === "saving" || operation.status === "pending" || operation.status === "unknown");
  const blocked = unresolved
    ? `${actionLabels[unresolved.action]} of ${unresolved.target.name} has not settled. Check that operation's status first.`
    : undefined;
  const refusal = (action: "stop" | "restart" | "input") => processMutationRefusal(view, row, action) ?? blocked;
  const stop = refusal("stop"), restart = refusal("restart"), input = refusal("input");
  const live = row.state === "starting" || row.state === "running" || row.state === "ready";
  return <li className="session-processes-row" key={processRowKey(target)} data-process-name={target.name} data-process-state={row.state}
    data-process-generation={target.generation} data-process-id={target.id} data-process-stale={view.stale || undefined}>
    <div className="session-processes-row-head">
      <span className="session-processes-name" title={target.name}>{target.name}</span>
      <span className="session-processes-badges">
        <span className="session-processes-state">{stateLabels[row.state]}</span>
        {row.persist && <span title="The broker records native persistence for this process">Persist</span>}
        {row.detached && <span title="Kept running when the broker exits">Detached</span>}
        {row.restartCount > 0 && <span title="Restarts observed by the broker">{row.restartCount} restarts</span>}
      </span>
    </div>
    <div className="session-processes-row-meta">
      <span>{row.pid === undefined ? "no pid reported" : `pid ${row.pid}`}</span>
      <span title="Output bytes retained by the broker">{row.outputBytes} bytes</span>
      {row.exitCode !== undefined && <span className="session-processes-exit">exit code {row.exitCode}</span>}
    </div>
    {row.readyPending.length > 0 && <p className="session-processes-readiness" data-pending={row.readyPending.join(" ")}>
      Readiness pending: the broker has not observed {row.readyPending.map(kind => readinessLabels[kind]).join(" and ")} yet, so this process is not ready.</p>}
    {row.state === "exited" && row.exitCode === undefined && <p className="session-processes-readiness">The broker reported no exit code for this process.</p>}
    <div className="session-processes-row-actions" role="group" aria-label={`Actions for ${target.name}`}>
      <button id={toggleId} type="button" className="session-processes-action" aria-expanded={!!logs} aria-controls={logs ? logsId : undefined}
        aria-label={logs ? `Hide recent output of ${target.name}` : `Show recent output of ${target.name}`} aria-busy={logs?.state === "pending"}
        title={logs ? "Close this output" : canRead ? "Read the broker's retained output for this process" : !view.supported ? "Unavailable" : !view.connected ? "Offline · output cannot be read" : "The Processes section is hidden"}
        disabled={!logs && !canRead}
        onClick={() => { if (logs) state.closeLogs(); else void state.inspect(parseSessionProcessTarget(target)); }}><Icon name="terminal"/>Output</button>
      <button type="button" className="session-processes-action" aria-label={`Stop ${target.name}`} disabled={!!stop}
        title={stop ?? "Ask the broker to stop this process"} onClick={() => void captureProcessMutation(state, row, "stop")}><Icon name="stop"/>Stop</button>
      <button type="button" className="session-processes-action" aria-label={`Restart ${target.name}`} disabled={!!restart}
        title={restart ?? "Ask the broker to restart this process with its recorded launch spec"} onClick={() => void captureProcessMutation(state, row, "restart")}><Icon name="refresh"/>Restart</button>
    </div>
    <details className="session-processes-details">
      <summary>Process details</summary>
      <div className="session-processes-row-meta">
        <code title="Launch generation">gen {target.generation}</code>
        <code title="OMP broker incarnation">Broker {target.brokerId}</code>
        <code title="Process record id">Record {target.id}</code>
        {row.nativeOwner && <span>Native owner {row.nativeOwner}</span>}
        <span>Project {view.snapshot?.owner.projectDir}</span>
        <time dateTime={isoStamp(row.startedAt)}>started {clock(row.startedAt)}</time>
        {row.readyAt !== undefined && <time dateTime={isoStamp(row.readyAt)}>ready {clock(row.readyAt)}</time>}
        {row.exitedAt !== undefined && <time dateTime={isoStamp(row.exitedAt)}>exited {clock(row.exitedAt)}</time>}
      </div>
    </details>
    {operations.map(operation => operationNote(operation, view, state, row))}
    {logs && processLogs(logs, state, toggleId)}
    {live && <ProcessInputForm row={row} view={view} state={state} refusal={input}/>}
  </li>;
}

/** Focus follows a settled operation without stealing focus when the note first appears or when a
 * background read repaints it; only a status change moves focus. */
function OutcomeFocus({ focusKey, targetId }: { focusKey: string; targetId: string }) {
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = seen.current;
    seen.current = focusKey;
    if (previous !== undefined && previous !== focusKey) document.getElementById(targetId)?.focus({ preventScroll: true });
  }, [focusKey, targetId]);
  return null;
}

/** Closing the output region returns keyboard focus to the control that opened it, unless focus was
 * already moved somewhere else on purpose. */
function LogsFocusReturn({ regionId, toggleId }: { regionId: string; toggleId: string }) {
  useEffect(() => {
    // The region node is captured while it is still mounted; `contains` also answers for a detached node.
    const region = document.getElementById(regionId);
    return () => {
      const active = document.activeElement;
      if (active && active !== document.body && region && !region.contains(active)) return;
      document.getElementById(toggleId)?.focus({ preventScroll: true });
    };
  }, [regionId, toggleId]);
  return null;
}

function operationNote(operation: SessionProcessOperationView, view: SessionProcessesView, state: Controls, row?: SessionProcessRow, orphan?: boolean): ReactNode {
  const id = `${elementId(operation.target)}-operation-${operation.operationId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const unresolved = operation.status === "pending" || operation.status === "unknown";
  const terminal = operation.status === "completed" || operation.status === "rejected" || operation.status === "not-sent";
  const lookupRefusal = !view.supported ? "OMP project processes are unavailable through this desktop bridge."
    : !view.connected ? "Offline · reconnect before asking the host for this receipt."
      : !view.visible ? "The Processes section is hidden."
        : operation.lookupPending ? "Already asking the host for this receipt." : undefined;
  const alert = operation.status === "rejected" || operation.status === "unknown" || operation.status === "not-sent" || !!operation.error;
  return <div key={operation.operationId} id={id} tabIndex={-1} role={alert ? "alert" : "status"}
    className={`session-processes-note session-processes-operation${alert ? " session-processes-error" : ""}`}
    data-kind="operation" data-operation-status={operation.status} data-operation-action={operation.action} data-operation-id={operation.operationId}
    data-operation-generation={operation.target.generation}>
    <OutcomeFocus focusKey={`${operation.operationId}:${operation.status}`} targetId={id}/>
    <p>{describeOperation(operation, row, orphan)}</p>
    {operation.error && <p className="session-processes-error">{operation.error}</p>}
    <details className="session-processes-details">
      <summary>Operation details</summary>
      <div className="session-processes-row-meta">
        <code>{operation.operationId}</code>
        <code>Broker {operation.target.brokerId}</code>
        <code>Record {operation.target.id}</code>
        <span>Original generation {operation.target.generation}</span>
        {operation.row && <span>Confirmed generation {operation.row.target.generation}</span>}
        <span>Project {operation.owner.projectDir}</span>
      </div>
    </details>
    {(unresolved || terminal) && <div className="session-processes-operation-actions" role="group" aria-label={`${actionLabels[operation.action]} for ${operation.target.name}`}>
      {unresolved && <button type="button" className="session-processes-action" aria-label={`Check the status of ${actionLabels[operation.action].toLowerCase()} for ${operation.target.name}`}
        aria-busy={operation.lookupPending} disabled={!!lookupRefusal}
        title={lookupRefusal ?? "Ask the host for this operation's durable receipt; nothing is re-sent"}
        onClick={() => void state.lookupReceipt(operation.operationId)}><Icon name="question"/>Check status</button>}
      {terminal && <button type="button" className="session-processes-dismiss" aria-label={`Dismiss the ${actionLabels[operation.action].toLowerCase()} notice for ${operation.target.name}`}
        onClick={() => state.dismissOperation(operation.operationId)}><Icon name="close"/></button>}
    </div>}
  </div>;
}

function describeOperation(operation: SessionProcessOperationView, row: SessionProcessRow | undefined, orphan?: boolean) {
  const action = actionLabels[operation.action].toLowerCase(), name = operation.target.name;
  const unsettled = operation.status === "saving" || operation.status === "pending" || operation.status === "unknown";
  const where = orphan ? ` ${name} is no longer listed.`
    : unsettled && row && !sameSessionProcessTarget(row.target, operation.target)
      ? " This process has been replaced; the operation still refers to its original instance." : "";
  const detail = operation.status === "saving" ? `Saving the ${action} of ${name}. Nothing has been sent yet.`
    : operation.status === "pending" ? `Waiting for a final ${action} receipt for ${name}. Nothing is retried.`
      : operation.status === "unknown" ? `The ${action} outcome for ${name} is unknown and may have taken effect. Check status before another action.`
        : operation.status === "not-sent" ? `The ${action} of ${name} was not sent.`
          : operation.status === "rejected" ? `The host rejected the ${action} of ${name}.`
            : operation.action === "input" ? `Standard input for ${name} was confirmed.`
              : `${actionLabels[operation.action]} of ${name} was confirmed${operation.row ? `; reported ${stateLabels[operation.row.state].toLowerCase()}` : ""}.`;
  return `${detail}${where}`;
}

function processLogs(logs: SessionProcessesLogs, state: Controls, toggleId?: string, orphan?: boolean): ReactNode {
  const name = logs.target.name, regionId = `${elementId(logs.target)}-output`;
  const heading = logs.state === "pending" ? `Reading recent output of ${name}…`
    : logs.state === "failed" ? `Recent output of ${name} is unavailable` : `Recent output of ${name}`;
  return <div key={regionId} id={regionId} className="session-processes-logs" role="region" tabIndex={-1} aria-label={`Recent output of ${name}`}
    data-log-state={logs.state} data-truncated={logs.truncated || undefined} data-process-name={name}>
    {toggleId && <LogsFocusReturn regionId={regionId} toggleId={toggleId}/>}
    <div className="session-processes-logs-head">
      <span>{heading}</span>
      <button type="button" className="session-processes-dismiss" aria-label={`Close recent output of ${name}`} disabled={logs.state === "pending"}
        onClick={() => state.closeLogs()}><Icon name="close"/></button>
    </div>
    {orphan && <p className="environment-note">This is the output that was read from generation {logs.target.generation} of {name}, which the broker no longer lists; it is not a current process's output.</p>}
    {logs.state === "failed" && <p className="session-processes-error" role="alert">{logs.error ?? "The broker did not return this process's output."}</p>}
    {logs.state === "ready" && (logs.text
      ? <pre className="session-processes-output" tabIndex={0} aria-label={`Output text of ${name}`}>{logs.text}</pre>
      : <p className="environment-note">The broker retains no output for this process.</p>)}
    {logs.truncated && <p className="environment-note" data-kind="truncated">Output is truncated to the broker's log limit; earlier bytes are not available here.</p>}
  </div>;
}

/** The draft lives only in this component: never in the view, the journal or any persisted place.
 * It survives a refused, failed or unknown send, and is cleared only when the durable completed
 * receipt created by this form's own send arrives while the user still holds that exact text. */
function ProcessInputForm({ row, view, state, refusal }: { row: SessionProcessRow; view: SessionProcessesView; state: Controls; refusal?: string }) {
  const [draft, setDraft] = useState("");
  const target = row.target, slug = elementId(target), inputId = `${slug}-input`, hintId = `${slug}-input-hint`;
  const submitted = useRef<ProcessInputSubmission | undefined>(undefined);
  useEffect(() => {
    const submission = submitted.current;
    if (!submission) return;
    const outcome = resolveInputDraft(view, submission, draft);
    if (!outcome) return;
    submitted.current = undefined;
    if (outcome.clear) setDraft("");
  }, [view.operations, draft]);
  const issue = processInputIssue(draft), reason = refusal ?? issue;
  return <form className="session-processes-input" data-process-name={target.name} onSubmit={event => {
    event.preventDefault();
    // Capture the bytes, the target and the operations that already exist, synchronously: a later
    // refresh must not rebind the send, and an older receipt must not clear a newer draft.
    if (refusal || processInputIssue(draft)) return;
    submitted.current = { text: draft, target: parseSessionProcessTarget(target), known: view.operations.map(operation => operation.operationId) };
    void captureProcessMutation(state, row, "input", draft);
  }}>
    <label htmlFor={inputId}>Standard input for {target.name}</label>
    <textarea id={inputId} className="session-processes-draft" rows={2} value={draft} spellCheck={false} aria-describedby={hintId}
      maxLength={SESSION_PROCESSES_MAX_INPUT_CHARS} placeholder="Bytes to write to standard input" onChange={event => setDraft(event.target.value)}/>
    <p id={hintId} className="session-processes-hint">{NO_NEWLINE} {draft.length}/{SESSION_PROCESSES_MAX_INPUT_CHARS} characters.
      {row.detached ? " This process is detached; the broker may have no writable standard input for it." : ""}</p>
    {issue && draft.length > 0 && <p className="session-processes-error" role="alert">{issue}</p>}
    <button type="submit" className="session-processes-action" aria-label={`Send standard input to ${target.name}`} disabled={!!reason}
      title={reason ?? "Write these bytes to this process's standard input"}><Icon name="arrow"/>Send input</button>
  </form>;
}
