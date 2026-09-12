import type { WorktreeStartingState } from './workspace';

/** Present even after returning to Local, so older clients cannot erase intent. */
export type NewChatExecution = { type: 'local' } | { type: 'worktree'; startingState: WorktreeStartingState };

export function parseWorktreeStartingState(value: unknown): WorktreeStartingState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Select a worktree starting state.');
  const state = value as Record<string, unknown>;
  if (state.type === 'working-tree' && Object.keys(state).length === 1) return { type: 'working-tree' };
  if (state.type === 'branch' && Object.keys(state).every(key => ['type', 'branchName', 'remoteRef'].includes(key))
    && typeof state.branchName === 'string' && state.branchName.length > 0
    && state.branchName.length <= 500 && !state.branchName.includes('\0')) {
    if (!Object.hasOwn(state, 'remoteRef')) return { type: 'branch', branchName: state.branchName };
    const ref = state.remoteRef;
    // Carry an exact remote namespace, never a display label or a revision expression.
    if (typeof ref === 'string' && ref.length <= 512 && ref.startsWith('refs/remotes/')
      && ref.slice('refs/remotes/'.length).includes('/') && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref)
      && !ref.includes('..') && !ref.includes('@{') && !ref.endsWith('.')
      && ref.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock')))
      return { type: 'branch', branchName: state.branchName, remoteRef: ref };
  }
  throw new Error('Invalid worktree starting state.');
}

export function parseNewChatExecution(value: unknown, projectId: string | null): NewChatExecution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Select Local or a new worktree.');
  const execution = value as Record<string, unknown>;
  if (execution.type === 'local' && Object.keys(execution).length === 1) return { type: 'local' };
  if (execution.type === 'worktree' && projectId && Object.keys(execution).length === 2) return { type: 'worktree', startingState: parseWorktreeStartingState(execution.startingState) };
  throw new Error('A new worktree requires a selected project and starting state.');
}

export function sameNewChatExecution(a?: NewChatExecution, b?: NewChatExecution): boolean {
  if (a?.type !== b?.type) return false;
  if (a?.type !== 'worktree' || b?.type !== 'worktree') return true;
  return a.startingState.type === b.startingState.type && (a.startingState.type !== 'branch' || b.startingState.type === 'branch' && a.startingState.branchName === b.startingState.branchName && a.startingState.remoteRef === b.startingState.remoteRef);
}

/** Presence is conservative so an older transport cannot erase malformed intent. */
export function hasRemoteStartingState(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.hasOwn(value, 'remoteRef');
}
export function hasRemoteExecution(value: unknown): boolean {
  return !!value && typeof value === 'object' && hasRemoteStartingState((value as { startingState?: unknown }).startingState);
}

/** Shared transport detection; malformed presence must still select the new route. */
export function hasRemoteWorktreeIntent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const command = value as Record<string, unknown>;
  return hasRemoteStartingState(command.worktree) || command.type === 'draft.put'
    && !!command.draft && typeof command.draft === 'object'
    && hasRemoteExecution((command.draft as Record<string, unknown>).execution);
}
