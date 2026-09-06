import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge, GoalMutation, GoalMutationRequest, SessionActivitySnapshot } from '../../../../packages/shared/src/protocol';
import { parseGoalMutationReceipt } from '../../../../packages/shared/src/protocol';

export function useGoalControl(bridge: DesktopBridge, hostId: string, sessionId: string, refresh: () => void) {
  const [pending, setPending] = useState(false), [error, setError] = useState<string>();
  const mounted = useRef(true), busy = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function mutate(snapshot: SessionActivitySnapshot, mutation: GoalMutation, expected?: Pick<GoalMutationRequest, 'expectedGoal' | 'goalFingerprint'>) {
    if (busy.current || !bridge.mutateGoal || !snapshot.goalControlTicket || snapshot.goal.availability !== 'available') return false;
    if (snapshot.hostId !== hostId || snapshot.sessionId !== sessionId || snapshot.protocolVersion !== 1) {
      setError('The goal snapshot belongs to another session. Refresh before acting.'); return false;
    }
    const goal = snapshot.goal.value;
    busy.current = true; setPending(true); setError(undefined);
    try {
      const requestId = crypto.randomUUID();
      const result = parseGoalMutationReceipt(await bridge.mutateGoal(sessionId, {
        ...snapshot.goalControlTicket, requestId, expectedGoal: goal ? { id: goal.id, updatedAt: goal.updatedAt } : null,
        ...expected, mutation,
      }, hostId), { hostId, sessionId, requestId });
      if (result.outcome !== 'completed') throw new Error(result.message);
      if (mounted.current) refresh();
      return true;
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error ? cause.message : 'The goal action could not be confirmed.'); refresh(); }
      return false;
    } finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  return { pending, error, mutate, dismissError: () => setError(undefined) };
}
