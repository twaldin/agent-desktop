import { useCallback, useEffect, useState } from 'react';
import type { DesktopBridge, LocalEnvironmentPreparationPhase } from '@agent-desktop/shared';
import type { PendingSubmission, SubmissionController } from './submissions';
import { Icon } from './Icons';
import './environment-preparation.css';

const labels: Record<LocalEnvironmentPreparationPhase, string> = {
  validated: 'Preparing worktree', 'worktree-creating': 'Creating worktree', 'worktree-created': 'Worktree ready',
  'setup-running': 'Setting up environment', 'setup-failed': 'Environment setup failed', 'setup-succeeded': 'Environment ready',
  'native-creating': 'Creating conversation', 'session-created': 'Conversation ready', 'cleanup-running': 'Cleaning up environment',
  'cleanup-failed': 'Environment cleanup failed', 'cleanup-succeeded': 'Environment cleaned up', removed: 'Worktree removed', unknown: 'Check environment outcome',
};
const resumable = new Set<LocalEnvironmentPreparationPhase>(['validated', 'worktree-created', 'setup-failed', 'setup-succeeded', 'session-created']);

/** Read-only observation never dispatches setup or input; continuation requires its explicit button. */
export function EnvironmentPreparationCard({ bridge, hostId, pending, submissions, connected, busy, onResume, onSettings }: {
  bridge: DesktopBridge; hostId: string; pending: PendingSubmission; submissions: SubmissionController;
  connected: boolean; busy: boolean; onResume(): void; onSettings(): void;
}) {
  const [error, setError] = useState<string>();
  const id = pending.preparation?.id ?? pending.create?.id;
  const projectId = pending.draft.projectId;
  const refresh = useCallback(async () => {
    if (!id || !projectId || !connected) return;
    try {
      const result = await bridge.workspaceQuery({ projectId }, { type: 'environment.preparation', preparationId: id }, hostId);
      if (result.type !== 'environment.preparation') throw new Error('The host did not return this environment preparation.');
      submissions.observePreparation(pending.draft.id, result.preparation);
      setError(undefined);
    } catch (cause) { if (!busy) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [bridge, hostId, id, projectId, pending.draft.id, submissions, connected, busy]);
  useEffect(() => {
    setError(undefined);
    if (!connected) return;
    void refresh(); const timer = setInterval(() => { void refresh(); }, 1500);
    return () => clearInterval(timer);
  }, [refresh, connected]);
  const preparation = pending.preparation;
  const phase = preparation?.phase;
  const running = phase && ['worktree-creating', 'setup-running', 'native-creating', 'cleanup-running'].includes(phase);
  const canResume = connected && !busy && phase !== undefined && resumable.has(phase);
  return <section className="environment-preparation-card" aria-label="Environment preparation">
    <div className="environment-preparation-heading"><span aria-hidden="true">{running || !phase && busy ? <span className="spinner"/> : <Icon name="terminal"/>}</span><strong>{phase ? labels[phase] : 'Preparing environment'}</strong><span>{preparation?.environment?.name}</span></div>
    {phase === 'setup-failed' && <p>Your worktree and original prompt are preserved.{preparation?.setup?.status === 'cancelled' ? ' Setup was cancelled.' : preparation?.setup?.exitCode != null ? ` Setup exited with code ${preparation.setup.exitCode}.` : ''}</p>}
    {phase === 'unknown' && <p>The last operation has no confirmed outcome. Inspect the worktree before taking another action; checking status does not run it again.</p>}
    {phase === 'removed' && <p>The worktree was removed. The original prompt remains in the pending submission below.</p>}
    {!connected && <p>Offline · showing the saved preparation.</p>}
    {error && <p role="status">{error}</p>}
    <div className="environment-preparation-actions">
      {phase && resumable.has(phase) && <button type="button" disabled={!canResume} onClick={onResume}>{pending.uncertain || pending.resume ? 'Check original submission' : phase === 'setup-failed' ? 'Retry setup and send' : 'Continue and send'}</button>}
      <button type="button" disabled={!connected} onClick={() => void refresh()}><Icon name="refresh"/>Check status</button>
      <button type="button" onClick={onSettings}>Environment settings</button>
    </div>
  </section>;
}
