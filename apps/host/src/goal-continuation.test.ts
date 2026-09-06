import { afterEach, expect, test } from 'bun:test';
import type { NativeGoalActivity, SessionSummary } from '@agent-desktop/shared';
import { GoalContinuationController, type GoalContinuationHandle } from './goal-continuation';
import type { GoalContinuationAcceptance, GoalContinuationCompletion, GoalContinuationEligibility } from './omp/goal-controller';

const controllers: GoalContinuationController[] = [];
afterEach(() => { for (const c of controllers.splice(0)) c.stop(); });
const goal: NativeGoalActivity = { id: 'goal-1', objective: 'Complete the native goal', status: 'active', enabled: true, mode: 'active', tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
const wait = async (check: () => boolean) => { for (let i = 0; i < 100; i++) { if (check()) return; await Bun.sleep(2); } throw new Error('Condition did not settle'); };
function fixture() {
  let session: SessionSummary = { id: 'session', hostId: 'host', projectId: null, cwd: '/disposable', title: 'Test', status: 'idle', sessionFile: '/disposable/session', model: null, createdAt: 1, updatedAt: 1, archived: false };
  let draft = false, running = false, current = true, starts = 0, reads = 0, activeGoal: NativeGoalActivity | null = goal;
  let eligibility: () => Promise<GoalContinuationEligibility> = async () => ({ eligible: true, goalId: goal.id, observedUpdatedAt: 1 });
  const accepted = Promise.withResolvers<GoalContinuationAcceptance>(), completed = Promise.withResolvers<GoalContinuationCompletion>();
  const errors: unknown[] = [];
  const handle: GoalContinuationHandle = {
    getSessionActivity: async () => { reads++; return { goal: { availability: 'available', value: activeGoal }, jobs: { availability: 'unavailable', reason: 'fixture' }, agents: { availability: 'available', value: [] }, sources: { availability: 'unsupported', reason: 'fixture' } }; },
    getGoalContinuationEligibility: () => eligibility(),
    startGoalContinuation: () => ({ accepted: accepted.promise, completion: completed.promise }),
  };
  let tail: Promise<unknown> = Promise.resolve();
  const options = {
    session: () => session,
    checkpoint: (_id: string, value: SessionSummary['goalContinuation']) => { session = { ...session, goalContinuation: value }; },
    hasDraft: () => draft, executing: () => running, getHandle: async () => handle, isCurrent: async () => current,
    ordered<T>(_id: string, op: () => Promise<T>) { const next = tail.catch(() => {}).then(op); tail = next; return next; },
    start: () => { starts++; running = true; session.status = 'running'; return handle.startGoalContinuation(goal.id); },
    error: (_id: string, error: unknown) => { errors.push(error); session.status = 'error'; }, delayMs: 2,
  };
  const make = () => { const c = new GoalContinuationController(options); controllers.push(c); return c; };
  return { c: make(), make, accepted, completed, errors, session: () => session, starts: () => starts, reads: () => reads,
    draft: (value: boolean) => { draft = value; }, status: (value: SessionSummary['status']) => { session.status = value; },
    archive: () => { session.archived = true; }, replace: () => { current = false; }, goal: (value: NativeGoalActivity | null) => { activeGoal = value; },
    eligibility: (fn: typeof eligibility) => { eligibility = fn; },
    end: () => { running = false; session.status = 'idle'; },
  };
}

test('owning host continues with no desktop peers, waits for drafts, and suppresses a no-tool loop durably', async () => {
  const s = fixture(); s.draft(true); s.c.request('session'); await wait(() => s.reads() > 0); await Bun.sleep(8);
  expect(s.starts()).toBe(0); expect(s.session().goalContinuation).toEqual({ goalId: goal.id });
  s.draft(false); s.c.request('session'); s.c.request('session'); await wait(() => s.starts() === 1);
  s.accepted.resolve({ goalId: goal.id, entryId: 'native-custom-entry' });
  s.end(); s.completed.resolve({ goalId: goal.id, hadToolCalls: false, suppressedNext: true });
  await wait(() => s.session().goalContinuation?.blocked === 'no-tools');
  s.c.stop(); const reopened = s.make(); reopened.request('session'); await Bun.sleep(15);
  expect(s.starts()).toBe(1); expect(s.errors).toEqual([]);
  reopened.explicitWork('session'); await wait(() => s.starts() === 2);
});

test('interrupt, a new draft, or replaced owner during eligibility read prevents admission', async () => {
  for (const change of ['interrupt', 'draft', 'owner', 'archive'] as const) {
    const s = fixture(), gate = Promise.withResolvers<GoalContinuationEligibility>(); let entered = false;
    s.eligibility(async () => { entered = true; return gate.promise; }); s.c.request('session'); await wait(() => entered);
    if (change === 'interrupt') { s.c.cancel('session'); s.status('interrupted'); }
    if (change === 'draft') s.draft(true);
    if (change === 'owner') s.replace();
    if (change === 'archive') s.archive();
    gate.resolve({ eligible: true, goalId: goal.id, observedUpdatedAt: 1 }); await Bun.sleep(8);
    expect(s.starts()).toBe(0); s.c.stop();
  }
});

test('pending native approvals and queued work are never answered or converted to a provider prompt', async () => {
  for (const reason of ['interaction-pending', 'native-async-work', 'post-prompt-work', 'disabled', 'inactive'] as const) {
    const s = fixture(); s.eligibility(async () => ({ eligible: false, reason })); s.c.request('session');
    await wait(() => s.reads() > 0); await Bun.sleep(8); expect(s.starts()).toBe(0); s.c.stop();
  }
});

test('uncertain admission persists a blocked checkpoint and cannot be replayed by events or restart', async () => {
  const s = fixture(); s.c.request('session'); await wait(() => s.starts() === 1);
  s.accepted.reject(new Error('Lost native receipt')); s.end();
  s.completed.resolve({ goalId: goal.id, hadToolCalls: true, suppressedNext: false });
  await wait(() => s.session().goalContinuation?.blocked === 'unknown');
  s.status('idle'); s.c.request('session'); await Bun.sleep(10); s.c.stop();
  s.make().request('session'); await Bun.sleep(10);
  expect(s.starts()).toBe(1); expect(s.errors.length).toBeGreaterThan(0);
});

test('a dispatched continuation is blocked on reopen even without relying on session-status crash recovery', async () => {
  const s = fixture(); s.c.request('session'); await wait(() => s.starts() === 1);
  expect(s.session().goalContinuation).toEqual({ goalId: goal.id, blocked: 'in-flight' });
  s.c.stop(); s.end(); s.make().request('session'); await Bun.sleep(12);
  expect(s.starts()).toBe(1);
});

test('pause or completion removes the continuation checkpoint without fabricating native state', async () => {
  for (const value of [null, { ...goal, status: 'paused' as const, enabled: false }]) {
    const s = fixture(); s.session().goalContinuation = { goalId: goal.id }; s.goal(value); s.c.request('session');
    await wait(() => s.reads() > 0); await Bun.sleep(8);
    expect(s.session().goalContinuation).toBeUndefined(); expect(s.starts()).toBe(0);
  }
});
