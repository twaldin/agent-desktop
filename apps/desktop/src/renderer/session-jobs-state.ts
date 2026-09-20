import type { DesktopEvent } from "../../../../packages/shared/src/protocol";
import { sameSessionJobsOwner, sameSessionJobTarget, type SessionJobRow, type SessionJobsEnvelope, type SessionJobsOwner, type SessionJobsRequest, type SessionJobsResult, type SessionJobsSnapshot, type SessionJobTarget } from "../../../../packages/shared/src/session-jobs";

/** Structural subset of DesktopBridge; the panel never needs anything else. */
export interface SessionJobsBridge {
  subscribe(listener: (event: DesktopEvent) => void): () => void;
  sessionJobs?(sessionId: string, request: SessionJobsRequest, hostId: string): Promise<SessionJobsEnvelope>;
}
export interface SessionJobsScope { hostId: string; sessionId: string; connected: boolean; visible: boolean }
export type SessionJobDetail = Extract<SessionJobsResult, { action: "inspect" }>["detail"];
export interface SessionJobsInspection { target: SessionJobTarget; state: "pending" | "ready" | "failed"; detail?: SessionJobDetail; error?: string }
/** `requested` is the native manager's answer that the abort was issued, not that the body or process settled. */
export interface SessionJobsCancellation { target: SessionJobTarget; state: "pending" | "requested" | "declined" | "failed"; error?: string }
export interface SessionJobsView {
  hostId: string; sessionId: string; supported: boolean; connected: boolean;
  /** No snapshot yet and a read is expected. */
  loading: boolean;
  reading: boolean;
  /** Last snapshot read from the original native owner; retained through failures, never replaced by a fabricated empty. */
  snapshot?: SessionJobsSnapshot;
  /** Retained rows whose latest read failed, returned another native owner, or whose host is offline. */
  stale: boolean;
  error?: string;
  inspection?: SessionJobsInspection;
  cancellation?: SessionJobsCancellation;
}
export interface SessionJobsTimers {
  setTimeout(handler: () => void, ms: number): unknown; clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, ms: number): unknown; clearInterval(handle: unknown): void;
}

/** Same cadence as the Environment activity observer. */
export const SESSION_JOBS_POLL_MS = 5000;
export const SESSION_JOBS_COALESCE_MS = 90;
const OWNER_CHANGED = "The native session behind these jobs changed. Reload to read the current native session.";

export const jobRowKey = (target: SessionJobTarget) => `${target.id}\u0000${target.startTime}\u0000${target.guard}`;

export function initialSessionJobsView(hostId: string, sessionId: string, supported: boolean, connected: boolean): SessionJobsView {
  return { hostId, sessionId, supported, connected, loading: supported && connected, reading: false, stale: false };
}

export function findJobRow(snapshot: SessionJobsSnapshot | undefined, target: SessionJobTarget): SessionJobRow | undefined {
  if (snapshot?.availability !== "available") return undefined;
  return snapshot.running.find(row => sameSessionJobTarget(row.target, target)) ?? snapshot.recent.find(row => sameSessionJobTarget(row.target, target));
}

/** Why cancellation is refused right now; undefined when the guarded cancel may be offered. */
export function cancelRefusal(view: SessionJobsView, row: SessionJobRow): string | undefined {
  if (!view.supported) return "Background jobs are unavailable through this desktop bridge.";
  if (!view.connected) return "Offline · reconnect before cancelling.";
  if (view.snapshot?.availability !== "available") return "The native job manager is unavailable.";
  if (view.stale) return "The last read failed. Refresh before cancelling.";
  if (row.status !== "running") return "This job already settled.";
  if (view.cancellation?.state === "pending") return "A cancellation is already in progress.";
  return undefined;
}


class LateResponse extends Error {}

/** One renderer-side observer of the original native session's background jobs.
 * Holds no registry: rows are whatever the owning host last reported for the pinned native owner.
 * Stopping or hiding only stops reads; it never cancels jobs. */
export class SessionJobsState {
  #bridge: SessionJobsBridge; #timers: SessionJobsTimers;
  #listeners = new Set<() => void>();
  #view: SessionJobsView;
  #scope?: SessionJobsScope;
  /** Bumped on host/session change and stop; settled requests from an older epoch never touch the view. */
  #epoch = 0;
  /** Last sent / last applied read sequence: an older response never overwrites a newer one. */
  #sequence = 0; #applied = 0;
  #inFlight = 0;
  #pollPending = false; #pollAgain = false;
  #reloadPending = false;
  #coalesce?: unknown; #interval?: unknown; #unsubscribe?: () => void;
  constructor(bridge: SessionJobsBridge, timers: SessionJobsTimers = globalThis) {
    this.#bridge = bridge; this.#timers = timers;
    this.#view = initialSessionJobsView("", "", this.supported, false);
  }
  get supported() { return typeof this.#bridge.sessionJobs === "function"; }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = () => this.#view;
  #publish(next: Partial<SessionJobsView>) { this.#view = { ...this.#view, ...next }; for (const listener of this.#listeners) listener(); }

  /** Called from the React layout effect. A host/session change drops the previous owner's view before any request settles. */
  configure(scope: SessionJobsScope) {
    const previous = this.#scope; this.#scope = scope;
    const changed = !previous || previous.hostId !== scope.hostId || previous.sessionId !== scope.sessionId;
    if (changed) {
      this.#epoch++; this.#sequence = 0; this.#applied = 0; this.#inFlight = 0; this.#pollPending = false; this.#pollAgain = false;
      this.#reloadPending = false;
      this.#view = initialSessionJobsView(scope.hostId, scope.sessionId, this.supported, scope.connected);
    }
    this.#stopPolling();
    const stale = !!this.#view.snapshot && (this.#view.stale || !scope.connected);
    if (scope.visible && scope.connected && this.supported) {
      this.#publish({ connected: true, stale });
      this.#startPolling(scope);
    } else this.#publish({ connected: scope.connected, loading: scope.connected && this.supported && !this.#view.snapshot && !this.#view.error, stale });
  }
  /** Unmount: stop reads and drop late results. Nothing native is cancelled. */
  stop() { this.#epoch++; this.#stopPolling(); this.#scope = undefined; this.#listeners.clear(); }

  #startPolling(scope: SessionJobsScope) {
    this.#unsubscribe = this.#bridge.subscribe(event => {
      if ((event.hostId ?? scope.hostId) !== scope.hostId) return;
      if (event.type === "runtime") {
        if (event.sessionId !== scope.sessionId) return;
        const native = event.event as { activityChanged?: unknown } | null;
        if (event.sessionActivity === true || (native !== null && typeof native === "object" && native.activityChanged === true)) this.#schedule();
      } else if (event.type === "state" && event.state.sessions.some(session => session.id === scope.sessionId)) this.#schedule();
    });
    void this.#poll();
    this.#interval = this.#timers.setInterval(() => void this.#poll(), SESSION_JOBS_POLL_MS);
  }
  #stopPolling() {
    this.#unsubscribe?.(); this.#unsubscribe = undefined;
    if (this.#interval !== undefined) { this.#timers.clearInterval(this.#interval); this.#interval = undefined; }
    if (this.#coalesce !== undefined) { this.#timers.clearTimeout(this.#coalesce); this.#coalesce = undefined; }
  }
  #schedule() {
    if (this.#coalesce !== undefined || !this.#unsubscribe) return;
    this.#coalesce = this.#timers.setTimeout(() => { this.#coalesce = undefined; void this.#poll(); }, SESSION_JOBS_COALESCE_MS);
  }
  /** Pinned read: once an owner is known every automatic read carries it and refuses another owner's rows. */
  async #poll() {
    if (!this.#unsubscribe || this.#reloadPending) return;
    if (this.#pollPending) { this.#pollAgain = true; return; }
    this.#pollPending = true;
    const epoch = this.#epoch;
    try { await this.#read(this.#view.snapshot?.owner); }
    finally {
      if (epoch === this.#epoch) { this.#pollPending = false; if (this.#pollAgain) { this.#pollAgain = false; this.#schedule(); } }
    }
  }
  async #read(owner: SessionJobsOwner | undefined) {
    try { await this.#request(owner ? { action: "read", owner } : { action: "read" }, owner); }
    catch (cause) { if (!(cause instanceof LateResponse)) return; }
  }
  /** Explicit control: same pinned read as the poll, issued now. */
  refresh() {
    if (!this.#scope || !this.supported || !this.#scope.connected || this.#reloadPending) return Promise.resolve();
    if (this.#coalesce !== undefined) { this.#timers.clearTimeout(this.#coalesce); this.#coalesce = undefined; }
    return this.#read(this.#view.snapshot?.owner);
  }
  /** Explicit control after owner loss: reads whatever native owner the host has now and replaces the retained view. */
  async reload() {
    if (!this.#scope || !this.supported || !this.#scope.connected || this.#reloadPending) return;
    const epoch = this.#epoch;
    this.#reloadPending = true;
    try { await this.#read(undefined); }
    finally { if (epoch === this.#epoch) this.#reloadPending = false; }
  }

  /** Every response is checked against the scope that sent it, the pinned owner, and later responses. */
  async #request(request: SessionJobsRequest, pin: SessionJobsOwner | undefined): Promise<SessionJobsResult> {
    const scope = this.#scope, sessionJobs = this.#bridge.sessionJobs;
    if (!scope || !sessionJobs) throw new Error("Background jobs are unavailable through this desktop bridge.");
    const epoch = this.#epoch, sequence = ++this.#sequence;
    this.#inFlight++; this.#publish({ reading: true });
    try {
      const envelope = await sessionJobs.call(this.#bridge, scope.sessionId, request, scope.hostId);
      if (epoch !== this.#epoch) throw new LateResponse();
      if (pin && this.#view.snapshot && !sameSessionJobsOwner(this.#view.snapshot.owner, pin)) throw new LateResponse();
      if (envelope.protocolVersion !== 1 || envelope.hostId !== scope.hostId || envelope.sessionId !== scope.sessionId) throw new Error("The jobs response belongs to a different session or an unsupported protocol.");
      if (envelope.result.action !== request.action) throw new Error("The host answered the jobs request with a different action.");
      if (request.action === "inspect" && envelope.result.action === "inspect" && !sameSessionJobTarget(envelope.result.detail.target, request.job)) throw new Error("The host answered with a different job's output.");
      const snapshot = envelope.result.snapshot;
      if (pin && !sameSessionJobsOwner(snapshot.owner, pin)) throw new Error(OWNER_CHANGED);
      if (sequence > this.#applied) {
        const ownerChanged = this.#view.snapshot && !sameSessionJobsOwner(this.#view.snapshot.owner, snapshot.owner);
        this.#applied = sequence;
        this.#publish({ snapshot, stale: false, error: undefined, loading: false, ...(ownerChanged ? { inspection: undefined, cancellation: undefined } : {}) });
      }
      return envelope.result;
    } catch (cause) {
      if (epoch !== this.#epoch) throw new LateResponse();
      if (pin && this.#view.snapshot && !sameSessionJobsOwner(this.#view.snapshot.owner, pin)) throw new LateResponse();
      if (cause instanceof LateResponse) throw cause;
      if (sequence > this.#applied) { this.#applied = sequence; this.#publish({ stale: !!this.#view.snapshot, error: cause instanceof Error ? cause.message : String(cause), loading: false }); }
      throw cause;
    } finally {
      if (epoch === this.#epoch) { this.#inFlight--; this.#publish({ reading: this.#inFlight > 0 }); }
    }
  }

  /** Inspects retained output for one settled row of the pinned owner; the host never consumes or acknowledges it.
   * Allowed while stale because it is a read: a success also refreshes the same-owner snapshot. */
  async inspect(target: SessionJobTarget) {
    const snapshot = this.#view.snapshot;
    if (!snapshot || !this.#scope?.connected || !this.supported || this.#reloadPending) return;
    const current = this.#view.inspection;
    if (current && sameSessionJobTarget(current.target, target)) { if (current.state !== "pending") this.#publish({ inspection: undefined }); return; }
    this.#publish({ inspection: { target, state: "pending" } });
    const owner = snapshot.owner;
    try {
      const result = await this.#request({ action: "inspect", owner, job: target }, owner);
      if (result.action !== "inspect") throw new Error("The host answered an inspection with a different action.");
      if (this.#inspecting(target)) this.#publish({ inspection: { target, state: "ready", detail: result.detail } });
    } catch (cause) {
      if (cause instanceof LateResponse || !this.#inspecting(target)) return;
      this.#publish({ inspection: { target, state: "failed", error: cause instanceof Error ? cause.message : String(cause) } });
    }
  }
  #inspecting(target: SessionJobTarget) { const current = this.#view.inspection; return !!current && current.state === "pending" && sameSessionJobTarget(current.target, target); }
  closeInspection() { if (this.#view.inspection?.state !== "pending") this.#publish({ inspection: undefined }); }

  /** Guarded single-job cancel: one request to the original native owner with the exact live-object target; never retried. */
  async cancel(target: SessionJobTarget) {
    const view = this.#view, row = findJobRow(view.snapshot, target);
    if (!row || cancelRefusal(view, row)) return;
    const owner = view.snapshot!.owner;
    this.#publish({ cancellation: { target, state: "pending" } });
    try {
      const result = await this.#request({ action: "cancel", owner, job: target }, owner);
      if (result.action !== "cancel") throw new Error("The host answered a cancellation with a different action.");
      this.#publish({ cancellation: { target, state: result.requested ? "requested" : "declined" } });
    } catch (cause) {
      if (cause instanceof LateResponse) return;
      this.#publish({ cancellation: { target, state: "failed", error: cause instanceof Error ? cause.message : String(cause) } });
    }
  }
  dismissCancellation() { if (this.#view.cancellation?.state !== "pending") this.#publish({ cancellation: undefined }); }
}
