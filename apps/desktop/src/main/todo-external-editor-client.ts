import {
  parseTodoExternalEditorCapabilities,
  parseTodoExternalEditorCursor,
  parseTodoExternalEditorList,
  parseTodoExternalEditorObservation,
  parseTodoExternalEditorRecovery,
  parseTodoExternalEditorRequest,
  type TodoExternalEditorCapabilities,
  type TodoExternalEditorList,
  type TodoExternalEditorObservation,
  type TodoExternalEditorRecovery,
  type TodoExternalEditorRequest,
} from "../../../../packages/shared/src/todo-external-editor";
import { MAX_TODO_BYTES, SESSION_TODOS_OWNER_HEADER } from "../../../../packages/shared/src/session-todos";
import { HostRequestError, type HostEndpoint } from "./host-transport";

const encoder = new TextEncoder();
// JSON can escape one source byte as six ASCII bytes. The response may also
// include a native Todo state receipt alongside the recovered Markdown.
const RESPONSE_LIMIT = 32 * 1024 * 1024;

function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || encoder.encode(value).byteLength > 200 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`Select the Todo editor request's owning ${label}.`);
  return value;
}

function capture(endpoint: HostEndpoint): HostEndpoint {
  const origin = endpoint.origin, hostId = identity(endpoint.hostId, "host"), token = endpoint.token;
  if (typeof origin !== "string" || !origin || /[\u0000-\u001f\u007f]/.test(origin)) throw new Error("The Todo editor host endpoint is invalid.");
  return { origin, hostId, token };
}

function errorDetail(value: unknown, status: number): HostRequestError {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const detail = object.error && typeof object.error === "object" && !Array.isArray(object.error) ? object.error as Record<string, unknown> : {};
  const message = typeof detail.message === "string" && detail.message.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(detail.message)
    ? detail.message : `Native Todo editor request failed (${status}).`;
  const code = typeof detail.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(detail.code) ? detail.code : undefined;
  return new HostRequestError(message, status, code);
}

async function readResponse(response: Response, hostId: string): Promise<unknown> {
  if (response.headers.get(SESSION_TODOS_OWNER_HEADER) !== hostId) {
    await response.body?.cancel();
    throw new HostRequestError("The Todo editor response belongs to another host.", 409, "OWNER_MISMATCH");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing native Todo editor response.");
  let value: unknown;
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > RESPONSE_LIMIT) throw new Error("Native Todo editor response exceeds its escaping-aware bound.");
      chunks.push(part.value);
    }
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("Invalid or oversized native Todo editor response.");
  } finally { reader.releaseLock(); }
  if (!response.ok) throw errorDetail(value, response.status);
  return value;
}

async function request(endpoint: HostEndpoint, sessionId: string, action: "capabilities" | "list" | "start" | "status" | "cancel" | "recovery",
  input?: TodoExternalEditorRequest, cursor?: string): Promise<unknown> {
  const captured = capture(endpoint);
  const suffix = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  const response = await fetch(`${captured.origin}/v1/sessions/${encodeURIComponent(sessionId)}/todos/editor/${action}${suffix}`, {
    method: input ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { [SESSION_TODOS_OWNER_HEADER]: captured.hostId, ...(input ? { "Content-Type": "application/json" } : {}),
      ...(captured.token ? { Authorization: `Bearer ${captured.token}` } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  return readResponse(response, captured.hostId);
}

export async function requestTodoExternalEditorCapabilities(endpoint: HostEndpoint, sessionValue: unknown): Promise<TodoExternalEditorCapabilities> {
  const sessionId = identity(sessionValue, "conversation"), captured = capture(endpoint);
  return parseTodoExternalEditorCapabilities(await request(captured, sessionId, "capabilities"), captured.hostId);
}

export async function requestTodoExternalEditorList(endpoint: HostEndpoint, sessionValue: unknown, cursorValue?: unknown): Promise<TodoExternalEditorList> {
  const sessionId = identity(sessionValue, "conversation"), cursor = cursorValue === undefined ? undefined : parseTodoExternalEditorCursor(cursorValue);
  const captured = capture(endpoint);
  return parseTodoExternalEditorList(await request(captured, sessionId, "list", undefined, cursor), captured.hostId, sessionId);
}

async function operation(endpoint: HostEndpoint, raw: unknown, action: "start" | "status" | "cancel"): Promise<TodoExternalEditorObservation> {
  const input = parseTodoExternalEditorRequest(raw), captured = capture(endpoint);
  return parseTodoExternalEditorObservation(await request(captured, input.sessionId, action, input), captured.hostId, input);
}

export function startTodoExternalEditor(endpoint: HostEndpoint, raw: unknown): Promise<TodoExternalEditorObservation> {
  return operation(endpoint, raw, "start");
}
export function requestTodoExternalEditorStatus(endpoint: HostEndpoint, raw: unknown): Promise<TodoExternalEditorObservation> {
  return operation(endpoint, raw, "status");
}
export function cancelTodoExternalEditor(endpoint: HostEndpoint, raw: unknown): Promise<TodoExternalEditorObservation> {
  return operation(endpoint, raw, "cancel");
}
export async function recoverTodoExternalEditor(endpoint: HostEndpoint, raw: unknown): Promise<TodoExternalEditorRecovery> {
  const input = parseTodoExternalEditorRequest(raw), captured = capture(endpoint);
  return parseTodoExternalEditorRecovery(await request(captured, input.sessionId, "recovery", input), captured.hostId, input);
}
