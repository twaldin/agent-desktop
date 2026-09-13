import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { parsePlanCommandId, parseSessionPlanResponse, parsePlanDocumentReadRequest, parsePlanDocumentResponse,
  SESSION_PLAN_OWNER_HEADER, type PlanDocumentResponse, type SessionPlanResponse } from "../../../../packages/shared/src/session-plan";
import { HostRequestError, type HostEndpoint } from "./host-transport";

const encoder = new TextEncoder();
function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || encoder.encode(value).byteLength > 200 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`Select the Plan request's owning ${label}.`);
  return value;
}

function errorDetail(value: unknown, status: number): HostRequestError {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const detail = object.error && typeof object.error === "object" && !Array.isArray(object.error) ? object.error as Record<string, unknown> : {};
  const message = typeof detail.message === "string" && detail.message.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(detail.message)
    ? detail.message : `Native Plan read failed (${status}).`;
  const code = typeof detail.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(detail.code) ? detail.code : undefined;
  return new HostRequestError(message, status, code);
}

/** Read only the original host/session owner. Endpoint fields are detached
 * before the first await so connection-cache mutation cannot retarget a read. */
export async function requestSessionPlan(endpoint: HostEndpoint, sessionValue: unknown, commandValue?: unknown): Promise<SessionPlanResponse> {
  const captured = { origin: endpoint.origin, hostId: identity(endpoint.hostId, "host"), token: endpoint.token };
  const sessionId = identity(sessionValue, "conversation");
  const commandId = commandValue === undefined ? undefined : parsePlanCommandId(commandValue);
  if (typeof captured.origin !== "string" || !captured.origin || /[\u0000-\u001f\u007f]/.test(captured.origin))
    throw new Error("The Plan request host endpoint is invalid.");
  const response = await fetch(`${captured.origin}/v1/sessions/${encodeURIComponent(sessionId)}/plan${commandId ? `?commandId=${encodeURIComponent(commandId)}` : ""}`, {
    headers: { [SESSION_PLAN_OWNER_HEADER]: captured.hostId,
      ...(captured.token ? { Authorization: `Bearer ${captured.token}` } : {}) },
    signal: AbortSignal.timeout(20_000), redirect: "error",
  });
  const value = await readPlanResponse(response, captured.hostId);
  return parseSessionPlanResponse(value, captured.hostId, sessionId, commandId);
}

async function readPlanResponse(response: Response, hostId: string): Promise<unknown> {
  if (response.headers.get(SESSION_PLAN_OWNER_HEADER) !== hostId) {
    await response.body?.cancel();
    throw new HostRequestError("The Plan state belongs to another host.", 409, "OWNER_MISMATCH");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing native Plan response.");
  let value: unknown;
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 12 * 1024 * 1024) throw new Error("Native Plan response exceeds 12 MiB.");
      chunks.push(part.value);
    }
    value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("Invalid or oversized native Plan response.");
  } finally { reader.releaseLock(); }
  if (!response.ok) throw errorDetail(value, response.status);
  return value;
}

export async function requestPlanDocumentSection(endpoint: HostEndpoint, raw: unknown): Promise<PlanDocumentResponse> {
  const request = parsePlanDocumentReadRequest(raw);
  const captured = { origin: endpoint.origin, hostId: identity(endpoint.hostId, "host"), token: endpoint.token };
  if (typeof captured.origin !== "string" || !captured.origin || /[\u0000-\u001f\u007f]/.test(captured.origin))
    throw new Error("The Plan document host endpoint is invalid.");
  const query = new URLSearchParams({ request: JSON.stringify(request) });
  const response = await fetch(`${captured.origin}/v1/sessions/${encodeURIComponent(request.sessionId)}/plan/section?${query}`, {
    headers: { [SESSION_PLAN_OWNER_HEADER]: captured.hostId, ...(captured.token ? { Authorization: `Bearer ${captured.token}` } : {}) },
    signal: AbortSignal.timeout(20_000), redirect: "error",
  });
  return parsePlanDocumentResponse(await readPlanResponse(response, captured.hostId), captured.hostId, request);
}

function sameEndpoint(endpoint: HostEndpoint, captured: HostEndpoint): boolean {
  return endpoint.hostId === captured.hostId && endpoint.origin === captured.origin && endpoint.token === captured.token;
}

export function registerPlanReadHandler(ipc: Pick<IpcMain, "handle">,
  assertTrusted: (event: IpcMainInvokeEvent) => void,
  endpointFor: (hostId: string) => Promise<HostEndpoint>): void {
  ipc.handle("host:plan-document-section", async (event, raw: unknown, hostValue: unknown) => {
    assertTrusted(event);
    const request = parsePlanDocumentReadRequest(raw), hostId = identity(hostValue, "host");
    const endpoint = await endpointFor(hostId);
    assertTrusted(event);
    if (endpoint.hostId !== hostId) throw new Error("The Plan document request host changed. Refresh its owning host.");
    const captured = { origin: endpoint.origin, hostId: endpoint.hostId, token: endpoint.token };
    const result = await requestPlanDocumentSection(captured, request);
    assertTrusted(event);
    if (!sameEndpoint(endpoint, captured)) throw new Error("The Plan document endpoint changed during inspection.");
    return result;
  });
  ipc.handle("host:plan-read", async (event, sessionValue: unknown, hostValue: unknown, commandValue?: unknown) => {
    assertTrusted(event);
    const sessionId = identity(sessionValue, "conversation"), hostId = identity(hostValue, "host");
    const commandId = commandValue === undefined ? undefined : parsePlanCommandId(commandValue);
    const endpoint = await endpointFor(hostId);
    assertTrusted(event);
    if (endpoint.hostId !== hostId) throw new Error("The Plan request host changed. Reconnect before refreshing it.");
    const captured = { origin: endpoint.origin, hostId: endpoint.hostId, token: endpoint.token };
    const result = await requestSessionPlan(captured, sessionId, commandId);
    assertTrusted(event);
    if (!sameEndpoint(endpoint, captured)) throw new Error("The Plan request endpoint changed. Refresh from its owning host.");
    return result;
  });
}
