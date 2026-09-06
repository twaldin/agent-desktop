import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detachedAnswerDraft, type DetachedQuestionSnapshot, type HostCommand } from '@agent-desktop/shared';
import { HostStore } from './store';

const answers = [{ questionId: 'density', selectedOptions: ['Compact'] }];
const question: DetachedQuestionSnapshot = { questionId: 'question', questionEntryId: 'native-open', originRunId: 'native-run', openedAt: 1,
  questions: [{ id: 'density', question: 'Which density?', options: [{ label: 'Compact' }], multi: false }], status: 'accepted',
  acceptance: { commandId: 'answer', acceptanceEntryId: 'native-accept', acceptedAt: 2, answers }, delivery: { status: 'waiting' } };

test('a lost native acceptance receipt reconciles only its exact session, question, answers and submitted draft revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-question-reconcile-')), store = new HostStore(root);
  try {
    const draft = { id: 'question:session:question', text: detachedAnswerDraft(answers), projectId: null, model: null };
    store.putDraft(draft, 0);
    const command: HostCommand = { type: 'session.question.answer', sessionId: 'session', questionId: 'question', questionEntryId: 'native-open', answers, draft: { id: draft.id, revision: 1 } };
    store.claimCommand('answer', 'hash', command);
    expect(store.reconcileQuestionAcceptance('other-session', question)).toBe(false);
    expect(store.reconcileQuestionAcceptance('session', { ...question, questionEntryId: 'different-open' })).toBe(false);
    expect(store.reconcileQuestionAcceptance('session', { ...question, acceptance: { ...question.acceptance!, answers: [{ questionId: 'density', selectedOptions: [], customInput: 'new input' }] } })).toBe(false);
    expect(store.getDraft(draft.id)?.revision).toBe(1);
    expect(store.reconcileQuestionAcceptance('session', question)).toBe(true);
    expect(store.getDraft(draft.id)).toMatchObject({ text: '', revision: 2 });
    expect(store.getCommand('answer')).toMatchObject({ state: 'done', result: { ok: true, value: { type: 'session.question.answer', receipt: { acceptanceEntryId: 'native-accept' } } } });
    expect(store.reconcileQuestionAcceptance('session', question)).toBe(false);
    expect(store.getDraft(draft.id)?.revision).toBe(2);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('unknown receipt recovery preserves a newer answer draft; definite rejection is never rewritten', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-question-reconcile-')), store = new HostStore(root);
  try {
    const draft = { id: 'question:session:question', text: detachedAnswerDraft(answers), projectId: null, model: null };
    store.putDraft(draft, 0);
    const command: HostCommand = { type: 'session.question.answer', sessionId: 'session', questionId: 'question', questionEntryId: 'native-open', answers, draft: { id: draft.id, revision: 1 } };
    store.claimCommand('answer', 'hash', command);
    store.finishCommand('answer', 'hash', { ok: false, commandId: 'answer', error: { code: 'OUTCOME_UNKNOWN', message: 'Lost worker response' } });
    store.putDraft({ ...draft, text: 'A newer unsent answer' }, 1);
    expect(store.reconcileQuestionAcceptance('session', question)).toBe(true);
    expect(store.getDraft(draft.id)).toMatchObject({ text: 'A newer unsent answer', revision: 2 });
    store.claimCommand('rejected', 'other-hash', command);
    store.finishCommand('rejected', 'other-hash', { ok: false, commandId: 'rejected', error: { code: 'DRAFT_CONFLICT', message: 'Newer draft' } });
    expect(store.reconcileQuestionAcceptance('session', { ...question, acceptance: { ...question.acceptance!, commandId: 'rejected' } })).toBe(false);
    expect(store.getCommand('rejected')?.result).toMatchObject({ ok: false, error: { code: 'DRAFT_CONFLICT' } });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
