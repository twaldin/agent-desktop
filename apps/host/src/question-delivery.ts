import type { DetachedQuestionSnapshot, SessionSummary } from '@agent-desktop/shared';
import type { OmpDetachedQuestionDeliveryRun } from './omp/detached-questions';

export interface QuestionDeliveryHandle {
  workerFailure?: { message: string };
  listQuestions(): Promise<DetachedQuestionSnapshot[]>;
  startQuestionDelivery(id: string): OmpDetachedQuestionDeliveryRun;
}

/** Delivers already accepted answers. OMP owns the journal and prevents replay;
 * this scheduler only wakes work when the owning host is eligible again. */
export class QuestionDeliveryController {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private generations = new Map<string, number>();
  private inFlight = new Set<string>();
  private stopped = false;
  constructor(private options: {
    session(id: string): SessionSummary | undefined;
    hasDraft(id: string): boolean;
    getHandle(id: string): Promise<QuestionDeliveryHandle>;
    isCurrent(id: string, handle: QuestionDeliveryHandle): Promise<boolean>;
    ordered<T>(id: string, operation: () => Promise<T>): Promise<T>;
    checkpoint(id: string, pending: boolean): void;
    start(id: string, handle: QuestionDeliveryHandle, questionId: string): OmpDetachedQuestionDeliveryRun;
    changed(id: string): void;
    error(id: string, error: unknown): void;
    delayMs?: number;
  }) {}

  request(id: string, delayMs = this.options.delayMs ?? 50): void {
    if (this.stopped || this.timers.has(id) || this.inFlight.has(id) || !this.options.session(id)?.questionDeliveryPending) return;
    const generation = this.generations.get(id) ?? 0;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.inspect(id, generation).catch(error => {
        if (this.current(id, generation)) { this.options.error(id, error); this.request(id, 5_000); }
      });
    }, delayMs);
    timer.unref(); this.timers.set(id, timer);
  }
  cancel(id: string): void {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
  }
  stop(): void { this.stopped = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
  private current(id: string, generation: number): boolean { return !this.stopped && (this.generations.get(id) ?? 0) === generation; }
  private eligible(id: string): boolean {
    const session = this.options.session(id);
    return Boolean(session?.questionDeliveryPending && !session.archived && ['idle', 'running'].includes(session.status) && !this.options.hasDraft(id));
  }
  private async inspect(id: string, generation: number): Promise<void> {
    if (!this.current(id, generation) || this.inFlight.has(id) || !this.eligible(id)) return;
    const handle = await this.options.getHandle(id);
    if (!this.current(id, generation) || !this.eligible(id)) return;
    if (handle.workerFailure) { this.request(id, 5_000); return; }
    const questions = await handle.listQuestions();
    const sameOwner = await this.options.isCurrent(id, handle);
    if (!this.current(id, generation) || !this.eligible(id) || !sameOwner) return;
    await this.options.ordered(id, async () => {
    if (!this.current(id, generation) || !this.eligible(id) || this.inFlight.has(id) || !await this.options.isCurrent(id, handle)) return;
    const waiting = questions.find(question => question.status === 'accepted' && question.delivery.status === 'waiting');
    if (!waiting) { this.options.checkpoint(id, false); return; }
    let run: OmpDetachedQuestionDeliveryRun;
    try { run = this.options.start(id, handle, waiting.questionId); }
    catch (error) {
      // Native preflight rejects before journaling an attempt. Approvals and
      // other native work can finish without a visible transcript event.
      if (error instanceof Error && error.name === 'DetachedQuestionRejected') { this.request(id, 5_000); return; }
      throw error;
    }
    this.inFlight.add(id);
    void run.completion.then(() => this.request(id), error => {
      if (this.current(id, generation) && !(error instanceof Error && error.name === 'DetachedQuestionRejected')) this.options.error(id, error);
    });
    // Native steer admission may wait for a running tool. Keep the host's
    // command queue free so reads, archive and Stop remain responsive.
    let retryDelay = this.options.delayMs ?? 50;
    void run.accepted.catch(error => {
      retryDelay = 5_000;
      if (this.current(id, generation) && !(error instanceof Error && error.name === 'DetachedQuestionRejected')) this.options.error(id, error);
    }).finally(() => {
      this.inFlight.delete(id);
      if (this.current(id, generation)) this.options.changed(id);
      this.request(id, retryDelay);
    });
    });
  }
}
