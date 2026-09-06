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
