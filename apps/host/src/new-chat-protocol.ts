import { hasRemoteExecution, hasRemoteStartingState, hasRemoteWorktreeIntent } from '../../../packages/shared/src/new-chat';
import type { Draft, HostCommand } from '@agent-desktop/shared';

export function hasNewChatIntent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const command = value as Record<string, unknown>;
  return Object.hasOwn(command, 'worktree') || command.type === 'draft.put' && !!command.draft
    && typeof command.draft === 'object' && Object.hasOwn(command.draft, 'execution');
}

export function requiresNewChatProtocol(command: HostCommand, getDraft: (id: string) => Draft | undefined): boolean {
  if (hasNewChatIntent(command)) return true;
  const id = command.type === 'draft.put' ? command.draft.id
    : command.type === 'session.prompt' || command.type === 'session.steer' ? command.draft?.id : undefined;
  return id !== undefined && getDraft(id)?.execution !== undefined;
}

export { hasRemoteWorktreeIntent } from '../../../packages/shared/src/new-chat';

/** Protect the stored choice as well as incoming fields, including draft consumption. */
export function requiresRemoteWorktreeProtocol(command: HostCommand, getDraft: (id: string) => Draft | undefined): boolean {
  if (hasRemoteWorktreeIntent(command)) return true;
  const id = command.type === 'draft.put' ? command.draft.id
    : command.type === 'session.create' || command.type === 'session.prompt' || command.type === 'session.steer' ? command.draft?.id : undefined;
  return id !== undefined && hasRemoteExecution(getDraft(id)?.execution);
}

/** Called under command dispatch ownership; transport alone cannot bypass preparation. */
export function remoteWorktreeProtocolError(command: HostCommand, version: number, getDraft: (id: string) => Draft | undefined, getPreparation: (id: string) => { startingState: unknown } | undefined): { code: string; message: string } | undefined {
  const remote = requiresRemoteWorktreeProtocol(command, getDraft) || command.type === 'session.environment.resume' && hasRemoteStartingState(getPreparation(command.preparationId)?.startingState);
  if (version < 12 && remote)
    return { code: 'REMOTE_WORKTREE_PROTOCOL_REQUIRED', message: 'Remote worktree starting state requires /v12/commands. Its intent was preserved.' };
  if (command.type === 'session.create' && remote
    && (!command.worktree || command.environment === undefined || !command.draft))
    return { code: 'REMOTE_WORKTREE_PREPARATION_REQUIRED', message: 'Send the saved draft and explicit environment selection with this remote worktree. Its creation must use the durable preparation.' };
}
