import { parseWholeFileAttachments, parseInlineWholeFileMentions, hasRepeatedWholeFileSources, type Draft, type HostState, type WholeFileAttachment } from '@agent-desktop/shared';
import { parseStandaloneFilePath } from '@agent-desktop/shared';
import { resolveTranscriptFileReference } from './TranscriptFileReference';

export function wholeFileOpenTarget(source:WholeFileAttachment['source'],hostId:string,cwd?:string){
  if(source.hostId!==hostId)throw new Error('This file belongs to another host. Open its owning conversation to view it.');
  const absolutePath=parseStandaloneFilePath(source.path);
  const target=resolveTranscriptFileReference(absolutePath,cwd === "/" || cwd === "~" ? undefined : cwd);
  return 'error' in target ? {absolutePath} : target.file;
}

export function appendWholeFile(draft: Draft, hostId: string, source: { hostId: string; path: string }, inline?:{textOffset:number;allowRepeated?:boolean}): WholeFileAttachment[] {
  if (source.hostId !== hostId) throw new Error('Choose a conversation on this file’s host to attach it. Your draft is unchanged.');
  const existing = draft.wholeFileAttachments ?? [];
  if (!inline?.allowRepeated && existing.some(file => file.source.hostId === source.hostId && file.source.path === source.path)) return parseWholeFileAttachments(existing);
  const files=[...existing, { id: crypto.randomUUID(), source: { kind: 'file' as const, ...source },...(inline?{textOffset:inline.textOffset}:{}) }];
  return inline?.allowRepeated?parseInlineWholeFileMentions(files.map(file=>({...file,textOffset:file.textOffset??0})),draft.text.length):parseWholeFileAttachments(files,draft.text.length);
}
export function wholeFileSendIssue(draft: Draft, hostId: string, running: boolean, capability?: HostState['wholeFiles']): string | undefined {
  if (!draft.wholeFileAttachments?.length) return;
  if (capability?.commandVersion !== 7 || !capability.ordinaryPrompt) return 'Update the owning host before sending whole files. Your draft is preserved.';
  if (draft.wholeFileAttachments.some(file=>file.textOffset!==undefined) && capability.inlineMentions?.commandVersion!==8) return 'Update the owning host to retain inline file positions. Your draft is preserved.';
  if (hasRepeatedWholeFileSources(draft.wholeFileAttachments)&&capability.inlineMentions?.repeatedSources?.commandVersion!==9) return 'Update the owning host before sending repeated file mentions. Your draft is preserved.';
  if (draft.wholeFileAttachments.some(file => file.source.hostId !== hostId)) return 'These files belong to another host. Remove them or use a conversation on their host.';
  if (draft.wholeFileAttachments.length > capability.maxFiles) return 'This draft exceeds the host’s file attachment limit. Remove a file before sending.';
  if (running) return 'Attached files can be sent when the current response finishes. Your draft is preserved.';
  if (draft.text.trimStart().startsWith('/') || draft.text.includes('/skill:')) return 'Files with native commands or skills are not connected yet. Send an ordinary prompt or remove the files.';
}
