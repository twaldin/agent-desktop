import { SESSION_PLAN_OWNER_HEADER, parsePlanCommandId, parsePlanDecisionJournalReceipt, parsePlanDecisionReceipt,
  parsePlanExecutionContinuation, parsePlanExecutionRetryResult, parseSessionPlanResponse,
  parsePlanDocumentReadRequest, parsePlanDocumentResponse,
  type PlanDocumentReadRequest, type PlanDecisionJournalReceipt, type PlanExecutionContinuation, type SessionPlan } from "../../../packages/shared/src/session-plan";
import type { PlanDocumentSection } from "../../../packages/shared/src/plan-document";
import type { CommandRecord } from "./store";

/** Projects only the exact original mutation command. Reading never retries a
 * Plan decision, opens a worker, or upgrades an orphaned pending outcome. */
export function projectPlanDecisionJournalReceipt(entry: CommandRecord | undefined, sessionId: string,
  commandId: string, active: boolean): PlanDecisionJournalReceipt {
  parsePlanCommandId(commandId);
  const command = entry?.command;
  if (!entry || entry.id !== commandId || !(command?.type === "session.plan.control" || command?.type === "session.plan.mutate" || command?.type === "session.plan.execution.retry")
    || command.sessionId !== sessionId)
    return { commandId, state: "absent" };
  if (entry.state === "pending") return { commandId, state: active ? "pending" : "unknown" };
  const result = entry.result;
  if (!result || result.commandId !== commandId) return { commandId, state: "unknown" };
  if (!result.ok) return { commandId, state: ["PLAN_NOT_LOADED", "PLAN_NOT_READY", "PLAN_REJECTED"].includes(result.error.code) ? "failed" : "unknown" };
  const value = result.value;
  if (!value || !("type" in value) || value.type !== command.type) return { commandId, state: "unknown" };
  try {
    if (value.type === "session.plan.control") return parsePlanDecisionJournalReceipt({ commandId, state: "succeeded",
      value: { type: value.type, state: value.state, ...(value.cancelled ? { cancelled: true } : {}) } }, commandId);
    if (value.type === "session.plan.execution.retry") {
      const retry = parsePlanExecutionRetryResult(value, commandId);
      if (command.type !== "session.plan.execution.retry" || retry.originalCommandId !== command.originalCommandId || retry.attemptId !== entry.id)
        return { commandId, state: "unknown" };
      return parsePlanDecisionJournalReceipt({ commandId, state: "succeeded", value: retry }, commandId);
    }
    const receipt = parsePlanDecisionReceipt(value.receipt, commandId);
    return parsePlanDecisionJournalReceipt({ commandId, state: receipt.outcome === "unknown" ? "unknown" : "succeeded",
      value: { type: value.type, receipt } }, commandId);
  } catch { return { commandId, state: "unknown" }; }
}

/** Read-only route mounted after bearer authentication. It never creates a
 * worker or reopens a review; the host supplies only existing-owner reads. */
export class SessionPlanHttp {
  constructor(private readonly options: {
    hostId: string;
    receipt: (sessionId: string, commandId: string) => PlanDecisionJournalReceipt;
    continuation?: (sessionId: string) => PlanExecutionContinuation | undefined;
    sessionExists(id: string): boolean;
    existing(id: string): Promise<{ getPlan(): Promise<SessionPlan>;
      getPlanDocumentSection?(request: PlanDocumentReadRequest): Promise<PlanDocumentSection> } | undefined>;
  }) {}

  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const section = /^\/v1\/sessions\/([^/]+)\/plan\/section$/.exec(url.pathname);
    if (section) return this.#section(request, url, section[1]!);
    const match = /^\/v1\/sessions\/([^/]+)\/plan$/.exec(url.pathname);
    if (!match) return;
    const headers = { "Cache-Control": "no-store", [SESSION_PLAN_OWNER_HEADER]: this.options.hostId };
    const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(SESSION_PLAN_OWNER_HEADER) !== this.options.hostId)
      return fail(409, "OWNER_MISMATCH", "The Plan session owner does not match this host.");
    if (request.method !== "GET") return fail(405, "INVALID_PLAN_REQUEST", "Use GET to inspect native Plan state.");
    let sessionId: string, commandId: string | undefined;
    try {
      if (match[1]!.length > 600 || url.search.length > 4096) throw new Error("Unexpected query or target");
      sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || sessionId.includes("\0") || new TextEncoder().encode(sessionId).length > 200) throw new Error("Invalid target");
      if ([...url.searchParams.keys()].some(key => key !== "commandId") || url.searchParams.getAll("commandId").length > 1) throw new Error("Invalid query");
      const raw = url.searchParams.get("commandId");
      commandId = raw === null ? undefined : parsePlanCommandId(raw);
    } catch { return fail(400, "INVALID_PLAN_REQUEST", "Invalid Plan session target."); }
    const current = () => this.options.sessionExists(sessionId);
    if (!current()) return fail(409, "STALE_TARGET", "The original Plan session no longer exists.");
    let decisionReceipt: PlanDecisionJournalReceipt | undefined;
    let executionContinuation: PlanExecutionContinuation | undefined;
    try { executionContinuation = this.options.continuation?.(sessionId); if (executionContinuation) parsePlanExecutionContinuation(executionContinuation); }
    catch { executionContinuation = undefined; }
    if (commandId !== undefined) {
      try { decisionReceipt = parsePlanDecisionJournalReceipt(this.options.receipt(sessionId, commandId), commandId); }
      catch { decisionReceipt = { commandId, state: "unknown" }; }
    }
    let value: SessionPlan | null = null;
    let unavailable = "This session has no loaded Plan owner. Open the original session to inspect its native state.";
    try {
      const owner = await this.options.existing(sessionId);
      const raw = owner ? await owner.getPlan() : null;
      if (owner && await this.options.existing(sessionId) !== owner)
        throw new Error("The native Plan worker changed during inspection.");
      value = parseSessionPlanResponse({ protocolVersion: 1, hostId: this.options.hostId, sessionId, value: raw,
        ...(raw === null ? { unavailable } : {}), ...(decisionReceipt ? { decisionReceipt } : {}),
        ...(executionContinuation ? { executionContinuation } : {}) }, this.options.hostId, sessionId, commandId).value;
    } catch {
      unavailable = "The original native Plan state could not be read. Reconnect and refresh; no decision was replayed.";
    }
    if (!current()) return fail(409, "STALE_TARGET", "The original Plan session retired during inspection.");
    const response = () => JSON.stringify(parseSessionPlanResponse({ protocolVersion: 1, hostId: this.options.hostId, sessionId, value,
      ...(value === null ? { unavailable } : {}), ...(decisionReceipt ? { decisionReceipt } : {}),
      ...(executionContinuation ? { executionContinuation } : {}) }, this.options.hostId, sessionId, commandId));
    let body = response();
    // Escaping can expand the content even when the native text fits its bound.
    // Refuse the response without truncating or changing the saved artifact.
    if (new TextEncoder().encode(body).length > 12 * 1024 * 1024) {
      value = null; unavailable = "The complete Plan exceeds the review transport limit. The saved native artifact is unchanged.";
      body = response();
      if (new TextEncoder().encode(body).length > 12 * 1024 * 1024 && commandId !== undefined) {
        // A successful control receipt may itself contain the prior full Plan.
        // Keep its durable command owner while declining to invent a partial state.
        decisionReceipt = { commandId, state: "unknown" };
        unavailable = "The complete Plan command receipt exceeds the review transport limit. Its durable outcome was not changed or replayed.";
        body = response();
      }
    }
    return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
  }

  async #section(request: Request, url: URL, target: string): Promise<Response> {
    const headers = { "Cache-Control": "no-store", [SESSION_PLAN_OWNER_HEADER]: this.options.hostId };
    const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(SESSION_PLAN_OWNER_HEADER) !== this.options.hostId)
      return fail(409, "OWNER_MISMATCH", "The Plan document owner does not match this host.");
    if (request.method !== "GET") return fail(405, "INVALID_PLAN_REQUEST", "Use GET to inspect a native Plan section.");
    let input: PlanDocumentReadRequest;
    try {
      if (target.length > 600 || url.search.length > 8192 || [...url.searchParams.keys()].some(key => key !== "request")
        || url.searchParams.getAll("request").length !== 1) throw new Error("Invalid section query");
      input = parsePlanDocumentReadRequest(JSON.parse(url.searchParams.get("request")!));
      if (decodeURIComponent(target) !== input.sessionId) throw new Error("Section query target mismatch");
    } catch { return fail(400, "INVALID_PLAN_REQUEST", "Invalid native Plan section request."); }
    if (!this.options.sessionExists(input.sessionId)) return fail(409, "STALE_TARGET", "The original Plan session no longer exists.");
    try {
      const owner = await this.options.existing(input.sessionId);
      if (!owner?.getPlanDocumentSection) return fail(409, "PLAN_NOT_LOADED", "This session has no loaded native Plan document owner.");
      const value = await owner.getPlanDocumentSection(input);
      if (!this.options.sessionExists(input.sessionId) || await this.options.existing(input.sessionId) !== owner)
        return fail(409, "STALE_TARGET", "The original Plan document worker changed during inspection.");
      const response = parsePlanDocumentResponse({ protocolVersion: 1, hostId: this.options.hostId,
        sessionId: input.sessionId, ticket: input.ticket, reviewId: input.reviewId, reviewRevision: input.reviewRevision, value }, this.options.hostId, input);
      return Response.json(response, { headers });
    } catch {
      return fail(409, "PLAN_DOCUMENT_UNAVAILABLE", "The native Plan section changed or could not be projected. Refresh the original review before continuing.");
    }
  }
}
