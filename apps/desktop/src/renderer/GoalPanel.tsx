import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge, GoalMutationRequest, NativeGoalActivity, SessionActivitySnapshot } from '../../../../packages/shared/src/protocol';
import { useSessionActivity } from './use-session-activity';
import { useGoalControl } from './use-goal-control';
import { GoalIcon } from './GoalIcons';
import { goalElapsed } from './GoalStrip';
import './goal.css';

type Activity = ReturnType<typeof useSessionActivity>;
type Edit = { objective: string; budget: string; base: NativeGoalActivity | null; fingerprint: string };
function editFrom(snapshot: SessionActivitySnapshot): Edit | undefined {
  if (snapshot.goal.availability !== 'available' || !snapshot.goalControlTicket) return;
  const goal = snapshot.goal.value;
  return { objective: goal?.objective ?? '', budget: goal?.tokenBudget?.toString() ?? '', base: goal, fingerprint: snapshot.goalControlTicket.goalFingerprint };
}
export function GoalPanel({ bridge, hostId, sessionId, connected, running, archived, active, activity: shared, localHostId }: {
  bridge: DesktopBridge; hostId: string; sessionId: string; connected: boolean; running: boolean; archived: boolean; active: boolean; activity?: Activity; localHostId?: string;
}) {
  const own = useSessionActivity(bridge, hostId, sessionId, connected, active && !shared, localHostId);
  const activity = shared ?? own, snapshot = activity.value;
  const control = useGoalControl(bridge, hostId, sessionId, activity.refresh);
  const [edit, setEdit] = useState<Edit>(), [notice, setNotice] = useState<string>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const dirty = Boolean(edit && (edit.objective !== (edit.base?.objective ?? '') || edit.budget !== (edit.base?.tokenBudget?.toString() ?? '')));
  useEffect(() => { if (snapshot && !dirty) { const next = editFrom(snapshot); if (next) setEdit(next); } }, [snapshot, dirty]);
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
    if (await control.mutate(snapshot, mutation, expected)) setEdit(undefined);
  };
  return <section className="goal-panel" aria-label="Edit goal" aria-busy={control.pending}>
    {(blocked || control.error || notice) && <div className="goal-notice" role="status"><span>{control.error || notice || blocked}</span><button onClick={activity.refresh}>Refresh</button></div>}
    {edit && <>
      <label className="sr-only" htmlFor={`goal-${sessionId}`}>Goal</label>
      <textarea ref={textarea} id={`goal-${sessionId}`} aria-label="Goal" value={edit.objective} maxLength={16384} rows={12} readOnly={Boolean(terminal)} placeholder="Goal" onChange={event => setEdit({ ...edit, objective: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); } }}/>
      <details className="goal-budget"><summary>Token budget{edit.base?.tokenBudget ? ` · ${edit.base.tokenBudget.toLocaleString()}` : ' · unlimited'}</summary><label>Budget<input type="number" min={1} step={1} aria-label="Goal token budget" placeholder="Unlimited" value={edit.budget} disabled={Boolean(terminal)} onChange={event => setEdit({ ...edit, budget: event.target.value })}/></label>{edit.base && <p>{edit.base.tokensUsed.toLocaleString()} tokens used · {goalElapsed(edit.base.timeUsedSeconds)}</p>}</details>
      {edit.base && edit.objective !== edit.base.objective && <p className="goal-notice">Changing the objective starts a new OMP goal and resets its usage.</p>}
      <footer><span>{dirty ? 'Unsaved changes' : edit.base ? 'Saved on host' : 'New goal'}</span><button aria-label="Revert goal edits" title="Revert goal edits" disabled={!dirty || control.pending} onClick={() => { if (snapshot) { setEdit(editFrom(snapshot)); setNotice(undefined); control.dismissError(); } }}><GoalIcon name="revert"/></button><button className="goal-save" disabled={Boolean(blocked) || Boolean(terminal) || control.pending || !dirty || !edit.objective.trim()} onClick={() => void save()}>{control.pending ? 'Saving…' : 'Save'}</button></footer>
    </>}
  </section>;
}
