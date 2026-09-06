import type { CommandResult, SessionSummary } from '@agent-desktop/shared';
import type { WorkerSession } from './omp-workers/runtime';
import { HostStore } from './store';

export interface BtwPromotionIntent {
  commandId: string; originId: string; runId: string;
  state: 'pending' | 'cancelled' | 'complete' | 'unknown';
  sessionFile?: string; sessionId?: string;
}
const key = (id: string, runId: string) => `btw-promotion:${id}:${runId}`;
const unknown = () => Object.assign(new Error('Native side-chat promotion is unconfirmed. Inspect the original command and session files; it will not be replayed.'), { code: 'OUTCOME_UNKNOWN' });

/** Native branching changes the worker's owner. Bind its result only after that
 * worker exits, together with its original command receipt and setup exports. */
export class BtwPromotionService {
  constructor(private readonly options: {
    store: HostStore;
    existing(id: string): Promise<WorkerSession | undefined>;
    forget(id: string, handle: WorkerSession): void;
    busy(id: string): boolean;
  }) {}
  blocked(id: string, runId: string): boolean {
    const record = this.options.store.readMetadata<BtwPromotionIntent>(key(id, runId));
    return Boolean(record && record.state !== 'cancelled');
  }
  async promote(commandId: string, originId: string, runId: string): Promise<CommandResult> {
    const { store } = this.options;
    const origin = store.getSession(originId);
    if (!origin || origin.archived || origin.status !== 'idle' || this.options.busy(originId)) throw new Error('The original conversation must be idle before forking a side answer.');
    if (this.blocked(originId, runId)) throw unknown();
    const handle = await this.options.existing(originId);
    if (!handle || handle.workerFailure || handle.id !== origin.id || handle.sessionFile !== origin.sessionFile)
      throw new Error('The original side-answer worker is unavailable. No replacement worker was opened.');
    const answer = await handle.getBtw();
    if (answer?.runId !== runId || answer.sessionId !== originId || answer.status !== 'complete' || !answer.canPromote)
      throw new Error('This side answer no longer has its original native branch point.');
    if (await this.options.existing(originId) !== handle || this.options.busy(originId)) throw new Error('The original side-answer owner changed before promotion.');
    const environment = store.getSessionEnvironment(originId);
    const intent: BtwPromotionIntent = { commandId, originId, runId, state: 'pending' };
    store.writeMetadata(key(originId, runId), intent); // Admission must be durable before calling native branching.
    let nativeStarted = false;
    try {
      nativeStarted = true;
      const result = await handle.promoteBtw(runId, commandId);
      if (result.cancelled) {
        if (handle.id !== originId || handle.sessionFile !== origin.sessionFile) throw unknown();
        return store.finishBtwPromotion(commandId, origin, undefined, { ...intent, state: 'cancelled' }, key(originId, runId));
      }
      if (result.sessionId === originId || result.sessionId !== handle.id || !result.sessionFile || result.sessionFile !== handle.sessionFile
        || result.sessionFile === origin.sessionFile || handle.cwd !== origin.cwd || store.getSession(result.sessionId)) throw unknown();
      const session: SessionSummary = { ...origin, id: result.sessionId, sessionFile: result.sessionFile,
        title: handle.title || 'Side chat', model: handle.model, createdAt: handle.createdAt, updatedAt: Date.now(), status: 'idle',
        error: undefined, goalContinuation: undefined, questionDeliveryPending: undefined };
      // Retain the actual new path even if disposal or final SQLite binding fails.
      store.writeMetadata(key(originId, runId), { ...intent, sessionId: session.id, sessionFile: session.sessionFile });
      await handle.dispose();
      this.options.forget(originId, handle);
      return store.finishBtwPromotion(commandId, session, environment, { ...intent, state: 'complete', sessionId: session.id, sessionFile: session.sessionFile }, key(originId, runId));
    } catch {
      if (nativeStarted) {
        try { store.writeMetadata(key(originId, runId), { ...intent, state: 'unknown', sessionId: handle.id, sessionFile: handle.sessionFile }); } catch { /* Durable pending intent remains. */ }
        try { await handle.dispose(); this.options.forget(originId, handle); } catch { /* Keep the retired handle fenced until host recovery. */ }
      }
      throw unknown();
    }
  }
}
