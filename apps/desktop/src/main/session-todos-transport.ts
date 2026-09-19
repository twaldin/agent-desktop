import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { parseTodoCommandId, parseSessionTodosResponse, SESSION_TODOS_OWNER_HEADER, type SessionTodosResponse } from "../../../../packages/shared/src/session-todos";
import { HostRequestError, type HostEndpoint } from "./host-transport";

/** The host bounds its own reply at 16 MiB; a larger body is refused unread. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || encoder.encode(value).byteLength > 200 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`Select the Todos request's owning ${label}.`);
  return value;
}

function errorDetail(value: unknown, status: number): HostRequestError {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const detail = object.error && typeof object.error === "object" && !Array.isArray(object.error) ? object.error as Record<string, unknown> : {};
  const message = typeof detail.message === "string" && detail.message.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(detail.message)
    ? detail.message : `Native Todos read failed (${status}).`;
  const code = typeof detail.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(detail.code) ? detail.code : undefined;
  return new HostRequestError(message, status, code);
}

/** Read only the original host/session owner. Endpoint fields are detached
 * before the first await so connection-cache mutation cannot retarget a read. */
export async function requestSessionTodos(endpoint: HostEndpoint, sessionValue: unknown, commandValue?: unknown): Promise<SessionTodosResponse> {
  const captured = { origin: endpoint.origin, hostId: identity(endpoint.hostId, "host"), token: endpoint.token };
  const sessionId = identity(sessionValue, "conversation");
  const commandId = commandValue === undefined ? undefined : parseTodoCommandId(commandValue);
  if (typeof captured.origin !== "string" || !captured.origin || /[\u0000-\u001f\u007f]/.test(captured.origin))
    throw new Error("The Todos request host endpoint is invalid.");
  const response = await fetch(`${captured.origin}/v1/sessions/${encodeURIComponent(sessionId)}/todos${commandId ? `?commandId=${encodeURIComponent(commandId)}` : ""}`, {
    headers: { [SESSION_TODOS_OWNER_HEADER]: captured.hostId,
      ...(captured.token ? { Authorization: `Bearer ${captured.token}` } : {}) },
    signal: AbortSignal.timeout(20_000), redirect: "error",
  });
  const value = await readTodosResponse(response, captured.hostId);
  return parseSessionTodosResponse(value, captured.hostId, sessionId, commandId);
}

async function readTodosResponse(response: Response, hostId: string): Promise<unknown> {
  if (response.headers.get(SESSION_TODOS_OWNER_HEADER) !== hostId) {
    await response.body?.cancel();
    throw new HostRequestError("The Todos state belongs to another host.", 409, "OWNER_MISMATCH");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing native Todos response.");
  let value: unknown;
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Native Todos response exceeds 16 MiB.");
      chunks.push(part.value);
    }
    value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("Invalid or oversized native Todos response.");
  } finally { reader.releaseLock(); }
  if (!response.ok) throw errorDetail(value, response.status);
  return value;
}

export function registerSessionTodosReadHandler(ipc: Pick<IpcMain, "handle">,
  assertTrusted: (event: IpcMainInvokeEvent) => void,
  endpointFor: (hostId: string) => Promise<HostEndpoint>): void {
  ipc.handle("host:session-todos-read", async (event, sessionValue: unknown, hostValue: unknown, commandValue?: unknown) => {
    assertTrusted(event);
    const sessionId = identity(sessionValue, "conversation"), hostId = identity(hostValue, "host");
    const commandId = commandValue === undefined ? undefined : parseTodoCommandId(commandValue);
    const endpoint = await endpointFor(hostId);
    assertTrusted(event);
    if (endpoint.hostId !== hostId) throw new Error("The Todos request host changed. Reconnect before refreshing it.");
    const captured = { origin: endpoint.origin, hostId: endpoint.hostId, token: endpoint.token };
    const result = await requestSessionTodos(captured, sessionId, commandId);
    assertTrusted(event);
    if (endpoint.hostId !== captured.hostId || endpoint.origin !== captured.origin || endpoint.token !== captured.token)
      throw new Error("The Todos request endpoint changed. Refresh from its owning host.");
    return result;
  });
}
