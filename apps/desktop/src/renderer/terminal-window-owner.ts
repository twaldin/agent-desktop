import type { DesktopBridge, TerminalCreationBridge, TerminalCreationRequest } from "@agent-desktop/shared";
import { parseTerminalWindowIntents, type TerminalWindowIntent } from "../terminal-window-intent";
import type { WindowViewState } from "../window-state";
import type { WindowSaveObserver } from "./window-view-state";
import { TerminalCreationController, terminalCreationDescriptor, type TerminalCreationOptions } from "./terminal-creation-controller";
import { unwrapNativeTerminalResult } from "./native-terminal-bridge";
import { TerminalWindowCheckpoint } from "./terminal-window-checkpoint";
import { captureBrowserReplacement, type BrowserReplacementOrigin } from "./browser-workspace-replacement";
import { isCurrentDockPresentation, type DockPresentations } from "./dock-presentations";
import type { TerminalPreparation } from "./use-workbench-dock";

export interface TerminalWindowContext {
  hostId: string;
  target?: TerminalCreationRequest["target"];
  connected: boolean;
  enabled: boolean;
  presentations: DockPresentations;
}
interface Entry {
  options: TerminalCreationOptions;
  // undefined has not observed a committed source yet; null observed it absent.
  origin?: BrowserReplacementOrigin | null;
  controller: TerminalCreationController;
  running: boolean;
  retiring?: TerminalWindowIntent;
  admission?: AbortController;
  detachedInspection?: boolean;
  settled?: () => void;
}
const key = (intent: TerminalWindowIntent) => `${intent.hostId}:${intent.request.requestId}`;
const targetKey = (target: TerminalCreationRequest["target"]) => "sessionId" in target ? `session:${target.sessionId}` : `project:${target.projectId}`;

/** Retained by one window, not one route or panel. The App feeds committed
 * context before committed view, and its existing save bridge feeds saved/failed.
 * Rendering reads intents; only explicit prepare/inspect can issue requests. */
export class TerminalWindowOwner implements WindowSaveObserver {
  private context?: TerminalWindowContext;
  private readonly checkpoint = new TerminalWindowCheckpoint();
  private readonly entries = new Set<Entry>();
  private values: TerminalWindowIntent[];
  private live = true;
  private saveError?: string;
  private generation = 0;
  constructor(private readonly bridge: Partial<TerminalCreationBridge & Pick<DesktopBridge, "nativeTerminalQuery">>, restored: readonly TerminalWindowIntent[],
    private readonly changed: () => void, private readonly restorationError?: string) {
    this.values = parseTerminalWindowIntents(restored);
    for (const intent of this.values) this.entry({ hostId: intent.hostId, target: intent.request.target, source: intent.source,
      cols: intent.request.cols, rows: intent.request.rows }, intent);
  }
  get intents(): TerminalWindowIntent[] { return structuredClone(this.values); }
  get error() { return this.restorationError ?? this.saveError; }
  private notify() { if (this.live) this.changed(); }
  private capture(options: TerminalCreationOptions, presentations = this.context?.presentations): BrowserReplacementOrigin | undefined {
    const source = options.source;
    if (!presentations || source.kind !== "browser" || !("sessionId" in options.target)) return;
    const origin = captureBrowserReplacement(presentations, source.tabId, { kind: "chat", hostId: options.hostId, sessionId: options.target.sessionId });
    const tab = presentations.snapshot.tabs.find(tab => tab.id === source.tabId);
    return origin && tab?.browserInstanceId === source.browserInstanceId && origin.title === source.title && origin.state.draft === source.draft ? origin : undefined;
  }
  private sourceCurrent(entry: Pick<Entry, "options" | "origin" | "detachedInspection">): boolean {
    const context = this.context;
    if (!context) return false;
    if (entry.options.source.kind === "dock" || entry.detachedInspection) return true;
    const origin = entry.origin, current = this.capture(entry.options);
    if (!origin || !current || !isCurrentDockPresentation(context.presentations, origin.presentation)) return false;
    const region = context.presentations.snapshot.state[origin.presentation.destination];
    return region.open && region.activeTabId === origin.presentation.tabId && current.state === origin.state && current.title === origin.title;
  }
  private entry(options: TerminalCreationOptions, restored?: TerminalWindowIntent): Entry {
    const entry = { options: structuredClone(options), running: false } as Entry;
    entry.controller = new TerminalCreationController(this.bridge, entry.options, () => ({
      hostId: this.context?.hostId ?? "", target: this.context?.target, connected: Boolean(this.context?.connected),
      enabled: Boolean(this.live && this.context?.enabled && !this.error), sourceCurrent: this.sourceCurrent(entry),
    }), intent => {
      const previous = entry.controller.intent;
      const next = this.values.filter(value => !previous || key(value) !== key(previous));
      if (intent) next.push(intent);
      this.values = parseTerminalWindowIntents(next);
      this.notify();
    }, (intent, signal) => this.checkpoint.wait(intent, signal), () => this.notify(), restored);
    this.entries.add(entry);
    return entry;
  }
  /** Deliver every committed transition, including temporary loss. No render
   * value or route cleanup is allowed to erase saved attempt knowledge. */
  commit(context: TerminalWindowContext) {
    const old = this.context;
    if (!old || old.hostId !== context.hostId || (old.target && targetKey(old.target)) !== (context.target && targetKey(context.target))
      || old.connected !== context.connected || old.enabled !== context.enabled) this.generation++;
    this.context = { ...context, target: context.target ? { ...context.target } : undefined };
    let observedSource = false;
    for (const entry of this.entries) {
      if (entry.options.source.kind === "browser" && entry.origin === undefined) {
        entry.origin = this.capture(entry.options) ?? null; observedSource = true;
      }
      if (!this.eligible(entry)) entry.admission?.abort(); entry.controller.observe();
    }
    if (observedSource) this.notify();
  }
  private eligible(entry: Pick<Entry, "options" | "origin" | "detachedInspection">) {
    return this.live && !this.error && this.context?.enabled && this.context.connected && this.context.hostId === entry.options.hostId
      && this.context.target && targetKey(this.context.target) === targetKey(entry.options.target) && this.sourceCurrent(entry);
  }
  /** Guard queued publication as well as the asynchronous preparation. */
  attachmentGuard(options: TerminalCreationOptions): () => boolean {
    return this.captureAttachmentGuard(options, false);
  }
  private captureAttachmentGuard(options: TerminalCreationOptions, detached: boolean): () => boolean {
    const generation = this.generation, origin = this.capture(options);
    const entry = { options, origin, detachedInspection: detached };
    return () => this.generation === generation && Boolean(this.eligible(entry));
  }
  /** Recovery uses the saved request's actual owner. Dock adoption deliberately
   * waives browser presence, never host/workspace/connection or entry lifetime. */
  recoveryAttachmentGuard(requestKey: string, detached = false): () => boolean {
    const entry = [...this.entries].find(value => value.controller.intent && key(value.controller.intent) === requestKey);
    if (!entry) return () => false;
    const guard = this.captureAttachmentGuard(entry.options, detached);
    return () => this.entries.has(entry) && (detached || this.sourceCurrent(entry)) && guard();
  }
  committed(view: WindowViewState) {
    this.checkpoint.committed(view);
    for (const entry of this.entries) {
      const intent = entry.controller.intent;
      if (intent && entry.controller.attached(view)) entry.retiring = intent;
    }
  }
  saved(view: WindowViewState) {
    this.saveError = undefined;
    this.checkpoint.saved(view);
    for (const entry of this.entries) {
      if (!entry.retiring || view.terminalCreations?.some(value => key(value) === key(entry.retiring!))) continue;
      const state = entry.controller.state;
      if (state.status !== "ready") continue;
      const tabs = view.dock?.tabs.filter(tab => tab.id === state.tab.id) ?? [];
      const locations = (["right", "bottom"] as const).filter(side => view.dock?.state[side].tabIds.includes(state.tab.id));
      if (tabs.length !== 1 || locations.length !== 1 || tabs[0]?.kind !== "terminal" || tabs[0].hostId !== state.tab.hostId
        || tabs[0].target !== state.tab.target || tabs[0].terminalId !== state.tab.terminalId) continue;
      this.settle(entry);
    }
  }
  failed(message: string) { this.saveError = message; this.checkpoint.failed(message); for (const entry of this.entries) { entry.admission?.abort(); entry.controller.observe(); } }
  private blocked(options: TerminalCreationOptions): Entry | undefined {
    return [...this.entries].find(entry => entry.options.hostId === options.hostId && targetKey(entry.options.target) === targetKey(options.target));
  }
  private settle(entry: Entry) {
    entry.controller.dispose(); this.entries.delete(entry);
    const callback = entry.settled; entry.settled = undefined; callback?.();
  }
  async prepare(options: TerminalCreationOptions, signal?: AbortSignal, catalogMode?: "reuse" | "validate", settled?: () => void): Promise<TerminalPreparation> {
    if (!this.live || !this.context || this.error) return { status: "error", outcome: "not-submitted", message: this.error ?? "The window is not ready to own a terminal request." };
    const existing = this.blocked(options);
    // The existing request retains its own uncertainty. This new call has not
    // queried or acquired anything, including when it comes from another tab.
    if (existing) return existing.running ? { status: "busy" } : { status: "error", outcome: "not-submitted", message: "Resolve this workspace’s original terminal request before creating another terminal." };
    if (this.values.length >= 64) return { status: "error", outcome: "not-submitted", message: "Resolve saved terminal requests before opening more terminals." };
    const entry = this.entry(options); entry.origin = this.capture(entry.options) ?? null; entry.running = true; entry.settled = settled;
    const admission = new AbortController(), abort = () => admission.abort(); entry.admission = admission;
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    try {
      if (!this.eligible(entry) || admission.signal.aborted) return { status: "cancelled", creationMayHaveRun: false };
      if (catalogMode) {
        if (!this.bridge.nativeTerminalQuery) return { status: "error", outcome: "not-submitted", message: "Update this desktop to inspect workspace terminals." };
        const catalog = unwrapNativeTerminalResult(await this.bridge.nativeTerminalQuery({ type: "list", target: options.target }, options.hostId));
        if (!this.eligible(entry) || admission.signal.aborted) return { status: "cancelled", creationMayHaveRun: false };
        if (catalog.type !== "list" || !Array.isArray(catalog.terminals)) throw new Error("The host returned an invalid terminal catalog.");
        const tabs = catalog.terminals.map(pane => {
          if ("filePath" in pane.target) throw new Error("The host returned a terminal without a project or session owner.");
          return terminalCreationDescriptor({ ...pane, target: pane.target }, options.hostId);
        }).filter(tab => tab.target === targetKey(options.target));
        let selected: string | null = null;
        try { selected = localStorage.getItem(`terminal.native.selected.${options.hostId}.${targetKey(options.target)}`); } catch { /* Optional local preference. */ }
        const tab = tabs.find(tab => tab.terminalId === selected) ?? tabs[0];
        if (tab && catalogMode === "reuse") return { status: "ready", tab };
      }
      return await entry.controller.prepare(admission.signal);
    } catch (error) {
      return admission.signal.aborted ? { status: "cancelled", creationMayHaveRun: false }
        : { status: "error", outcome: "not-submitted", message: error instanceof Error ? error.message : String(error) };
    }
    finally {
      signal?.removeEventListener("abort", abort); entry.admission = undefined;
      entry.running = false;
      if (!entry.controller.intent && !entry.retiring) { entry.controller.dispose(); this.entries.delete(entry); }
      this.notify();
    }
  }
  inspect(requestKey: string): Promise<TerminalPreparation> { return this.inspectResult(requestKey, false); }
  /** Separate explicit user action: inspect the original request for adoption
   * into an ordinary terminal dock when its initiating browser no longer exists.
   * This does not recreate or overwrite that browser or repeat acquisition. */
  inspectToDock(requestKey: string): Promise<TerminalPreparation> { return this.inspectResult(requestKey, true); }
  private async inspectResult(requestKey: string, detached: boolean): Promise<TerminalPreparation> {
    const entry = [...this.entries].find(value => value.controller.intent && key(value.controller.intent!) === requestKey);
    if (!entry || !this.live) return { status: "error", outcome: "not-submitted", message: "The saved terminal request is unavailable." };
    if (entry.running) return { status: "busy" };
    entry.detachedInspection = detached;
    // A fresh explicit check may follow the same presentation to its new
    // region. A replacement incarnation or edited draft cannot inherit it.
    const current = this.capture(entry.options);
    if (entry.origin && current && current.presentation.instanceId === entry.origin.presentation.instanceId
      && current.state === entry.origin.state && current.title === entry.origin.title) entry.origin = current;
    entry.running = true;
    try { return await entry.controller.inspect(); }
    finally {
      entry.detachedInspection = false;
      entry.running = false;
      if (!entry.controller.intent && !entry.retiring) this.settle(entry);
      this.notify();
    }
  }
  status(requestKey: string) {
    const entry = [...this.entries].find(value => value.controller.intent && key(value.controller.intent!) === requestKey);
    return entry ? { state: entry.controller.state, checking: entry.controller.checking, running: entry.running } : undefined;
  }
  /** Recovery belongs on the original presentation, even when moved or hidden.
   * A replacement or changed source instead needs explicit dock adoption. Read
   * the supplied render snapshot without changing the committed admission owner. */
  hasRecoveryBrowser(requestKey: string, presentations: DockPresentations): boolean {
    const entry = [...this.entries].find(value => value.controller.intent && key(value.controller.intent!) === requestKey);
    if (!entry) return false;
    const current = this.capture(entry.options, presentations);
    return Boolean(current && (entry.origin === undefined || entry.origin && current.presentation.instanceId === entry.origin.presentation.instanceId
      && current.state === entry.origin.state && current.title === entry.origin.title));
  }
  retainsSource(presentations: DockPresentations, tabId: string): boolean {
    return [...this.entries].some(entry => {
      if (entry.options.source.kind !== "browser" || entry.options.source.tabId !== tabId) return false;
      if (!entry.running && !entry.controller.intent && !entry.retiring) return false;
      if (entry.origin === null) return false;
      // Moving invalidates an attachment captured for the former region, but
      // must not make an unresolved request eligible for automatic disposal.
      if (entry.origin) return presentations.instances.get(tabId) === entry.origin.presentation.instanceId;
      const tab = presentations.snapshot.tabs.find(value => value.id === tabId);
      return tab?.browserInstanceId === entry.options.source.browserInstanceId && tab.hostId === entry.options.hostId && tab.target === targetKey(entry.options.target);
    });
  }
  dispose() {
    this.live = false; this.checkpoint.failed("The terminal request’s window closed.");
    for (const entry of this.entries) { entry.admission?.abort(); entry.controller.dispose(); }
  }
}
