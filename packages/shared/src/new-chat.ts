import type { WorktreeStartingState } from './workspace';

/** Present even after returning to Local, so older clients cannot erase intent. */
export type NewChatExecution = { type: 'local' } | { type: 'worktree'; startingState: WorktreeStartingState };

export function parseWorktreeStartingState(value: unknown): WorktreeStartingState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Select a worktree starting state.');
  const state = value as Record<string, unknown>;
  if (state.type === 'working-tree' && Object.keys(state).length === 1) return { type: 'working-tree' };
  if (state.type === 'branch' && Object.keys(state).length === 2 && typeof state.branchName === 'string'
    && state.branchName.length > 0 && state.branchName.length <= 500 && !state.branchName.includes('\0')) return { type: 'branch', branchName: state.branchName };
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
  return a.startingState.type === b.startingState.type && (a.startingState.type !== 'branch' || b.startingState.type === 'branch' && a.startingState.branchName === b.startingState.branchName);
}
