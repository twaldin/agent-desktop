import { expect, test } from 'bun:test';
import type { DetachedQuestionSnapshot, SessionSummary } from '@agent-desktop/shared';
import { QuestionDeliveryController } from './question-delivery';

test('slow native inspection never occupies the command queue; cancellation invalidates its stale result', async () => {
  const read = Promise.withResolvers<DetachedQuestionSnapshot[]>();
  const started = Promise.withResolvers<void>();
  let queueCalls = 0, startCalls = 0, checkpoints = 0;
  const session = { id: 'session', status: 'idle', archived: false, questionDeliveryPending: true } as SessionSummary;
  const handle = { listQuestions: () => { started.resolve(); return read.promise; }, startQuestionDelivery: () => { throw new Error('Not expected'); } };
  const controller = new QuestionDeliveryController({ session: () => session, hasDraft: () => false, getHandle: async () => handle, isCurrent: async () => true,
    ordered: async (_id, action) => { queueCalls++; return action(); }, checkpoint: () => { checkpoints++; }, start: () => { startCalls++; throw new Error('Not expected'); },
    changed() {}, error(_id, error) { throw error; }, delayMs: 0 });
  try {
    controller.request('session'); await started.promise;
    expect(queueCalls).toBe(0);
    controller.cancel('session'); session.archived = true;
    read.resolve([]); await Bun.sleep(10);
    expect(queueCalls).toBe(0); expect(startCalls).toBe(0); expect(checkpoints).toBe(0);
  } finally { read.resolve([]); controller.stop(); }
});
