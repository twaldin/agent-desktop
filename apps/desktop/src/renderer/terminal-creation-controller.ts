import { parseTerminalCreationCapabilities, parseTerminalCreationResponse, type TerminalCreationBridge,
  type TerminalCreationMetadata, type TerminalCreationResponse, type TerminalCreationRequest } from "@agent-desktop/shared";
import { parseTerminalWindowIntent, type TerminalWindowIntent } from "../terminal-window-intent";
import { dockTabId, createDockState, insertDockTab, type DockTab } from "./dock-state";
import { parseDockSnapshot, type WindowViewState } from "../window-state";
import { unwrapNativeTerminalResult } from "./native-terminal-bridge";
import type { TerminalPreparation } from "./use-workbench-dock";

export interface TerminalCreationOwner {
  hostId: string;
  target?: TerminalCreationRequest["target"];
  connected: boolean;
  enabled: boolean;
  /** The caller validates its original runtime source, not merely a logical ID. */
  sourceCurrent: boolean;
}
export interface TerminalCreationOptions {
  hostId: string;
  target: TerminalCreationRequest["target"];
  source: TerminalWindowIntent["source"];
  cols: number;
  rows: number;
}
function sameTarget(a: TerminalCreationRequest["target"] | undefined, b: TerminalCreationRequest["target"]): boolean {
  return Boolean(a && ("sessionId" in a ? "sessionId" in b && a.sessionId === b.sessionId : "projectId" in b && a.projectId === b.projectId));
}
export function terminalCreationDescriptor(metadata: Pick<TerminalCreationMetadata, "target" | "id" | "cwd">, hostId: string): DockTab {
  const tab: DockTab = { kind: "terminal", hostId, target: "sessionId" in metadata.target ? `session:${metadata.target.sessionId}` : `project:${metadata.target.projectId}`,
    terminalId: metadata.id, title: (metadata.cwd.split("/").filter(Boolean).at(-1) ?? "Terminal").slice(0, 1000), id: "" };
  tab.id = dockTabId(tab);
  const parsed = parseDockSnapshot({ state: insertDockTab(createDockState(), tab, "bottom"), tabs: [tab] });
  if (!parsed) throw new Error("The observed terminal cannot be represented by this desktop.");
  return parsed.tabs[0]!;
}
/** One explicit creation attempt. Restored intent is inspection-only. The window
 * owns persistence and committed lifecycle observations; this owner never reads
 * a terminal list or calls unkeyed acquisition to repair an unknown outcome. */
export class TerminalCreationController {
  private live = true;
  private started = false;
  private active?: AbortController;
  private reservedId?: string;
  private finalOutcome?: "completed" | "not-submitted";
  private intentValue?: TerminalWindowIntent;
  state: TerminalPreparation = { status: "busy" };
  checking = false;
  constructor(private readonly bridge: Partial<TerminalCreationBridge>, private readonly options: TerminalCreationOptions,
    private readonly current: () => TerminalCreationOwner,
    private readonly persist: (intent: TerminalWindowIntent | undefined) => void,
    private readonly checkpoint: (intent: TerminalWindowIntent, signal: AbortSignal) => Promise<void>,
    private readonly changed: () => void, restored?: TerminalWindowIntent) {
    // Copy constructor inputs so a later caller mutation cannot retarget the request.
    this.options = structuredClone(options);
    if (restored) {
      const intent = parseTerminalWindowIntent(restored);
      const bound = parseTerminalWindowIntent({ ...intent, hostId: options.hostId, source: options.source,
        request: { ...intent.request, target: options.target, cols: options.cols, rows: options.rows } });
      if (JSON.stringify(intent) !== JSON.stringify(bound)) throw new Error("The restored terminal intent belongs to another source.");
      this.intentValue = intent; this.started = true;
      this.state = { status: "error", outcome: "unknown", message: "A saved terminal request needs an explicit result check. It will not be repeated." };
    }
  }
  get intent() { return this.intentValue ? structuredClone(this.intentValue) : undefined; }
  private eligible() {
    const current = this.current();
    return this.live && current.connected && current.enabled && current.sourceCurrent
      && current.hostId === this.options.hostId && sameTarget(current.target, this.options.target);
  }
  /** Required on every committed owner/source/connection transition. An abort
   * latches loss even if eligibility is restored before the pending reply. */
  observe() { if (!this.eligible()) this.active?.abort(); }
  cancel() { this.active?.abort(); }
  dispose() { this.live = false; this.active?.abort(); }
  private set(result: TerminalPreparation) { this.state = result; if (this.live) this.changed(); return result; }
  private save(intent: TerminalWindowIntent | undefined) {
    const next = intent ? parseTerminalWindowIntent(intent) : undefined;
    this.persist(next ? structuredClone(next) : undefined);
    this.intentValue = next;
  }
  private usable(operation: AbortController) { this.observe(); return this.live && !operation.signal.aborted; }
  private validate(value: unknown, intent: TerminalWindowIntent): TerminalCreationResponse {
    const response = parseTerminalCreationResponse(value, intent.hostId, intent.request);
    const id = response.status === "pending" ? response.terminalId : response.status === "settled" ? response.receipt.terminalId : undefined;
    if (id && this.reservedId && id !== this.reservedId) throw new Error("The terminal result changed its reserved identity. No replacement was requested.");
    if (id) this.reservedId = id;
    if (this.finalOutcome && response.status === "settled" && response.receipt.outcome !== this.finalOutcome)
      throw new Error("The terminal creation receipt changed its final outcome.");
    if (response.status === "settled" && response.receipt.outcome !== "unknown") this.finalOutcome = response.receipt.outcome;
    return response;
  }
  private async read(intent: TerminalWindowIntent, operation: AbortController, explicit: boolean): Promise<TerminalPreparation> {
    if (!this.bridge.observeTerminalCreation) throw new Error("This desktop cannot inspect the original terminal request. Update it without repeating creation.");
    const raw = await this.bridge.observeTerminalCreation(structuredClone(intent.request), intent.hostId);
    if (!this.usable(operation)) return { status: "cancelled", creationMayHaveRun: true };
    const response = this.validate(unwrapNativeTerminalResult(raw), intent);
    if (response.status === "settled" && response.receipt.outcome === "not-submitted") {
      this.save(undefined); return { status: "error", outcome: "not-submitted", message: response.receipt.message };
    }
    // Explicit recovery may adopt a positively identified live reserved terminal
    // even if the immutable receipt remains unknown. Never rewrite that receipt.
    if (response.terminal?.attachable === true && (explicit || response.status === "settled" && response.receipt.outcome === "completed"))
      return { status: "ready", tab: terminalCreationDescriptor(response.terminal, intent.hostId) };
    return { status: "error", outcome: "unknown", message: response.status === "unavailable"
      ? "The host has no observable result for this exact request. Creation was not repeated."
      : "The original terminal is not currently available for attachment. Check again after reconnecting; no new shell was started." };
  }
  async prepare(signal?: AbortSignal): Promise<TerminalPreparation> {
    if (this.active) return { status: "busy" };
    if (this.started) return { status: "error", outcome: "unknown", message: "This attempt cannot create another terminal. Inspect its original result." };
    if (!this.eligible() || signal?.aborted) return { status: "cancelled", creationMayHaveRun: false };
    if (!this.bridge.getTerminalCreationCapabilities || !this.bridge.createNativeTerminal || !this.bridge.observeTerminalCreation)
      return this.set({ status: "error", outcome: "not-submitted", message: "Update this desktop to create terminals with durable request ownership." });
    this.started = true;
    const operation = new AbortController(), abort = () => operation.abort();
    this.active = operation; signal?.addEventListener("abort", abort, { once: true });
    let sent = false;
    try {
      this.set({ status: "busy" });
      if (!this.usable(operation)) return this.set({ status: "cancelled", creationMayHaveRun: false });
      const raw = await this.bridge.getTerminalCreationCapabilities(this.options.hostId);
      if (!this.usable(operation)) return this.set({ status: "cancelled", creationMayHaveRun: false });
      const capabilities = parseTerminalCreationCapabilities(unwrapNativeTerminalResult(raw), this.options.hostId);
      const intent = parseTerminalWindowIntent({ version: 1, hostId: this.options.hostId, source: this.options.source,
        request: { version: 1, requestId: crypto.randomUUID(), controlEpoch: capabilities.controlEpoch, target: this.options.target, cols: this.options.cols, rows: this.options.rows } });
      this.save(intent);
      await this.checkpoint(structuredClone(intent), operation.signal);
      if (!this.usable(operation)) { this.save(undefined); return this.set({ status: "cancelled", creationMayHaveRun: false }); }
      sent = true;
      const result = await this.bridge.createNativeTerminal(structuredClone(intent.request), intent.hostId);
      if (!this.usable(operation)) return this.set({ status: "cancelled", creationMayHaveRun: true });
      const response = this.validate(unwrapNativeTerminalResult(result), intent);
      if (response.status === "settled" && response.receipt.outcome === "not-submitted") {
        this.save(undefined); return this.set({ status: "error", outcome: "not-submitted", message: response.receipt.message });
      }
      if (response.status !== "settled" || response.receipt.outcome !== "completed")
        return this.set({ status: "error", outcome: "unknown", message: "Terminal creation is unresolved. Check the original result; it will not be repeated." });
      return this.set(await this.read(intent, operation, false));
    } catch (error) {
      if (!sent) { try { this.save(undefined); } catch { /* Retain unresolved persisted input if the window writer also rejects removal. No create was sent. */ } }
      return this.set(operation.signal.aborted || !this.live ? { status: "cancelled", creationMayHaveRun: sent }
        : { status: "error", outcome: sent ? "unknown" : "not-submitted", message: error instanceof Error ? error.message : String(error) });
    } finally { signal?.removeEventListener("abort", abort); if (this.active === operation) this.active = undefined; }
  }
  async inspect(): Promise<TerminalPreparation> {
    if (this.active) return { status: "busy" };
    if (!this.intentValue) return { status: "error", outcome: "not-submitted", message: "There is no saved terminal request to inspect." };
    if (!this.eligible()) return { status: "cancelled", creationMayHaveRun: true };
    const operation = new AbortController(); this.active = operation; this.checking = true;
    try {
      this.changed();
      if (!this.usable(operation)) return this.set({ status: "cancelled", creationMayHaveRun: true });
      return this.set(await this.read(this.intentValue, operation, true));
    } catch (error) {
      return this.set(operation.signal.aborted || !this.live ? { status: "cancelled", creationMayHaveRun: true }
        : { status: "error", outcome: "unknown", message: error instanceof Error ? error.message : String(error) });
    } finally { this.checking = false; if (this.active === operation) this.active = undefined; if (this.live) this.changed(); }
  }
  /** Retire only after the confirmed descriptor appears in committed window
   * state. Merely returning ready or enqueueing a replacement is insufficient. */
  attached(view: WindowViewState): boolean {
    if (!this.live || !this.intentValue || this.state.status !== "ready") return false;
    const expected = this.state.tab, tabs = view.dock?.tabs.filter(tab => tab.id === expected.id) ?? [];
    const tab = tabs.length === 1 ? tabs[0] : undefined;
    const locations = (["right", "bottom"] as const).filter(side => view.dock?.state[side].tabIds.includes(expected.id));
    if (!tab || locations.length !== 1 || tab.id !== dockTabId(tab) || tab.kind !== "terminal" || tab.hostId !== expected.hostId || tab.target !== expected.target || tab.terminalId !== expected.terminalId) return false;
    this.save(undefined); return true;
  }
}
