import { expect, test } from 'bun:test';
import type { SessionForkSnapshot } from '../../../../packages/shared/src/session-fork';
import { forkSlashQueryRemoval, sessionForkDestinations } from './SessionFork';

test('Fork dismissal removes only its captured query and maps the original composer selection', () => {
  const query = { text: 'before /fork local after', start: 7, end: 18 };
  expect(forkSlashQueryRemoval(query, query.text, { start: 20, end: 24 })).toEqual({ text: 'before  after', selection: { start: 9, end: 13 } });
  expect(forkSlashQueryRemoval(query, query.text, { start: 2, end: 15 })).toEqual({ text: 'before  after', selection: { start: 2, end: 7 } });
  expect(forkSlashQueryRemoval({ text: '/fork', start: 0, end: 5 }, '/fork', { start: 5, end: 5 })).toEqual({ text: '', selection: { start: 0, end: 0 } });
});

test('a stale Fork dismissal cannot clear newer unrelated input or its selection', () => {
  const query = { text: '/fork', start: 0, end: 5 };
  expect(forkSlashQueryRemoval(query, '/fork newer unrelated text', { start: 12, end: 12 })).toBeUndefined();
  expect(forkSlashQueryRemoval(query, 'A different draft', { start: 2, end: 9 })).toBeUndefined();
});

test('source worktree labels survive unavailable destinations without fabricating a new-worktree option', () => {
  const snapshot: SessionForkSnapshot = { version: 1, hostId: 'host', sessionId: 'source', revision: 'current',
    local: { available: true, cwd: '/worktrees/source', isWorktree: true }, worktree: { available: false, reason: 'New worktree creation is unavailable.' } };
  expect(sessionForkDestinations(snapshot).map(item => ({ id: item.id, title: item.title, description: item.description, available: item.available }))).toEqual([
    { id: 'local', title: 'Fork chat in same worktree', description: 'Fork this chat in the same worktree', available: true },
  ]);
  snapshot.local.available = false; snapshot.local.reason = 'Source temporarily unavailable.';
  expect(sessionForkDestinations(snapshot)[0]).toMatchObject({ title: 'Fork chat in same worktree', description: 'Fork this chat in the same worktree', available: false, reason: 'Source temporarily unavailable.' });
  snapshot.local.isWorktree = false;
  expect(sessionForkDestinations(snapshot)[0]?.title).toBe('Fork chat');
});
