import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopBridge, GoalMutationRequest } from '../../../../packages/shared/src/protocol';
import { useSessionActivity } from './use-session-activity';
import { useGoalControl } from './use-goal-control';
import { GoalIcon } from './GoalIcons';
import { goalElapsed } from './GoalStrip';
import { GoalDraftStore, goalEditDirty, goalEditFrom, type GoalEdit } from './goal-draft';
import './goal.css';

type Activity = ReturnType<typeof useSessionActivity>;
type GoalPanelProps = {
  bridge: DesktopBridge; hostId: string; sessionId: string; connected: boolean; running: boolean; archived: boolean; active: boolean; activity?: Activity; localHostId?: string; draftWindowId?: string;
};
export function GoalPanel(props: GoalPanelProps) {
  return <GoalEditor key={JSON.stringify([props.draftWindowId, props.hostId, props.sessionId])} {...props}/>;
}
function GoalEditor({ bridge, hostId, sessionId, connected, running, archived, active, activity: shared, localHostId, draftWindowId }: GoalPanelProps) {
  const own = useSessionActivity(bridge, hostId, sessionId, connected, active && !shared, localHostId);
  const activity = shared ?? own;
  const snapshot = activity.value?.hostId === hostId && activity.value.sessionId === sessionId ? activity.value : undefined;
  const store = useMemo(() => draftWindowId ? new GoalDraftStore(draftWindowId, hostId, sessionId, {
    getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key),
  }) : undefined, [draftWindowId, hostId, sessionId]);
  const control = useGoalControl(bridge, hostId, sessionId, activity.refresh);
  const [edit, setEdit] = useState<GoalEdit | undefined>(() => store?.read()), [notice, setNotice] = useState<string>();
  const textarea = useRef<HTMLTextAreaElement>(null), mounted = useRef(true);
  const [storageWarning, setStorageWarning] = useState(store?.warning);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const change = (next: GoalEdit) => {
    setEdit(next);
    if (goalEditDirty(next)) store?.write(next);
    else if (edit) store?.discard(edit);
    setStorageWarning(store?.warning);
  };
  const dirty = Boolean(edit && goalEditDirty(edit));
  useEffect(() => { if (snapshot && !dirty) { const next = goalEditFrom(snapshot); if (next) setEdit(next); } }, [snapshot, dirty]);
  useEffect(() => { if (active) textarea.current?.focus(); }, [active, Boolean(edit)]);
  const unavailable = !connected ? 'Reconnect to the owning host to change its goal.' : activity.error || (snapshot?.goal.availability !== 'available' ? snapshot?.goal.reason || 'Loading native goal…' : !snapshot.goalControlTicket || !bridge.mutateGoal ? 'Update this host to change native goals.' : undefined);
  const blocked = unavailable || (archived ? 'Unarchive this conversation to change its goal.' : running ? 'Wait for the current turn to finish before saving goal changes.' : edit?.base?.status === 'paused' && edit.objective !== edit.base.objective ? 'Resume this goal before changing its objective.' : undefined);
  const terminal = edit?.base?.status === 'complete' || edit?.base?.mode === 'exiting';
  const save = async () => {
    if (!edit || !snapshot || blocked || control.pending || terminal) return;
    const budget = edit.budget.trim() ? Number(edit.budget) : undefined;
    if (!edit.objective.trim() || edit.objective.length > 16384 || budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0)) { setNotice('Enter a goal and an optional positive whole-number token budget.'); return; }
    setNotice(undefined);
    const expected: Pick<GoalMutationRequest, 'expectedGoal' | 'goalFingerprint'> = { expectedGoal: edit.base ? { id: edit.base.id, updatedAt: edit.base.updatedAt } : null, goalFingerprint: edit.fingerprint };
    const mutation = !edit.base ? { type: 'create' as const, objective: edit.objective, tokenBudget: budget } : edit.objective !== edit.base.objective ? { type: 'replace' as const, objective: edit.objective, tokenBudget: budget } : { type: 'setBudget' as const, tokenBudget: budget };
    if (await control.mutate(snapshot, mutation, expected)) {
      store?.discard(edit);
      if (mounted.current) { setEdit(undefined); setStorageWarning(store?.warning); }
    }
  };
  return <section className="goal-panel" aria-label="Edit goal" aria-busy={control.pending}>
    {(blocked || control.error || notice) && <div className="goal-notice" role="status"><span>{control.error || notice || blocked}</span><button onClick={activity.refresh}>Refresh</button></div>}
    {storageWarning && <p className="goal-notice" role="status">{storageWarning}</p>}
    {edit && <>
      <label className="sr-only" htmlFor={`goal-${sessionId}`}>Goal</label>
      <textarea ref={textarea} id={`goal-${sessionId}`} aria-label="Goal" value={edit.objective} maxLength={16384} rows={12} readOnly={Boolean(terminal) || control.pending} placeholder="Goal" onChange={event => change({ ...edit, objective: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); } }}/>
      <details className="goal-budget"><summary>Token budget{edit.base?.tokenBudget ? ` · ${edit.base.tokenBudget.toLocaleString()}` : ' · unlimited'}</summary><label>Budget<input type="number" min={1} step={1} aria-label="Goal token budget" placeholder="Unlimited" value={edit.budget} disabled={Boolean(terminal) || control.pending} onChange={event => change({ ...edit, budget: event.target.value.slice(0, 128) })}/></label>{edit.base && <p>{edit.base.tokensUsed.toLocaleString()} tokens used · {goalElapsed(edit.base.timeUsedSeconds)}</p>}</details>
      {edit.base && edit.objective !== edit.base.objective && <p className="goal-notice">Changing the objective starts a new OMP goal and resets its usage.</p>}
      <footer><span>{dirty ? 'Unsaved changes' : edit.base ? 'Saved on host' : 'New goal'}</span><button aria-label="Revert goal edits" title="Revert goal edits" disabled={!dirty || control.pending} onClick={() => { if (snapshot) { store?.discard(edit); setStorageWarning(store?.warning); setEdit(goalEditFrom(snapshot)); setNotice(undefined); control.dismissError(); } }}><GoalIcon name="revert"/></button><button className="goal-save" disabled={Boolean(blocked) || Boolean(terminal) || control.pending || !dirty || !edit.objective.trim()} onClick={() => void save()}>{control.pending ? 'Saving…' : 'Save'}</button></footer>
    </>}
  </section>;
}
