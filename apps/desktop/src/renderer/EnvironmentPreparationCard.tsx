import { useCallback, useEffect, useRef, useState, useId } from 'react';
import type { CommandEnvelope, DesktopBridge, LocalEnvironmentExecutionOutput, LocalEnvironmentPreparationPhase } from '@agent-desktop/shared';
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
export function EnvironmentPreparationCard({ bridge, hostId, pending, submissions, connected, busy, executionControls, onResume, onSettings }: {
  bridge: DesktopBridge; hostId: string; pending: PendingSubmission; submissions: SubmissionController;
  connected: boolean; busy: boolean; executionControls?: { scriptOutput?: true; scriptCancellation?: true }; onResume(): void; onSettings(): void;
}) {
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [output, setOutput] = useState<LocalEnvironmentExecutionOutput | null>();
  const [outputError, setOutputError] = useState<string>();
  const [cancellation, setCancellation] = useState<'sending' | 'uncertain' | 'accepted'>();
  const [cancelError, setCancelError] = useState<string>();
  const cancellationCommand = useRef<CommandEnvelope | undefined>(undefined);
  const alive = useRef(true);
  const outputId = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const id = pending.preparation?.id ?? pending.create?.id;
  const projectId = pending.draft.projectId;
  const refresh = useCallback(async () => {
    if (!id || !projectId || !connected) return;
    try {
      const result = await bridge.workspaceQuery({ projectId }, { type: 'environment.preparation', preparationId: id }, hostId);
      if (!alive.current) return;
      if (result.type !== 'environment.preparation') throw new Error('The host did not return this environment preparation.');
      submissions.observePreparation(pending.draft.id, result.preparation);
      setError(undefined);
    } catch (cause) { if (alive.current && !busy) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [bridge, hostId, id, projectId, pending.draft.id, submissions, connected, busy]);
  useEffect(() => {
    setError(undefined);
    if (!connected) return;
    void refresh(); const timer = setInterval(() => { void refresh(); }, 1500);
    return () => clearInterval(timer);
  }, [refresh, connected]);
  useEffect(() => {
    if (!expanded || !executionControls?.scriptOutput || !connected || !id || !projectId) return;
    let active = true, querying = false;
    const read = async () => {
      if (querying) return;
      querying = true;
      try {
        const result = await bridge.workspaceQuery({ projectId }, { type: 'environment.output', preparationId: id }, hostId);
        if (!active) return;
        if (result.type !== 'environment.output') throw new Error('The host did not return setup output.');
        setOutput(previous => !previous || !result.output || result.output.runRevision > previous.runRevision || result.output.runRevision === previous.runRevision && result.output.sequence >= previous.sequence ? result.output : previous);
        setOutputError(undefined);
      } catch (cause) { if (active) setOutputError(cause instanceof Error ? cause.message : String(cause)); }
      finally { querying = false; }
    };
    void read(); const timer = setInterval(() => void read(), 750);
    return () => { active = false; clearInterval(timer); };
  }, [bridge, hostId, id, projectId, connected, expanded, executionControls?.scriptOutput]);
  const preparation = pending.preparation;
  const phase = preparation?.phase;
  useEffect(() => { if (phase === 'setup-failed' || phase === 'cleanup-failed') setExpanded(true); }, [phase]);
  const running = phase && ['worktree-creating', 'setup-running', 'native-creating', 'cleanup-running'].includes(phase);
  const canResume = connected && !busy && phase !== undefined && resumable.has(phase);
  useEffect(() => { cancellationCommand.current = undefined; setCancellation(undefined); setCancelError(undefined); }, [preparation?.revision]);
  const cancel = async () => {
    if (!preparation || !projectId || !connected || cancellation === 'sending') return;
    const envelope = cancellationCommand.current ??= { id: crypto.randomUUID(), commandVersion: 5, command: { type: 'session.environment.cancel', preparationId: preparation.id, projectId, runRevision: preparation.revision } };
    setCancellation('sending'); setCancelError(undefined);
    try {
      const result = await bridge.command(envelope, hostId);
      if (!alive.current || cancellationCommand.current !== envelope) return;
      if (!result.ok) { cancellationCommand.current = undefined; setCancellation(undefined); setCancelError(result.error.message); }
      else setCancellation('accepted');
    } catch (cause) {
      if (alive.current && cancellationCommand.current === envelope) { setCancellation('uncertain'); setCancelError('Cancellation was not confirmed. Check the same request before taking another action.'); }
    }
    await refresh();
  };
  return <section className="environment-preparation-card" aria-label="Environment preparation">
    <div className="environment-preparation-heading"><span aria-hidden="true">{running || !phase && busy ? <span className="spinner"/> : <Icon name="terminal"/>}</span><strong>{phase ? labels[phase] : 'Preparing environment'}</strong><span>{preparation?.environment?.name}</span></div>
    {phase === 'setup-failed' && <p>Your worktree and original prompt are preserved.{preparation?.setup?.status === 'cancelled' ? ' Setup was cancelled.' : preparation?.setup?.exitCode != null ? ` Setup exited with code ${preparation.setup.exitCode}.` : ''}</p>}
    {phase === 'unknown' && <p>The last operation has no confirmed outcome. Inspect the worktree before taking another action; checking status does not run it again.</p>}
    {phase === 'removed' && <p>The worktree was removed. The original prompt remains in the pending submission below.</p>}
    {!connected && <p>Offline · showing the saved preparation.</p>}
    {error && <p role="status">{error}</p>}
    {cancelError && <p role="status">{cancelError}</p>}
    {cancellation === 'accepted' && <p role="status">Cancellation requested. Waiting for the script to stop.</p>}
    <div className="environment-preparation-actions">
      {executionControls?.scriptCancellation && (phase === 'setup-running' || phase === 'cleanup-running') && <button type="button" disabled={!connected || cancellation === 'sending' || cancellation === 'accepted'} onClick={() => void cancel()}>{cancellation === 'uncertain' ? 'Check cancellation' : 'Cancel'}</button>}
      {executionControls?.scriptOutput && <button type="button" aria-expanded={expanded} aria-controls={outputId} onClick={() => setExpanded(value => !value)}>{expanded ? 'Less details' : 'More details'}</button>}
      {phase && resumable.has(phase) && <button type="button" disabled={!canResume} onClick={onResume}>{pending.uncertain || pending.resume ? 'Check original submission' : phase === 'setup-failed' ? 'Retry setup and send' : 'Continue and send'}</button>}
      <button type="button" disabled={!connected} onClick={() => void refresh()}><Icon name="refresh"/>Check status</button>
      <button type="button" onClick={onSettings}>Environment settings</button>
    </div>
    {expanded && executionControls?.scriptOutput && <div id={outputId} className="environment-preparation-output">
      {outputError && <p role="status">{outputError}</p>}
      {output == null ? <p>{connected ? 'Waiting for setup output.' : 'Reconnect to read setup output.'}</p> : <>
        <div className="environment-output-meta">{output.lifecycle === 'setup' ? 'Setup' : 'Cleanup'}{!connected ? ' · Offline snapshot' : ''}</div>
        <div className="environment-output-scroll" tabIndex={0} aria-label="Environment script output">
          {output.stdout && <pre aria-label="Standard output">{output.stdout}</pre>}
          {output.stderr && <pre aria-label="Standard error" className="environment-output-stderr">{output.stderr}</pre>}
          {!output.stdout && !output.stderr && <p>No output yet.</p>}
        </div>
        {output.truncated && <p>Output limit reached. Later output is omitted.</p>}
        {phase === 'unknown' && !output.finished && <p>Output captured before the host stopped; the final outcome is unknown.</p>}
      </>}
    </div>}
  </section>;
}
