import type { PlanDecisionReceipt, PlanDocumentReadRequest, PlanMutation, PlanMutationRequest, PlanReview, PlanTicket, SessionPlan } from "../../../../packages/shared/src/session-plan";
import { parsePlanDocumentAction, parsePlanDocumentSection, type PlanDocumentAction, type PlanDocumentSection } from "../../../../packages/shared/src/plan-document";

/** Proven no-effect refusal: local admission, or an explicit host preflight code. */
export class PlanReviewNotSubmitted extends Error {}

export interface PlanReviewOwner { hostId: string; sessionId: string }
export interface PlanReviewFailure {
  owner: PlanReviewOwner; commandId: string; request: PlanMutationRequest; message: string;
}
export interface PlanReviewBinding { sessionId: string; ticket: PlanTicket; reviewId: string; reviewRevision: string }
export interface PlanReviewExecutionChoice { role: string; provider: string; modelId: string; thinking?: string; selected?: boolean; default?: boolean; label?: string; unavailableReason?: string }
export interface PlanReviewInput {
  owner: PlanReviewOwner; plan: SessionPlan; connected: boolean; fresh: boolean; open: boolean;
  executionChoices: readonly PlanReviewExecutionChoice[];
  receipt?: PlanDecisionReceipt; failure?: PlanReviewFailure; error?: string;
}
export interface PlanReviewPorts {
  mutate(owner: PlanReviewOwner, request: PlanMutationRequest): Promise<PlanDecisionReceipt>;
  dismiss(owner: PlanReviewOwner, binding: PlanReviewBinding): Promise<void>;
  reopen(owner: PlanReviewOwner, binding: PlanReviewBinding): Promise<void>;
  /** Reconcile the original command; never reissue a mutation to recover. */
  refresh(owner: PlanReviewOwner, original?: { request?: PlanMutationRequest; receipt?: PlanDecisionReceipt }): Promise<void>;
  copy?(text: string): Promise<void>;
  openPlan?(owner: PlanReviewOwner, binding: PlanReviewBinding, reference: string): Promise<void>;
  readDocumentSection?(owner: PlanReviewOwner, request: PlanDocumentReadRequest): Promise<PlanDocumentSection>;
}
type Draft = {
  base: PlanReview; text: string; editing: boolean; feedback: string; destination: string; role: string; roleTouched: boolean;
  pending?: string; error?: string; uncertain: boolean; receipt?: PlanDecisionReceipt;
  request?: PlanMutationRequest; acceptedEdit?: { originalRevision: string; content: string };
  previousCommandId?: string; failedCommandId?: string;
};
export interface PlanReviewView extends PlanReviewInput {
  documentKey?: string; draft?: Readonly<Draft>; dirty: boolean; conflict: boolean; blockedReason?: string;
  canCopy: boolean; canOpenPlan: boolean;
  refreshing: boolean;
}
const key = (input: PlanReviewInput) => JSON.stringify([input.owner.hostId, input.owner.sessionId,
  input.plan.ticket.epoch, input.plan.ticket.nativeSessionId, input.plan.review?.id]);
const receiptMatches = (receipt: PlanDecisionReceipt, request: PlanMutationRequest) => receipt.reviewId === request.reviewId
  && receipt.reviewRevision === request.reviewRevision && receipt.action === request.mutation.action;

function samePlanRequest(a: PlanMutationRequest, b: PlanMutationRequest) {
  if (a.sessionId !== b.sessionId || a.ticket.epoch !== b.ticket.epoch || a.ticket.nativeSessionId !== b.ticket.nativeSessionId
    || a.ticket.revision !== b.ticket.revision || a.reviewId !== b.reviewId || a.reviewRevision !== b.reviewRevision) return false;
  const left = a.mutation, right = b.mutation;
  if (left.action === "edit") return right.action === "edit" && left.content === right.content;
  if (left.action === "refine") return right.action === "refine" && left.text === right.text;
  if (left.action === "save") return right.action === "save" && left.destination === right.destination;
  if (left.action === "document") return right.action === "document" && left.renderColumns === right.renderColumns
    && JSON.stringify(parsePlanDocumentAction(left.documentAction)) === JSON.stringify(parsePlanDocumentAction(right.documentAction));
  return right.action === "approve" && left.context === right.context && left.executionRole === right.executionRole;
}

/** Local drafts and in-flight UI operations only. Native review/tickets and
 * durable command outcomes remain supplied by the owning bridge. */
export class PlanReviewModel {
  #input: PlanReviewInput; #ports: PlanReviewPorts; #drafts = new Map<string, Draft>();
  #listeners = new Set<() => void>(); #view!: PlanReviewView;
  #readPending?: string; #readError?: { owner: string; text: string };
  constructor(input: PlanReviewInput, ports: PlanReviewPorts) { this.#input = input; this.#ports = ports; this.#reconcile(); this.#publish(); }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = () => this.#view;
  /** Called by the React layout effect, never by a speculative render. */
  configure(input: PlanReviewInput, ports: PlanReviewPorts) { this.#input = input; this.#ports = ports; this.#reconcile(); this.#publish(); }
  #draft() { return this.#drafts.get(key(this.#input)); }
  #reconcile() {
    const review = this.#input.plan.review; if (!review) return;
    let draft = this.#draft();
    if (!draft) {
      const role = this.#input.plan.defaultExecutionRole ?? this.#input.executionChoices.find(choice => choice.default)?.role
        ?? this.#input.executionChoices.find(choice => choice.selected)?.role ?? "";
      draft = { base: { ...review }, text: review.content, editing: false, feedback: "", destination: "", role, roleTouched: false, uncertain: false };
      this.#drafts.set(key(this.#input), draft);
    }
    if (!draft.roleTouched) draft.role = this.#input.plan.defaultExecutionRole ?? this.#input.executionChoices.find(choice => choice.default)?.role
      ?? this.#input.executionChoices.find(choice => choice.selected)?.role ?? "";
    const receipt = this.#input.receipt;
    if (receipt && draft.request && receiptMatches(receipt, draft.request)
      && (draft.receipt?.commandId === receipt.commandId || draft.previousCommandId !== receipt.commandId)
      && (!draft.receipt || draft.receipt.commandId === receipt.commandId)) this.#acceptReceipt(draft, receipt);
    const failure = this.#input.failure;
    if (failure && draft.request && failure.owner.hostId === this.#input.owner.hostId && failure.owner.sessionId === this.#input.owner.sessionId
      && failure.commandId !== draft.previousCommandId && (!draft.receipt || draft.receipt.commandId === failure.commandId)
      && samePlanRequest(failure.request, draft.request)) {
      draft.uncertain = false; draft.error = failure.message; draft.failedCommandId = failure.commandId;
      // Failure evidence is not a cancelled/successful decision receipt.
      draft.receipt = undefined;
    }
    if (review.revision !== draft.base.revision) {
      const acknowledged = draft.acceptedEdit?.originalRevision === draft.base.revision && draft.acceptedEdit.content === review.content;
      if (acknowledged || !draft.pending && !draft.uncertain && draft.text === draft.base.content) {
        const clean = draft.text === draft.base.content;
        draft.base = { ...review }; if (clean) draft.text = review.content;
        draft.acceptedEdit = undefined;
      }
    }
  }
  #publish() {
    const input = this.#input, draft = this.#draft(), review = input.plan.review;
    const conflict = !!draft && !!review && draft.base.revision !== review.revision;
    const blockedReason = !input.connected ? "Offline · reconnect before changing this plan."
      : !input.fresh ? "Plan state is stale. Refresh before making a decision."
      : input.plan.reconciliationRequired ? "A native plan transition needs reconciliation. Check status; do not repeat the action."
      : !review ? "No plan is available to review."
      : review.status === "unknown" || draft?.uncertain || input.receipt?.reviewId === review.id && input.receipt.outcome === "unknown"
        ? "The original outcome is not confirmed. Check status before another decision."
      : review.status === "deciding" || draft?.pending || this.#readPending === key(input) ? "A plan action is in progress."
      : draft?.receipt?.outcome === "applied" && ["approve", "save"].includes(draft.receipt.action)
        ? "The host confirmed this decision. Refresh to see the resulting session."
      : conflict ? "The host plan changed. Preserve your edits or load the latest plan before deciding."
      : draft?.acceptedEdit?.originalRevision === draft?.base.revision ? "Edits were saved. Refresh to load the confirmed plan revision."
      : input.plan.busyReason;
    this.#view = { ...input, error: this.#readError?.owner === key(input) ? this.#readError.text : input.error, documentKey: review ? key(input) : undefined, draft: draft ? { ...draft, base: { ...draft.base } } : undefined,
      dirty: !!draft && draft.text !== draft.base.content, conflict, blockedReason, canCopy: !!this.#ports.copy, canOpenPlan: !!this.#ports.openPlan,
      refreshing: this.#readPending === key(input) };
    for (const listener of this.#listeners) listener();
  }
  setText(text: string) { const draft = this.#draft(); if (draft) { draft.text = text; this.#publish(); } }
  setEditing(editing: boolean) { const draft = this.#draft(); if (draft) { draft.editing = editing; this.#publish(); } }
  setFeedback(text: string) { const draft = this.#draft(); if (draft) { draft.feedback = text; this.#publish(); } }
  setDestination(destination: string) { const draft = this.#draft(); if (draft) { draft.destination = destination; this.#publish(); } }
  setRole(role: string) { const draft = this.#draft(); if (draft) { draft.role = role; draft.roleTouched = true; this.#publish(); } }
  discardEdits() {
    const draft = this.#draft(), review = this.#input.plan.review;
    if (!draft || !review || draft.pending || draft.uncertain) return;
    draft.base = { ...review }; draft.text = review.content; draft.editing = false; draft.error = undefined; this.#publish();
  }
  #binding(draft: Draft): PlanReviewBinding {
    return { sessionId: this.#input.owner.sessionId, ticket: { ...this.#input.plan.ticket }, reviewId: draft.base.id, reviewRevision: draft.base.revision };
  }
  #acceptReceipt(draft: Draft, receipt: PlanDecisionReceipt) {
    if (!draft.request || !receiptMatches(receipt, draft.request)) return;
    draft.receipt = { ...receipt }; draft.uncertain = receipt.outcome === "unknown";
    if (receipt.outcome !== "unknown") draft.error = undefined;
    if (receipt.outcome !== "applied") return;
    const mutation = draft.request.mutation;
    if (mutation.action === "edit") draft.acceptedEdit = { originalRevision: draft.request.reviewRevision, content: mutation.content };
    if (mutation.action === "refine" && draft.feedback === mutation.text) draft.feedback = "";
  }
  async mutate(action: Exclude<PlanMutation["action"], "document">, context?: "fresh" | "compact" | "keep") {
    const draft = this.#draft(); if (!draft) return;
    if (!this.#input.open || this.#input.plan.review?.status === "dismissed" || this.#input.plan.mode !== "active") {
      draft.error = "Reopen an active plan review before making a decision."; this.#publish(); return;
    }
    if (this.#view.blockedReason) { draft.error = this.#view.blockedReason; this.#publish(); return; }
    let mutation: PlanMutation;
    if (action === "edit") { if (draft.text === draft.base.content) return; mutation = { action, content: draft.text }; }
    else if (this.#view.dirty) { draft.error = "Save or discard your plan edits before continuing."; this.#publish(); return; }
    else if (action === "refine") {
      mutation = { action, text: draft.feedback.trim() ? draft.feedback : "" };
    } else if (action === "save") {
      if (!draft.destination.trim()) { draft.error = "Enter a destination on the owning host."; this.#publish(); return; }
      mutation = { action, destination: draft.destination };
    } else {
      if (!context) return;
      if (context === "keep" && !this.#input.plan.review?.canKeepContext) {
        draft.error = this.#input.plan.review?.keepContextReason ?? "Keeping context is unavailable."; this.#publish(); return;
      }
      const choices = this.#input.executionChoices;
      if (draft.role && !choices.some(choice => choice.role === draft.role && !choice.unavailableReason)) {
        draft.error = "The selected execution role is no longer available. Choose an available role."; this.#publish(); return;
      }
      mutation = { action, context, ...(draft.role && choices.length > 1 ? { executionRole: draft.role } : {}) };
    }
    await this.#submit(draft, mutation);
  }
  async readDocumentSection(sectionId: string): Promise<PlanDocumentSection> {
    const input = this.#input, document = input.plan.review?.document, draft = this.#draft();
    if (!draft || !document || !input.open || !input.connected || !input.fresh || this.#view.blockedReason
      || input.plan.review?.status !== "ready" || !this.#ports.readDocumentSection)
      throw new Error("Refresh an open native Plan document before reading a section.");
    if (!document.sections.some(section => section.sectionId === sectionId)) throw new Error("The native Plan section changed.");
    const request: PlanDocumentReadRequest = { ...this.#binding(draft), selection: {
      documentRevision: document.documentRevision, renderColumns: document.renderColumns, sectionId,
    } };
    const owner = { ...input.owner }, ownerKey = key(input), ports = this.#ports;
    const section = parsePlanDocumentSection(await ports.readDocumentSection!(owner, request), request.selection);
    if (key(this.#input) !== ownerKey || !this.#input.open || !this.#input.fresh || !this.#input.connected
      || this.#input.plan.ticket.revision !== request.ticket.revision
      || this.#input.plan.review?.status !== "ready" || this.#view.blockedReason
      || this.#input.plan.review?.document?.renderColumns !== request.selection.renderColumns
      || this.#input.plan.review?.document?.documentRevision !== request.selection.documentRevision)
      throw new Error("The original Plan document changed during inspection.");
    return section;
  }
  async mutateDocument(raw: PlanDocumentAction) {
    const draft = this.#draft(), document = this.#input.plan.review?.document;
    if (!draft) return;
    if (!document || !this.#input.open || this.#input.plan.mode !== "active" || this.#input.plan.review?.status !== "ready" || this.#view.blockedReason || this.#view.dirty) {
      draft.error = this.#view.blockedReason ?? "Save or discard edits, then reopen the original Plan document before changing it.";
      this.#publish(); return;
    }
    let documentAction: PlanDocumentAction;
    try { documentAction = parsePlanDocumentAction(raw); }
    catch (cause) { draft.error = cause instanceof Error ? cause.message : String(cause); this.#publish(); return; }
    if (documentAction.expectedDocumentRevision !== document.documentRevision) {
      draft.error = "The Plan document changed. Refresh before changing its sections or annotations."; this.#publish(); return;
    }
    return this.#submit(draft, { action: "document", documentAction, renderColumns: document.renderColumns });
  }
  async #submit(draft: Draft, mutation: PlanMutation) {
    const owner = { ...this.#input.owner }, request = { ...this.#binding(draft), mutation }, ports = this.#ports;
    draft.previousCommandId = this.#input.failure?.commandId ?? draft.failedCommandId ?? this.#input.receipt?.commandId ?? draft.receipt?.commandId;
    draft.failedCommandId = undefined;
    draft.request = request; draft.pending = mutation.action; draft.error = undefined; draft.receipt = undefined; this.#publish();
    try {
      const receipt = await ports.mutate(owner, request);
      if (!receiptMatches(receipt, request)) throw new Error("The host returned a receipt for a different review action.");
      this.#acceptReceipt(draft, receipt);
      return receipt;
    } catch (cause) {
      draft.uncertain = !(cause instanceof PlanReviewNotSubmitted); draft.error = cause instanceof Error ? cause.message : String(cause);
    } finally { draft.pending = undefined; this.#reconcile(); this.#publish(); }
  }
  async auxiliary(action: "dismiss" | "reopen" | "refresh" | "copy" | "open") {
    const draft = this.#draft();
    if (action === "refresh") {
      if (!this.#input.connected || this.#readPending === key(this.#input) || draft?.pending) return;
      const owner = { ...this.#input.owner }, ports = this.#ports, ownerKey = key(this.#input);
      const receipt = draft?.receipt ?? this.#input.receipt;
      this.#readPending = ownerKey; this.#readError = undefined; this.#publish();
      try { await ports.refresh(owner, draft?.request || receipt ? { request: draft?.request, receipt } : undefined); }
      catch (cause) { this.#readError = { owner: ownerKey, text: cause instanceof Error ? cause.message : String(cause) }; }
      finally { if (this.#readPending === ownerKey) this.#readPending = undefined; this.#reconcile(); this.#publish(); }
      return;
    }
    if (!draft) return;
    const input = this.#input, owner = { ...input.owner }, binding = this.#binding(draft), ports = this.#ports;
    if (draft.pending) return;
    if (["refresh", "dismiss", "reopen", "open"].includes(action) && !input.connected) return;
    if (["dismiss", "reopen", "open"].includes(action) && this.#view.blockedReason) return;
    draft.pending = action; draft.error = undefined; this.#publish();
    try {
      if (action === "dismiss") await ports.dismiss(owner, binding);
      else if (action === "reopen") await ports.reopen(owner, binding);
      else if (action === "copy") { if (!ports.copy) throw new Error("Copy is unavailable in this desktop context."); await ports.copy(draft.text); }
      else { if (!ports.openPlan) throw new Error("Open in editor is unavailable in this desktop context."); await ports.openPlan(owner, binding, draft.base.reference); }
    } catch (cause) { draft.error = cause instanceof Error ? cause.message : String(cause); }
    finally { draft.pending = undefined; this.#reconcile(); this.#publish(); }
  }
}
