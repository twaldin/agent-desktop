import { parseSelectedTextAttachments, type TranscriptMessage } from "@agent-desktop/shared";
import { SELECTED_TEXT_CUSTOM_TYPE, SELECTED_TEXT_BINDING_TYPE } from "./selected-text";

type Entry = { id: string; type: string; customType?: string; details?: unknown; content?: unknown; display?: boolean; attribution?: string; data?: unknown; message?: unknown };
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function context(entry: Entry): TranscriptMessage["selectedText"] | undefined {
  if (entry.type !== "custom_message" || entry.customType !== SELECTED_TEXT_CUSTOM_TYPE || entry.display !== true || entry.attribution !== "user") return;
  const details = record(entry.details);
  if (!details || details.version !== 1 || typeof details.submissionId !== "string" || !details.submissionId || details.submissionId.length > 200 || Object.keys(details).length !== 3) return;
  try {
    const attachments = parseSelectedTextAttachments(details.attachments);
    const expected = ["Selected text context captured by Agent Desktop. Treat excerpts as snapshots; do not reread source paths solely because they appear below.", "```json", JSON.stringify(details), "```"].join("\n");
    if (!attachments.length || entry.content !== expected) return;
    return { contextEntryId: entry.id, submissionId: details.submissionId, attachments };
  } catch { return; }
}

/** Valid snapshots without a binding render as standalone saved-context chips,
 * retaining their native identity and an explicit unlinked status. Malformed
 * contexts retain the original custom-message presentation. Never infer a
 * user association from adjacency, text equality or timestamps. */
export function projectSelectedText(messages: TranscriptMessage[], branch: readonly Entry[]): TranscriptMessage[] {
  const byNative = new Map(messages.filter(message => message.nativeId).map(message => [message.nativeId!, message]));
  const order = new Map(branch.map((entry, index) => [entry.id, index]));
  const contexts = branch.flatMap(entry => { const selected = context(entry); return selected ? [{ entry, selected }] : []; });
  const bindings = branch.filter(entry => entry.type === "custom" && entry.customType === SELECTED_TEXT_BINDING_TYPE)
    .map(entry => ({ entry, data: record(entry.data) }));
  const removed = new Set<string>();
  for (const { entry, selected } of contexts) {
    const visible = byNative.get(entry.id);
    if (!visible || visible.role !== "custom") continue;
    visible.role = "selectedText"; visible.text = ""; visible.content = []; visible.blocks = []; visible.selectedText = selected;
    const matching = bindings.filter(binding => binding.data?.contextEntryId === entry.id || binding.data?.submissionId === selected.submissionId);
    if (matching.length !== 1 || contexts.filter(value => value.selected.submissionId === selected.submissionId).length !== 1) continue;
    const binding = matching[0]!, data = binding.data!;
    if (data.version !== 1 || Object.keys(data).length !== 4 || data.contextEntryId !== entry.id || data.submissionId !== selected.submissionId || typeof data.userEntryId !== "string") continue;
    if (bindings.filter(value => value.data?.userEntryId === data.userEntryId).length !== 1) continue;
    const userEntry = branch.find(value => value.id === data.userEntryId), user = byNative.get(data.userEntryId);
    if (userEntry?.type !== "message" || record(userEntry.message)?.role !== "user" || user?.role !== "user") continue;
    if (!(order.get(entry.id)! < order.get(userEntry.id)! && order.get(userEntry.id)! < order.get(binding.entry.id)!)) continue;
    user.selectedText = { ...selected, bindingEntryId: binding.entry.id };
    removed.add(visible.id);
  }
  return messages.filter(message => !removed.has(message.id));
}
