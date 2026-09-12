import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parseAutomationInput, parseAutomationsSnapshot, type Automation, type AutomationInput, type AutomationMutation,
  type AutomationRun, type AutomationsSnapshot } from '../../../../packages/shared/src/automations';
import type { DesktopBridge, HostIdentity, ModelInfo, Project, SessionSummary } from '../../../../packages/shared/src/protocol';
import { AutomationEditor } from './AutomationEditor';
import { automationStatus, newAutomationInput, readSchedule, scheduleRule, type ScheduleForm } from './automation-form';
import { AutomationRequests } from './automation-requests';
import { Icon } from './Icons';
import './automations.css';

interface Props {
  bridge: DesktopBridge; hostId: string; hostName: string; hosts: HostIdentity[]; connected: boolean; supported: boolean;
  projects: Project[]; sessions: SessionSummary[]; models: ModelInfo[]; requests: AutomationRequests;
  cache: Map<string, AutomationsSnapshot>; views: Map<string, AutomationPageMemory>; onSelectHost(hostId: string): void; onOpenChat(sessionId: string, hostId: string): void; onClose(): void;
}

export interface AutomationPageMemory { selectedId?: string; edit?: Edit; query: string; filter: string; showArchived: boolean }
type Edit = { id: string; revision: number; initial: AutomationInput; current: AutomationInput; schedule?: ScheduleForm };
const message = (error: unknown) => error instanceof Error ? error.message : 'The scheduled task request could not be confirmed.';
const when = (time: number | null) => time === null ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time);

export function AutomationsPage(props: Props) {
  const { bridge, hostId, hostName, connected, supported, requests } = props;
  const [snapshot, setSnapshot] = useState<AutomationsSnapshot | undefined>(() => props.cache.get(hostId));
  const [selectedId, setSelectedId] = useState<string | undefined>(() => props.views.get(hostId)?.selectedId), [edit, setEdit] = useState<Edit | undefined>(() => props.views.get(hostId)?.edit);
  const [query, setQuery] = useState(() => props.views.get(hostId)?.query ?? ''), [filter, setFilter] = useState(() => props.views.get(hostId)?.filter ?? 'all');
  const [loading, setLoading] = useState(false), [error, setError] = useState<string>(), [notice, setNotice] = useState<string>();
  const [showArchived, setShowArchived] = useState(() => props.views.get(hostId)?.showArchived ?? false);
  useLayoutEffect(() => { props.views.set(hostId, {selectedId, edit, query, filter, showArchived}); }, [hostId, selectedId, edit, query, filter, showArchived]);
  const [confirmation, setConfirmation] = useState<{ title: string; detail: string; action: string; run(): void }>();
  const dialog = useRef<HTMLDialogElement>(null), generation = useRef(0), current = useRef({ hostId, connected, supported, bridge: bridge.automations });
  const readSequence = useRef(0), historyCursor = useRef<string | null>(null), loadedEarlier = useRef(false);
  const snapshotRef = useRef(snapshot), selectedRef = useRef(selectedId);
  snapshotRef.current = snapshot; selectedRef.current = selectedId;
  useLayoutEffect(() => {
    current.current = { hostId, connected, supported, bridge: bridge.automations }; generation.current++;
    return () => { generation.current++; requests.invalidate(hostId); };
  }, [hostId, connected, supported, bridge.automations]);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { if (confirmation) dialog.current?.showModal(); else dialog.current?.close(); }, [confirmation]);
  const actionable = connected && supported && !!bridge.automations;
  const busy = requests.busy(hostId), pending = requests.pending(hostId);
  const selected = snapshot?.tasks.find(task => task.id === selectedId);
  const dirty = !!edit && (JSON.stringify(edit.initial) !== JSON.stringify(edit.current) || edit.schedule !== undefined && JSON.stringify(readSchedule(edit.initial.rrule)) !== JSON.stringify(edit.schedule));

  async function refresh(older = false) {
    const api = bridge.automations;
    if (!actionable || !api) return;
    const ownGeneration = generation.current, sequence = ++readSequence.current, selected = selectedRef.current;
    if (older && !historyCursor.current) return;
    setLoading(true);
    try {
      const value = parseAutomationsSnapshot(await api.list(hostId, { ...(selected ? { automationId: selected } : {}), ...(older ? { before: historyCursor.current! } : {}) }), hostId);
      if (ownGeneration !== generation.current || sequence !== readSequence.current || selected !== selectedRef.current) return;
      if (older) loadedEarlier.current = true;
      if (older || !loadedEarlier.current) historyCursor.current = value.nextRunCursor;
      const previous = snapshotRef.current;
      const next = { ...value, nextRunCursor: historyCursor.current, runs: [...new Map([...(previous?.hostId === hostId ? previous.runs : []), ...value.runs].map(run => [run.id, run])).values()].sort((a, b) => b.createdAt - a.createdAt) };
      snapshotRef.current = next; props.cache.set(hostId, next); setSnapshot(next); setError(undefined);
    } catch (error) { if (ownGeneration === generation.current && sequence === readSequence.current) setError(message(error)); }
    finally { if (ownGeneration === generation.current && sequence === readSequence.current) setLoading(false); }
  }
  useEffect(() => {
    historyCursor.current = null; loadedEarlier.current = false;
    snapshotRef.current = props.cache.get(hostId); setSnapshot(snapshotRef.current);
    void refresh();
    if (!actionable) return;
    const interval = setInterval(() => { if (!requests.busy(hostId)) void refresh(); }, 5000);
    const unsubscribe = bridge.subscribe(event => { if (event.type === 'automations' && event.hostId === hostId && !requests.busy(hostId)) void refresh(); });
    return () => { clearInterval(interval); unsubscribe(); };
  }, [hostId, connected, supported, bridge.automations, selectedId]);

  function leave(action: () => void) {
    if (!dirty) { action(); return; }
    if (edit && edit.revision > 0) {
      // Existing tasks save before navigation; a refused or unknown save keeps this editor.
      if (busy || pending) return;
      if (!actionable) { setError('Reconnect to save these scheduled task changes before leaving.'); return; }
      const originalGeneration = generation.current;
      void save(edit.current).then(saved => { if (saved && originalGeneration === generation.current) action(); });
      return;
    }
    setConfirmation({ title: 'Discard scheduled task changes?', detail: 'Your changes to this scheduled task will be lost.', action: 'Discard', run: action });
  }
  function select(task: Automation) { leave(() => { setEdit(undefined); setSelectedId(task.id); setNotice(undefined); }); }
  function begin() {
    leave(() => { const input = newAutomationInput(); setEdit({ id: crypto.randomUUID(), revision: 0, initial: input, current: input }); setSelectedId(undefined); });
  }
  async function mutate(mutation: AutomationMutation) {
    const api = bridge.automations, captured = generation.current;
    if (!actionable || !api) return false;
    setError(undefined); setNotice(undefined);
    try {
      const result = await requests.submit(hostId, mutation, api, () => captured === generation.current && current.current.hostId === hostId && current.current.connected && current.current.supported && current.current.bridge === api);
      if (captured !== generation.current) return false;
      const next = {...result.snapshot, nextRunCursor: historyCursor.current, runs:[...new Map([...(snapshotRef.current?.runs ?? []), ...result.snapshot.runs, ...(result.run ? [result.run] : [])].map(run=>[run.id,run])).values()].sort((a,b)=>b.createdAt-a.createdAt)};
      snapshotRef.current=next; props.cache.set(hostId,next); setSnapshot(next);
      if (mutation.type === 'save') { setEdit(undefined); setSelectedId(result.task?.id); }
      if (mutation.type === 'delete') { setEdit(undefined); setSelectedId(undefined); }
      if (mutation.type === 'run') setNotice(result.run?.status === 'failed' || result.run?.status === 'unknown' ? result.run.error || 'The run did not complete.' : result.run?.status === 'skipped' ? result.run.error || 'This run was skipped.' : result.run?.status === 'completed' ? 'Scheduled task completed' : 'Scheduled task admitted');
      // An idempotent retry returns its original receipt; always read current state after it.
      void refresh();
      return true;
    } catch (error) { if (captured === generation.current) setError(message(error)); return false; }
  }
  async function save(input: AutomationInput) {
    if (!edit) return false;
    try {
      if (edit.schedule) scheduleRule(edit.schedule);
      return await mutate({ type: 'save', requestId: crypto.randomUUID(), id: edit.id, expectedRevision: edit.revision, input: parseAutomationInput(input) });
    } catch (error) { setError(message(error)); return false; }
  }
  function updateTask(task: Automation, status: 'active' | 'paused') {
    const input = parseAutomationInput({ ...task, status });
    void mutate({ type: 'save', requestId: crypto.randomUUID(), id: task.id, expectedRevision: task.revision, input });
  }
  function runHistory(run: AutomationRun, archived = run.archivedAt !== null) {
    return mutate({ type: 'history', requestId: crypto.randomUUID(), runId: run.id, read: true, archived });
  }
  const tasks = snapshot?.tasks.filter(task => task.status !== 'deleted' && (filter === 'all' || automationStatus(task) === filter)
    && `${task.name}\n${task.prompt}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim())) ?? [];
  const runs = snapshot?.runs.filter(run => (!selectedId || run.automationId === selectedId) && (showArchived || run.archivedAt === null)) ?? [];
  const history = <>
          <header className="automation-history-header"><h3>Previous runs</h3><label><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)}/> Show archived</label></header>
          <div className="automation-history">{runs.map(run => <article key={run.id} className="automation-run"><div><strong>{!selectedId && `${run.automationName} · `}{run.status === 'unknown' ? 'Outcome unknown' : run.status}</strong><time>{when(run.createdAt)}</time></div>{run.error && <p role={run.status === 'failed' ? 'alert' : undefined}>{run.error}</p>}<div>
            {run.sessionId && <button onClick={() => { props.onOpenChat(run.sessionId!, hostId); if (actionable && !busy && !pending) void runHistory(run); }}>Open chat</button>}
            <button disabled={!actionable || busy || !!pending} onClick={() => void runHistory(run, run.archivedAt === null)}>{run.archivedAt === null ? 'Archive run' : 'Unarchive'}</button></div></article>)}</div>
          {!runs.length && <p className="automation-empty">No previous runs</p>}{snapshot?.nextRunCursor && <button disabled={!actionable || loading} onClick={() => void refresh(true)}>Load earlier runs</button>}
  </>;
  return <section className="automations-page" aria-label="Scheduled tasks">
    <aside className="automations-list">
      <header className="automations-list-header"><div role="tablist" aria-label="Scheduled task status">{['all', 'active', 'paused', 'completed'].map(status => <button key={status} role="tab" aria-selected={filter === status} onClick={() => setFilter(status)}>{status[0]!.toUpperCase() + status.slice(1)}</button>)}</div>
        <button className="icon-button" aria-label="New scheduled task" disabled={!actionable || busy || !!pending} onClick={begin}><Icon name="plus"/></button></header>
      <div className="automations-search"><Icon name="search"/><input aria-label="Search scheduled tasks" placeholder="Search scheduled tasks" value={query} onChange={event => setQuery(event.target.value)}/></div>
      {props.hosts.length > 1 && <select className="automation-host-select" aria-label="Scheduled task host" value={hostId} onChange={event => { const host = event.target.value; leave(() => props.onSelectHost(host)); }}>{props.hosts.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}</select>}
      <div className="automation-task-list">{tasks.map(task => <button key={task.id} className={`automation-task ${task.id === selectedId && !edit ? 'selected' : ''}`} aria-current={task.id === selectedId && !edit ? 'page' : undefined} onClick={() => select(task)}>
        <span className="automation-status-symbol" aria-hidden="true">{automationStatus(task) === 'paused' ? 'Ⅱ' : automationStatus(task) === 'completed' ? '✓' : '▷'}</span><span><strong>{task.name}</strong><small>{automationStatus(task) === 'completed' ? 'Completed' : task.status === 'paused' ? 'Paused' : when(task.nextRunAt)}</small></span>
        {snapshot?.runs.some(run => run.automationId === task.id && run.readAt === null && run.completedAt !== null) && <span className="automation-unread" aria-label="Unread runs"/>}
      </button>)}</div>
      {!tasks.length && <p className="automation-empty">{loading && !snapshot ? 'Loading scheduled tasks…' : query ? 'No scheduled tasks found' : 'No scheduled tasks'}</p>}
      <button className="automation-refresh" onClick={() => leave(() => { setEdit(undefined); setSelectedId(undefined); })}>Run history</button>
      <button className="automation-refresh" disabled={!actionable || loading} onClick={() => void refresh()}>Refresh</button>
    </aside>
    <main className="automation-details">
      <header className="automation-detail-header"><span>{edit?.revision === 0 ? 'New' : edit ? 'Edit' : selected ? automationStatus(selected) : 'Scheduled tasks'}</span><button className="icon-button" aria-label="Close scheduled task details" onClick={() => leave(props.onClose)}><Icon name="close"/></button></header>
      {!connected && <p className="automation-warning" role="status">{hostName} is offline. Reconnect to change or run scheduled tasks.</p>}
      {connected && !supported && <p className="automation-warning" role="status">Update this host to use scheduled tasks.</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="automation-notice" role="status">{notice}</p>}
      {pending && <div className="automation-warning"><p>{busy ? 'Waiting for the original request…' : 'A saved request still needs a confirmed result. Retrying uses the same request ID.'}</p>
        <button disabled={!actionable || busy} onClick={() => void mutate(pending.mutation)}>Retry original request</button>
        <button disabled={busy} onClick={() => setConfirmation({ title: 'Dismiss saved request?', detail: 'This does not undo or repeat the operation. Inspect the owning host before submitting another run.', action: 'Dismiss request', run: () => requests.discard(hostId, pending.mutation.requestId) })}>Dismiss after inspection</button></div>}
      {edit ? <AutomationEditor key={`${edit.id}:${edit.revision}`} initial={edit.current} initialSchedule={edit.schedule} hostName={hostName} projects={props.projects} sessions={props.sessions} models={props.models}
        busy={busy || !!pending || !actionable} isNew={edit.revision === 0} onChange={(input, schedule) => setEdit(current => current?.id === edit.id ? { ...current, current: input, schedule } : current)} onSave={save} onCancel={() => leave(() => setEdit(undefined))}/>
        : selected ? <div className="automation-detail-scroll"><h1>{selected.name}</h1><p className="automation-saved-prompt">{selected.prompt}</p>
          <div className="automation-detail-actions"><button disabled={!actionable || busy || !!pending} onClick={() => { const input = parseAutomationInput({ ...selected, status: selected.status === 'active' ? 'active' : 'paused' }); setEdit({ id: selected.id, revision: selected.revision, initial: input, current: input }); }}>Edit</button>
            <button disabled={!actionable || busy || !!pending} onClick={() => void mutate({ type: 'run', requestId: crypto.randomUUID(), id: selected.id, expectedRevision: selected.revision })}>Run now</button>
            <button disabled={!actionable || busy || !!pending} onClick={() => updateTask(selected, selected.status === 'active' ? 'paused' : 'active')}>{selected.status === 'active' ? 'Pause' : 'Resume'}</button>
            {selected.destination.kind === 'heartbeat' && <button onClick={() => props.onOpenChat(selected.destination.kind === 'heartbeat' ? selected.destination.sessionId : '', hostId)}>Open chat</button>}
            <button disabled={!actionable || busy || !!pending} onClick={() => setConfirmation({ title: `Delete “${selected.name}”?`, detail: 'Future runs stop. Already admitted runs and their recorded outcomes remain available.', action: 'Delete', run: () => void mutate({ type: 'delete', requestId: crypto.randomUUID(), id: selected.id, expectedRevision: selected.revision }) })}>Delete</button>
          </div>
          <div className="automation-fields"><div className="automation-field"><span>Runs on</span><span>{hostName}</span></div><div className="automation-field"><span>Next run</span><span>{when(selected.nextRunAt)}</span></div><div className="automation-field"><span>Schedule</span><code>{selected.rrule}</code></div></div>
          {history}
        </div> : <div className="automation-detail-scroll"><h1>Scheduled tasks</h1><p>Schedule tasks, set reminders, or monitor for updates.</p><button className="primary-button" disabled={!actionable || busy || !!pending} onClick={begin}>New scheduled task</button>{history}</div>}
    </main>
    <dialog ref={dialog} className="app-dialog automation-confirm" onCancel={event => { event.preventDefault(); setConfirmation(undefined); }}>
      <h2>{confirmation?.title}</h2><p>{confirmation?.detail}</p><footer><button onClick={() => setConfirmation(undefined)}>{confirmation?.action === 'Discard' ? 'Keep editing' : 'Cancel'}</button><button className="primary-button" onClick={() => { const action = confirmation?.run; setConfirmation(undefined); action?.(); }}>{confirmation?.action}</button></footer>
    </dialog>
  </section>;
}
