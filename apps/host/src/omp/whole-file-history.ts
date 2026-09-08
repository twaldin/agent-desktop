import { parseWholeFileAttachments, serializeWholeFilePrompt, type TranscriptMessage, type WholeFileAttachment } from "@agent-desktop/shared";
import { projectFileMentions } from "./file-mentions";
import { WHOLE_FILE_ATTEMPT_TYPE, WHOLE_FILE_BINDING_TYPE } from "./whole-file";

type Entry = { id: string; type: string; customType?: string; data?: unknown; message?: unknown };
type Binding = { submissionId: string; userEntryId: string; fileEntryIds: string[]; authoredText: string; attachments: WholeFileAttachment[] };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function boundedLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function binding(entry: Entry): Binding | undefined {
  if (entry.type !== "custom" || entry.customType !== WHOLE_FILE_BINDING_TYPE) return;
  const data = record(entry.data);
  if (!data || data.version !== 2 || !exactKeys(data, ["version", "submissionId", "userEntryId", "fileEntryIds", "authoredText", "attachments"])
    || !boundedLabel(data.submissionId) || !boundedLabel(data.userEntryId) || typeof data.authoredText !== "string"
    || data.authoredText.length > 500_000 || !Array.isArray(data.fileEntryIds) || data.fileEntryIds.length === 0
    || data.fileEntryIds.some(id => !boundedLabel(id)) || new Set(data.fileEntryIds).size !== data.fileEntryIds.length) return;
  try {
    const attachments = parseWholeFileAttachments(data.attachments, data.authoredText.length);
    if (!attachments.length || attachments.some(item => item.textOffset === undefined)) return;
    return { submissionId: data.submissionId, userEntryId: data.userEntryId, fileEntryIds: [...data.fileEntryIds] as string[], authoredText: data.authoredText, attachments };
  } catch { return; }
}
function exactAttempt(entry: Entry, submissionId: string): boolean {
  const data = record(entry.data);
  return entry.type === "custom" && entry.customType === WHOLE_FILE_ATTEMPT_TYPE && !!data && data.version === 1
    && data.submissionId === submissionId && exactKeys(data, ["version", "submissionId"]);
}
function userText(value: unknown): string | undefined {
  const message = record(value); if (message?.role !== "user") return;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content) || message.content[0]?.type !== "text" || typeof message.content[0].text !== "string"
    || message.content.slice(1).some(block => record(block)?.type === "text")) return;
  return message.content[0].text;
}

/**
 * Link inline whole-file provenance only through the flushed native v2 binding.
 * Legacy, malformed, ambiguous, and orphaned native file rows stay visible.
 */
export function projectWholeFiles(messages: TranscriptMessage[], branch: readonly Entry[]): TranscriptMessage[] {
  if (new Set(branch.map(entry => entry.id)).size !== branch.length) return messages;
  const displaysByNative = new Map<string, TranscriptMessage[]>();
  for (const message of messages) if (message.nativeId) displaysByNative.set(message.nativeId, [...(displaysByNative.get(message.nativeId) ?? []), message]);
  const uniqueDisplay = (id: string) => { const values = displaysByNative.get(id); return values?.length === 1 ? values[0] : undefined; };
  const order = new Map(branch.map((entry, index) => [entry.id, index]));
  const rawBindings = branch.filter(entry => entry.type === "custom" && entry.customType === WHOLE_FILE_BINDING_TYPE);
  const parsed = rawBindings.flatMap(entry => { const value = binding(entry); return value ? [{ entry, value }] : []; });
  const removed = new Set<string>();
  for (const { entry: bindingEntry, value } of parsed) {
    const loose = rawBindings.map(entry => ({ entry, data: record(entry.data) }));
    if (loose.filter(item => item.data?.submissionId === value.submissionId).length !== 1
      || loose.filter(item => item.data?.userEntryId === value.userEntryId).length !== 1
      || value.fileEntryIds.some(id => loose.filter(item => Array.isArray(item.data?.fileEntryIds) && item.data.fileEntryIds.includes(id)).length !== 1)) continue;
    const looseAttempts = branch.filter(item => item.type === "custom" && item.customType === WHOLE_FILE_ATTEMPT_TYPE
      && record(item.data)?.submissionId === value.submissionId);
    if (looseAttempts.length !== 1 || !exactAttempt(looseAttempts[0]!, value.submissionId)) continue;
    const userEntries = branch.filter(item => item.id === value.userEntryId), user = uniqueDisplay(value.userEntryId);
    let expectedText: string;
    try { expectedText = serializeWholeFilePrompt(value.authoredText, value.attachments); } catch { continue; }
    if (expectedText.length > 500_000) continue;
    const displayTextBlocks = user?.content?.filter(block => block.type === "text");
    if (userEntries.length !== 1 || userEntries[0]?.type !== "message" || userText(userEntries[0].message) !== expectedText
      || user?.role !== "user" || user.text !== expectedText || displayTextBlocks?.length !== 1 || displayTextBlocks[0]?.text !== expectedText) continue;
    const userEntry = userEntries[0];
    const fileEntries = value.fileEntryIds.map(id => { const matches = branch.filter(item => item.id === id); return matches.length === 1 ? matches[0] : undefined; });
    const visibleFiles = value.fileEntryIds.map(uniqueDisplay);
    if (fileEntries.some(item => item?.type !== "message") || visibleFiles.some(item => item?.role !== "fileMention")) continue;
    const referenceGroups = fileEntries.map(item => projectFileMentions(item!.message));
    if (referenceGroups.some(group => group === undefined)) continue;
    if (visibleFiles.some((visible, index) => !visible!.fileReferences || visible!.fileReferences!.length !== referenceGroups[index]!.length
      || visible!.fileReferences!.some((reference, fileIndex) => reference.path !== referenceGroups[index]![fileIndex]!.path))) continue;
    const references = referenceGroups.flatMap(group => group!);
    if (references.length !== value.attachments.length
      || references.some((reference, index) => reference.path !== value.attachments[index]!.source.path)) continue;
    const attemptOrder = order.get(looseAttempts[0]!.id), userOrder = order.get(userEntry.id), bindingOrder = order.get(bindingEntry.id);
    const fileOrders = value.fileEntryIds.map(id => order.get(id));
    if (attemptOrder === undefined || userOrder === undefined || bindingOrder === undefined || fileOrders.some(index => index === undefined)
      || !(attemptOrder < Math.min(...fileOrders as number[]) && Math.max(...fileOrders as number[]) < userOrder && userOrder < bindingOrder)) continue;
    user.wholeFiles = { bindingEntryId: bindingEntry.id, submissionId: value.submissionId, fileEntryIds: [...value.fileEntryIds],
      authoredText: value.authoredText, attachments: parseWholeFileAttachments(value.attachments, value.authoredText.length) };
    for (let index = 0; index < visibleFiles.length; index++) {
      const references = referenceGroups[index]!;
      if (references.every(reference => reference.skippedReason === undefined && reference.image?.error === undefined)) removed.add(visibleFiles[index]!.id);
    }
  }
  return messages.filter(message => !removed.has(message.id));
}
