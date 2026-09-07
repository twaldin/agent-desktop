import { parseSelectedTextAttachments, type Draft, type FileTextSelection, type HostState, type SelectedTextAttachment } from "@agent-desktop/shared";

/** Capture the current buffer; source ownership is descriptive and may differ from the draft host. */
export function appendSelectedText(draft: Draft, source: { hostId: string; path: string }, selection: FileTextSelection): SelectedTextAttachment[] {
  return parseSelectedTextAttachments([...(draft.selectedTextAttachments ?? []), { id: crypto.randomUUID(), text: selection.text,
    source: { kind: "file", ...source, range: selection.range } }]);
}
export function selectedTextSendIssue(draft: Draft, running: boolean, capability?: HostState["selectedText"]): string | undefined {
  if (!draft.selectedTextAttachments?.length) return;
  if (capability?.commandVersion !== 6 || !capability.ordinaryPrompt) return "Update the owning host before sending selected text. Your selections are preserved.";
  if (JSON.stringify(draft.selectedTextAttachments).length > capability.maxSerializedChars) return "The selected excerpts exceed this host’s limit. Remove a selection group before sending.";
  if (running) return "Selected text can be sent when the current response finishes. Your draft is preserved.";
  if (draft.text.trimStart().startsWith("/") || draft.text.includes("/skill:")) return "Selected text with native commands or skills is not connected yet. Remove the selection group or send an ordinary prompt.";
}
