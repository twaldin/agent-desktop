import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { CommandEnvelope, DesktopBridge, DesktopEvent, SessionSummary } from "../../../../packages/shared/src/protocol";
import { parsePlanExecutionRetryRequest, parsePlanDecisionJournalReceipt, type PlanExecutionContinuation, parsePlanCommandId, parsePlanControlRequest, parsePlanMutationRequest, parsePlanDecisionReceipt, parseSessionPlan, parseSessionPlanResponse, type PlanControlRequest, type PlanDecisionReceipt, type PlanMutationRequest, type SessionPlan } from "../../../../packages/shared/src/session-plan";
import { PlanReviewNotSubmitted, type PlanReviewOwner, type PlanReviewFailure } from "./plan-review-model";
import { parsePlanDocumentReadRequest, parsePlanDocumentResponse, type PlanDocumentReadRequest } from "../../../../packages/shared/src/session-plan";

export interface SessionPlanPorts {
  bridge: Pick<DesktopBridge, "getPlan" | "getPlanDocumentSection" | "command" | "subscribe">;
  documentSupported?: boolean;
  storage?: { read(key: string): string | null; write(key: string, value: string): void; remove(key: string): void };
  onTransition(owner: PlanReviewOwner, session: Pick<SessionSummary, "id" | "hostId">): void;
}
export interface SessionPlanView {
  owner: PlanReviewOwner; value: SessionPlan | null; fresh: boolean; loading: boolean;
  pending: boolean; uncertain: boolean; error?: string; unavailable?: string; receipt?: PlanDecisionReceipt; failure?: PlanReviewFailure;
  executionContinuation?: PlanExecutionContinuation; executionRetryCommandId?: string;
}
const noEffectCodes = new Set(["PLAN_NOT_LOADED", "PLAN_NOT_READY", "PLAN_REJECTED"]);
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Owns the desktop read/admission lifetime, not native Plan state. Every write
 * goes through the existing deduplicated host command path. Reads never replay. */
export class SessionPlanState {
  #ports?: SessionPlanPorts; #enabled = false; #generation = 0; #reading = false; #again = false; #readToken = 0;
  #listeners = new Set<() => void>(); #view: SessionPlanView;
  #original?: CommandEnvelope; #restored = false;
  #storageKey() { return `agent-desktop:plan-command:v1:${JSON.stringify(this.owner)}`; }
  #remember(envelope?: CommandEnvelope) {
    const storage = this.#ports?.storage;
    if (storage) { if (envelope) storage.write(this.#storageKey(), JSON.stringify(envelope)); else storage.remove(this.#storageKey()); }
    this.#original = envelope;
  }
  #refused(original: CommandEnvelope, reason: string) {
    this.#remember();
    const command = original.command;
    if (command.type === "session.plan.mutate") {
      const { type: _type, ...request } = command;
      this.#set({ failure: { owner: { ...this.owner }, commandId: original.id, request: structuredClone(request), message: reason }, receipt: undefined });
    }
    this.#set({ uncertain: false, error: reason });
  }
  constructor(readonly owner: PlanReviewOwner) {
    this.#view = { owner, value: null, fresh: false, loading: false, pending: false, uncertain: false };
  }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = () => this.#view;
  #set(patch: Partial<SessionPlanView>) { this.#view = { ...this.#view, ...patch, executionRetryCommandId: this.#original?.command.type === "session.plan.execution.retry" ? this.#original.id : undefined }; this.#listeners.forEach(listener => listener()); }
  #documentGeneration = 0;
  configure(ports: SessionPlanPorts, enabled: boolean, unavailable?: string) {
    if (this.#ports?.bridge !== ports.bridge || this.#ports?.documentSupported !== ports.documentSupported) this.#documentGeneration++;
    this.#ports = ports;
    if (!this.#restored) {
      this.#restored = true;
      try {
        const text = ports.storage?.read(this.#storageKey());
        if (text) {
          const raw: unknown = JSON.parse(text);
          if (!raw || typeof raw !== "object" || !("id" in raw) || !("commandVersion" in raw) || (raw.commandVersion !== 19 && raw.commandVersion !== 20)
            || !("command" in raw) || !raw.command || typeof raw.command !== "object" || !("type" in raw.command)
            || Object.keys(raw).some(key => !["id", "commandVersion", "command"].includes(key))) throw new Error("Stored Plan command is invalid.");
          const id = parsePlanCommandId(raw.id), { type, ...fields } = raw.command;
          const command = type === "session.plan.mutate" ? { type, ...parsePlanMutationRequest(fields) } as const
            : type === "session.plan.control" ? { type, ...parsePlanControlRequest(fields) } as const
            : type === "session.plan.execution.retry" ? { type, ...parsePlanExecutionRetryRequest(fields) } as const : undefined;
          if (!command || command.sessionId !== this.owner.sessionId) throw new Error("Stored Plan command belongs to another owner.");
          if (command.type === "session.plan.mutate" && command.mutation.action === "document" && raw.commandVersion !== 20)
            throw new Error("Stored Plan document command requires version 20.");
          this.#original = { id, commandVersion: raw.commandVersion, command };
          this.#set({ uncertain: true, error: "Check the original Plan action status before making another decision." });
        }
      } catch (cause) { this.#set({ uncertain: true, error: `Plan recovery record could not be read: ${message(cause)}` }); }
    }
    if (this.#enabled !== enabled) { this.#generation++; this.#reading = false; this.#again = false; }
    this.#enabled = enabled;
    this.#set({ unavailable, ...(!enabled ? { fresh: false, loading: false } : {}) });
  }
  disconnect() { this.#enabled = false; this.#generation++; this.#reading = false; this.#again = false; this.#set({ fresh: false, loading: false }); }
  #assert(owner = this.owner) {
    if (!this.#enabled || owner.hostId !== this.owner.hostId || owner.sessionId !== this.owner.sessionId)
      throw new PlanReviewNotSubmitted("Open the connected owning conversation before changing its Plan mode.");
  }
  refresh = async () => {
    this.#assert();
    if (this.#reading) { this.#again = true; return; }
    const ports = this.#ports!, generation = this.#generation, token = ++this.#readToken, original = this.#original;
    this.#reading = true; this.#set({ loading: true, fresh: false });
    try {
      if (!ports.bridge.getPlan) throw new Error("Update the desktop to read native Plan state.");
      const response = parseSessionPlanResponse(await ports.bridge.getPlan(this.owner.sessionId, this.owner.hostId, original?.id), this.owner.hostId, this.owner.sessionId, original?.id);
      if (this.#enabled && generation === this.#generation && token === this.#readToken) {
        let recovered: PlanDecisionReceipt | undefined, refusal: string | undefined;
        const journal = response.decisionReceipt;
        if (original && journal?.value) {
          const value = journal.value;
          if (value.type !== original.command.type) throw new Error("The journal returned a different Plan command type.");
          if (value.type === "session.plan.mutate" && original.command.type === "session.plan.mutate") {
            recovered = value.receipt;
            if (recovered.reviewId !== original.command.reviewId || recovered.reviewRevision !== original.command.reviewRevision || recovered.action !== original.command.mutation.action)
              throw new Error("The journal decision belongs to another Plan review.");
            this.#remember(recovered.outcome === "unknown" ? original : undefined);
            this.#set({ receipt: recovered, uncertain: recovered.outcome === "unknown" });
          } else if (value.type === "session.plan.execution.retry" && original.command.type === "session.plan.execution.retry") {
            if (value.originalCommandId !== original.command.originalCommandId || value.attemptId !== original.id)
              throw new Error("The journal returned another original Plan execution attempt.");
            this.#remember(); this.#set({ uncertain: false });
          } else if (value.type === "session.plan.control") { this.#remember(); this.#set({ uncertain: false }); }
        }
        if (original && journal?.state === "failed") {
          // The owning journal reserves failed for its explicit no-effect
          // allowlist. Generic failures are classified as unknown by the host.
          refusal = "The owning host confirmed the original Plan command was refused before any effects. Review the current plan before choosing another action.";
          this.#refused(original, refusal);
        }
        this.#set({ value: response.value, executionContinuation: response.executionContinuation, unavailable: response.unavailable, fresh: true,
          error: refusal ?? (this.#view.uncertain ? "The original Plan action is not confirmed. Check status without repeating the decision." : this.#view.failure?.message) });
        // A read-only original journal receipt is also an authoritative committed
        // identity. It never causes another approval, prompt, or native transition.
        if (recovered?.transition === "new-session" && recovered.destinationSessionId)
          ports.onTransition(this.owner, { hostId: this.owner.hostId, id: recovered.destinationSessionId });
      }
    } catch (cause) { if (this.#enabled && generation === this.#generation && token === this.#readToken) this.#set({ fresh: false, error: message(cause) }); }
    finally {
      if (generation === this.#generation && token === this.#readToken) {
        this.#reading = false; this.#set({ loading: false });
        if (this.#again && this.#enabled) { this.#again = false; void this.refresh(); }
      }
    }
  };
  #invalidateRead() { this.#readToken++; this.#reading = false; this.#again = false; this.#set({ loading: false, fresh: false }); }
  #admit(owner: PlanReviewOwner, ticket: PlanControlRequest["ticket"]) {
    this.#assert(owner);
    if (!this.#view.fresh || this.#view.pending || this.#view.uncertain || !this.#view.value)
      throw new PlanReviewNotSubmitted("Refresh the original Plan action before making another decision.");
    const current = this.#view.value.ticket;
    if (ticket.epoch !== current.epoch || ticket.nativeSessionId !== current.nativeSessionId || ticket.revision !== current.revision)
      throw new PlanReviewNotSubmitted("The native Plan owner changed. Refresh and review its current state.");
    if (this.#view.value.reconciliationRequired) throw new PlanReviewNotSubmitted("The original native Plan action needs reconciliation.");
  }
  openExecutionOwner(expected: PlanExecutionContinuation) {
    this.#assert();
    const continuation = this.#view.executionContinuation;
    if (!continuation || continuation.originalCommandId !== expected.originalCommandId || continuation.executionOwnerId !== expected.executionOwnerId
      || continuation.originSessionId !== expected.originSessionId) throw new PlanReviewNotSubmitted("Refresh the original Plan execution owner.");
    this.#ports!.onTransition(this.owner, { hostId: this.owner.hostId, id: continuation.executionOwnerId });
  }
  async retryExecution(expected: PlanExecutionContinuation): Promise<void> {
    this.#assert();
    const current = this.#view.executionContinuation;
    if (!this.#view.fresh || this.#view.pending || this.#view.uncertain || !current || current.state !== "ready"
      || current.executionOwnerId !== this.owner.sessionId || current.originalCommandId !== expected.originalCommandId
      || current.originSessionId !== expected.originSessionId || current.executionOwnerId !== expected.executionOwnerId
      || current.latestAttemptId !== expected.latestAttemptId || expected.state !== "ready") {
      const reason = "Refresh the exact original Plan execution attempt before retrying.";
      this.#set({ error: reason }); throw new PlanReviewNotSubmitted(reason);
    }
    const request = parsePlanExecutionRetryRequest({ sessionId: current.executionOwnerId, originSessionId: current.originSessionId,
      originalCommandId: current.originalCommandId, expectedAttemptId: current.latestAttemptId });
    const ports = this.#ports!, generation = this.#generation;
    const envelope: CommandEnvelope = { id: crypto.randomUUID(), commandVersion: 19, command: { type: "session.plan.execution.retry", ...request } };
    try { this.#remember(envelope); } catch (cause) {
      const reason = `The Plan retry recovery record could not be saved: ${message(cause)}`;
      this.#set({ error: reason }); throw new PlanReviewNotSubmitted(reason);
    }
    this.#invalidateRead(); this.#set({ pending: true, error: undefined, failure: undefined });
    try {
      const result = await ports.bridge.command(envelope, this.owner.hostId);
      if (result.commandId !== envelope.id) throw new Error("The Plan retry response belongs to another command.");
      if (!result.ok) {
        if (noEffectCodes.has(result.error.code)) { this.#refused(envelope, result.error.message); throw new PlanReviewNotSubmitted(result.error.message); }
        throw new Error(result.error.message);
      }
      const journal = parsePlanDecisionJournalReceipt({ commandId: envelope.id, state: "succeeded", value: result.value }, envelope.id);
      const value = journal.value;
      if (value?.type !== "session.plan.execution.retry" || value.originalCommandId !== request.originalCommandId || value.attemptId !== envelope.id)
        throw new Error("The host did not confirm this exact original Plan execution attempt.");
      this.#remember(); this.#invalidateRead(); this.#set({ uncertain: false });
      if (this.#enabled && generation === this.#generation) await this.refresh();
    } catch (cause) { this.#set({ error: message(cause), uncertain: !!this.#original, fresh: false }); throw cause; }
    finally { this.#set({ pending: false }); }
  }
  async control(owner: PlanReviewOwner, request: PlanControlRequest) {
    if (request.sessionId !== owner.sessionId) throw new PlanReviewNotSubmitted("The Plan request belongs to another conversation.");
    this.#admit(owner, request.ticket);
    const ports = this.#ports!, generation = this.#generation;
    const envelope: CommandEnvelope = { id: crypto.randomUUID(), commandVersion: 19, command: { type: "session.plan.control", ...structuredClone(request) } };
    try { this.#remember(envelope); } catch (cause) { throw new PlanReviewNotSubmitted(`The Plan recovery record could not be saved: ${message(cause)}`); }
    this.#invalidateRead(); this.#set({ pending: true, error: undefined, failure: undefined });
    try {
      const result = await ports.bridge.command(envelope, owner.hostId);
      if (result.commandId !== envelope.id) throw new Error("The Plan response belongs to another command.");
      if (!result.ok) {
        if (noEffectCodes.has(result.error.code)) { this.#refused(envelope, result.error.message); throw new PlanReviewNotSubmitted(result.error.message); }
        throw new Error(result.error.message);
      }
      if (!result.value || !("type" in result.value) || result.value.type !== "session.plan.control") throw new Error("The original Plan control outcome was not returned.");
      const value = parseSessionPlan(result.value.state);
      this.#remember(); this.#invalidateRead();
      this.#set({ value, fresh: this.#enabled && generation === this.#generation, uncertain: false });
      return result.value;
    } catch (cause) {
      this.#set({ error: message(cause), uncertain: !!this.#original, fresh: false }); throw cause;
    } finally { this.#set({ pending: false }); }
  }
  async mutate(owner: PlanReviewOwner, request: PlanMutationRequest): Promise<PlanDecisionReceipt> {
    if (request.sessionId !== owner.sessionId) throw new PlanReviewNotSubmitted("The Plan request belongs to another conversation.");
    this.#admit(owner, request.ticket);
    const ports = this.#ports!, generation = this.#generation;
    if (request.mutation.action === "document" && !ports.documentSupported)
      throw new PlanReviewNotSubmitted("Update the owning host to edit native Plan sections and annotations.");
    const envelope: CommandEnvelope = { id: crypto.randomUUID(), commandVersion: request.mutation.action === "document" ? 20 : 19,
      command: { type: "session.plan.mutate", ...structuredClone(request) } };
    try { this.#remember(envelope); } catch (cause) { throw new PlanReviewNotSubmitted(`The Plan recovery record could not be saved: ${message(cause)}`); }
    this.#invalidateRead(); this.#set({ pending: true, error: undefined, receipt: undefined, failure: undefined });
    try {
      const result = await ports.bridge.command(envelope, owner.hostId);
      if (result.commandId !== envelope.id) throw new Error("The Plan response belongs to another command.");
      if (!result.ok) {
        if (noEffectCodes.has(result.error.code)) { this.#refused(envelope, result.error.message); throw new PlanReviewNotSubmitted(result.error.message); }
        throw new Error(result.error.message);
      }
      if (!result.value || !("type" in result.value) || result.value.type !== "session.plan.mutate") throw new Error("The original Plan decision receipt was not returned.");
      const receipt = parsePlanDecisionReceipt(result.value.receipt, envelope.id);
      if (receipt.reviewId !== request.reviewId || receipt.reviewRevision !== request.reviewRevision || receipt.action !== request.mutation.action)
        throw new Error("The returned decision belongs to another Plan review.");
      this.#remember(receipt.outcome === "unknown" ? envelope : undefined); this.#invalidateRead();
      this.#set({ receipt, uncertain: receipt.outcome === "unknown", fresh: false });
      const destination = result.value.session;
      if (receipt.transition === "new-session") {
        if (!destination || destination.id !== receipt.destinationSessionId || destination.hostId !== owner.hostId)
          throw new Error("The host did not confirm the destination session identity. Refresh before navigating.");
        if (this.#enabled && generation === this.#generation) ports.onTransition(owner, destination);
      }
      if (this.#enabled && generation === this.#generation) await this.refresh();
      return receipt;
    } catch (cause) {
      this.#set({ error: message(cause), uncertain: !!this.#original, fresh: false }); throw cause;
    } finally { this.#set({ pending: false }); }
  }
  async readDocumentSection(owner: PlanReviewOwner, raw: PlanDocumentReadRequest) {
    const request = parsePlanDocumentReadRequest(raw);
    this.#admit(owner, request.ticket);
    const ports = this.#ports!, generation = this.#generation, documentGeneration = this.#documentGeneration;
    if (request.sessionId !== owner.sessionId || !ports.documentSupported || !ports.bridge.getPlanDocumentSection)
      throw new PlanReviewNotSubmitted("Native Plan document inspection is unavailable for this owner.");
    const response = parsePlanDocumentResponse(await ports.bridge.getPlanDocumentSection(request, owner.hostId), owner.hostId, request);
    if (generation !== this.#generation || documentGeneration !== this.#documentGeneration)
      throw new PlanReviewNotSubmitted("The Plan owner changed during document inspection.");
    this.#admit(owner, request.ticket);
    return response.value;
  }
}

export function planEventMatches(event: DesktopEvent, owner: PlanReviewOwner, localHostId?: string) {
  if ((event.hostId ?? localHostId) !== owner.hostId) return false;
  if (event.type === "state") return true;
  if (event.type === "settings") return event.sessionId === owner.sessionId;
  if (event.type !== "runtime" || event.sessionId !== owner.sessionId) return false;
  const native = event.event;
  return !!native && typeof native === "object" && "type" in native && typeof native.type === "string"
    && ["plan_changed", "agent_end", "turn_end", "session_start"].includes(native.type);
}

export function useSessionPlan(owner: PlanReviewOwner, ports: SessionPlanPorts,
  options: { connected: boolean; supported: boolean; active: boolean; localHostId?: string }) {
  const states = useMemo(() => new Map<string, SessionPlanState>(), []);
  const state = useMemo(() => {
    const key = JSON.stringify(owner); let value = states.get(key);
    if (!value) { value = new SessionPlanState(owner); states.set(key, value); } return value;
  }, [states, owner.hostId, owner.sessionId]);
  const enabled = !!owner.sessionId && options.connected && options.supported && options.active;
  useLayoutEffect(() => { state.configure(ports, enabled, !owner.sessionId ? "Open a conversation to use native Plan mode."
    : !options.supported ? "Update the owning host and desktop to use native Plan mode." : undefined); }, [state, ports, enabled, options.supported]);
  useLayoutEffect(() => () => state.disconnect(), [state]);
  useEffect(() => { if (enabled) void state.refresh(); }, [state, enabled]);
  useEffect(() => {
    if (!enabled) return;
    return ports.bridge.subscribe(event => {
      if ((event.hostId ?? options.localHostId) === owner.hostId && event.type === "connection") {
        if (!event.connected) state.disconnect();
        else { state.configure(ports, true); void state.refresh().catch(() => {}); }
      }
      else if (planEventMatches(event, owner, options.localHostId)) void state.refresh().catch(() => {});
    });
  }, [state, ports.bridge, enabled, options.localHostId]);
  const view = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  return { state, view };
}
