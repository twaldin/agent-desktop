import { createHash } from "node:crypto";
import { projectFileMentions } from "./file-mentions";
import type { TranscriptAssistantMetadata, TranscriptBlock, TranscriptMessage } from "@agent-desktop/shared";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { readNativeImage } from "./images";

type MessageRecord = Record<string, unknown> & { role: string };
export interface NativeTranscriptEntry { id: string; message: unknown }
interface Pending { key: string; occurrence: number; message: MessageRecord; complete: boolean; order: number; fileReferences?: TranscriptMessage["fileReferences"] }
interface ToolProgress { message: MessageRecord; status: "running" | "completed"; occurrence: number; order: number }
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function messageRecord(value: unknown): MessageRecord | undefined { const object = record(value); return object && typeof object.role === "string" ? object as MessageRecord : undefined; }
function hidden(message: MessageRecord): boolean { return message.role === 'custom' && message.display === false; }
function messageKey(message: MessageRecord): string {
  // Tool start/update/result timestamps differ. The native call ID is their identity.
  if (message.role === "toolResult" && typeof message.toolCallId === "string") return JSON.stringify([message.role, message.toolCallId]);
  // Text is deliberately excluded: native display can copy/deobfuscate it, and streams grow.
  return JSON.stringify([message.role, message.timestamp, message.customType]);
}
function displayId(key: string, occurrence = 0) { return `message-${createHash("sha256").update(key).digest("hex").slice(0, 24)}-${occurrence}`; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function numeric(source: Record<string, unknown>, names: string[]) { return Object.fromEntries(names.filter(name => finite(source[name])).map(name => [name, source[name] as number])); }
function content(message: MessageRecord): TranscriptBlock[] {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  if (!Array.isArray(message.content)) return typeof message.output === "string" ? [{ type: "text", text: message.output }] : [];
  return message.content.map((value, blockIndex): TranscriptBlock => {
    const block = record(value);
    if (block?.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (block?.type === "thinking" && typeof block.thinking === "string") return { type: "thinking", thinking: block.thinking };
    if (block?.type === "image") {
      let metadata: { bytes?: number; sha256?: string } = {};
      try { const image = readNativeImage(block); metadata = { bytes: image.bytes, sha256: image.sha256 }; }
      catch { if (typeof block.sha256 === "string" && /^[a-f0-9]{64}$/.test(block.sha256) && finite(block.bytes)) metadata = { bytes: block.bytes, sha256: block.sha256 }; }
      return { type: "image", nativeType: "image", blockIndex, mimeType: typeof block.mimeType === "string" ? block.mimeType.slice(0, 100) : "application/octet-stream", ...metadata };
    }
    if (block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") return { type: "toolCall", id: block.id, name: block.name, arguments: structuredClone(record(block.arguments) ?? {}), ...(typeof block.intent === "string" ? { intent: block.intent } : {}) };
    // Replay signatures, uploaded-provider references and opaque server payloads stay native.
    return { type: "unsupported", nativeType: typeof block?.type === "string" ? block.type : "unknown", ...(typeof block?.mimeType === "string" ? { mimeType: block.mimeType } : {}) };
  });
}
function pendingMessage(message: MessageRecord): MessageRecord {
  // Never clone retained provider payloads or image bytes merely to render a
  // pending row. Actual native objects stay in the SDK for admission/storage.
  const value: MessageRecord = { role: message.role, content: content(message) };
  for (const key of ["timestamp", "customType", "toolCallId", "toolName", "isError", "provider", "model", "upstreamProvider", "upstreamModel", "errorMessage", "stopReason", "duration", "completedAt"]) {
    if (["string", "number", "boolean"].includes(typeof message[key])) value[key] = message[key];
  }
  if (message.role === "assistant") value.usage = assistant(message).usage;
  return value;
}
function assistant(message: MessageRecord): TranscriptAssistantMetadata {
  const value: TranscriptAssistantMetadata = {};
  for (const name of ["provider", "model", "upstreamProvider", "upstreamModel", "errorMessage"] as const) if (typeof message[name] === "string") value[name] = message[name];
  if (["stop", "length", "toolUse", "error", "aborted"].includes(String(message.stopReason))) value.stopReason = message.stopReason as TranscriptAssistantMetadata["stopReason"];
  if (finite(message.duration)) value.durationMs = message.duration;
  if (finite(message.completedAt)) value.completedAt = message.completedAt;
  const usage = record(message.usage); if (usage) { value.usage = numeric(usage, ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]); const cost = record(usage.cost); if (cost) value.usage.cost = numeric(cost, ["input", "output", "cacheRead", "cacheWrite", "total"]); }
  return value;
}
function project(message: MessageRecord, id: string, nativeId?: string, lifecycle?: TranscriptMessage["lifecycle"], progress?: ToolProgress, fileReferences?: TranscriptMessage["fileReferences"]): TranscriptMessage {
  const blocks = content(message);
  const value: TranscriptMessage = { id, role: message.role, text: blocks.filter(block => block.type === "text").map(block => block.text).join("\n"), content: blocks, blocks, ...(nativeId ? { nativeId } : {}), ...(lifecycle ? { lifecycle } : {}), ...(finite(message.timestamp) ? { timestamp: message.timestamp } : {}) };
  if (message.role === "fileMention") value.fileReferences = fileReferences ?? projectFileMentions(message);
  if (message.role === "assistant") value.assistant = assistant(message);
  if (message.role === "toolResult" && typeof message.toolCallId === "string") {
    value.tool = { callId: message.toolCallId, ...(typeof message.toolName === "string" ? { name: message.toolName } : {}), ...(typeof message.isError === "boolean" ? { isError: message.isError } : typeof progress?.message.isError === "boolean" ? { isError: progress.message.isError } : {}), ...(lifecycle === "complete" ? { status: "completed" } : progress ? { status: progress.status } : {}) };
    if (record(progress?.message.arguments)) value.tool.arguments = structuredClone(progress!.message.arguments as Record<string, unknown>);
    if (typeof progress?.message.intent === "string") value.tool.intent = progress.message.intent;
  }
  return value;
}

/** Actual native messages/events, with content-independent identities and allowlisted display metadata. */
export class TranscriptMirror {
  #pending = new Map<string, Pending>();
  #active = new Map<string, Pending>();
  #occurrences = new Map<string, number>();
  #tools = new Map<string, ToolProgress>();
  #order = 0;
  accept(event: AgentSessionEvent): void {
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
      const message = messageRecord(event.message); if (!message || hidden(message)) return;
      const key = messageKey(message);
      let pending = this.#active.get(key);
      if (event.type === "message_start" || !pending) {
        const tool = message.role === "toolResult" ? this.#tools.get(String(message.toolCallId)) : undefined;
        const occurrence = tool?.occurrence ?? this.#occurrences.get(key) ?? 0;
        this.#occurrences.set(key, occurrence + 1);
        pending = { key, occurrence, message, complete: false, order: this.#tools.get(String(message.toolCallId))?.order ?? this.#order++ };
        this.#active.set(key, pending);
      }
      pending.fileReferences = message.role === "fileMention" ? projectFileMentions(message) : undefined;
      pending.message = pendingMessage(message); pending.complete = event.type === "message_end";
      this.#pending.set(displayId(key, pending.occurrence), pending);
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const previous = event.type === "tool_execution_start" ? undefined : this.#tools.get(event.toolCallId);
      const result = record(event.type === "tool_execution_update" ? event.partialResult : event.type === "tool_execution_end" ? event.result : undefined);
      const key = messageKey({ role: "toolResult", toolCallId: event.toolCallId });
      const occurrence = previous?.occurrence ?? this.#occurrences.get(key) ?? 0;
      this.#occurrences.set(key, Math.max(this.#occurrences.get(key) ?? 0, occurrence + 1));
      this.#tools.set(event.toolCallId, { occurrence, order: previous?.order ?? this.#order++, status: event.type === "tool_execution_end" ? "completed" : "running", message: { ...previous?.message, role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName, ...(event.type !== "tool_execution_end" && record(event.args) ? { arguments: structuredClone(event.args) } : {}), ...(event.type === "tool_execution_start" && event.intent ? { intent: event.intent } : {}), content: Array.isArray(result?.content) ? content({ role: "toolResult", content: result.content }) : previous?.message.content ?? [], ...(event.type === "tool_execution_end" && typeof event.isError === "boolean" ? { isError: event.isError } : {}) } });
    }
  }
  snapshot(displayMessages: readonly unknown[], entries: readonly NativeTranscriptEntry[]): TranscriptMessage[] {
    const nativeIds = new Map<string, string[]>();
    for (const entry of entries) { const message = messageRecord(entry.message); if (!message) continue; const key = messageKey(message), ids = nativeIds.get(key) ?? []; ids.push(entry.id); nativeIds.set(key, ids); this.#occurrences.set(key, Math.max(this.#occurrences.get(key) ?? 0, ids.length)); }
    const counts = new Map<string, number>(), displayed = new Set<string>(); const result: TranscriptMessage[] = [];
    for (const value of displayMessages) {
      const message = messageRecord(value); if (!message || hidden(message)) continue;
      const key = messageKey(message), occurrence = counts.get(key) ?? 0; counts.set(key, occurrence + 1);
      const id = displayId(key, occurrence), nativeId = nativeIds.get(key)?.[occurrence], pending = this.#pending.get(id), progress = this.#tools.get(String(message.toolCallId));
      const tool = progress?.occurrence === occurrence ? progress : undefined;
      const lifecycle = nativeId || pending?.complete ? "complete" : pending ? "streaming" : undefined;
      result.push(project(message, id, nativeId, lifecycle, tool)); displayed.add(id);
      if (nativeId) {
        this.#pending.delete(id);
        if (pending?.complete && this.#active.get(key) === pending) this.#active.delete(key);
        if (tool) this.#tools.delete(String(message.toolCallId));
      }
    }
    const rest = [...this.#pending].filter(([id]) => !displayed.has(id)).map(([id, pending]) => ({ order: pending.order, message: project(pending.message, id, undefined, pending.complete ? "complete" : "streaming", this.#tools.get(String(pending.message.toolCallId)), pending.fileReferences) }));
    for (const [callId, tool] of this.#tools) {
      const id = displayId(messageKey(tool.message), tool.occurrence); if (displayed.has(id) || rest.some(item => item.message.id === id)) continue;
      rest.push({ order: tool.order, message: project(tool.message, id, undefined, tool.status === "completed" ? "complete" : undefined, tool) });
    }
    result.push(...rest.sort((a, b) => a.order - b.order).map(item => item.message));
    return result;
  }
}

/** Only persisted completion entries establish achievement. Attach to the last
 * native assistant in that branch, never to a later turn or a pending row. */
export function projectGoalCompletions(messages: TranscriptMessage[], branch: readonly { id: string; type: string; customType?: string; data?: unknown; message?: unknown }[]): void {
  const visible = new Map(messages.filter(message => message.nativeId).map(message => [message.nativeId!, message]));
  let precedingAssistant: string | undefined;
  for (const entry of branch) {
    if (entry.type === 'message') {
      const message = messageRecord(entry.message);
      if (message?.role === 'assistant') precedingAssistant = entry.id;
      // A fresh human turn cannot inherit an earlier turn's completion badge.
      else if (message?.role === 'user') precedingAssistant = undefined;
    }
    if (entry.type !== 'custom' || entry.customType !== 'goal-completed' || !precedingAssistant) continue;
    const target = visible.get(precedingAssistant), data = record(entry.data);
    if (!target || target.role !== 'assistant' || !data || typeof data.objective !== 'string' || data.objective.length > 16384
      || !Number.isSafeInteger(data.tokensUsed) || (data.tokensUsed as number) < 0
      || !Number.isSafeInteger(data.timeUsedSeconds) || (data.timeUsedSeconds as number) < 0
      || data.tokenBudget !== undefined && (!Number.isSafeInteger(data.tokenBudget) || (data.tokenBudget as number) <= 0)) continue;
    target.goalCompletion = { entryId: entry.id, objective: data.objective, tokensUsed: data.tokensUsed as number,
      timeUsedSeconds: data.timeUsedSeconds as number, ...(data.tokenBudget === undefined ? {} : { tokenBudget: data.tokenBudget as number }) };
  }
}
