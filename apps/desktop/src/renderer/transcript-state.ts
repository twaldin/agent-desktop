import type { TranscriptBlock, TranscriptMessage } from "../../../../packages/shared/src/protocol";

/** Old-host compatibility is explicit; new projections always supply ordered content. */
export function messageBlocks(message: TranscriptMessage): TranscriptBlock[] {
  if (message.content) return message.content;
  if (!message.blocks?.length) return message.text ? [{ type: "text", text: message.text }] : [];
  return message.blocks.map(value => {
    const block = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
    if (block?.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (block?.type === "thinking" && typeof block.thinking === "string") return { type: "thinking", thinking: block.thinking };
    if (block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") return { type: "toolCall", id: block.id, name: block.name, arguments: typeof block.arguments === "object" && block.arguments !== null && !Array.isArray(block.arguments) ? block.arguments as Record<string, unknown> : {}, ...(typeof block.intent === "string" ? { intent: block.intent } : {}) };
    return { type: "unsupported", nativeType: typeof block?.type === "string" ? block.type : "unknown" };
  });
}
export interface ToolLink { key: string; messageId: string; call: Extract<TranscriptBlock, { type: "toolCall" }>; result?: TranscriptMessage }
export function toolLinks(messages: TranscriptMessage[]) {
  const calls = new Map<string, ToolLink>(), results = new Map<string, ToolLink>(), awaiting = new Map<string, ToolLink[]>();
  for (const message of messages) {
    messageBlocks(message).forEach((block, index) => { if (block.type !== "toolCall") return; const link: ToolLink = { key: `${message.id}:block:${index}`, messageId: message.id, call: block }; calls.set(link.key, link); awaiting.set(block.id, [...awaiting.get(block.id) ?? [], link]); });
    if (message.role !== "toolResult" || !message.tool) continue;
    const candidates = awaiting.get(message.tool.callId) ?? [];
    // Reused IDs are legal across completed turns; two unresolved calls are ambiguous.
    if (candidates.length !== 1) continue;
    const link = candidates[0]!; link.result = message; results.set(message.id, link); awaiting.delete(message.tool.callId);
  }
  return { calls, results };
}
export function toolOutcome(message?: TranscriptMessage, connected = true) {
  if (!message?.tool) return { label: "Outcome unavailable", tone: "unknown" } as const;
  if (message.tool.isError === true) return { label: "Failed", tone: "error" } as const;
  if (message.tool.status === "running") return { label: connected ? "Running" : "Last observed running", tone: connected ? "running" : "unknown" } as const;
  if (message.tool.status === "completed" || message.lifecycle === "complete") return { label: message.tool.isError === false ? "Completed" : "Finished · outcome unavailable", tone: "complete" } as const;
  return { label: "Outcome unavailable", tone: "unknown" } as const;
}
/** Survives message unmounts during reconnect; never persists transcript content or answers. */
export class TranscriptDisclosureState {
  private choices = new Map<string, boolean>();
  get(key: string, running = false) { return this.choices.get(key) ?? running; }
  set(key: string, value: boolean) { this.choices.set(key, value); }
}
