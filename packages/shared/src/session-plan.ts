import { parsePlanDocumentAction, parsePlanDocumentSection, parsePlanDocumentSelection, parsePlanDocumentSummary, parsePlanRenderColumns,
  type PlanDocumentAction, type PlanDocumentSection, type PlanDocumentSelection, type PlanDocumentSummary } from "./plan-document";

/** Plan review is a native mode, separate from the session's permission mode.
 * The worker owns references and revisions; clients never choose a read path. */
export interface PlanTicket {
  epoch: string;
  nativeSessionId: string;
  revision: string;
}
export type PlanExecutionContext = "fresh" | "compact" | "keep";
export interface PlanReview {
  id: string;
  revision: string;
  title: string;
  /** Display/reference only. Mutations address id + revision, never this value. */
  reference: string;
  content: string;
  status: "ready" | "dismissed" | "deciding" | "unknown";
  canKeepContext: boolean;
  keepContextReason?: string;
  /** Absent on older owners; never synthesize a browser document owner. */
  document?: PlanDocumentSummary;
}
export interface PlanExecutionChoice { role: string; provider: string; modelId: string; thinking?: string; selected?: boolean; default?: boolean }
export interface SessionPlan {
  ticket: PlanTicket;
  mode: "off" | "active" | "paused";
  enabled: boolean;
  canToggle: boolean;
  busyReason?: string;
  warning?: string;
  review: PlanReview | null;
  executionChoices: PlanExecutionChoice[];
  defaultExecutionRole?: string;
  reconciliationRequired?: boolean;
}
export type PlanMutation =
  | { action: "edit"; content: string }
  | { action: "document"; documentAction: PlanDocumentAction; renderColumns: number }
  | { action: "approve"; context: PlanExecutionContext; executionRole?: string }
  | { action: "refine"; text: string }
  | { action: "save"; destination: string };
export interface PlanMutationRequest {
  sessionId: string;
  ticket: PlanTicket;
  reviewId: string;
  reviewRevision: string;
  mutation: PlanMutation;
}
export interface PlanDocumentReadRequest {
  sessionId: string;
  ticket: PlanTicket;
  reviewId: string;
  reviewRevision: string;
  selection: PlanDocumentSelection;
}
export interface PlanDocumentResponse {
  protocolVersion: 1;
  hostId: string;
  sessionId: string;
  ticket: PlanTicket;
  reviewId: string;
  reviewRevision: string;
  value: PlanDocumentSection;
}
export type PlanControlRequest = {
  sessionId: string;
  ticket: PlanTicket;
} & ({ action: "toggle" | "review" } | { action: "dismiss" | "reopen"; reviewId: string; reviewRevision: string });
export interface PlanControlResult { state: SessionPlan; cancelled?: true }
export interface PlanDecisionReceipt {
  commandId: string;
  reviewId: string;
  reviewRevision: string;
  action: PlanMutation["action"];
  outcome: "applied" | "cancelled" | "unknown";
  artifact: "unchanged" | "written" | "unknown";
  transition: "unchanged" | "new-session" | "unknown";
  execution: "not-requested" | "not-entered" | "entered" | "unknown";
  destinationSessionId?: string;
  savedDestination?: string;
  message?: string;
  /** Native compaction may fail while approved execution proceeds best-effort. */
  compaction?: { outcome: "ok" | "cancelled" | "failed"; message?: string };
  /** Approval-mode side effect, independent of native session replacement. */
  planExit?: "unchanged" | "completed" | "unknown";
}
export type PlanExecutionContinuationState = "ready" | "pending" | "entered" | "unknown";
export interface PlanExecutionContinuation {
  originSessionId: string;
  executionOwnerId: string;
  originalCommandId: string;
  latestAttemptId: string;
  state: PlanExecutionContinuationState;
}
export interface PlanExecutionRetryRequest {
  sessionId: string;
  originSessionId: string;
  originalCommandId: string;
  expectedAttemptId: string;
}
export interface PlanExecutionRetryResult {
  type: "session.plan.execution.retry";
  originalCommandId: string;
  attemptId: string;
  execution: "entered" | "not-entered";
}
export interface PlanDecisionJournalReceipt {
  commandId: string;
  state: "absent" | "pending" | "succeeded" | "failed" | "unknown";
  value?: PlanCommandJournalValue;
}
export type PlanCommandJournalValue = ({ type: "session.plan.control" } & PlanControlResult)
  | { type: "session.plan.mutate"; receipt: PlanDecisionReceipt }
  | PlanExecutionRetryResult;
export interface SessionPlanResponse {
  protocolVersion: 1;
  hostId: string;
  sessionId: string;
  value: SessionPlan | null;
  unavailable?: string;
  decisionReceipt?: PlanDecisionJournalReceipt;
  executionContinuation?: PlanExecutionContinuation;
}
export const SESSION_PLAN_OWNER_HEADER = "X-Agent-Plan-Host-Id";
/** Transport limit, not an implicit truncation of the native plan file. */
export const MAX_PLAN_CONTENT_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
function invalid(field: string): never { throw new Error(`Invalid native Plan ${field}.`); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("object");
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid("keys");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 200, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.length) || value.includes("\0") || encoder.encode(value).byteLength > max) return invalid("text");
  return value;
}
function digest(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) return invalid("revision");
  return result;
}
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : invalid("boolean"); }
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : invalid("choice");
}
function optionalText(key: string, value: unknown, max = 4096): Record<string, string> {
  return value === undefined ? {} : { [key]: text(value, max) };
}
export function parsePlanCommandId(value: unknown): string {
  const result = text(value);
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(result)) return invalid("command identity");
  return result;
}
export function parsePlanTicket(value: unknown): PlanTicket {
  const v = record(value, ["epoch", "nativeSessionId", "revision"]);
  return { epoch: text(v.epoch), nativeSessionId: text(v.nativeSessionId), revision: digest(v.revision) };
}
export function parsePlanReview(value: unknown): PlanReview {
  const v = record(value, ["id", "revision", "title", "reference", "content", "status", "canKeepContext", "keepContextReason", "document"]);
  const result: PlanReview = { id: text(v.id), revision: digest(v.revision), title: text(v.title, 4096), reference: text(v.reference, 16384),
    content: text(v.content, MAX_PLAN_CONTENT_BYTES, true), status: choice(v.status, ["ready", "dismissed", "deciding", "unknown"]),
    canKeepContext: bool(v.canKeepContext), ...optionalText("keepContextReason", v.keepContextReason),
    ...(v.document === undefined ? {} : { document: parsePlanDocumentSummary(v.document) }) };
  if (!result.canKeepContext && !result.keepContextReason) return invalid("keep-context reason");
  return result;
}
export function parseSessionPlan(value: unknown): SessionPlan {
  const v = record(value, ["ticket", "mode", "enabled", "canToggle", "busyReason", "warning", "review", "executionChoices", "defaultExecutionRole", "reconciliationRequired"]);
  if (!Array.isArray(v.executionChoices) || v.executionChoices.length > 100) return invalid("execution choices");
  const roles = new Set<string>();
  const executionChoices = Array.from(v.executionChoices, entry => {
    const c = record(entry, ["role", "provider", "modelId", "thinking", "selected", "default"]);
    const role = text(c.role, 100);
    if (roles.has(role)) return invalid("duplicate execution role"); roles.add(role);
    return { role, provider: text(c.provider), modelId: text(c.modelId, 500), ...optionalText("thinking", c.thinking, 100),
      ...(c.selected === undefined ? {} : { selected: bool(c.selected) }), ...(c.default === undefined ? {} : { default: bool(c.default) }) };
  });
  const result: SessionPlan = { ticket: parsePlanTicket(v.ticket), mode: choice(v.mode, ["off", "active", "paused"]),
    enabled: bool(v.enabled), canToggle: bool(v.canToggle), ...optionalText("busyReason", v.busyReason), ...optionalText("warning", v.warning),
    review: v.review === null ? null : parsePlanReview(v.review), executionChoices,
    ...optionalText("defaultExecutionRole", v.defaultExecutionRole, 100),
    ...(v.reconciliationRequired === undefined ? {} : { reconciliationRequired: bool(v.reconciliationRequired) }) };
  if (result.defaultExecutionRole && !executionChoices.some(c => c.role === result.defaultExecutionRole)) return invalid("default execution role");
  if (result.canToggle && (result.reconciliationRequired || !result.enabled || result.busyReason || result.review?.status === "deciding" || result.review?.status === "unknown")) return invalid("toggle availability");
  return result;
}
export function parsePlanMutationRequest(value: unknown): PlanMutationRequest {
  const v = record(value, ["sessionId", "ticket", "reviewId", "reviewRevision", "mutation"]);
  const raw = record(v.mutation, ["action", "content", "context", "executionRole", "text", "destination", "documentAction", "renderColumns"]);
  let mutation: PlanMutation;
  if (raw.action === "edit") {
    record(raw, ["action", "content"]); mutation = { action: "edit", content: text(raw.content, MAX_PLAN_CONTENT_BYTES, true) };
  } else if (raw.action === "document") {
    record(raw, ["action", "documentAction", "renderColumns"]);
    mutation = { action: "document", documentAction: parsePlanDocumentAction(raw.documentAction), renderColumns: parsePlanRenderColumns(raw.renderColumns) };
  } else if (raw.action === "approve") {
    record(raw, ["action", "context", "executionRole"]);
    mutation = { action: "approve", context: choice(raw.context, ["fresh", "compact", "keep"]), ...optionalText("executionRole", raw.executionRole, 100) };
  } else if (raw.action === "refine") {
    record(raw, ["action", "text"]); mutation = { action: "refine", text: text(raw.text, 500_000, true) };
  } else if (raw.action === "save") {
    record(raw, ["action", "destination"]); mutation = { action: "save", destination: text(raw.destination, 16_384) };
  } else return invalid("mutation");
  return { sessionId: text(v.sessionId), ticket: parsePlanTicket(v.ticket), reviewId: text(v.reviewId), reviewRevision: digest(v.reviewRevision), mutation };
}
export function parsePlanDocumentReadRequest(value: unknown): PlanDocumentReadRequest {
  const v = record(value, ["sessionId", "ticket", "reviewId", "reviewRevision", "selection"]);
  return { sessionId: text(v.sessionId), ticket: parsePlanTicket(v.ticket), reviewId: text(v.reviewId), reviewRevision: digest(v.reviewRevision),
    selection: parsePlanDocumentSelection(v.selection) };
}
export function parsePlanDocumentResponse(value: unknown, hostId: string, expected: PlanDocumentReadRequest): PlanDocumentResponse {
  const v = record(value, ["protocolVersion", "hostId", "sessionId", "ticket", "reviewId", "reviewRevision", "value"]);
  const request = parsePlanDocumentReadRequest(expected), ticket = parsePlanTicket(v.ticket);
  if (v.protocolVersion !== 1 || text(v.hostId) !== text(hostId) || text(v.sessionId) !== request.sessionId
    || text(v.reviewId) !== request.reviewId || digest(v.reviewRevision) !== request.reviewRevision
    || ticket.epoch !== request.ticket.epoch || ticket.nativeSessionId !== request.ticket.nativeSessionId || ticket.revision !== request.ticket.revision)
    return invalid("document response owner");
  return { protocolVersion: 1, hostId, sessionId: request.sessionId, ticket, reviewId: request.reviewId, reviewRevision: request.reviewRevision,
    value: parsePlanDocumentSection(v.value, request.selection) };
}
export function parsePlanControlRequest(value: unknown): PlanControlRequest {
  const v = record(value, ["sessionId", "ticket", "action", "reviewId", "reviewRevision"]);
  const owner = { sessionId: text(v.sessionId), ticket: parsePlanTicket(v.ticket) };
  if (v.action === "toggle" || v.action === "review") {
    record(v, ["sessionId", "ticket", "action"]);
    return { ...owner, action: v.action };
  }
  if (v.action === "dismiss" || v.action === "reopen") return { ...owner, action: v.action,
    reviewId: text(v.reviewId), reviewRevision: digest(v.reviewRevision) };
  return invalid("control");
}
export function parsePlanExecutionRetryRequest(value: unknown): PlanExecutionRetryRequest {
  const v = record(value, ["sessionId", "originSessionId", "originalCommandId", "expectedAttemptId"]);
  return { sessionId: text(v.sessionId), originSessionId: text(v.originSessionId),
    originalCommandId: parsePlanCommandId(v.originalCommandId), expectedAttemptId: parsePlanCommandId(v.expectedAttemptId) };
}
export function parsePlanExecutionRetryResult(value: unknown, attemptId: string): PlanExecutionRetryResult {
  const v = record(value, ["type", "originalCommandId", "attemptId", "execution"]);
  if (v.type !== "session.plan.execution.retry" || parsePlanCommandId(v.attemptId) !== parsePlanCommandId(attemptId))
    return invalid("execution retry receipt owner");
  return { type: "session.plan.execution.retry", originalCommandId: parsePlanCommandId(v.originalCommandId),
    attemptId, execution: choice(v.execution, ["entered", "not-entered"]) };
}
export function parsePlanExecutionContinuation(value: unknown): PlanExecutionContinuation {
  const v = record(value, ["originSessionId", "executionOwnerId", "originalCommandId", "latestAttemptId", "state"]);
  return { originSessionId: text(v.originSessionId), executionOwnerId: text(v.executionOwnerId),
    originalCommandId: parsePlanCommandId(v.originalCommandId), latestAttemptId: parsePlanCommandId(v.latestAttemptId),
    state: choice(v.state, ["ready", "pending", "entered", "unknown"]) };
}
export function parsePlanControlResult(value: unknown): PlanControlResult {
  const v = record(value, ["state", "cancelled"]);
  if (v.cancelled !== undefined && v.cancelled !== true) return invalid("cancellation");
  return { state: parseSessionPlan(v.state), ...(v.cancelled === true ? { cancelled: true as const } : {}) };
}
export function parsePlanDecisionReceipt(value: unknown, commandId: string): PlanDecisionReceipt {
  const v = record(value, ["commandId", "reviewId", "reviewRevision", "action", "outcome", "artifact", "transition", "execution", "destinationSessionId", "savedDestination", "message", "compaction", "planExit"]);
  if (text(v.commandId) !== text(commandId)) return invalid("receipt command owner");
  const result: PlanDecisionReceipt = { commandId, reviewId: text(v.reviewId), reviewRevision: digest(v.reviewRevision),
    action: choice(v.action, ["edit", "document", "approve", "refine", "save"]), outcome: choice(v.outcome, ["applied", "cancelled", "unknown"]),
    artifact: choice(v.artifact, ["unchanged", "written", "unknown"]), transition: choice(v.transition, ["unchanged", "new-session", "unknown"]),
    execution: choice(v.execution, ["not-requested", "not-entered", "entered", "unknown"]),
    ...optionalText("destinationSessionId", v.destinationSessionId, 200), ...optionalText("savedDestination", v.savedDestination, 16_384), ...optionalText("message", v.message) };
  if (v.compaction !== undefined) {
    if (result.action !== "approve") return invalid("unexpected compaction");
    const compact = record(v.compaction, ["outcome", "message"]);
    result.compaction = { outcome: choice(compact.outcome, ["ok", "cancelled", "failed"]), ...optionalText("message", compact.message) };
  }
  if (v.planExit !== undefined) {
    if (result.action !== "approve" && result.action !== "save") return invalid("unexpected Plan exit");
    result.planExit = choice(v.planExit, ["unchanged", "completed", "unknown"] as const);
    if (result.planExit === "unknown" && result.outcome !== "unknown") return invalid("unknown Plan exit");
  }
  if (result.transition === "new-session" && !result.destinationSessionId
    || result.destinationSessionId && result.transition !== "new-session" && result.transition !== "unknown") return invalid("destination identity");
  if (result.outcome !== "unknown" && [result.artifact, result.transition, result.execution].includes("unknown")) return invalid("unknown effect");
  if (result.savedDestination !== undefined && (result.action !== "save" || result.artifact !== "written" && result.artifact !== "unknown")) return invalid("saved artifact");
  if (["save", "edit", "document"].includes(result.action) && result.execution !== "not-requested") return invalid("unexpected execution");
  if (result.action === "document" && result.transition !== "unchanged") return invalid("document identity transition");
  if (result.action === "save" && result.artifact === "written" && !result.savedDestination) return invalid("saved destination");
  return result;
}
export function parsePlanDecisionJournalReceipt(value: unknown, commandId: string): PlanDecisionJournalReceipt {
  const v = record(value, ["commandId", "state", "value"]);
  const owner = parsePlanCommandId(commandId);
  if (parsePlanCommandId(v.commandId) !== owner) return invalid("journal command owner");
  const state = choice(v.state, ["absent", "pending", "succeeded", "failed", "unknown"]);
  let result: PlanCommandJournalValue | undefined;
  if (v.value !== undefined) {
    const raw = record(v.value, ["type", "state", "cancelled", "receipt", "originalCommandId", "attemptId", "execution"]);
    if (raw.type === "session.plan.control") {
      const control = parsePlanControlResult({ state: raw.state, ...(raw.cancelled === undefined ? {} : { cancelled: raw.cancelled }) });
      result = { type: "session.plan.control", ...control };
    } else if (raw.type === "session.plan.mutate") {
      const mutation = record(v.value, ["type", "receipt"]);
      result = { type: "session.plan.mutate", receipt: parsePlanDecisionReceipt(mutation.receipt, owner) };
    } else if (raw.type === "session.plan.execution.retry") {
      result = parsePlanExecutionRetryResult(v.value, owner);
    } else return invalid("journal command type");
  }
  const expected = result?.type === "session.plan.mutate" && result.receipt.outcome === "unknown" ? "unknown" : result ? "succeeded" : undefined;
  if (expected && state !== expected) return invalid("journal receipt state");
  if (!result && state === "succeeded") return invalid("missing journal receipt");
  return { commandId: owner, state, ...(result ? { value: result } : {}) };
}
export function parseSessionPlanResponse(value: unknown, hostId: string, sessionId: string, commandId?: string): SessionPlanResponse {
  const v = record(value, ["protocolVersion", "hostId", "sessionId", "value", "unavailable", "decisionReceipt", "executionContinuation"]);
  if (v.protocolVersion !== 1 || text(v.hostId) !== text(hostId) || text(v.sessionId) !== text(sessionId)) return invalid("response owner");
  const state = v.value === null ? null : parseSessionPlan(v.value);
  if ((state === null) !== (v.unavailable !== undefined)) return invalid("availability");
  if (commandId === undefined && v.decisionReceipt !== undefined) return invalid("unsolicited journal receipt");
  const decisionReceipt = commandId === undefined ? undefined : parsePlanDecisionJournalReceipt(v.decisionReceipt, commandId);
  const executionContinuation = v.executionContinuation === undefined ? undefined : parsePlanExecutionContinuation(v.executionContinuation);
  if (executionContinuation && executionContinuation.originSessionId !== sessionId && executionContinuation.executionOwnerId !== sessionId)
    return invalid("execution continuation owner");
  return { protocolVersion: 1, hostId, sessionId, value: state, ...optionalText("unavailable", v.unavailable),
    ...(decisionReceipt ? { decisionReceipt } : {}), ...(executionContinuation ? { executionContinuation } : {}) };
}
