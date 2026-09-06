import type { NativeSessionActivity, SessionSummary } from '@agent-desktop/shared';
import type { GoalContinuationEligibility, OmpGoalContinuationRun } from './omp/goal-controller';

export interface GoalContinuationHandle {
  workerFailure?: { message: string };
  getSessionActivity(): Promise<NativeSessionActivity>;
  getGoalContinuationEligibility(): Promise<GoalContinuationEligibility>;
  startGoalContinuation(expectedGoalId: string): OmpGoalContinuationRun;
}
type Checkpoint = SessionSummary['goalContinuation'];

/** One owning-host scheduler. Desktop connectivity never controls execution.
 * Admission shares the prompt command queue; native OMP checks its own pending
 * work again at dispatch. An uncertain run is not retried automatically. */
export class GoalContinuationController {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private generations = new Map<string, number>();
  private stopped = false;
  constructor(private options: {
    session(id: string): SessionSummary | undefined;
    checkpoint(id: string, state: Checkpoint): void;
    hasDraft(id: string): boolean;
    executing(id: string): boolean;
    getHandle(id: string): Promise<GoalContinuationHandle>;
    isCurrent(id: string, handle: GoalContinuationHandle): Promise<boolean>;
    ordered<T>(id: string, operation: () => Promise<T>): Promise<T>;
    start(id: string, handle: GoalContinuationHandle, goalId: string): OmpGoalContinuationRun;
    error(id: string, error: unknown): void;
    delayMs?: number;
  }) {}

  request(id: string, delayMs = this.options.delayMs ?? 800): void {
    if (this.stopped || this.timers.has(id)) return;
    const generation = this.generations.get(id) ?? 0;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.options.ordered(id, () => this.inspect(id, generation)).catch(error => {
        if (this.current(id, generation)) this.options.error(id, error);
      });
    }, delayMs);
    timer.unref(); this.timers.set(id, timer);
  }

  cancel(id: string): void {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
  }

  /** A successful explicit create/replace/resume or user prompt releases the
   * no-tool checkpoint. Pause/drop and stop are handled by cancel(). */
  explicitWork(id: string): void {
    const checkpoint = this.options.session(id)?.goalContinuation;
    if (checkpoint?.blocked) this.options.checkpoint(id, { goalId: checkpoint.goalId });
    this.request(id);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private current(id: string, generation: number): boolean {
    return !this.stopped && (this.generations.get(id) ?? 0) === generation;
  }
  private idle(id: string): boolean {
    const session = this.options.session(id);
    return Boolean(session && !session.archived && session.status === 'idle' && !this.options.executing(id));
  }
  private async inspect(id: string, generation: number): Promise<void> {
    if (!this.current(id, generation) || !this.idle(id)) return;
    const handle = await this.options.getHandle(id);
    if (!this.current(id, generation) || handle.workerFailure || !this.idle(id)) return;
    const activity = await handle.getSessionActivity();
    const sameOwner = await this.options.isCurrent(id, handle);
    if (!this.current(id, generation) || !this.idle(id) || !sameOwner) return;
    if (activity.goal.availability !== 'available') return;
    const goal = activity.goal.value;
    if (!goal || !goal.enabled || goal.status !== 'active' || goal.mode !== 'active') {
      this.options.checkpoint(id, undefined); return;
    }
    const prior = this.options.session(id)?.goalContinuation;
    if (prior?.goalId === goal.id && prior.blocked) return;
    this.options.checkpoint(id, { goalId: goal.id });
    if (this.options.hasDraft(id)) return;
    const eligibility = await handle.getGoalContinuationEligibility();
    const sameBeforeDispatch = await this.options.isCurrent(id, handle);
    if (!this.current(id, generation) || !this.idle(id) || this.options.hasDraft(id) || !sameBeforeDispatch) return;
    if (!eligibility.eligible || eligibility.goalId !== goal.id) {
      if (!eligibility.eligible && eligibility.reason === 'suppressed-no-tools') this.options.checkpoint(id, { goalId: goal.id, blocked: 'no-tools' });
      // Async jobs and native post-prompt work can finish without a visible
      // transcript event. A bounded recheck recovers a lost wake-up.
      else if (!eligibility.eligible && ['post-prompt-work', 'native-async-work', 'interaction-pending', 'tool-running', 'mutation-pending', 'admission-pending'].includes(eligibility.reason)) this.request(id, 5000);
      return;
    }
    let run: OmpGoalContinuationRun;
    // Persist before dispatch. HostStore also recovers running sessions as
    // interrupted, but this checkpoint must be safe independently on reopen.
    this.options.checkpoint(id, { goalId: goal.id, blocked: 'in-flight' });
    try { run = this.options.start(id, handle, goal.id); }
    catch (error) {
      if (error instanceof Error && error.name === 'GoalContinuationRejected') { this.options.checkpoint(id, { goalId: goal.id }); return; }
      this.options.checkpoint(id, { goalId: goal.id, blocked: 'unknown' }); throw error;
    }
    // Completion may settle before admission; attach both handlers immediately.
    void run.completion.then(result => {
      if (!this.current(id, generation)) return;
      const checkpoint = this.options.session(id)?.goalContinuation;
      if (checkpoint?.goalId === goal.id && checkpoint.blocked !== 'unknown') {
        this.options.checkpoint(id, { goalId: goal.id, ...(result.suppressedNext ? { blocked: 'no-tools' as const } : {}) });
      }
      if (!result.suppressedNext) this.request(id);
    }).catch(error => {
      if (!this.current(id, generation)) return;
      this.options.checkpoint(id, { goalId: goal.id, blocked: 'unknown' }); this.options.error(id, error);
    });
    try {
      const receipt = await run.accepted;
      if (receipt.goalId !== goal.id || !receipt.entryId) throw new Error('Native goal continuation admission is unknown.');
    } catch (error) {
      if (this.current(id, generation)) this.options.checkpoint(id, { goalId: goal.id, blocked: 'unknown' });
      throw error;
    }
  }
}
