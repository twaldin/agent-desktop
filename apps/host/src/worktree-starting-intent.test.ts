import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNewChatExecution, parseWorktreeStartingState, sameNewChatExecution } from '../../../packages/shared/src/new-chat';
import type { DraftInput, HostCommand } from '../../../packages/shared/src/protocol';
import { requiresRemoteWorktreeProtocol } from './new-chat-protocol';
import { HostStore } from './store';
import { initializeLocalEnvironmentPreparations, LocalEnvironmentPreparations } from './local-environments/preparations';
import { WorkspaceService } from './workspace/service';

const remote = { type: 'branch' as const, branchName: 'topic', remoteRef: 'refs/remotes/origin/topic' };
const roots: string[] = [];
const stores = new Set<HostStore>();
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const value = mkdtempSync(join(tmpdir(), 'worktree-intent-')); roots.push(value); return value; }
function open(path: string) { const store = new HostStore(path); stores.add(store); return store; }
function close(store: HostStore) { store.close(); stores.delete(store); }
function version(path: string) { const db = new Database(join(path, 'state.sqlite')); try { return db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version; } finally { db.close(); } }
function fixture() {
  const path = root(), store = open(path), sourceRoot = join(path, 'source'); mkdirSync(sourceRoot);
  const project = store.addProject({ path: sourceRoot });
  const draft: DraftInput = { id: 'draft', text: 'keep this', projectId: project.id, model: null, execution: { type: 'worktree', startingState: remote } };
  return { path, store, project, draft };
}

test('exact remote intent survives parsing and participates in captured-draft equality', () => {
  const value = { type: 'worktree' as const, startingState: { ...remote } };
  expect(parseWorktreeStartingState(remote)).toEqual(remote);
  expect(parseNewChatExecution(value, 'project')).toEqual(value);
  expect(sameNewChatExecution(value, structuredClone(value))).toBe(true);
  expect(sameNewChatExecution(value, { type: 'worktree', startingState: { type: 'branch', branchName: 'topic' } })).toBe(false);
  expect(sameNewChatExecution(value, { type: 'worktree', startingState: { ...remote, remoteRef: 'refs/remotes/upstream/topic' } })).toBe(false);
  expect(parseWorktreeStartingState({ type: 'branch', branchName: 'main' })).toEqual({ type: 'branch', branchName: 'main' });
  expect(parseWorktreeStartingState({ type: 'working-tree' })).toEqual({ type: 'working-tree' });
});

test('remote namespace is exact and malformed or extra fields cannot be silently dropped', () => {
  for (const remoteRef of [undefined, null, '', 'origin/topic', 'refs/heads/topic', 'refs/remotes/topic', 'refs/remotes/o/',
    'refs/remotes/o/a..b', 'refs/remotes/o/a@{1}', 'refs/remotes/o/a.lock', 'refs/remotes/o/.hidden',
    'refs/remotes/o/a b', 'refs/remotes/o/a\nb', 'refs/remotes/o/a*', 'refs/remotes/o/a\\b', 'refs/remotes/o/a^2'])
    expect(() => parseWorktreeStartingState({ ...remote, remoteRef })).toThrow();
  expect(() => parseWorktreeStartingState({ ...remote, extra: true })).toThrow();
  expect(() => parseWorktreeStartingState({ type: 'working-tree', remoteRef: remote.remoteRef })).toThrow();
  expect(() => parseNewChatExecution({ type: 'worktree', startingState: remote }, null)).toThrow();
  expect(parseWorktreeStartingState({ ...remote, remoteRef: 'refs/remotes/team/nested/主题' })).toEqual({ ...remote, remoteRef: 'refs/remotes/team/nested/主题' });
});

test('stored remote choice protects overwrite and all draft-consuming commands before dispatch', () => {
  const { store, draft } = fixture(); store.putDraft(draft, 0);
  const commands: HostCommand[] = [
    { type: 'draft.put', draft: { ...draft, execution: { type: 'local' } }, expectedRevision: 1 },
    { type: 'session.create', projectId: draft.projectId, draft: { id: draft.id, revision: 1 } },
    { type: 'session.prompt', sessionId: 'session', text: 'send', draft: { id: draft.id, revision: 1 } },
    { type: 'session.steer', sessionId: 'session', text: 'send', draft: { id: draft.id, revision: 1 } },
  ];
  for (const command of commands) expect(requiresRemoteWorktreeProtocol(command, id => store.getDraft(id))).toBe(true);
  expect(requiresRemoteWorktreeProtocol({ type: 'session.create', projectId: draft.projectId, worktree: remote }, () => undefined)).toBe(true);
  expect(requiresRemoteWorktreeProtocol({ type: 'draft.put', draft, expectedRevision: 0 }, () => undefined)).toBe(true);
  expect(requiresRemoteWorktreeProtocol({ type: 'session.create', projectId: draft.projectId }, id => store.getDraft(id))).toBe(false);
  expect(store.getDraft(draft.id)?.revision).toBe(1);
  expect(store.getDraft(draft.id)?.execution).toEqual(draft.execution);
});

test('remote draft, conflict, consumption and reopen preserve namespace and permanent schema floor', () => {
  const { path, store, draft } = fixture(); const policy = store.getDeviceAccessPolicy();
  expect(store.putDraft(draft, 0).ok).toBe(true);
  const conflict = store.putDraft({ ...draft, execution: { type: 'worktree', startingState: { ...remote, remoteRef: 'refs/remotes/team/topic' } } }, 0);
  expect(conflict.ok).toBe(false);
  if (conflict.ok) throw new Error('Expected conflict');
  expect(conflict.conflict.attempted.execution).toEqual({ type: 'worktree', startingState: { ...remote, remoteRef: 'refs/remotes/team/topic' } });
  store.consumeDraft({ id: draft.id, revision: 1 }, 'original-command');
  close(store);
  expect(version(path)).toBe(18);
  const reopened = open(path);
  expect(reopened.getDraft(draft.id)?.execution).toEqual(draft.execution);
  expect(reopened.getDraft(draft.id)?.lastConsumption?.commandId).toBe('original-command');
  expect(reopened.getDeviceAccessPolicy()).toEqual(policy);
  expect(reopened.putDraft({ ...draft, execution: { type: 'local' } }, 2).ok).toBe(true);
  close(reopened); expect(version(path)).toBe(18);
});

test('remote conflict-only and command-only histories raise the floor without a remote current draft', () => {
  const { path, store, draft } = fixture();
  store.putDraft({ ...draft, execution: { type: 'local' } }, 0);
  expect(store.putDraft(draft, 0).ok).toBe(false);
  expect(store.getDraft(draft.id)?.execution).toEqual({ type: 'local' });
  close(store); expect(version(path)).toBe(18);
  const other = root(), commands = open(other);
  commands.claimCommand('original-id', 'exact-hash', { type: 'session.create', projectId: null, worktree: remote });
  close(commands); expect(version(other)).toBe(18);
  const reopened = open(other);
  expect(reopened.getCommand('original-id')?.command).toEqual({ type: 'session.create', projectId: null, worktree: remote });
  expect(reopened.claimCommand('original-id', 'different-hash').kind).toBe('conflict');
});

test('preparation serializer keeps exact remote identity rather than reconstructing a local branch', () => {
  const path = root(), db = new Database(join(path, 'preparation.sqlite'));
  try {
    initializeLocalEnvironmentPreparations(db);
    const preparations = new LocalEnvironmentPreparations(db, 'host');
    const record = preparations.create({ id: 'prep', projectId: 'project', sourceRoot: join(path, 'source'), worktreePath: join(path, 'worktree'),
      startingState: remote, draft: { id: 'draft', revision: 1 }, environment: null });
    expect(record.startingState).toEqual(remote);
    expect(preparations.get(record.id)?.startingState).toEqual(remote);
  } finally { db.close(); }
});

test('host preparation persistence raises floor and invalid preparation rolls back floor and policy seed', () => {
  const { path, store, project } = fixture();
  const input = { id: 'prep', projectId: project.id, sourceRoot: project.path, worktreePath: join(path, 'worktree'), startingState: remote, draft: { id: 'draft', revision: 1 }, environment: null };
  const before = version(path);
  expect(() => store.createEnvironmentPreparation({ ...input, startingState: { ...remote, remoteRef: 'invalid' } })).toThrow();
  expect(version(path)).toBe(before);
  expect(store.readMetadata('device-access.v1')).toBeUndefined();
  expect(store.createEnvironmentPreparation(input).startingState).toEqual(remote);
  close(store); expect(version(path)).toBe(18);
  expect(open(path).environmentPreparations.get(input.id)?.startingState).toEqual(remote);
});

test('remote worktree execution fails before filesystem or Git access until admitted resolution is implemented', async () => {
  const service = new WorkspaceService(root());
  await expect(service.createSessionWorktree('target', remote)).rejects.toMatchObject({ code: 'REMOTE_WORKTREE_PROTOCOL_REQUIRED' });
});
