import { MAX_TODO_BYTES, parseTodoTicket, parseTodoMutationResult, type TodoMutationResult, type TodoTicket } from "./session-todos";

export interface TodoExternalEditorRequest {
  requestId: string;
  controlEpoch: string;
  sessionId: string;
  ticket: TodoTicket;
}

export interface TodoExternalEditorCapabilities {
  protocolVersion: 1;
  hostId: string;
  controlEpoch: string;
  available: boolean;
  reason?: string;
}

export type TodoExternalEditorResult = {
  outcome: "applied" | "cancelled" | "not-submitted" | "unknown";
  receipt?: TodoMutationResult;
  message?: string;
};

export interface TodoExternalEditorObservation {
  protocolVersion: 1;
  hostId: string;
  request: TodoExternalEditorRequest;
  state: "absent" | "pending" | "settled";
  terminalId?: string;
  result?: TodoExternalEditorResult;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const encoder = new TextEncoder();

function invalid(field: string): never { throw new Error(`Invalid Todo external editor ${field}.`); }
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
function optionalText(key: string, value: unknown): Record<string, string> {
  return value === undefined ? {} : { [key]: text(value, 4096) };
}

export function parseTodoExternalEditorRequest(value: unknown): TodoExternalEditorRequest {
  const request = record(value, ["requestId", "controlEpoch", "sessionId", "ticket"]);
  if (text(request.sessionId) !== parseTodoTicket(request.ticket).nativeSessionId) invalid("request owner");
  return {
    requestId: id(request.requestId),
    controlEpoch: id(request.controlEpoch),
    sessionId: text(request.sessionId),
    ticket: parseTodoTicket(request.ticket),
  };
}

export function parseTodoExternalEditorCapabilities(value: unknown, expectedHostId: string): TodoExternalEditorCapabilities {
  const hostId = text(expectedHostId);
  const capabilities = record(value, ["protocolVersion", "hostId", "controlEpoch", "available", "reason"]);
  if (capabilities.protocolVersion !== 1 || text(capabilities.hostId) !== hostId)
    return invalid("capability owner or version");
  if (typeof capabilities.available !== "boolean") return invalid("availability");
  const result: TodoExternalEditorCapabilities = {
    protocolVersion: 1,
    hostId,
    controlEpoch: id(capabilities.controlEpoch),
    available: capabilities.available,
    ...optionalText("reason", capabilities.reason),
  };
  if (result.available === (result.reason !== undefined)) return invalid("availability reason");
  return result;
}

function sameRequest(left: TodoExternalEditorRequest, right: TodoExternalEditorRequest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseResult(value: unknown, request: TodoExternalEditorRequest): TodoExternalEditorResult {
  const raw = record(value, ["outcome", "receipt", "message"]);
  if (raw.outcome !== "applied" && raw.outcome !== "cancelled" && raw.outcome !== "not-submitted" && raw.outcome !== "unknown")
    return invalid("result outcome");
  const result: TodoExternalEditorResult = { outcome: raw.outcome, ...optionalText("message", raw.message) };
  if (raw.receipt !== undefined) {
    const receipt = parseTodoMutationResult(raw.receipt, request.requestId);
    if (receipt.state.ticket.nativeSessionId !== request.ticket.nativeSessionId || receipt.state.ticket.epoch !== request.ticket.epoch)
      return invalid("receipt owner");
    result.receipt = receipt;
  }
  if (result.outcome === "applied") {
    if (!result.receipt) return invalid("applied receipt");
  } else if (result.outcome === "not-submitted") {
    if (result.receipt) return invalid("not-submitted receipt");
  } else if (result.receipt !== undefined) {
    return invalid("contradictory receipt");
  }
  return result;
}

export function parseTodoExternalEditorObservation(
  value: unknown,
  expectedHostId: string,
  expectedRequest: TodoExternalEditorRequest,
): TodoExternalEditorObservation {
  const hostId = text(expectedHostId), request = parseTodoExternalEditorRequest(expectedRequest);
  const observation = record(value, ["protocolVersion", "hostId", "request", "state", "terminalId", "result"]);
  const observedRequest = parseTodoExternalEditorRequest(observation.request);
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
export interface TodoExternalEditorRecovery {
  observation: TodoExternalEditorObservation;
  content?: string;
  source?: "original-input" | "completed-output";
}
export function parseTodoExternalEditorRecovery(value: unknown, expectedHostId: string,
  expectedRequest: TodoExternalEditorRequest): TodoExternalEditorRecovery {
  const raw = record(value, ["observation", "content", "source"]);
  const observation = parseTodoExternalEditorObservation(raw.observation, expectedHostId, expectedRequest);
  if (raw.content === undefined) { if (raw.source !== undefined) return invalid("recovery source"); return { observation }; }
  if (observation.state !== "settled" || observation.result?.outcome !== "unknown")
    return invalid("recovery state");
  if (raw.source !== "original-input" && raw.source !== "completed-output") return invalid("recovery source");
  return { observation, content: text(raw.content, MAX_TODO_BYTES, true), source: raw.source };
}

export const TODO_EXTERNAL_EDITOR_PAGE_SIZE = 16;
export interface TodoExternalEditorList {
  protocolVersion: 1;
  hostId: string;
  sessionId: string;
  items: TodoExternalEditorObservation[];
  nextCursor?: string;
}

export function parseTodoExternalEditorCursor(value: unknown): string {
  return id(value);
}

export function parseTodoExternalEditorList(value: unknown, expectedHostId: string,
  expectedSessionId: string): TodoExternalEditorList {
  const hostId = text(expectedHostId), sessionId = text(expectedSessionId);
  const raw = record(value, ["protocolVersion", "hostId", "sessionId", "items", "nextCursor"]);
  if (raw.protocolVersion !== 1 || text(raw.hostId) !== hostId || text(raw.sessionId) !== sessionId
    || !Array.isArray(raw.items) || raw.items.length > TODO_EXTERNAL_EDITOR_PAGE_SIZE)
    return invalid("list owner, session, or page");
  const items = raw.items.map(item => {
    const request = parseTodoExternalEditorRequest(record(item, ["protocolVersion", "hostId", "request", "state", "terminalId", "result"]).request);
    if (request.sessionId !== sessionId) return invalid("list item session");
    return parseTodoExternalEditorObservation(item, hostId, request);
  });
  if (new Set(items.map(item => item.request.requestId)).size !== items.length)
    return invalid("duplicate list item");
  const nextCursor = raw.nextCursor === undefined ? undefined : parseTodoExternalEditorCursor(raw.nextCursor);
  if (nextCursor !== undefined && (items.length !== TODO_EXTERNAL_EDITOR_PAGE_SIZE
    || items.at(-1)?.request.requestId !== nextCursor)) return invalid("list cursor");
  return { protocolVersion: 1, hostId, sessionId, items, ...(nextCursor === undefined ? {} : { nextCursor }) };
}
