import type { DesktopBridge } from "@agent-desktop/shared";
import type { SessionPlan } from "../../../../packages/shared/src/session-plan";
import { parsePlanExternalEditorCapabilities, parsePlanExternalEditorObservation, parsePlanExternalEditorRequest,
  parsePlanExternalEditorRecovery, parsePlanExternalEditorList, type PlanExternalEditorCapabilities,
  type PlanExternalEditorEdit, type PlanExternalEditorObservation, type PlanExternalEditorRequest } from "../../../../packages/shared/src/plan-external-editor";

export interface PlanEditorInput { hostId: string; sessionId: string; connected: boolean; fresh: boolean; open: boolean; plan: SessionPlan; dirty: boolean }
export interface PlanEditorPorts {
  bridge: Pick<DesktopBridge, "getPlanEditorCapabilities" | "startPlanEditor" | "getPlanEditorStatus" | "cancelPlanEditor" | "recoverPlanEditor" | "listPlanEditors">;
  storage: Pick<Storage, "getItem" | "setItem">;
  openTerminal(hostId: string, sessionId: string, terminalId: string): void;
  refreshPlan(): Promise<void>;
  copy(text: string): Promise<void>;
}
export interface PlanEditorView {
  available: boolean; reason?: string; busy: boolean; error?: string;
  jobs: readonly PlanExternalEditorObservation[]; nextCursor?: string;
  recovery?: { requestId: string; content: string };
}
interface OwnerState { capability?: PlanExternalEditorCapabilities; jobs: Map<string, PlanExternalEditorObservation>;
  busy: boolean; error?: string; nextCursor?: string; listed?: boolean; recovery?: { requestId: string; content: string }; terminalIntent?: string }
const ownerKey = (input: Pick<PlanEditorInput, "hostId" | "sessionId">) => JSON.stringify([input.hostId, input.sessionId]);
const sameReviewOwner = (left: SessionPlan, right: SessionPlan) => left.ticket.epoch === right.ticket.epoch
  && left.ticket.nativeSessionId === right.ticket.nativeSessionId && left.ticket.revision === right.ticket.revision
  && left.review?.id === right.review?.id && left.review?.revision === right.review?.revision
  && left.review?.document?.documentRevision === right.review?.document?.documentRevision;
const savedKey = (key: string) => `agent-desktop.plan-editor.requests.v1:${key}`;
const message = (error: unknown) => error instanceof Error ? error.message : "The original Plan editor could not be inspected.";

/** Renderer requests never own the process. Persist before dispatch, discover
 * other clients' jobs from the host, and only inspect originals after failures. */
export class PlanExternalEditorState {
  #input: PlanEditorInput; #ports: PlanEditorPorts;
  #owners = new Map<string, OwnerState>(); #listeners = new Set<() => void>(); #view!: PlanEditorView;
  constructor(input: PlanEditorInput, ports: PlanEditorPorts) { this.#input = input; this.#ports = ports; this.#owner(); this.#publish(); }
  configure(input: PlanEditorInput, ports: PlanEditorPorts) {
    if (ownerKey(input) !== ownerKey(this.#input) || !input.open || !sameReviewOwner(input.plan, this.#input.plan)) this.#owner().terminalIntent = undefined;
    this.#input = input; this.#ports = ports; this.#owner(); this.#publish(); }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = () => this.#view;
  #owner(): OwnerState {
    const key = ownerKey(this.#input); let value = this.#owners.get(key);
    if (!value) {
      value = { jobs: new Map(), busy: false, terminalIntent: undefined }; this.#owners.set(key, value);
      try {
        const raw = this.#ports.storage.getItem(savedKey(key));
        if (raw) {
          const requests: unknown = JSON.parse(raw);
          if (!Array.isArray(requests)) throw new Error("Saved editor requests are invalid.");
          for (const rawRequest of requests) {
            const request = parsePlanExternalEditorRequest(rawRequest);
            if (request.sessionId !== this.#input.sessionId) throw new Error("Saved editor request owner changed.");
            value.jobs.set(request.requestId, { protocolVersion: 1, hostId: this.#input.hostId, request, state: "settled",
              result: { outcome: "unknown", message: "Check the original host for this saved request. It will not be sent again." } });
          }
        }
      } catch (error) { value.error = message(error); }
    }
    return value;
  }
  #persist(key: string, state: OwnerState, ports = this.#ports) {
    ports.storage.setItem(savedKey(key), JSON.stringify([...state.jobs.values()]
      .filter(job => job.state !== "settled" || job.result?.outcome === "unknown").map(job => job.request)));
  }
  #publish() {
    const state = this.#owner(), input = this.#input, bridge = this.#ports.bridge;
    const reason = !input.connected ? "Reconnect to the owning host."
      : !bridge.getPlanEditorCapabilities || !bridge.startPlanEditor || !bridge.listPlanEditors ? "Update this desktop to use the configured editor."
      : !input.open || !input.fresh || !input.plan.enabled || input.plan.mode !== "active" || input.plan.review?.status !== "ready" || input.plan.reconciliationRequired || input.plan.busyReason
        ? "Refresh and open the original ready Plan review."
      : input.dirty ? "Save or discard local Markdown edits first."
      : !input.plan.review.document ? "The native Plan document is unavailable."
      : state.busy ? "An editor request is in progress."
      : [...state.jobs.values()].some(job => job.state === "pending") ? "This conversation already has an active editor."
      : state.capability?.available ? undefined : state.capability?.reason ?? "Checking the owning host’s configured editor…";
    this.#view = { available: !reason, reason, busy: state.busy, error: state.error,
      jobs: [...state.jobs.values()], nextCursor: state.nextCursor, recovery: state.recovery };
    for (const listener of this.#listeners) listener();
  }
  async refresh(more = false) {
    const input = this.#input, ports = this.#ports, state = this.#owner(), key = ownerKey(input);
    if (!input.connected || state.busy || !ports.bridge.listPlanEditors || !ports.bridge.getPlanEditorCapabilities) return;
    state.busy = true; state.error = undefined; this.#publish();
    try {
      const results = await Promise.allSettled([
        ports.bridge.getPlanEditorCapabilities(input.sessionId, input.hostId),
        ports.bridge.listPlanEditors(input.sessionId, input.hostId, more ? state.nextCursor : undefined),
      ]);
      if (results[0].status === "fulfilled") state.capability = parsePlanExternalEditorCapabilities(results[0].value, input.hostId);
      else { state.capability = undefined; state.error = message(results[0].reason); }
      if (results[1].status === "rejected") throw results[1].reason;
      const list = parsePlanExternalEditorList(results[1].value, input.hostId, input.sessionId);
      const changed = list.items.some(item => item.result?.outcome === "applied"
        && state.jobs.get(item.request.requestId)?.result?.outcome !== "applied");
      for (const item of list.items) state.jobs.set(item.request.requestId, item);
      if (more || !state.listed) { state.nextCursor = list.nextCursor; state.listed = true; }
      // Saved requests outside this page still need their exact original status.
      for (const job of [...state.jobs.values()]) {
        if ((job.state !== "settled" || job.result?.outcome === "unknown")
          && !list.items.some(item => item.request.requestId === job.request.requestId) && ports.bridge.getPlanEditorStatus)
          state.jobs.set(job.request.requestId, parsePlanExternalEditorObservation(await ports.bridge.getPlanEditorStatus(job.request, input.hostId), input.hostId, job.request));
      }
      this.#persist(key, state, ports);
      this.#showTerminal(key, state, ports);
      if (changed && ownerKey(this.#input) === key) await ports.refreshPlan();
    } catch (error) { state.error = message(error); }
    finally { state.busy = false; this.#publish(); }
  }
  async start(edit: PlanExternalEditorEdit) {
    if (!this.#view.available) return;
    const input = this.#input, ports = this.#ports, key = ownerKey(input), state = this.#owner();
    const review = input.plan.review!;
    const request = parsePlanExternalEditorRequest({ requestId: crypto.randomUUID(), controlEpoch: state.capability!.controlEpoch,
      sessionId: input.sessionId, ticket: input.plan.ticket, reviewId: review.id, reviewRevision: review.revision,
      documentRevision: review.document!.documentRevision, edit });
    const original: PlanExternalEditorObservation = { protocolVersion: 1, hostId: input.hostId, request, state: "pending" };
    state.busy = true; state.error = undefined; state.terminalIntent = request.requestId; state.jobs.set(request.requestId, original); this.#publish();
    let sent = false, confirmed = false;
    try {
      this.#persist(key, state, ports); // If local persistence fails, do not dispatch.
      sent = true;
      const result = parsePlanExternalEditorObservation(await ports.bridge.startPlanEditor!(request, input.hostId), input.hostId, request);
      confirmed = true; state.jobs.set(request.requestId, result); this.#persist(key, state, ports);
      this.#showTerminal(key, state, ports);
    } catch (error) {
      if (!confirmed) state.jobs.set(request.requestId, { ...original, state: "settled", result: { outcome: sent ? "unknown" : "not-submitted", message: message(error) } });
      state.error = message(error);
    } finally { state.busy = false; this.#publish(); }
  }
  #showTerminal(key: string, state: OwnerState, ports: PlanEditorPorts) {
    if (!state.terminalIntent) return;
    const job = state.jobs.get(state.terminalIntent);
    if (!job?.terminalId || ownerKey(this.#input) !== key || !this.#input.connected || !this.#input.open) return;
    state.terminalIntent = undefined;
    if (job.request.ticket.epoch !== this.#input.plan.ticket.epoch || job.request.ticket.nativeSessionId !== this.#input.plan.ticket.nativeSessionId
      || job.request.ticket.revision !== this.#input.plan.ticket.revision || job.request.reviewId !== this.#input.plan.review?.id
      || job.request.reviewRevision !== this.#input.plan.review?.revision
      || job.request.documentRevision !== this.#input.plan.review?.document?.documentRevision) return;
    try { ports.openTerminal(job.hostId, job.request.sessionId, job.terminalId); }
    catch (error) { state.error = message(error); }
  }
  async act(requestId: string, action: "status" | "cancel" | "recover" | "terminal" | "copy") {
    const input = this.#input, state = this.#owner(), ports = this.#ports, key = ownerKey(input), job = state.jobs.get(requestId);
    if (!job || state.busy || !input.connected && action !== "copy") return;
    if (action === "terminal") { if (job.terminalId) ports.openTerminal(input.hostId, input.sessionId, job.terminalId); return; }
    state.busy = true; state.error = undefined; this.#publish();
    try {
      if (action === "copy") {
        if (state.recovery?.requestId === requestId) await ports.copy(state.recovery.content);
      } else if (action === "recover") {
        if (!ports.bridge.recoverPlanEditor) throw new Error("Editor recovery is unavailable in this desktop.");
        const result = parsePlanExternalEditorRecovery(await ports.bridge.recoverPlanEditor(job.request, input.hostId), input.hostId, job.request);
        state.jobs.set(requestId, result.observation);
        state.recovery = result.content === undefined ? undefined : { requestId, content: result.content };
        if (result.content === undefined) state.error = "No completed edited text is available for this original request.";
      } else {
        const operation = action === "cancel" ? ports.bridge.cancelPlanEditor : ports.bridge.getPlanEditorStatus;
        if (!operation) throw new Error("Editor status is unavailable in this desktop.");
        const result = parsePlanExternalEditorObservation(await operation(job.request, input.hostId), input.hostId, job.request);
        state.jobs.set(requestId, result);
        if (result.result?.outcome === "applied" && ownerKey(this.#input) === key) await ports.refreshPlan();
      }
      this.#persist(key, state, ports);
    } catch (error) { state.error = message(error); }
    finally { state.busy = false; this.#publish(); }
  }
}
