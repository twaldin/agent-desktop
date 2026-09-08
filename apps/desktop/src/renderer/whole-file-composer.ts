import { parseWholeFileAttachments, type Draft, type HostState, type WholeFileAttachment } from '@agent-desktop/shared';

export function appendWholeFile(draft: Draft, hostId: string, source: { hostId: string; path: string }): WholeFileAttachment[] {
  if (source.hostId !== hostId) throw new Error('Choose a conversation on this file’s host to attach it. Your draft is unchanged.');
  const existing = draft.wholeFileAttachments ?? [];
  if (existing.some(file => file.source.hostId === source.hostId && file.source.path === source.path)) return parseWholeFileAttachments(existing);
  return parseWholeFileAttachments([...existing, { id: crypto.randomUUID(), source: { kind: 'file', ...source } }]);
}
export function wholeFileSendIssue(draft: Draft, hostId: string, running: boolean, capability?: HostState['wholeFiles']): string | undefined {
  if (!draft.wholeFileAttachments?.length) return;
  if (capability?.commandVersion !== 7 || !capability.ordinaryPrompt) return 'Update the owning host before sending whole files. Your draft is preserved.';
  if (draft.wholeFileAttachments.some(file => file.source.hostId !== hostId)) return 'These files belong to another host. Remove them or use a conversation on their host.';
  if (draft.wholeFileAttachments.length > capability.maxFiles) return 'This draft exceeds the host’s file attachment limit. Remove a file before sending.';
  if (running) return 'Attached files can be sent when the current response finishes. Your draft is preserved.';
  if (draft.text.trimStart().startsWith('/') || draft.text.includes('/skill:')) return 'Files with native commands or skills are not connected yet. Send an ordinary prompt or remove the files.';
}
