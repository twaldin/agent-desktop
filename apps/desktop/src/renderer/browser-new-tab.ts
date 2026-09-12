import type { HtmlPreviewAdmission } from "../../../../packages/shared/src/html-preview";
import { parseBrowserCreateRequest, parseBrowserNavigationUrl, parseNativeBrowserTabMetadata,
  type BrowserCreateRequest, type BrowserCreateReceipt, type NativeBrowserTabMetadata, type BrowserFrameTarget, type DesktopBridge } from "@agent-desktop/shared";
import { dockTabId, type DockTab } from "./dock-state";
import { browserNavigationAddress } from "./browser-address";

/** A local launcher, not an assertion about a native about:blank document. */
export interface BrowserNewTabState {
  status: "idle" | "pending" | "rejected" | "unknown";
  /** Presence matters: an explicitly empty draft is still an edit. */
  draft?: string;
  request?: BrowserCreateRequest;
  preview?: HtmlPreviewAdmission;
  message?: string;
}

export function parseBrowserNewTabState(value: unknown): BrowserNewTabState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid browser launcher.");
  const v = value as BrowserNewTabState;
  if (!["idle", "pending", "rejected", "unknown"].includes(v.status)
    || v.draft !== undefined && (typeof v.draft !== "string" || v.draft.length > 8192 || v.draft.includes("\0"))
    || v.message !== undefined && (typeof v.message !== "string" || v.message.length > 4096)) throw new Error("Invalid browser launcher state.");
  if (v.preview !== undefined && (!Number.isSafeInteger(v.preview?.workerPid) || v.preview.workerPid <= 0 || !Number.isSafeInteger(v.preview.expiresAt) || v.preview.expiresAt <= 0)) throw new Error("Invalid original HTML preview owner.");
  const request = v.request === undefined ? undefined : parseBrowserCreateRequest(v.request);
  if (request && request.initialUrl === undefined || v.status === "unknown" && !request || v.status === "idle" && request) throw new Error("Invalid browser launcher request.");
  // Loading a window never resumes an acquisition. A ticket lookup has no side effect.
  const status = v.status === "pending" ? request ? "unknown" : "idle" : v.status;
  return { status, ...(v.preview ? { preview: { ...v.preview } } : {}), ...(v.draft === undefined ? {} : { draft: v.draft }), ...(request ? { request } : {}),
    ...(v.status === "pending" && request ? { message: "Browser creation was interrupted. Its outcome is unknown; the address is retained." }
      : v.message === undefined ? {} : { message: v.message }) };
}

export function createBrowserNewTab(hostId: string, sessionId: string, instanceId: string = crypto.randomUUID()): DockTab {
  const descriptor: Omit<DockTab, "id"> = { kind: "browser", title: "New tab", hostId, target: `session:${sessionId}`,
    browserInstanceId: instanceId, browserNewTab: { status: "idle" } };
  return { ...descriptor, id: dockTabId(descriptor) };
}

export class BrowserNewTabController {
  private live = true;
  private readonly saveCancellation = new AbortController();
  private inFlight = false;
  private presentationObserved = false;
  private connectionAvailable = false;
  private connectionGeneration = 0;
  get connected() { return this.connectionAvailable; }
  set connected(value: boolean) {
    if (this.connectionAvailable && !value) this.connectionGeneration++;
    this.connectionAvailable = value;
  }
  checking = false;
  state: BrowserNewTabState;
  private readonly sessionId: string;
  constructor(private bridge: Pick<DesktopBridge, "getBrowserMetadata" | "createBrowserTab" | "getBrowserCreationStatus">, readonly tab: DockTab,
    private changed: (state: BrowserNewTabState) => void,
    private materialized: (target: BrowserFrameTarget, title: string) => void,
    private checkpoint: (tab: DockTab, state: BrowserNewTabState, signal: AbortSignal) => Promise<void>) {
    if (!tab.browserNewTab || !tab.browserInstanceId || tab.browserTarget || tab.kind !== "browser" || !tab.target.startsWith("session:")) throw new Error("A browser launcher requires its own session identity.");
    this.sessionId = tab.target.slice(8);
    this.state = parseBrowserNewTabState(tab.browserNewTab);
  }
  dispose() { this.live = false; this.saveCancellation.abort(); }
  /** Committed local presentation state, not native metadata or a paint claim. */
  observePresentation() { if (this.live) this.presentationObserved = true; }
  get hasObservedPristinePresentation(): boolean {
    return this.live && this.presentationObserved && !this.inFlight && this.state.status === "idle"
      && this.state.draft === undefined && this.state.request === undefined;
  }
  private set(state: BrowserNewTabState) { if (this.state.preview && state.draft === this.state.draft) state = { ...state, preview: this.state.preview }; this.state = state; if (this.live) this.changed(state); }
  edit(draft: string | undefined) {
    if (!this.live || this.inFlight || this.state.status === "unknown") return;
    if (draft !== undefined && (draft.length > 8192 || draft.includes("\0"))) return;
    this.set({ status: "idle", ...(draft === undefined ? {} : { draft }) });
  }
  async submit(retained: () => boolean = () => true) {
    if (!this.live || this.inFlight || this.state.status === "unknown" || !this.state.draft?.trim() || !retained()) return;
    const assertRetained = () => {
      if (!retained()) throw new Error("The original saved output is no longer selected.");
      if (this.state.preview && Date.now() >= this.state.preview.expiresAt) throw new Error("The HTML preview expired. Reopen its current Suggested output.");
    };
    const draft = this.state.draft;
    let request: BrowserCreateRequest | undefined;
    let dispatched = false;
    this.inFlight = true;
    this.set({ status: "pending", draft });
    try {
      assertRetained();
      const initialUrl = parseBrowserNavigationUrl(browserNavigationAddress(draft));
      if (!this.connected) throw new Error("Reconnect to the owning host to open this address.");
      if (!this.bridge.getBrowserMetadata || !this.bridge.createBrowserTab) throw new Error("Update this desktop and host to open browser tabs.");
      const metadata = await this.bridge.getBrowserMetadata(this.sessionId, this.tab.hostId);
      if (!this.live) return;
      assertRetained();
      if (!this.connected) throw new Error("The owning host disconnected before browser creation.");
      if (this.state.preview && (metadata?.availability !== "running" || metadata.workerPid !== this.state.preview.workerPid)) throw new Error("The HTML preview belongs to the original task worker. Reopen its current Suggested output.");
      if (!metadata || metadata.hostId !== this.tab.hostId || metadata.sessionId !== this.sessionId || !metadata.creationTicket) throw new Error("A current creation ticket from this browser's owner is unavailable.");
      request = parseBrowserCreateRequest({ ...metadata.creationTicket, initialUrl, requestId: crypto.randomUUID() });
      this.set({ status: "pending", draft, request });
      if (!this.live) return;
      assertRetained();
      await this.checkpoint(this.tab, this.state, this.saveCancellation.signal);
      if (!this.live) return;
      assertRetained();
      if (!this.connected) throw new Error("The owning host disconnected before browser creation.");
      dispatched = true;
      const receipt = await this.bridge.createBrowserTab(this.sessionId, request, this.tab.hostId);
      if (!this.live) return;
      assertRetained();
      const native = this.validateReceipt(receipt, request);
      if (receipt.outcome !== "completed") {
        this.set({ status: receipt.outcome === "rejected" ? "rejected" : "unknown", draft, request,
          message: typeof receipt.message === "string" ? receipt.message.slice(0, 4096) : "Browser creation could not be confirmed." });
        return;
      }
      this.materialize(native!, receipt.workerPid);
    } catch (cause) {
      if (this.live) this.set({ status: dispatched ? "unknown" : "rejected", draft, ...(request ? { request } : {}),
        message: (cause instanceof Error ? cause.message : "The browser could not be opened.").slice(0, 4096) });
    } finally { this.inFlight = false; }
  }
  private validateReceipt(receipt: BrowserCreateReceipt, request: BrowserCreateRequest): NativeBrowserTabMetadata | undefined {
    if (!receipt || receipt.protocolVersion !== 1 || receipt.hostId !== this.tab.hostId || receipt.sessionId !== this.sessionId || receipt.requestId !== request.requestId)
      throw new Error("The browser creation receipt belongs to a different request or owner.");
    if (receipt.outcome === "rejected" || receipt.outcome === "unknown") {
      if (typeof receipt.message !== "string" || !receipt.message || receipt.message.length > 4096) throw new Error("Invalid browser creation outcome.");
      return;
    }
    if (receipt.outcome !== "completed") throw new Error("Invalid browser creation outcome.");
    const native = parseNativeBrowserTabMetadata(receipt.tab);
    const disposition = native.kindTag === "headless" ? "created-page" : native.kindTag === "cmux" ? "created-surface" : "adopted-existing-target";
    if (!Number.isSafeInteger(receipt.workerPid) || receipt.workerPid <= 0 || native.state !== "alive"
      || native.name !== `desktop-${request.requestId}` || receipt.targetDisposition !== disposition) throw new Error("Browser creation returned an invalid native target.");
    return native;
  }
  private materialize(native: NativeBrowserTabMetadata, workerPid: number) {
    this.materialized({ workerPid, name: native.name, targetId: native.targetId },
      (native.title || (native.url === "about:blank" ? "New tab" : native.url) || "Browser").slice(0, 1000));
    this.live = false;
  }
  async inspect() {
    if (!this.live || !this.connected || this.inFlight || this.state.status !== "unknown" || !this.state.request) return;
    const connectionGeneration = this.connectionGeneration;
    const request = this.state.request, draft = this.state.draft;
    this.inFlight = true; this.checking = true; this.set({ ...this.state });
    try {
      if (!this.bridge.getBrowserCreationStatus) throw new Error("Update this desktop and host to inspect the original browser request.");
      const observed = await this.bridge.getBrowserCreationStatus(this.sessionId, request, this.tab.hostId);
      if (!this.live) return;
      if (!this.connected || this.connectionGeneration !== connectionGeneration) throw new Error("The owning host disconnected while checking browser creation. Check again after reconnecting.");
      if (!observed || observed.protocolVersion !== 1 || observed.hostId !== this.tab.hostId || observed.sessionId !== this.sessionId || observed.requestId !== request.requestId)
        throw new Error("The browser observation belongs to a different request or owner.");
      if (observed.status === "pending" || observed.status === "unavailable") {
        if ("receipt" in observed) throw new Error("Invalid browser creation observation.");
        this.set({ status: "unknown", draft, request, message: observed.status === "pending"
          ? "Browser creation is still pending. Check again after it finishes; the request was not repeated."
          : "Creation history is unavailable. The original request is retained and will not be repeated." });
        return;
      }
      if (observed.status !== "settled") throw new Error("Invalid browser creation observation.");
      const receipt = observed.receipt, historical = this.validateReceipt(receipt, request);
      if (receipt.outcome !== "completed") {
        this.set({ status: receipt.outcome === "rejected" ? "rejected" : "unknown", draft, request, message: receipt.message }); return;
      }
      if (!this.bridge.getBrowserMetadata) throw new Error("Read-only browser metadata is unavailable; the request was not repeated.");
      const metadata = await this.bridge.getBrowserMetadata(this.sessionId, this.tab.hostId);
      if (!this.live) return;
      if (!this.connected || this.connectionGeneration !== connectionGeneration) throw new Error("The owning host disconnected while checking the existing browser target. Check again after reconnecting.");
      if (!metadata || metadata.protocolVersion !== 1 || metadata.hostId !== this.tab.hostId || metadata.sessionId !== this.sessionId
        || metadata.availability !== "running" || metadata.workerPid !== receipt.workerPid || !Array.isArray(metadata.tabs))
        throw new Error("The original browser worker is not currently available. The request was not repeated.");
      const matches = metadata.tabs.filter(tab => tab.name === historical!.name && tab.targetId === historical!.targetId);
      if (matches.length !== 1) throw new Error("The original browser target is not currently available. The request was not repeated.");
      const native = parseNativeBrowserTabMetadata(matches[0]);
      if (native.state !== "alive" || native.backend !== historical!.backend || native.kindTag !== historical!.kindTag)
        throw new Error("The original browser target changed. The request was not repeated.");
      this.materialize(native, receipt.workerPid);
    } catch (cause) {
      if (this.live) this.set({ status: "unknown", draft, request,
        message: (cause instanceof Error ? cause.message : "Browser creation could not be inspected.").slice(0, 4096) });
    } finally { this.inFlight = false; this.checking = false; if (this.live) this.set({ ...this.state }); }
  }

}
