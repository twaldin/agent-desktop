import type { DesktopBridge, SessionActivitySnapshot } from '../../../../packages/shared/src/protocol';
import { useEffect, useMemo, useState } from 'react';
import { GoalIcon } from './GoalIcons';
import { useGoalControl } from './use-goal-control';
import './goal.css';

export function goalElapsed(seconds: number) {
  const elapsed = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(elapsed / 3600), minutes = Math.floor(elapsed % 3600 / 60);
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${elapsed % 60}s` : `${elapsed}s`;
}
export function GoalStrip({ bridge, hostId, sessionId, snapshot, stale, running, archived, refresh, onEdit }: {
  bridge: DesktopBridge; hostId: string; sessionId: string; snapshot?: SessionActivitySnapshot | null;
  stale?: string; running: boolean; archived: boolean; refresh(): void; onEdit(): void;
}) {
  const control = useGoalControl(bridge, hostId, sessionId, refresh);
  const goal = snapshot?.goal.availability === 'available' ? snapshot.goal.value : undefined;
  // Native active wall-time advances between reports. Use the client's receipt
  // clock for display only so another host's clock skew cannot inflate usage.
  const received = useMemo(() => performance.now(), [hostId, sessionId, goal?.id, goal?.updatedAt, goal?.timeUsedSeconds, goal?.status, stale]);
  const [, tick] = useState(0);
  const liveClock = !stale && goal?.enabled && goal.status === 'active';
  useEffect(() => { if (!liveClock) return; const timer = setInterval(() => tick(value => value + 1), 1000); return () => clearInterval(timer); }, [liveClock, received]);
  const elapsed = (goal?.timeUsedSeconds ?? 0) + (liveClock ? Math.max(0, Math.floor((performance.now() - received) / 1000)) : 0);
  if (!goal || goal.status === 'dropped' || goal.status === 'complete' || goal.mode === 'exiting') return null;
  const label = goal.status === 'active' ? 'Pursuing goal' : goal.status === 'paused' ? 'Paused goal' : 'Goal limited';
  const reason = stale || (archived ? 'Unarchive this conversation to change its goal.' : !bridge.mutateGoal || !snapshot?.goalControlTicket ? 'Update this host to change native goals.' : undefined);
  const resumeReason = goal.status === 'budget-limited' ? 'Edit the token budget before resuming this goal.' : running && goal.status !== 'active' ? 'Wait for the current turn to finish before resuming this goal.' : undefined;
  const disabled = Boolean(reason) || control.pending;
  return <div className="goal-region">
    <div className="goal-strip" aria-label={label} aria-busy={control.pending}>
      <GoalIcon name="goal"/>
      <span className="goal-status">{label}</span>
      <span className="goal-objective" title={goal.objective}>· {goal.objective}</span>
      <span className="goal-usage" title={`${goal.tokensUsed.toLocaleString()} tokens used · ${goalElapsed(elapsed)} active time${goal.tokenBudget ? ` · ${goal.tokenBudget.toLocaleString()} token budget` : ''}`}>
        {goal.tokenBudget ? `${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()}` : goalElapsed(elapsed)}
      </span>
      <button aria-label="Clear goal" title={reason || 'Clear goal'} disabled={disabled} onClick={() => void control.mutate(snapshot!, { type: 'drop' })}><GoalIcon name="clear"/></button>
      <button aria-label={goal.status === 'active' ? 'Pause goal' : 'Resume goal'} title={reason || resumeReason || (goal.status === 'active' ? 'Pause goal' : 'Resume goal')} disabled={disabled || Boolean(resumeReason) || goal.status === 'budget-limited'} onClick={() => void control.mutate(snapshot!, { type: goal.status === 'active' ? 'pause' : 'resume' })}><GoalIcon name={goal.status === 'active' ? 'pause' : 'resume'}/></button>
      <button aria-label="Edit goal" title="Edit goal" onClick={onEdit}><GoalIcon name="edit"/></button>
    </div>
    {(stale || control.error) && <div className="goal-notice" role="status"><span>{control.error || stale}</span><button onClick={() => { control.dismissError(); refresh(); }}>Refresh goal</button></div>}
  </div>;
}
