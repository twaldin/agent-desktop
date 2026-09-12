import { parseBrowserCreateRequest, parseBrowserCreationTicket, parseBrowserNavigationUrl, parseDraftBrowserCreationReceipt, parseNativeBrowserTabMetadata,
  type BrowserCreateRequest, type DraftBrowserBridge, type DraftBrowserCreationReceipt, type NativeBrowserTabMetadata } from "@agent-desktop/shared";
import type { DraftBrowserWindowIntent } from "../draft-browser-window-intent";
import type { BrowserNewTabState } from "./browser-new-tab";
import { browserNavigationAddress } from "./browser-address";

export { createDraftBrowserPageIntent, parseDraftBrowserPageIntent } from "../draft-browser-page-intent";
export type { DraftBrowserPageIntent } from "../draft-browser-page-intent";
import { parseDraftBrowserPageIntent, type DraftBrowserPageIntent } from "../draft-browser-page-intent";

export interface DraftBrowserPageReady {
  intent: DraftBrowserPageIntent;
  workerPid: number;
  tab: NativeBrowserTabMetadata;
}
/** Explicit draft page creation and journal recovery. Owner acquisition is a
 * prior operation; neither submit nor inspect can create/replace that owner. */
export class DraftBrowserPageController {
  private readonly original: Omit<DraftBrowserPageIntent, "launcher">;
  private current: BrowserNewTabState;
  private context = { connected: false, enabled: false };
  private generation = 0;
  private live = true;
  private busy = false;
  private inspecting = false;
  private cancellation?: AbortController;
  constructor(private readonly bridge: Pick<DraftBrowserBridge, "status" | "create" | "creationStatus" | "metadata">,
    restored: DraftBrowserPageIntent, private readonly changed: (intent: DraftBrowserPageIntent) => void,
    private readonly checkpoint: (intent: DraftBrowserPageIntent, signal: AbortSignal) => Promise<void>,
    private readonly ownerGuard: (owner: DraftBrowserWindowIntent) => (() => boolean),
    private readonly materialized: (result: DraftBrowserPageReady, guard: () => boolean) => Promise<boolean>) {
    const parsed = parseDraftBrowserPageIntent(restored);
    this.original = { version: 1, instanceId: parsed.instanceId, owner: parsed.owner }; this.current = parsed.launcher;
  }
  get intent(): DraftBrowserPageIntent { return structuredClone({ ...this.original, launcher: this.current }); }
  get state(): BrowserNewTabState { return structuredClone(this.current); }
  get checking() { return this.inspecting; }
  observe(context: { connected: boolean; enabled: boolean }) {
    if (!this.live) return;
    if (this.context.connected !== context.connected || this.context.enabled !== context.enabled) { this.generation++; this.cancellation?.abort(); }
    this.context = { ...context };
  }
  private eligible() { return this.live && this.context.connected && this.context.enabled; }
  private set(state: BrowserNewTabState) { this.current = state; if (this.live) this.changed(this.intent); }
  edit(draft: string | undefined) {
    if (!this.live || this.busy || this.current.status === "unknown") return;
    if (draft !== undefined && (draft.length > 8192 || draft.includes("\0"))) return;
    this.set({ status: "idle", ...(draft === undefined ? {} : { draft }) });
  }
  private admission() {
    const generation = ++this.generation, ownerGuard = this.ownerGuard(structuredClone(this.original.owner));
    this.cancellation = new AbortController();
    const current = () => this.eligible() && this.generation === generation && !this.cancellation?.signal.aborted && ownerGuard();
    const assert = () => { if (!current()) throw new Error("The original draft page or owner changed. Check again explicitly; no request was repeated."); };
    return { current, assert };
  }
  private receipt(value: DraftBrowserCreationReceipt, request: BrowserCreateRequest) {
    return parseDraftBrowserCreationReceipt(value, { protocolVersion: 1, ownerKind: "draft", hostId: this.original.owner.hostId,
      ownerId: this.original.owner.reference.ownerId, requestId: request.requestId });
  }
  async submit(): Promise<void> {
    if (!this.eligible() || this.busy || this.current.status === "unknown" || !this.current.draft?.trim()) return;
    const draft = this.current.draft;
    let request: BrowserCreateRequest | undefined, dispatched = false;
    this.busy = true;
    try {
      const admission = this.admission(); admission.assert(); this.set({ status: "pending", draft }); admission.assert();
      const initialUrl = parseBrowserNavigationUrl(browserNavigationAddress(draft));
      const owner = this.original.owner;
      const status = await this.bridge.status(structuredClone(owner.reference), owner.hostId); admission.assert();
      if (!status || status.protocolVersion !== 1 || status.hostId !== owner.hostId || status.ownerId !== owner.reference.ownerId
        || status.state !== "ready" || status.error !== undefined || !Number.isSafeInteger(status.workerPid) || status.workerPid! <= 0)
        throw new Error("The original draft browser owner is not ready. Inspect that owner before opening a page.");
      const expectedWorkerPid = status.workerPid;
      request = parseBrowserCreateRequest({ ...parseBrowserCreationTicket(status.ticket), requestId: crypto.randomUUID(), initialUrl });
      this.set({ status: "pending", draft, request }); admission.assert();
      await this.checkpoint(this.intent, this.cancellation!.signal); admission.assert();
      dispatched = true;
      const value = await this.bridge.create(structuredClone(owner.reference), structuredClone(request), owner.hostId); admission.assert();
      const receipt = this.receipt(value, request);
      if (receipt.outcome === "completed" && receipt.workerPid !== expectedWorkerPid) throw new Error("The browser worker changed during creation. Inspect the original request before continuing.");
      await this.accept(receipt, draft, request, admission);
    } catch (cause) {
      if (this.live) this.set({ status: dispatched ? "unknown" : "rejected", draft, ...(request ? { request } : {}), message: this.message(cause) });
    } finally { this.busy = false; this.cancellation = undefined; }
  }
  private async accept(receipt: DraftBrowserCreationReceipt, draft: string | undefined, request: BrowserCreateRequest,
    admission: { current(): boolean; assert(): void }) {
    admission.assert();
    if (receipt.outcome !== "completed") { this.set({ status: receipt.outcome, draft, request, message: receipt.message }); return; }
    const owner = this.original.owner;
    const metadata = await this.bridge.metadata(structuredClone(owner.reference), owner.hostId); admission.assert();
    if (!metadata || metadata.protocolVersion !== 1 || metadata.ownerKind !== "draft" || metadata.hostId !== owner.hostId
      || metadata.ownerId !== owner.reference.ownerId || metadata.availability !== "running" || metadata.workerPid !== receipt.workerPid
      || !Array.isArray(metadata.tabs) || metadata.tabs.length > 1000) throw new Error("The original browser worker cannot be confirmed. The request was not repeated.");
    const matching = metadata.tabs.filter(tab => tab.name === receipt.tab.name && tab.targetId === receipt.tab.targetId);
    if (matching.length !== 1) throw new Error("The original browser target is unavailable. The request was not repeated.");
    const tab = parseNativeBrowserTabMetadata(matching[0]);
    if (tab.state !== "alive" || tab.backend !== receipt.tab.backend || tab.kindTag !== receipt.tab.kindTag)
      throw new Error("The original browser target changed. The request was not repeated.");
    admission.assert();
    const accepted = await this.materialized({ intent: this.intent, workerPid: receipt.workerPid, tab }, admission.current);
    admission.assert();
    if (accepted !== true) throw new Error("The initiating page no longer accepts this target. The original request is retained for inspection.");
    // The consumer acknowledged its queued replacement. A new controller can
    // only recover from its own saved original intent; no automatic replay.
    this.live = false;
  }
  async inspect(): Promise<void> {
    if (!this.eligible() || this.busy || this.current.status !== "unknown" || !this.current.request) return;
    const request = structuredClone(this.current.request), draft = this.current.draft;
    this.busy = true; this.inspecting = true;
    try {
      const admission = this.admission(); admission.assert(); this.set({ ...this.current }); admission.assert();
      const owner = this.original.owner;
      const value = await this.bridge.creationStatus(structuredClone(owner.reference), structuredClone(request), owner.hostId); admission.assert();
      if (!value || value.protocolVersion !== 1 || value.ownerKind !== "draft" || value.hostId !== owner.hostId
        || value.ownerId !== owner.reference.ownerId || value.requestId !== request.requestId) throw new Error("The creation history belongs to a different draft owner or request.");
      if (value.status === "pending" || value.status === "unavailable") {
        if ("receipt" in value) throw new Error("Invalid draft page observation.");
        this.set({ status: "unknown", draft, request, message: value.status === "pending"
          ? "Page creation is still pending. Check again later; the request was not repeated."
          : "Page creation history is unavailable. The original request is retained without replay." }); return;
      }
      if (value.status !== "settled") throw new Error("Invalid draft page observation.");
      await this.accept(this.receipt(value.receipt, request), draft, request, admission);
    } catch (cause) { if (this.live) this.set({ status: "unknown", draft, request, message: this.message(cause) }); }
    finally { this.busy = false; this.inspecting = false; this.cancellation = undefined; if (this.live) this.set({ ...this.current }); }
  }
  private message(cause: unknown) { return (cause instanceof Error ? cause.message : "Draft browser page could not be confirmed.").slice(0, 4096); }
  dispose() { this.live = false; this.generation++; this.cancellation?.abort(); }
}
