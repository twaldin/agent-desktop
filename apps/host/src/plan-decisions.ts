import type { CommandResult, SessionSummary } from "@agent-desktop/shared";
import { parsePlanExecutionRetryRequest, parsePlanMutationRequest, type PlanDecisionReceipt, type PlanExecutionContinuation,
  type PlanExecutionRetryRequest, type PlanExecutionRetryResult, type PlanMutationRequest } from "../../../packages/shared/src/session-plan";
import type { WorkerSession } from "./omp-workers/runtime";
import { HostStore } from "./store";

export interface PlanDecisionIntent {
  commandId: string;
  originId: string;
  reviewId: string;
  reviewRevision: string;
  state: "pending" | "complete" | "rejected" | "unknown";
  receipt?: PlanDecisionReceipt;
  phaseId?: string;
  destination?: { id: string; sessionFile: string };
  execution?: {
    phaseId: string;
    owner: { id: string; sessionFile: string; cwd: string };
    latestAttemptId: string;
    state: "ready" | "pending" | "entered" | "unknown";
  };
}
export const planDecisionKey = (sessionId: string) => `plan-decision:${sessionId}`;
export const planDecisionOwnerKey = (sessionId: string) => `plan-decision-owner:${sessionId}`;
export const planDecisionCommandKey = (commandId: string) => `plan-decision-command:${commandId}`;
const failure = (commandId: string, code: string, message: string): CommandResult => ({ ok: false, commandId, error: { code, message } });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The original command is claimed by the host before entry. Retain native
 * effects before worker retirement, then bind a replacement before execution.
 * Pending/unknown decisions are inspected through the journal, never replayed. */
export class PlanDecisionService {
  constructor(private readonly options: {
    store: HostStore;
    existing(id: string): Promise<WorkerSession | undefined>;
    forget(id: string, handle: WorkerSession): Promise<void>;
    reopen(id: string): Promise<WorkerSession>;
    busy(id: string): boolean;
    active?(commandId: string): boolean;
    execute(handle: WorkerSession, phaseId: string): Promise<"entered" | "not-entered">;
  }) {}

  continuation(sessionId: string): PlanExecutionContinuation | undefined {
    const intent = this.options.store.getPlanDecisionForSession(sessionId);
    return intent?.execution ? { originSessionId: intent.originId, executionOwnerId: intent.execution.owner.id,
      originalCommandId: intent.commandId, latestAttemptId: intent.execution.latestAttemptId,
      state: intent.execution.state === "pending" && this.options.active && !this.options.active(intent.execution.latestAttemptId)
        ? "unknown" : intent.execution.state } : undefined;
  }

  async retry(commandId: string, raw: PlanExecutionRetryRequest): Promise<CommandResult> {
    const request = parsePlanExecutionRetryRequest(raw), { store } = this.options;
    const claim = store.getCommand(commandId);
    if (!claim || claim.command?.type !== "session.plan.execution.retry" || claim.command.sessionId !== request.sessionId
      || claim.command.originSessionId !== request.originSessionId || claim.command.originalCommandId !== request.originalCommandId
      || claim.command.expectedAttemptId !== request.expectedAttemptId)
      throw new Error("The Plan execution retry has no matching durable command claim.");
    if (claim.state === "done") return claim.result!;
    const intent = store.getPlanDecisionByCommand(request.originalCommandId, request.originSessionId, request.sessionId);
    const refuse = (code: string, text: string) => failure(commandId, code, text);
    if (!intent?.execution || intent.originId !== request.originSessionId || intent.commandId !== request.originalCommandId
      || intent.execution.owner.id !== request.sessionId)
      return refuse("PLAN_NOT_READY", "The approved Plan execution does not match this conversation.");
    if (intent.execution.state !== "ready" || intent.execution.latestAttemptId !== request.expectedAttemptId)
      return refuse(intent.execution.state === "unknown" || intent.execution.state === "pending" ? "OUTCOME_UNKNOWN" : "PLAN_NOT_READY",
        "This Plan execution is no longer a known not-entered attempt. Refresh its continuation before retrying.");
    const owner = store.getSession(request.sessionId);
    if (!owner || owner.archived || owner.sessionFile !== intent.execution.owner.sessionFile || owner.cwd !== intent.execution.owner.cwd
      || this.options.busy(owner.id)) return refuse("PLAN_NOT_READY", "The approved Plan execution owner must be available and idle.");
    store.reservePlanExecutionRetry(intent, commandId, request);
    let handle: WorkerSession | undefined;
    try {
      handle = await this.options.existing(owner.id) ?? await this.options.reopen(owner.id);
      if (handle.workerFailure || handle.id !== owner.id || handle.sessionFile !== owner.sessionFile || handle.cwd !== owner.cwd)
        throw Object.assign(new Error("The approved Plan execution owner could not be reopened."), { code: "PLAN_NOT_LOADED" });
    } catch (error) {
      const result = failure(commandId, "PLAN_NOT_LOADED", message(error));
      return store.finishPlanExecutionRetry(intent, commandId, "ready", result);
    }
    try {
      const execution = await this.options.execute(handle, intent.execution.phaseId);
      const value: PlanExecutionRetryResult = { type: "session.plan.execution.retry", originalCommandId: intent.commandId,
        attemptId: commandId, execution };
      return store.finishPlanExecutionRetry(intent, commandId, execution === "entered" ? "entered" : "ready",
        { ok: true, commandId, value });
    } catch (error) {
      return store.finishPlanExecutionRetry(intent, commandId, "unknown",
        failure(commandId, "OUTCOME_UNKNOWN", `The Plan execution retry outcome could not be confirmed. ${message(error)}`));
    }
  }

  async decide(commandId: string, raw: PlanMutationRequest): Promise<CommandResult> {
    const request = parsePlanMutationRequest(raw), { store } = this.options;
    const claim = store.getCommand(commandId);
    if (!claim || claim.command?.type !== "session.plan.mutate" || claim.command.sessionId !== request.sessionId
      || claim.command.reviewId !== request.reviewId || claim.command.reviewRevision !== request.reviewRevision)
      throw new Error("The Plan decision has no matching durable command claim.");
    if (claim.state === "done") return claim.result!;
    const origin = store.getSession(request.sessionId);
    const refuse = (text: string) => failure(commandId, "PLAN_NOT_READY", text);
    if (!origin || origin.archived || this.options.busy(origin.id)) return refuse("The original Plan owner must be available and idle.");
    const prior = store.readMetadata<PlanDecisionIntent>(planDecisionKey(origin.id));
    if (prior && (prior.state === "pending" || prior.state === "unknown"))
      return failure(commandId, "OUTCOME_UNKNOWN", "The original Plan decision has no confirmed outcome. Inspect its command receipt; it will not be replayed.");
    const handle = await this.options.existing(origin.id);
    if (!handle || handle.workerFailure || handle.id !== origin.id || handle.sessionFile !== origin.sessionFile || handle.cwd !== origin.cwd)
      return failure(commandId, "PLAN_NOT_LOADED", "The original Plan worker is unavailable. No replacement worker was started.");
    const state = await handle.getPlan();
    if (await this.options.existing(origin.id) !== handle || this.options.busy(origin.id)
      || state.ticket.epoch !== request.ticket.epoch || state.ticket.nativeSessionId !== request.ticket.nativeSessionId
      || state.ticket.revision !== request.ticket.revision || state.review?.id !== request.reviewId
      || state.review.revision !== request.reviewRevision || state.review.status !== "ready" || state.reconciliationRequired)
      return refuse("The captured Plan review is no longer current. Refresh before choosing an action.");
    const environment = store.getSessionEnvironment(origin.id);
    const intent: PlanDecisionIntent = { commandId, originId: origin.id, reviewId: request.reviewId, reviewRevision: request.reviewRevision, state: "pending" };
    store.writeMetadata(planDecisionKey(origin.id), intent);
    store.writeMetadata(planDecisionCommandKey(commandId), intent);
    let receipt: PlanDecisionReceipt | undefined;
    let destination: SessionSummary | undefined;
    let nativeReturned = false;
    let originalRetired = false;
    const replacement = (identity: { nativeSessionId: string; sessionFile: string }, status: "idle" | "interrupted", error?: string): SessionSummary => {
      if (handle.id !== identity.nativeSessionId || handle.sessionFile !== identity.sessionFile || handle.cwd !== origin.cwd
        || identity.nativeSessionId === origin.id || identity.sessionFile === origin.sessionFile)
        throw new Error("The native Plan replacement differs from its original decision.");
      return { ...origin, id: identity.nativeSessionId, sessionFile: identity.sessionFile,
        title: handle.title || "New conversation", model: handle.model, createdAt: handle.createdAt, updatedAt: Date.now(),
        status, error, goalContinuation: undefined, questionDeliveryPending: undefined };
    };
    try {
      const prepared = await handle.preparePlanDecision(commandId, request);
      nativeReturned = true;
      receipt = prepared.receipt;
      if (receipt.reviewId !== request.reviewId || receipt.reviewRevision !== request.reviewRevision || receipt.action !== request.mutation.action)
        throw new Error("The native Plan receipt belongs to a different review decision.");
      intent.receipt = receipt;
      if (prepared.execution) intent.phaseId = prepared.execution.phaseId;
      if (prepared.transition) intent.destination = { id: prepared.transition.nativeSessionId, sessionFile: prepared.transition.sessionFile };
      // Preserve an observed replacement even when cleanup or binding fails.
      store.writeMetadata(planDecisionKey(origin.id), intent);
      store.writeMetadata(planDecisionCommandKey(commandId), intent);
      if (receipt.outcome === "unknown") {
        if (prepared.transition) {
          const proposed = replacement(prepared.transition, "interrupted",
            receipt.message || "The native Plan transition completed with an unknown later outcome. Inspect this replacement before continuing.");
          await handle.dispose(); await this.options.forget(origin.id, handle); originalRetired = true;
          store.bindPlanDecisionDestination(intent, proposed, environment); destination = proposed;
        }
        return this.finish(intent, receipt, destination);
      }
      let executionOwner = handle;
      if (prepared.transition) {
        const identity = prepared.transition;
        const proposed = replacement(identity, "idle");
        if (prepared.execution) intent.execution = { phaseId: prepared.execution.phaseId,
          owner: { id: proposed.id, sessionFile: proposed.sessionFile, cwd: proposed.cwd }, latestAttemptId: commandId, state: "pending" };
        await handle.dispose();
        await this.options.forget(origin.id, handle); originalRetired = true;
        store.bindPlanDecisionDestination(intent, proposed, environment);
        destination = proposed;
        if (prepared.execution) {
          executionOwner = await this.options.reopen(destination.id);
          if (executionOwner.workerFailure || executionOwner.id !== destination.id || executionOwner.sessionFile !== destination.sessionFile
            || executionOwner.cwd !== destination.cwd) throw new Error("The original approved Plan replacement could not be reopened.");
        }
      } else if (await this.options.existing(origin.id) !== handle) {
        throw new Error("The original Plan worker changed after its decision.");
      }
      if (prepared.execution && !intent.execution) {
        intent.execution = { phaseId: prepared.execution.phaseId,
          owner: { id: origin.id, sessionFile: origin.sessionFile, cwd: origin.cwd }, latestAttemptId: commandId, state: "pending" };
        store.writeMetadata(planDecisionKey(origin.id), intent);
        store.writeMetadata(planDecisionCommandKey(commandId), intent);
      }
      if (prepared.execution) receipt = { ...receipt, execution: await this.options.execute(executionOwner, prepared.execution.phaseId) };
      return this.finish(intent, receipt, destination);
    } catch (error) {
      if (!nativeReturned && error && typeof error === "object" && "code" in error && error.code === "PLAN_REJECTED") {
        intent.state = "rejected";
        const result = failure(commandId, "PLAN_REJECTED", message(error));
        return store.finishPlanDecision(intent, result);
      }
      // A thrown transport/cleanup error does not prove that native effects did
      // not happen. Preserve the actual identity when available, never dispatch.
      const base: PlanDecisionReceipt = receipt ?? { commandId, reviewId: request.reviewId, reviewRevision: request.reviewRevision,
        action: request.mutation.action, outcome: "unknown", artifact: ["save", "edit"].includes(request.mutation.action) ? "unknown" : "unchanged",
        transition: request.mutation.action === "save" || request.mutation.action === "approve" && request.mutation.context === "fresh" ? "unknown" : "unchanged",
        execution: ["approve", "refine"].includes(request.mutation.action) ? "unknown" : "not-requested" };
      receipt = { ...base, outcome: "unknown", message: message(error),
        ...(intent.phaseId && base.execution !== "entered" ? { execution: "unknown" } : {}) };
      if (intent.execution) intent.execution.state = "unknown";
      if (!originalRetired && (handle.id !== origin.id || handle.sessionFile !== origin.sessionFile)) {
        intent.destination = { id: handle.id, sessionFile: handle.sessionFile };
        if (!destination) receipt = { ...receipt, transition: "unknown", destinationSessionId: handle.id };
        try { await handle.dispose(); await this.options.forget(origin.id, handle); } catch { /* Original reservation stays held on failed drain. */ }
      }
      return this.finish(intent, receipt, destination);
    }
  }

  private finish(intent: PlanDecisionIntent, receipt: PlanDecisionReceipt, destination?: SessionSummary): CommandResult {
    intent.state = receipt.outcome === "unknown" ? "unknown" : "complete";
    intent.receipt = receipt;
    if (intent.execution) intent.execution.state = receipt.execution === "entered" ? "entered"
      : receipt.execution === "not-entered" ? "ready" : receipt.execution === "unknown" ? "unknown" : intent.execution.state;
    return this.options.store.finishPlanDecision(intent, { ok: true, commandId: intent.commandId,
      value: { type: "session.plan.mutate", receipt, ...(destination ? { session: destination } : {}) } });
  }
}
