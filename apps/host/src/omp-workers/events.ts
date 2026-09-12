import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type { OmpBridgeEvent, OmpRuntimeEvent } from "../omp";
import type { NativeQueuedMessagesSnapshot } from "../../../../packages/shared/src/queued-messages";

export interface NativeEventMetadata {
  type: AgentSessionEvent["type"];
  message?: { role: string; errorMessage?: string };
  thinkingLevel?: string; configured?: string; resolved?: string;
  toolCallId?: string; toolName?: string;
  errorMessage?: string; finalError?: string;
  activityChanged?: boolean;
  isTerminal?: boolean; isError?: boolean; aborted?: boolean; willRetry?: boolean; success?: boolean;
  attempt?: number; maxAttempts?: number; delayMs?: number;
}
export type WorkerEvent = NativeEventMetadata | OmpBridgeEvent | { type: "queued_messages_changed"; snapshot: NativeQueuedMessagesSnapshot };
export type WorkerEventListener = (event: WorkerEvent) => void;
export const projectNativeErrorMessage = (value: string) => value.slice(0, 4096).replace(/data:image\/[^\s"']+/gi, "[image payload omitted]").replace(/[A-Za-z0-9+/]{256,}={0,2}/g, "[encoded payload omitted]");

/** Called on the native object BEFORE structuredClone, serialization or queue accounting. */
export function projectWorkerEvent(event: OmpRuntimeEvent): WorkerEvent {
  if (event.type === "queued_messages_changed") return { type: event.type, snapshot: structuredClone(event.snapshot) };
  if (event.type === "extension_interaction_requested" || event.type === "extension_interaction_resolved"
    || event.type === "extension_notification" || event.type === "extension_ui_unsupported") return event;
  const result: NativeEventMetadata = { type: event.type };
  if (["goal_updated", "agent_start", "agent_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) result.activityChanged = true;
  if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
    result.message = { role: event.message.role };
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.errorMessage) result.message.errorMessage = projectNativeErrorMessage(event.message.errorMessage);
  }
  if (event.type === "thinking_level_changed") {
    result.thinkingLevel = event.thinkingLevel; result.configured = event.configured; result.resolved = event.resolved;
  }
  if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
    result.toolCallId = event.toolCallId.slice(0, 200); result.toolName = event.toolName.slice(0, 200);
  }
  const fields = event as unknown as Record<string, unknown>;
  for (const key of ["isTerminal", "isError", "aborted", "willRetry", "success"] as const) {
    if (typeof fields[key] === "boolean") result[key] = fields[key];
  }
  for (const key of ["attempt", "maxAttempts", "delayMs"] as const) {
    if (typeof fields[key] === "number") result[key] = fields[key];
  }
  for (const key of ["errorMessage", "finalError"] as const) {
    if (typeof fields[key] === "string") result[key] = projectNativeErrorMessage(fields[key]);
  }
  return result;
}
