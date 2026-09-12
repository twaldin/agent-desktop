import {
  NATIVE_QUEUED_MESSAGES_OWNER_HEADER,
  NATIVE_QUEUED_MESSAGES_PROTOCOL_VERSION,
  parseNativeQueuedMessageMutation,
  parseNativeQueuedMessagesSnapshot,
  type NativeQueuedMessageMutation,
  type NativeQueuedMessageMutationReceipt,
  type NativeQueuedMessagesResponse,
} from "../../../../packages/shared/src/queued-messages";
import { HostRequestError, type HostEndpoint } from "./host-transport";

async function request(endpoint: HostEndpoint, sessionId: string, mutation?: NativeQueuedMessageMutation): Promise<unknown> {
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error("Invalid queued-message owner.");
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/queued-messages`, {
    method: mutation ? "POST" : "GET",
    headers: { [NATIVE_QUEUED_MESSAGES_OWNER_HEADER]: endpoint.hostId,
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
      ...(mutation ? { "Content-Type": "application/json" } : {}) },
    ...(mutation ? { body: JSON.stringify(parseNativeQueuedMessageMutation(mutation)) } : {}),
    signal: AbortSignal.timeout(20_000), redirect: "error",
  });
  if (response.headers.get(NATIVE_QUEUED_MESSAGES_OWNER_HEADER) !== endpoint.hostId) {
    await response.body?.cancel(); throw new HostRequestError("Queued messages belong to a different host.", 409, "OWNER_MISMATCH");
  }
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error("Invalid queued-message response."); }
  if (!response.ok) {
    const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const detail = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
    throw new HostRequestError(typeof detail.message === "string" ? detail.message : `Queued-message operation failed (${response.status}).`,
      response.status, typeof detail.code === "string" ? detail.code : undefined);
  }
  const owner = value as Partial<NativeQueuedMessagesResponse>;
  if (owner.protocolVersion !== NATIVE_QUEUED_MESSAGES_PROTOCOL_VERSION || owner.hostId !== endpoint.hostId || owner.sessionId !== sessionId)
    throw new Error("Queued-message response changed owner or protocol.");
  return value;
}

export async function requestQueuedMessages(endpoint: HostEndpoint, sessionId: string): Promise<NativeQueuedMessagesResponse> {
  const value = await request(endpoint, sessionId) as NativeQueuedMessagesResponse;
  return { protocolVersion: NATIVE_QUEUED_MESSAGES_PROTOCOL_VERSION, hostId: value.hostId, sessionId: value.sessionId,
    ...parseNativeQueuedMessagesSnapshot(value) };
}

export async function mutateQueuedMessages(endpoint: HostEndpoint, sessionId: string,
  mutation: NativeQueuedMessageMutation): Promise<NativeQueuedMessageMutationReceipt> {
  const value = await request(endpoint, sessionId, mutation) as Record<string, unknown>;
  if (value.type !== "native-queued-messages" || value.mutation !== mutation.type
    || (value.messageId !== undefined && typeof value.messageId !== "string")) throw new Error("Invalid queued-message mutation receipt.");
  return { type: value.type, mutation: mutation.type,
    ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
    snapshot: parseNativeQueuedMessagesSnapshot(value.snapshot) };
}
