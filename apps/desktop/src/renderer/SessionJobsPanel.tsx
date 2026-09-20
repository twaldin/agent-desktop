import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { sameSessionJobTarget, type SessionJobRow, type SessionJobsSnapshot } from "../../../../packages/shared/src/session-jobs";
import { Icon } from "./Icons";
import { cancelRefusal, findJobRow, initialSessionJobsView, jobRowKey, SessionJobsState, type SessionJobsBridge, type SessionJobsCancellation, type SessionJobsInspection, type SessionJobsView } from "./session-jobs-state";
import "./session-jobs.css";

export interface SessionJobsPanelProps { bridge: SessionJobsBridge; hostId: string; sessionId: string; connected: boolean; visible: boolean }
type Controls = Pick<SessionJobsState, "refresh" | "reload" | "inspect" | "closeInspection" | "cancel" | "dismissCancellation">;

/** Renders inside the Environment card's existing Jobs section. Reads and the guarded single-job
 * cancel go to the original native owner; hiding or unmounting only stops reads. */
export function SessionJobsPanel({ bridge, hostId, sessionId, connected, visible }: SessionJobsPanelProps) {
  const state = useMemo(() => new SessionJobsState(bridge), [bridge]);
  useLayoutEffect(() => { state.configure({ hostId, sessionId, connected, visible }); }, [state, hostId, sessionId, connected, visible]);
  useEffect(() => () => state.stop(), [state]);
  const stored = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  // A host/session change must not paint the previous owner's rows even for one frame; the effect reconfigures after this render.
  const view = stored.hostId === hostId && stored.sessionId === sessionId ? stored : initialSessionJobsView(hostId, sessionId, state.supported, connected);
  return <SessionJobsPanelContent view={view} state={state}/>;
}

const statusLabels: Record<SessionJobRow["status"], string> = { running: "Running", completed: "Completed", failed: "Failed", cancelled: "Cancelled" };
const typeLabels: Record<SessionJobRow["type"], string> = { bash: "Shell", task: "Agent", eval: "Eval" };
const CANCELLED_QUALIFIER = "Cancellation was requested; the native manager does not confirm that the underlying process or body has finished.";

function clock(ms: number) { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }

/** Shared rendering path for prop-driven tests; `state` supplies the controls. */
export function SessionJobsPanelContent({ view, state }: { view: SessionJobsView; state: Controls }) {
  const snapshot = view.snapshot, available = snapshot?.availability === "available" ? snapshot : undefined;
  const canRead = view.supported && view.connected;
  const inspection = view.inspection, cancellation = view.cancellation;
  const orphanInspection = inspection && !findJobRow(snapshot, inspection.target) ? inspection : undefined;
  const orphanCancellation = cancellation && !findJobRow(snapshot, cancellation.target) ? cancellation : undefined;
  const row = (job: SessionJobRow, stale: boolean) => <JobRow key={jobRowKey(job.target)} job={job} view={view} state={state} stale={stale}
    inspection={inspection && sameSessionJobTarget(inspection.target, job.target) ? inspection : undefined}
    cancellation={cancellation && sameSessionJobTarget(cancellation.target, job.target) ? cancellation : undefined}/>;
  return <div className="session-jobs" data-stale={view.stale} data-supported={view.supported} data-connected={view.connected} aria-busy={view.reading}>
    <div className="session-jobs-toolbar" role="toolbar" aria-label="Background job actions">
      <span className="session-jobs-summary" role="status">{summary(view, available)}</span>
      <button type="button" className="icon-button" aria-label="Refresh background jobs" title={canRead ? "Refresh background jobs" : "Offline"} aria-busy={view.reading}
        disabled={!canRead} onClick={() => void state.refresh()}><Icon name="refresh"/></button>
    </div>
    {!view.supported && <p className="environment-note session-jobs-note" data-kind="unsupported" role="status">Background jobs are unavailable through this desktop bridge.</p>}
    {view.supported && !view.connected && !snapshot && <p className="environment-note session-jobs-note" data-kind="offline" role="status">Offline · background jobs cannot be read until this host reconnects.</p>}
    {view.loading && <p className="environment-note session-jobs-note" data-kind="loading" role="status">Loading background jobs…</p>}
    {view.error && <p className="session-jobs-error session-jobs-note" data-kind="error" role="alert">{view.error}</p>}
    {view.stale && snapshot && <div className="session-jobs-stale session-jobs-note" data-kind="stale" role="status">
      <p><strong>Stale.</strong> Showing the last jobs read from the original native session{view.error ? "; the latest read failed" : view.connected ? "; a fresh read is pending" : " while this host is offline"}. Cancellation is disabled until a fresh read succeeds.</p>
      {view.connected && view.error && <button type="button" aria-label="Reload from native session" onClick={() => void state.reload()}>Reload from native session</button>}
    </div>}
    {snapshot?.availability === "unavailable" && <p className="environment-note session-jobs-note" data-kind="unavailable" role="status">{snapshot.reason}</p>}
    {available && <>
      {!available.running.length && !available.recent.length && <p className="environment-note session-jobs-note" data-kind="empty">No background jobs in this native session.</p>}
      {available.running.length > 0 && <JobGroup group="running" title="Running" count={available.running.length}>{available.running.map(job => row(job, view.stale))}</JobGroup>}
      {available.recent.length > 0 && <JobGroup group="recent" title="Recent" count={available.recent.length}>{available.recent.map(job => row(job, view.stale))}</JobGroup>}
      <div className="session-jobs-delivery" role="group" aria-label="Result delivery to the agent" data-queued={available.delivery.queued} data-delivering={available.delivery.delivering}>
        <span>Delivery to agent</span>
        <span>{available.delivery.queued} queued{available.delivery.delivering ? " · delivering" : ""}{available.delivery.nextRetryAt !== undefined ? ` · retry at ${clock(available.delivery.nextRetryAt)}` : ""}</span>
        {available.delivery.pendingJobIds.length > 0 && <code>{available.delivery.pendingJobIds.join(", ")}</code>}
      </div>
    </>}
    {orphanCancellation && <CancellationNote cancellation={orphanCancellation} state={state} orphan/>}
    {orphanInspection && <InspectionDetail inspection={orphanInspection} state={state} orphan/>}
  </div>;
}

function summary(view: SessionJobsView, available: Extract<SessionJobsSnapshot, { availability: "available" }> | undefined) {
  if (!view.supported) return "Unavailable";
  if (available) {
    const queued = available.running.filter(job => job.queued).length;
    return `${available.running.length} running${queued ? ` (${queued} queued)` : ""} · ${available.recent.length} recent`;
  }
  if (view.snapshot) return "Native manager unavailable";
  return view.loading ? "Loading" : view.connected ? "Not read yet" : "Offline";
}

function JobGroup({ group, title, count, children }: { group: "running" | "recent"; title: string; count: number; children: ReactNode }) {
  return <section className="session-jobs-group" aria-label={`${title} jobs`}>
    <h4>{title}<small>{count}</small></h4>
    <ul className="session-jobs-list" data-group={group}>{children}</ul>
  </section>;
}

function JobRow({ job, view, state, stale, inspection, cancellation }: {
  job: SessionJobRow; view: SessionJobsView; state: Controls; stale: boolean; inspection?: SessionJobsInspection; cancellation?: SessionJobsCancellation;
}) {
  const { target } = job, refusal = cancelRefusal(view, job), started = new Date(target.startTime);
  // Closing the output region returns keyboard focus to the control that opened it.
  const inspectButton = useRef<HTMLButtonElement>(null), wasInspecting = useRef(false);
  useEffect(() => { if (wasInspecting.current && !inspection) inspectButton.current?.focus({ preventScroll: true }); wasInspecting.current = !!inspection; }, [inspection]);
  return <li className="session-jobs-row" data-job-id={target.id} data-job-status={job.status} data-job-type={job.type} data-job-queued={job.queued || undefined} data-job-start={target.startTime} data-job-stale={stale || undefined}>
    <div className="session-jobs-row-head">
      <span className="session-jobs-label" title={job.label}>{job.label}</span>
      <span className="session-jobs-badges">
        <span className="session-jobs-type">{typeLabels[job.type]}</span>
        <span className="session-jobs-status">{statusLabels[job.status]}</span>
        {job.queued && <span className="session-jobs-queued" title="Waiting for a native slot; the body has not started">Queued</span>}
      </span>
    </div>
    <div className="session-jobs-row-meta">
      <code>{target.id}</code>
      {job.agentId && <code title="Native agent id">{job.agentId}</code>}
      <time className="session-jobs-started" dateTime={started.toISOString()} title={started.toLocaleString()}>started {clock(target.startTime)}</time>
    </div>
    {job.status === "cancelled" && <p className="session-jobs-qualifier">{CANCELLED_QUALIFIER}</p>}
    <div className="session-jobs-row-actions" role="group" aria-label={`Actions for ${target.id}`}>
      {job.status !== "running" && <button ref={inspectButton} type="button" aria-label={`Inspect output of ${target.id}`} aria-pressed={!!inspection} aria-busy={inspection?.state === "pending"}
        disabled={!view.connected || !view.supported} onClick={() => void state.inspect(target)}>Inspect output</button>}
      {job.status === "running" && <button type="button" aria-label={`Cancel ${target.id}`} disabled={!!refusal} title={refusal ?? "Ask the native manager to cancel this job"} aria-busy={cancellation?.state === "pending"}
        onClick={() => void state.cancel(target)}><Icon name="stop"/>Cancel</button>}
    </div>
    {cancellation && <CancellationNote cancellation={cancellation} state={state}/>}
    {inspection && <InspectionDetail inspection={inspection} state={state}/>}
  </li>;
}

/** Keyboard focus follows the outcome, since the Cancel control disappears once the row settles. */
function useOutcomeFocus<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, [key]);
  return ref;
}

function CancellationNote({ cancellation, state, orphan }: { cancellation: SessionJobsCancellation; state: Pick<SessionJobsState, "dismissCancellation">; orphan?: boolean }) {
  const ref = useOutcomeFocus<HTMLParagraphElement>(`${jobRowKey(cancellation.target)}:${cancellation.state}`);
  const id = cancellation.target.id;
  const text = cancellation.state === "pending" ? `Asking the native manager to cancel ${id}…`
    : cancellation.state === "requested" ? `Cancellation of ${id} was requested. The job is marked cancelled; its process or body may still be finishing and its result will not be delivered to the agent.`
    : cancellation.state === "declined" ? `The native manager declined to cancel ${id}: it already settled or is no longer owned by this session. Nothing was retried.`
    : `Cancellation of ${id} could not be confirmed: ${cancellation.error ?? "unknown error"}. The request may have taken effect. Nothing was retried; refresh to read the native state.`;
  return <p ref={ref} tabIndex={-1} className={`session-jobs-note session-jobs-cancel${cancellation.state === "failed" ? " session-jobs-error" : ""}`} data-kind="cancel" data-cancel-state={cancellation.state} data-job-id={id}
    role={cancellation.state === "failed" ? "alert" : "status"}>
    {text}{orphan ? " The job is no longer listed by the native manager." : ""}
    {cancellation.state !== "pending" && <button type="button" className="session-jobs-dismiss" aria-label={`Dismiss cancellation notice for ${id}`} onClick={() => state.dismissCancellation()}><Icon name="close"/></button>}
  </p>;
}

function InspectionDetail({ inspection, state, orphan }: { inspection: SessionJobsInspection; state: Pick<SessionJobsState, "closeInspection">; orphan?: boolean }) {
  const ref = useOutcomeFocus<HTMLDivElement>(`${jobRowKey(inspection.target)}:${inspection.state}`);
  const id = inspection.target.id, detail = inspection.detail;
  return <div ref={ref} tabIndex={-1} className="session-jobs-detail" data-job-id={id} data-consumed={detail?.consumed} data-truncated={detail?.truncated} role="region" aria-label={`Output of ${id}`}>
    <div className="session-jobs-detail-head">
      <span>{inspection.state === "pending" ? `Reading output of ${id}…` : inspection.state === "failed" ? `Output of ${id} unavailable` : `Output of ${id}`}</span>
      <button type="button" className="session-jobs-dismiss" aria-label={`Close output of ${id}`} disabled={inspection.state === "pending"} onClick={() => state.closeInspection()}><Icon name="close"/></button>
    </div>
    {orphan && <p className="environment-note">This job is no longer retained by the native manager.</p>}
    {inspection.state === "failed" && <p className="session-jobs-error" role="alert">{inspection.error}</p>}
    {detail && <>
      <p className="environment-note">{detail.consumed ? "The native manager marks this result as consumed." : "The native manager has not marked this result as consumed."} Viewing here does not deliver or acknowledge it.{detail.truncated ? " Output is truncated to the host's inspection limit." : ""}</p>
      {detail.resultText !== undefined && <pre className="session-jobs-output" data-kind="result" tabIndex={0} aria-label={`Result text of ${id}`}>{detail.resultText}</pre>}
      {detail.errorText !== undefined && <pre className="session-jobs-output" data-kind="error" tabIndex={0} aria-label={`Error text of ${id}`}>{detail.errorText}</pre>}
      {detail.resultText === undefined && detail.errorText === undefined && <p className="environment-note">No retained output.</p>}
    </>}
  </div>;
}
