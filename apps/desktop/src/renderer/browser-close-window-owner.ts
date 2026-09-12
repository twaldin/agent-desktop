import { parseBrowserCreationTicket, type BrowserFrameTarget, type DesktopBridge } from "@agent-desktop/shared";
import { parseBrowserCloseOwner, parseBrowserCloseReceipt, parseBrowserCloseObservation, type BrowserCloseOwner } from "../../../../packages/shared/src/browser-close";
import { browserCloseIntentKey, parseBrowserCloseWindowIntent, parseBrowserCloseWindowIntents, type BrowserCloseWindowIntent } from "../browser-close-window-intent";
import type { WindowViewState } from "../window-state";
import type { WindowSaveObserver } from "./window-view-state";
import type { DockPresentationRef } from "./dock-presentations";
import { BrowserCloseCheckpoint } from "./browser-close-checkpoint";

export interface BrowserCloseSelection {
  source: DockPresentationRef; owner: BrowserCloseOwner; target: BrowserFrameTarget;
  /** Original committed owner/presentation/connection generation, not a reusable live boolean. */
  isCurrent(): boolean;
}
export type BrowserCloseResult = { status: "retained"; message: string }
  | { status: "completed"; intent: BrowserCloseWindowIntent; canRemove(): boolean };
interface Attempt {
  original: BrowserCloseWindowIntent; intent?: BrowserCloseWindowIntent;
  current(): boolean; invalid: boolean; running: boolean; cancellation: AbortController;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sourceKey = (source: DockPresentationRef) => JSON.stringify([source.hostId, source.tabId, source.instanceId]);
const sameSource = (a: DockPresentationRef, b: DockPresentationRef) => a.hostId === b.hostId && a.tabId === b.tabId && a.instanceId === b.instanceId
  && a.destination === b.destination && a.kind === b.kind && a.target === b.target;
const message = (cause: unknown) => (cause instanceof Error ? cause.message : "Browser Close could not be confirmed.").slice(0, 4096);

/** Own explicit close requests across navigation. No operation starts at construction/commit/restore. */
export class BrowserCloseWindowOwner implements WindowSaveObserver {
  private readonly checkpoint = new BrowserCloseCheckpoint();
  private readonly lifetime = new AbortController();
  private readonly attempts = new Map<string, Attempt>();
  private values: BrowserCloseWindowIntent[];
  private current?: BrowserCloseWindowIntent[];
  private savedValues?: BrowserCloseWindowIntent[];
  private live = true;
  private saveError?: string;
  private retiring = false;
  private retirementView?: string;
  constructor(private readonly bridge: Pick<DesktopBridge, "browserClose" | "getBrowserMetadata" | "draftBrowser">,
    restored: readonly BrowserCloseWindowIntent[], private readonly changed: () => void, private readonly restorationError?: string) {
    this.values = parseBrowserCloseWindowIntents(restored);
  }
  get intents() { return parseBrowserCloseWindowIntents(this.values); }
  get error() { return this.restorationError ?? this.saveError; }
  private find(intent: BrowserCloseWindowIntent, list = this.values) { return list.find(value => browserCloseIntentKey(value) === browserCloseIntentKey(intent)); }
  private original(attempt: Attempt) {
    if (!attempt.current()) { attempt.invalid = true; attempt.cancellation.abort(); }
    return this.live && !attempt.invalid;
  }
  /** The App must deliver committed losses, including connection/owner loss followed by return. */
  observe(): void { for (const attempt of this.attempts.values()) this.original(attempt); }
  committed(view: WindowViewState): void {
    if (!this.live) return;
    try { this.current = parseBrowserCloseWindowIntents(view.browserCloses ?? []); }
    catch { this.failed("The committed browser Close history is invalid."); return; }
    this.savedValues = undefined; this.checkpoint.committed(view); this.observe();
  }
  saved(view: WindowViewState): void {
    if (!this.live) return;
    try { this.savedValues = parseBrowserCloseWindowIntents(view.browserCloses ?? []); }
    catch { this.failed("The saved browser Close history is invalid."); return; }
    this.checkpoint.saved(view); this.saveError = undefined;
    const visible = same(this.current, this.savedValues) ? JSON.stringify(this.savedValues) : undefined;
    if (visible !== this.retirementView) { this.retirementView = visible; this.changed(); }
  }
  failed(text: string): void {
    if (!this.live) return;
    this.current = undefined; this.savedValues = undefined; this.saveError = text; this.checkpoint.failed(text);
    if (this.retirementView !== undefined) { this.retirementView = undefined; this.changed(); }
  }
  retains(source: DockPresentationRef): boolean {
    return [...this.attempts.values()].some(attempt => sameSource(attempt.original.source, source) && attempt.running)
      || this.values.some(value => sameSource(value.source, source) && (!value.receipt || value.receipt.outcome === "unknown"));
  }
  private admitted(intent: BrowserCloseWindowIntent) {
    return this.live && !this.error && this.current && this.savedValues
      && same(this.find(intent, this.current), intent) && same(this.find(intent, this.savedValues), intent);
  }
  private publish(intent: BrowserCloseWindowIntent) {
    const found = this.find(intent);
    this.values = parseBrowserCloseWindowIntents(found ? this.values.map(value => browserCloseIntentKey(value) === browserCloseIntentKey(intent) ? intent : value) : [...this.values, intent]);
    this.changed();
  }
  private assert(attempt: Attempt) {
    if (!this.original(attempt) || this.error || attempt.cancellation.signal.aborted) throw new Error(this.error ?? "The original browser Close selection changed. Its tab is retained.");
  }
  private async ticket(attempt: Attempt) {
    const { owner, hostId, request } = attempt.original;
    let metadata;
    let ticket;
    if (owner.kind === "session") {
      metadata = await this.bridge.getBrowserMetadata?.(owner.sessionId, hostId); this.assert(attempt);
      if (!metadata || metadata.protocolVersion !== 1 || metadata.hostId !== hostId || metadata.sessionId !== owner.sessionId) throw new Error("The original session browser is unavailable.");
      ticket = metadata.creationTicket;
    } else {
      const reference = { ownerId: owner.ownerId, draftId: owner.draftId, draftRevision: owner.draftRevision };
      const status = await this.bridge.draftBrowser?.status({ ...reference }, hostId); this.assert(attempt);
      if (!status || status.protocolVersion !== 1 || status.hostId !== hostId || status.ownerId !== owner.ownerId || status.state !== "ready" || status.workerPid !== request.target.workerPid) throw new Error("Inspect the original draft browser owner before closing its page.");
      ticket = status.ticket;
      metadata = await this.bridge.draftBrowser?.metadata({ ...reference }, hostId); this.assert(attempt);
      if (!metadata || metadata.protocolVersion !== 1 || metadata.ownerKind !== "draft" || metadata.hostId !== hostId || metadata.ownerId !== owner.ownerId) throw new Error("The original draft browser metadata changed.");
    }
    const target = request.target;
    if (metadata.availability !== "running" || metadata.workerPid !== target.workerPid || !Array.isArray(metadata.tabs)
      || metadata.tabs.filter(tab => tab.name === target.name && tab.targetId === target.targetId && tab.state === "alive").length !== 1) throw new Error("The original live browser target is unavailable. No replacement was closed.");
    return parseBrowserCreationTicket(ticket);
  }
  private async settlement(attempt: Attempt, input: unknown): Promise<BrowserCloseResult> {
    const pending = attempt.intent!;
    const receipt = parseBrowserCloseReceipt(input, pending.hostId, pending.owner, pending.request);
    if (!this.live) return { status: "retained", message: "The window closed; inspect the saved original request after reopening." };
    const next = parseBrowserCloseWindowIntent({ ...pending, receipt });
    attempt.intent = next; this.publish(next);
    await this.checkpoint.wait(next, this.lifetime.signal, pending);
    if (receipt.outcome !== "completed") return { status: "retained", message: receipt.message };
    return { status: "completed", intent: parseBrowserCloseWindowIntent(next), canRemove: () => Boolean(this.original(attempt) && this.admitted(next)) };
  }
  async close(selection: BrowserCloseSelection): Promise<BrowserCloseResult> {
    if (!this.live || !this.bridge.browserClose || this.error || this.retiring) return { status: "retained", message: this.error ?? (this.retiring ? "Wait for the Close history save before starting another operation." : "Browser Close is unavailable. The tab is retained.") };
    const original = parseBrowserCloseWindowIntent({ version: 1, hostId: selection.source.hostId, source: selection.source, owner: parseBrowserCloseOwner(selection.owner),
      request: { requestId: crypto.randomUUID(), controlEpoch: "not-dispatched", observedAt: 1, target: selection.target } });
    const key = sourceKey(original.source);
    if (this.attempts.get(key)?.running || this.values.some(value => sameSource(value.source, original.source) && (!value.receipt || value.receipt.outcome !== "rejected"))) return { status: "retained", message: "Check the original browser Close request; it was not repeated." };
    const attempt: Attempt = { original, current: selection.isCurrent, invalid: false, running: true, cancellation: new AbortController() };
    this.attempts.set(key, attempt);
    try {
      this.assert(attempt); const ticket = await this.ticket(attempt); this.assert(attempt);
      const pending = parseBrowserCloseWindowIntent({ ...original, request: { ...original.request, ...ticket } });
      attempt.intent = pending; this.publish(pending);
      await this.checkpoint.wait(pending, attempt.cancellation.signal, null);
      this.assert(attempt); if (!this.admitted(pending)) throw new Error("The original Close request is not in the saved current window.");
      const receipt = await this.bridge.browserClose.close(structuredClone(pending.owner), structuredClone(pending.request), pending.hostId);
      return await this.settlement(attempt, receipt);
    } catch (cause) { return { status: "retained", message: message(cause) }; }
    finally { attempt.running = false; if (this.live) this.changed(); }
  }
  /** Explicit read-only recovery. Never acquire, obtain a new ticket or repeat close. */
  async inspect(value: BrowserCloseWindowIntent, isCurrent: () => boolean): Promise<BrowserCloseResult> {
    const intent = parseBrowserCloseWindowIntent(value), current = this.find(intent), key = sourceKey(intent.source);
    if (!this.live || !this.bridge.browserClose || this.error || this.retiring || !current || !same(current, intent) || this.attempts.get(key)?.running)
      return { status: "retained", message: this.error ?? "The original saved browser Close request is unavailable or busy." };
    const attempt: Attempt = { original: intent, intent, current: isCurrent, invalid: false, running: true, cancellation: new AbortController() };
    this.attempts.set(key, attempt);
    try {
      this.assert(attempt); await this.checkpoint.wait(intent, attempt.cancellation.signal); this.assert(attempt);
      if (!this.admitted(intent)) throw new Error("Save the original browser Close request before checking its status.");
      const raw = await this.bridge.browserClose.status(structuredClone(intent.owner), structuredClone(intent.request), intent.hostId);
      const observed = parseBrowserCloseObservation(raw, intent.hostId, intent.owner, intent.request);
      if (observed.status !== "settled") return { status: "retained", message: observed.status === "pending" ? "Browser Close is still pending; it was not repeated." : "Browser Close history is unavailable; the original request is retained." };
      return await this.settlement(attempt, observed.receipt);
    } catch (cause) { return { status: "retained", message: message(cause) }; }
    finally { attempt.running = false; if (this.live) this.changed(); }
  }
  canRetire(value: BrowserCloseWindowIntent): boolean {
    const intent = parseBrowserCloseWindowIntent(value);
    return Boolean(this.live && !this.error && !this.retiring && ![...this.attempts.values()].some(attempt => attempt.running)
      && intent.receipt && intent.receipt.outcome !== "unknown" && same(this.find(intent), intent)
      && same(this.values, this.current) && same(this.values, this.savedValues));
  }
  /** Explicit local history dismissal. The host journal and request IDs are never
   * deleted, queried or replayed. An unknown record cannot be retired. */
  async retire(value: BrowserCloseWindowIntent): Promise<{ retired: boolean; message: string }> {
    const intent = parseBrowserCloseWindowIntent(value);
    if (!this.canRetire(intent)) return { retired: false, message: "Only saved, confirmed Close records can be dismissed while no Close operation is running." };
    const previous = this.intents;
    this.retiring = true;
    try {
      const acknowledgement = this.checkpoint.waitRemoval(intent, this.lifetime.signal);
      this.values = previous.filter(row => browserCloseIntentKey(row) !== browserCloseIntentKey(intent)); this.changed();
      await acknowledgement;
      if (!this.live || this.error || !same(this.values, this.current) || !same(this.values, this.savedValues))
        throw new Error("The current retired Close history has not been acknowledged.");
      const key = sourceKey(intent.source), attempt = this.attempts.get(key);
      if (attempt?.intent && browserCloseIntentKey(attempt.intent) === browserCloseIntentKey(intent)) this.attempts.delete(key);
      return { retired: true, message: "Confirmed Close history dismissed from this window." };
    } catch (cause) {
      // Failure is not disk rollback. Restore the known record for the next normal save.
      if (this.live) this.values = previous;
      return { retired: false, message: message(cause) };
    } finally { this.retiring = false; if (this.live) this.changed(); }
  }
  dispose(): void { this.live = false; this.lifetime.abort(); for (const attempt of this.attempts.values()) attempt.cancellation.abort(); this.checkpoint.dispose(); }
}
