import { MAX_PLAN_ANNOTATION_BYTES, parsePlanDocumentId, parsePlanRenderColumns } from "./plan-document";
import { MAX_PLAN_CONTENT_BYTES, parsePlanDecisionReceipt, parsePlanTicket, type PlanDecisionReceipt, type PlanTicket } from "./session-plan";

export type PlanExternalEditorEdit =
  | { kind: "plan" }
  | { kind: "annotation";
      target: { kind: "section"; sectionId: string } | { kind: "line"; sectionId: string; rowId: string };
      note: string; renderColumns: number };

export interface PlanExternalEditorRequest {
  requestId: string;
  controlEpoch: string;
  sessionId: string;
  ticket: PlanTicket;
  reviewId: string;
  reviewRevision: string;
  documentRevision: string;
  edit: PlanExternalEditorEdit;
}

export interface PlanExternalEditorCapabilities {
  protocolVersion: 1;
  hostId: string;
  controlEpoch: string;
  available: boolean;
  reason?: string;
}

export type PlanExternalEditorResult = {
  outcome: "applied" | "cancelled" | "not-submitted" | "unknown";
  receipt?: PlanDecisionReceipt;
  message?: string;
};

export interface PlanExternalEditorObservation {
  protocolVersion: 1;
  hostId: string;
  request: PlanExternalEditorRequest;
  state: "absent" | "pending" | "settled";
  terminalId?: string;
  result?: PlanExternalEditorResult;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const encoder = new TextEncoder();

function invalid(field: string): never { throw new Error(`Invalid Plan external editor ${field}.`); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) return invalid("keys");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  return typeof value === "string" && uuid.test(value) ? value : invalid("UUID identity");
}
function text(value: unknown, max = 200, empty = false): string {
  if (typeof value !== "string" || !empty && !value.length || value.includes("\0") || encoder.encode(value).byteLength > max)
    return invalid("text");
  return value;
}
function digest(value: unknown): string {
  const result = text(value, 64);
  return /^[a-f0-9]{64}$/.test(result) ? result : invalid("review revision");
}
function optionalText(key: string, value: unknown): Record<string, string> {
  return value === undefined ? {} : { [key]: text(value, 4096) };
}

function parseEdit(value: unknown): PlanExternalEditorEdit {
  const edit = record(value, ["kind", "target", "note", "renderColumns"]);
  if (edit.kind === "plan") {
    record(edit, ["kind"]);
    return { kind: "plan" };
  }
  if (edit.kind !== "annotation") return invalid("edit");
  record(edit, ["kind", "target", "note", "renderColumns"]);
  const rawTarget = record(edit.target, ["kind", "sectionId", "rowId"]);
  const sectionId = parsePlanDocumentId(rawTarget.sectionId);
  let target: Extract<PlanExternalEditorEdit, { kind: "annotation" }>["target"];
  if (rawTarget.kind === "section") {
    record(rawTarget, ["kind", "sectionId"]);
    target = { kind: "section", sectionId };
  } else if (rawTarget.kind === "line") {
    record(rawTarget, ["kind", "sectionId", "rowId"]);
    target = { kind: "line", sectionId, rowId: parsePlanDocumentId(rawTarget.rowId) };
  } else return invalid("annotation target");
  return { kind: "annotation", target, note: text(edit.note, MAX_PLAN_ANNOTATION_BYTES, true),
    renderColumns: parsePlanRenderColumns(edit.renderColumns) };
}

export function parsePlanExternalEditorRequest(value: unknown): PlanExternalEditorRequest {
  const request = record(value, ["requestId", "controlEpoch", "sessionId", "ticket", "reviewId", "reviewRevision", "documentRevision", "edit"]);
  return {
    requestId: id(request.requestId),
    controlEpoch: id(request.controlEpoch),
    sessionId: text(request.sessionId),
    ticket: parsePlanTicket(request.ticket),
    reviewId: text(request.reviewId),
    reviewRevision: digest(request.reviewRevision),
    documentRevision: parsePlanDocumentId(request.documentRevision),
    edit: parseEdit(request.edit),
  };
}

export function parsePlanExternalEditorCapabilities(value: unknown, expectedHostId: string): PlanExternalEditorCapabilities {
  const hostId = text(expectedHostId);
  const capabilities = record(value, ["protocolVersion", "hostId", "controlEpoch", "available", "reason"]);
  if (capabilities.protocolVersion !== 1 || text(capabilities.hostId) !== hostId)
    return invalid("capability owner or version");
  if (typeof capabilities.available !== "boolean") return invalid("availability");
  const result: PlanExternalEditorCapabilities = {
    protocolVersion: 1,
    hostId,
    controlEpoch: id(capabilities.controlEpoch),
    available: capabilities.available,
    ...optionalText("reason", capabilities.reason),
  };
  if (result.available === (result.reason !== undefined)) return invalid("availability reason");
  return result;
}

function sameRequest(left: PlanExternalEditorRequest, right: PlanExternalEditorRequest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseResult(value: unknown, request: PlanExternalEditorRequest): PlanExternalEditorResult {
  const raw = record(value, ["outcome", "receipt", "message"]);
  if (raw.outcome !== "applied" && raw.outcome !== "cancelled" && raw.outcome !== "not-submitted" && raw.outcome !== "unknown")
    return invalid("result outcome");
  const result: PlanExternalEditorResult = { outcome: raw.outcome, ...optionalText("message", raw.message) };
  if (raw.receipt !== undefined) {
    const receipt = parsePlanDecisionReceipt(raw.receipt, request.requestId);
    const action = request.edit.kind === "plan" ? "edit" : "document";
    if (receipt.reviewId !== request.reviewId || receipt.reviewRevision !== request.reviewRevision || receipt.action !== action)
      return invalid("receipt owner or action");
    result.receipt = receipt;
  }
  if (result.outcome === "applied") {
    if (!result.receipt || result.receipt.outcome !== "applied" || result.receipt.transition !== "unchanged"
      || result.receipt.execution !== "not-requested") return invalid("applied receipt");
  } else if (result.outcome === "not-submitted") {
    if (result.receipt) return invalid("not-submitted receipt");
  } else if (result.receipt?.outcome !== undefined && result.receipt.outcome !== result.outcome) {
    return invalid("contradictory receipt");
  }
  return result;
}

export function parsePlanExternalEditorObservation(
  value: unknown,
  expectedHostId: string,
  expectedRequest: PlanExternalEditorRequest,
): PlanExternalEditorObservation {
  const hostId = text(expectedHostId), request = parsePlanExternalEditorRequest(expectedRequest);
  const observation = record(value, ["protocolVersion", "hostId", "request", "state", "terminalId", "result"]);
  const observedRequest = parsePlanExternalEditorRequest(observation.request);
  if (observation.protocolVersion !== 1 || text(observation.hostId) !== hostId || !sameRequest(observedRequest, request))
    return invalid("observation owner or request");
  if (observation.state !== "absent" && observation.state !== "pending" && observation.state !== "settled")
    return invalid("observation state");
  const terminalId = observation.terminalId === undefined ? undefined : id(observation.terminalId);
  if (observation.state !== "settled") {
    if (observation.result !== undefined) return invalid("non-settled result");
    if (observation.state === "absent" && terminalId) return invalid("absent terminal");
    return { protocolVersion: 1, hostId, request: observedRequest, state: observation.state,
      ...(terminalId ? { terminalId } : {}) };
  }
  if (observation.result === undefined) return invalid("settled result");
  return { protocolVersion: 1, hostId, request: observedRequest, state: "settled",
    ...(terminalId ? { terminalId } : {}), result: parseResult(observation.result, request) };
}

/** Explicit recovery returns only the original job output, never a path or a command. */
export interface PlanExternalEditorRecovery {
  observation: PlanExternalEditorObservation;
  content?: string;
}
export function parsePlanExternalEditorRecovery(value: unknown, expectedHostId: string,
  expectedRequest: PlanExternalEditorRequest): PlanExternalEditorRecovery {
  const raw = record(value, ["observation", "content"]);
  const observation = parsePlanExternalEditorObservation(raw.observation, expectedHostId, expectedRequest);
  if (raw.content === undefined) return { observation };
  if (observation.state !== "settled" || observation.result?.outcome !== "unknown")
    return invalid("recovery state");
  return { observation, content: text(raw.content, MAX_PLAN_CONTENT_BYTES, true) };
}

export const PLAN_EXTERNAL_EDITOR_PAGE_SIZE = 16;
export interface PlanExternalEditorList {
  protocolVersion: 1;
  hostId: string;
  sessionId: string;
  items: PlanExternalEditorObservation[];
  nextCursor?: string;
}

export function parsePlanExternalEditorCursor(value: unknown): string {
  return id(value);
}

export function parsePlanExternalEditorList(value: unknown, expectedHostId: string,
  expectedSessionId: string): PlanExternalEditorList {
  const hostId = text(expectedHostId), sessionId = text(expectedSessionId);
  const raw = record(value, ["protocolVersion", "hostId", "sessionId", "items", "nextCursor"]);
  if (raw.protocolVersion !== 1 || text(raw.hostId) !== hostId || text(raw.sessionId) !== sessionId
    || !Array.isArray(raw.items) || raw.items.length > PLAN_EXTERNAL_EDITOR_PAGE_SIZE)
    return invalid("list owner, session, or page");
  const items = raw.items.map(item => {
    const request = parsePlanExternalEditorRequest(record(item, ["protocolVersion", "hostId", "request", "state", "terminalId", "result"]).request);
    if (request.sessionId !== sessionId) return invalid("list item session");
    return parsePlanExternalEditorObservation(item, hostId, request);
  });
  if (new Set(items.map(item => item.request.requestId)).size !== items.length)
    return invalid("duplicate list item");
  const nextCursor = raw.nextCursor === undefined ? undefined : parsePlanExternalEditorCursor(raw.nextCursor);
  if (nextCursor !== undefined && (items.length !== PLAN_EXTERNAL_EDITOR_PAGE_SIZE
    || items.at(-1)?.request.requestId !== nextCursor)) return invalid("list cursor");
  return { protocolVersion: 1, hostId, sessionId, items, ...(nextCursor === undefined ? {} : { nextCursor }) };
}
