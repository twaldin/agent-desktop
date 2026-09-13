import {
  parsePlanExternalEditorCapabilities,
  parsePlanExternalEditorCursor,
  parsePlanExternalEditorList,
  parsePlanExternalEditorObservation,
  parsePlanExternalEditorRecovery,
  parsePlanExternalEditorRequest,
  type PlanExternalEditorCapabilities,
  type PlanExternalEditorList,
  type PlanExternalEditorObservation,
  type PlanExternalEditorRecovery,
  type PlanExternalEditorRequest,
} from "../../../../packages/shared/src/plan-external-editor";
import { MAX_PLAN_ANNOTATION_BYTES } from "../../../../packages/shared/src/plan-document";
import { MAX_PLAN_CONTENT_BYTES, SESSION_PLAN_OWNER_HEADER } from "../../../../packages/shared/src/session-plan";
import { HostRequestError, type HostEndpoint } from "./host-transport";

const encoder = new TextEncoder();
// JSON can escape one source byte as six ASCII bytes. The response may also
// repeat the bounded annotation request alongside the recovered Plan content.
const RESPONSE_LIMIT = MAX_PLAN_CONTENT_BYTES * 6 + MAX_PLAN_ANNOTATION_BYTES * 6 + 4 * 1024 * 1024;

function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || encoder.encode(value).byteLength > 200 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`Select the Plan editor request's owning ${label}.`);
  return value;
}

function capture(endpoint: HostEndpoint): HostEndpoint {
  const origin = endpoint.origin, hostId = identity(endpoint.hostId, "host"), token = endpoint.token;
  if (typeof origin !== "string" || !origin || /[\u0000-\u001f\u007f]/.test(origin)) throw new Error("The Plan editor host endpoint is invalid.");
  return { origin, hostId, token };
}

function errorDetail(value: unknown, status: number): HostRequestError {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const detail = object.error && typeof object.error === "object" && !Array.isArray(object.error) ? object.error as Record<string, unknown> : {};
  const message = typeof detail.message === "string" && detail.message.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(detail.message)
    ? detail.message : `Native Plan editor request failed (${status}).`;
  const code = typeof detail.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(detail.code) ? detail.code : undefined;
  return new HostRequestError(message, status, code);
}

async function readResponse(response: Response, hostId: string): Promise<unknown> {
  if (response.headers.get(SESSION_PLAN_OWNER_HEADER) !== hostId) {
    await response.body?.cancel();
    throw new HostRequestError("The Plan editor response belongs to another host.", 409, "OWNER_MISMATCH");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing native Plan editor response.");
  let value: unknown;
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > RESPONSE_LIMIT) throw new Error("Native Plan editor response exceeds its escaping-aware bound.");
      chunks.push(part.value);
    }
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("Invalid or oversized native Plan editor response.");
  } finally { reader.releaseLock(); }
  if (!response.ok) throw errorDetail(value, response.status);
  return value;
}

async function request(endpoint: HostEndpoint, sessionId: string, action: "capabilities" | "list" | "start" | "status" | "cancel" | "recovery",
  input?: PlanExternalEditorRequest, cursor?: string): Promise<unknown> {
  const captured = capture(endpoint);
  const suffix = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  const response = await fetch(`${captured.origin}/v1/sessions/${encodeURIComponent(sessionId)}/plan/editor/${action}${suffix}`, {
    method: input ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { [SESSION_PLAN_OWNER_HEADER]: captured.hostId, ...(input ? { "Content-Type": "application/json" } : {}),
      ...(captured.token ? { Authorization: `Bearer ${captured.token}` } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  return readResponse(response, captured.hostId);
}

export async function requestPlanExternalEditorCapabilities(endpoint: HostEndpoint, sessionValue: unknown): Promise<PlanExternalEditorCapabilities> {
  const sessionId = identity(sessionValue, "conversation"), captured = capture(endpoint);
  return parsePlanExternalEditorCapabilities(await request(captured, sessionId, "capabilities"), captured.hostId);
}

export async function requestPlanExternalEditorList(endpoint: HostEndpoint, sessionValue: unknown, cursorValue?: unknown): Promise<PlanExternalEditorList> {
  const sessionId = identity(sessionValue, "conversation"), cursor = cursorValue === undefined ? undefined : parsePlanExternalEditorCursor(cursorValue);
  const captured = capture(endpoint);
  return parsePlanExternalEditorList(await request(captured, sessionId, "list", undefined, cursor), captured.hostId, sessionId);
}

async function operation(endpoint: HostEndpoint, raw: unknown, action: "start" | "status" | "cancel"): Promise<PlanExternalEditorObservation> {
  const input = parsePlanExternalEditorRequest(raw), captured = capture(endpoint);
  return parsePlanExternalEditorObservation(await request(captured, input.sessionId, action, input), captured.hostId, input);
}

export function startPlanExternalEditor(endpoint: HostEndpoint, raw: unknown): Promise<PlanExternalEditorObservation> {
  return operation(endpoint, raw, "start");
}
export function requestPlanExternalEditorStatus(endpoint: HostEndpoint, raw: unknown): Promise<PlanExternalEditorObservation> {
  return operation(endpoint, raw, "status");
}
export function cancelPlanExternalEditor(endpoint: HostEndpoint, raw: unknown): Promise<PlanExternalEditorObservation> {
  return operation(endpoint, raw, "cancel");
}
export async function recoverPlanExternalEditor(endpoint: HostEndpoint, raw: unknown): Promise<PlanExternalEditorRecovery> {
  const input = parsePlanExternalEditorRequest(raw), captured = capture(endpoint);
  return parsePlanExternalEditorRecovery(await request(captured, input.sessionId, "recovery", input), captured.hostId, input);
}
