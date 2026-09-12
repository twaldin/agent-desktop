import { parseBrowserCreationTicket, type DraftBrowserBridge, type DraftBrowserOwnerSnapshot } from "@agent-desktop/shared";
import { parseDraftBrowserWindowIntent, type DraftBrowserWindowIntent } from "../draft-browser-window-intent";
import type { DraftController } from "./drafts";

export interface DraftBrowserOwnerContext { hostId: string; draftId: string; connected: boolean; enabled: boolean }
export interface DraftBrowserOwnerState {
  status: "idle" | "saving" | "acquiring" | "checking" | "ready" | "absent" | "unavailable" | "retired" | "unknown" | "error";
  snapshot?: DraftBrowserOwnerSnapshot;
  message?: string;
}
/** One original host/draft owner. App must deliver committed context changes and
 * retain intent through route/panel loss. Construction/restoration never calls a bridge. */
export class DraftBrowserOwnerController {
  private live = true;
  private busy = false;
  private generation = 0;
  private context?: DraftBrowserOwnerContext;
  private cancellation?: AbortController;
  private callerSignal?: AbortSignal;
  private value?: DraftBrowserWindowIntent;
  private current: DraftBrowserOwnerState;
  private project: string | null;
  private conflicted: boolean;
  private readonly unsubscribe: () => void;
  readonly hostId: string;
  constructor(private readonly bridge: Pick<DraftBrowserBridge, "acquire" | "status" | "metadata">,
    private readonly drafts: DraftController, readonly draftId: string,
    private readonly changed: () => void,
    private readonly checkpoint: (intent: DraftBrowserWindowIntent, signal: AbortSignal) => Promise<void>,
    restored?: DraftBrowserWindowIntent) {
    this.hostId = drafts.ownerHostId;
    if (typeof draftId !== "string" || !draftId || draftId.length > 200 || /[\u0000-\u001f\u007f]/.test(draftId)) throw new Error("Choose an original draft.");
    const view = drafts.get(draftId); this.project = view.draft.projectId; this.conflicted = Boolean(view.conflict);
    this.value = restored === undefined ? undefined : parseDraftBrowserWindowIntent(restored);
    if (this.value && (this.value.hostId !== this.hostId || this.value.reference.draftId !== draftId)) throw new Error("The saved browser belongs to another draft or host.");
    this.current = { status: this.value ? "unknown" : "idle" };
    this.unsubscribe = drafts.subscribe(() => {
      const next = drafts.get(draftId), conflict = Boolean(next.conflict);
      if (next.draft.projectId !== this.project || conflict !== this.conflicted) {
        this.project = next.draft.projectId; this.conflicted = conflict; this.invalidate();
      }
    });
  }
  get intent() { return this.value ? parseDraftBrowserWindowIntent(this.value) : undefined; }
  get state(): DraftBrowserOwnerState { return structuredClone(this.current); }
  private notify() { if (this.live) this.changed(); }
  private set(state: DraftBrowserOwnerState) { this.current = state; this.notify(); }
  private invalidate() {
    this.generation++; this.cancellation?.abort();
    if (this.value && this.current.status === "ready") this.set({ status: "unknown", message: "Check the original browser owner after returning to this draft." });
  }
  observe(context: DraftBrowserOwnerContext) {
    if (!this.live) return;
    const old = this.context;
    this.context = { ...context };
    if (!old || old.hostId !== context.hostId || old.draftId !== context.draftId || old.connected !== context.connected || old.enabled !== context.enabled) this.invalidate();
  }
  private eligible() {
    return this.live && this.context?.hostId === this.hostId && this.context.draftId === this.draftId
      && this.context.connected && this.context.enabled && !this.drafts.get(this.draftId).conflict;
  }
  private assertCurrent(generation: number) {
    if (this.generation !== generation || !this.eligible() || this.cancellation?.signal.aborted || this.callerSignal?.aborted) throw new Error("The initiating draft or connection changed. Check again explicitly.");
  }
  /** Also usable at a later queued publication boundary. Every observed loss is
   * latched; restoring the same host/draft does not revive an earlier guard. */
  attachmentGuard(): () => boolean {
    const generation = this.generation;
    return () => this.generation === generation && Boolean(this.eligible()) && this.current.status === "ready";
  }
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.busy || !this.eligible() || this.value && this.current.status !== "absent") return;
    const generation = ++this.generation, project = this.project;
    this.busy = true; this.cancellation = new AbortController(); this.callerSignal = signal; let dispatched = false;
    try {
      this.set({ status: "saving" }); this.assertCurrent(generation);
      if (!this.value) {
        const saved = await this.drafts.ensureSaved(this.draftId);
        this.assertCurrent(generation);
        if (saved.id !== this.draftId || saved.projectId !== project || !Number.isSafeInteger(saved.revision) || saved.revision < 1) throw new Error("The host did not acknowledge this draft's original binding.");
        this.value = parseDraftBrowserWindowIntent({ version: 1, hostId: this.hostId,
          reference: { ownerId: crypto.randomUUID(), draftId: this.draftId, draftRevision: saved.revision } });
        this.notify();
      }
      const intent = this.intent!;
      this.assertCurrent(generation);
      await this.checkpoint(intent, signal ? AbortSignal.any([signal, this.cancellation.signal]) : this.cancellation.signal);
      this.assertCurrent(generation);
      this.set({ status: "acquiring" }); this.assertCurrent(generation);
      dispatched = true;
      const result = await this.bridge.acquire(intent.reference, intent.hostId);
      this.assertCurrent(generation); await this.accept(result, intent, generation);
    } catch (cause) {
      if (this.live) this.set({ status: dispatched || this.value ? "unknown" : "error", message: this.message(cause) });
    } finally { this.busy = false; this.cancellation = undefined; this.callerSignal = undefined; }
  }
  /** Read-only recovery. No acquire fallback, ticket replay or new owner ID. An
   * observed absence permits a later explicit acquire of this SAME saved ID. */
  async inspect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.busy || !this.value || !this.eligible()) return;
    const generation = ++this.generation, intent = this.intent!;
    this.busy = true; this.cancellation = new AbortController(); this.callerSignal = signal;
    try {
      this.set({ status: "checking" }); this.assertCurrent(generation);
      const result = await this.bridge.status(intent.reference, intent.hostId);
      this.assertCurrent(generation); await this.accept(result, intent, generation);
    } catch (cause) { if (this.live) this.set({ status: "unknown", message: this.message(cause) }); }
    finally { this.busy = false; this.cancellation = undefined; this.callerSignal = undefined; }
  }
  private async accept(result: DraftBrowserOwnerSnapshot, intent: DraftBrowserWindowIntent, generation: number) {
    if (!result || result.protocolVersion !== 1 || result.hostId !== intent.hostId || result.ownerId !== intent.reference.ownerId
      || !["absent", "starting", "ready", "unavailable", "retired"].includes(result.state)
      || result.workerPid !== undefined && (!Number.isSafeInteger(result.workerPid) || result.workerPid <= 0)
      || result.error !== undefined && (typeof result.error !== "string" || result.error.length > 4096)
      || result.state === "ready" && (result.workerPid === undefined || result.error !== undefined)
      || result.state === "absent" && result.workerPid !== undefined) throw new Error("The browser owner response could not be confirmed.");
    const snapshot = { protocolVersion: 1 as const, hostId: result.hostId, ownerId: result.ownerId, state: result.state,
      ticket: parseBrowserCreationTicket(result.ticket), ...(result.workerPid === undefined ? {} : { workerPid: result.workerPid }),
      ...(result.error === undefined ? {} : { error: result.error }) };
    if (snapshot.state === "ready") {
      // Status is journal/registry observation only. A guarded existing-worker
      // read also checks its original directory/project admission before use.
      const metadata = await this.bridge.metadata(intent.reference, intent.hostId);
      this.assertCurrent(generation);
      if (!metadata || metadata.protocolVersion !== 1 || metadata.ownerKind !== "draft" || metadata.hostId !== intent.hostId
        || metadata.ownerId !== intent.reference.ownerId || metadata.availability !== "running" || metadata.workerPid !== snapshot.workerPid)
        throw new Error("The original draft browser worker is not currently available.");
    }
    this.assertCurrent(generation);
    this.set({ status: snapshot.state === "starting" ? "unknown" : snapshot.state, snapshot, ...(snapshot.error ? { message: snapshot.error } : {}) });
  }
  private message(cause: unknown) { return (cause instanceof Error ? cause.message : "Browser ownership could not be confirmed.").slice(0, 4096); }
  dispose() { this.live = false; this.generation++; this.cancellation?.abort(); this.unsubscribe(); }
}
