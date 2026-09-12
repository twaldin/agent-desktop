import type { DesktopBridge } from "@agent-desktop/shared";
import type { BrowserCloseWindowIntent } from "../browser-close-window-intent";
import type { WindowViewState } from "../window-state";
import { BrowserCloseWindowOwner, type BrowserCloseResult } from "./browser-close-window-owner";
import { captureDockPresentation, isCurrentDockPresentation, type DockPresentationRef, type DockPresentations } from "./dock-presentations";
import { closeDockTab, draftBrowserIdFromDock, type DockTab } from "./dock-state";
import type { DraftBrowserDockController } from "./draft-browser-dock-controller";
import type { BrowserNewTabState } from "./browser-new-tab";
import type { DraftBrowserPageIntent } from "../draft-browser-page-intent";

/** Titles/unread flags may change while Close is pending; native/local identity may not. */
export function sameCloseBrowser(a: DockTab, b: DockTab): boolean {
  const identity = (tab: DockTab) => [tab.id, tab.kind, tab.hostId, tab.target, tab.browserInstanceId,
    tab.browserTarget?.workerPid, tab.browserTarget?.name, tab.browserTarget?.targetId,
    tab.browserNewTab?.status, tab.browserNewTab?.draft, tab.browserNewTab?.request];
  return JSON.stringify(identity(a)) === JSON.stringify(identity(b));
}

/** Called INSIDE the dock's functional updater, after the outcome save. */
export function removeClosedBrowser(previous: DockPresentations, source: DockPresentationRef, selected: DockTab, allowed: () => boolean) {
  const tab = previous.snapshot.tabs.find(value => value.id === source.tabId);
  if (!allowed() || !isCurrentDockPresentation(previous, source) || !tab || tab.kind !== "browser" || !sameCloseBrowser(tab, selected)) return previous.snapshot;
  return { state: closeDockTab(previous.snapshot.state, source.destination, source.tabId), tabs: previous.snapshot.tabs.filter(value => value.id !== source.tabId) };
}
interface Context {
  route: string; enabled: boolean; connected: ReadonlySet<string>; presentations: DockPresentations;
  drafts: ReadonlyMap<string, Pick<DraftBrowserDockController, "ready" | "previewGuard" | "state">>; pages: readonly DraftBrowserPageIntent[];
  launcher(tab: DockTab): BrowserNewTabState | undefined;
  protected(tab: DockTab): boolean;
}

/** App's committed close owner. Route/overlay/host loss is latched before observers
 * run; save acknowledgement and native request ownership remain in WindowOwner. */
export class BrowserCloseDockOwner {
  private readonly owner: BrowserCloseWindowOwner;
  private context?: Context;
  private routeGeneration = 0;
  private readonly hostGenerations = new Map<string, number>();
  private live = true;
  private feedback?: string;
  private checking = new Set<string>();
  constructor(bridge: Pick<DesktopBridge, "browserClose" | "getBrowserMetadata" | "draftBrowser">,
    restored: readonly BrowserCloseWindowIntent[], private readonly changed: () => void,
    private readonly remove: (source: DockPresentationRef, tab: DockTab, allowed: () => boolean, focusId?: string) => void, error?: string) {
    this.owner = new BrowserCloseWindowOwner(bridge, restored, changed, error);
  }
  get intents() { return this.owner.intents; }
  get message() { return this.feedback ?? this.owner.error; }
  get pending() { return this.checking.size > 0; }
  commit(context: Context) {
    if (!this.live) return;
    const old = this.context;
    if (!old || old.route !== context.route || old.enabled !== context.enabled) this.routeGeneration++;
    if (old) for (const host of old.connected) if (!context.connected.has(host)) this.hostGenerations.set(host, (this.hostGenerations.get(host) ?? 0) + 1);
    this.context = { ...context, connected: new Set(context.connected) };
    this.owner.observe();
  }
  committed(view: WindowViewState) { this.owner.committed(view); }
  saved(view: WindowViewState) { this.owner.saved(view); }
  failed(message: string) { this.owner.failed(message); }
  retains(presentations: DockPresentations, id: string) {
    const source = captureDockPresentation(presentations, id); return Boolean(source && this.owner.retains(source));
  }
  private guard(hostId: string, online: boolean) {
    const route = this.routeGeneration, host = this.hostGenerations.get(hostId) ?? 0;
    return () => Boolean(this.live && this.context?.enabled && route === this.routeGeneration
      && (!online || this.context.connected.has(hostId) && host === (this.hostGenerations.get(hostId) ?? 0)));
  }
  private original(source: DockPresentationRef, tab: DockTab) {
    const context = this.context, current = context?.presentations.snapshot.tabs.find(value => value.id === source.tabId);
    return Boolean(context && current && isCurrentDockPresentation(context.presentations, source) && sameCloseBrowser(current, tab));
  }
  private report(message: string) { if (this.live) { this.feedback = message; this.changed(); } }
  private finish(result: BrowserCloseResult, tab: DockTab | undefined, focusId?: string) {
    if (!this.live) return;
    if (result.status === "retained") { this.report(result.message); return; }
    if (tab && result.canRemove() && this.original(result.intent.source, tab)) {
      this.remove(result.intent.source, tab, result.canRemove, focusId);
      this.report("Browser Close was confirmed and saved.");
    } else this.report("Browser Close was confirmed and saved. The changed or restored tab was retained.");
  }
  async close(value: DockTab, instanceId: string | undefined, focusId?: string): Promise<boolean> {
    // The generic DockPanel remover must NEVER run after our async browser path.
    const context = this.context, tab = structuredClone(value), source = context && captureDockPresentation(context.presentations, tab.id);
    if (!context?.enabled || !source || source.instanceId !== instanceId || !this.original(source, tab)) { this.report("The original browser tab changed. Select it again to close it."); return false; }
    if (context.protected(tab) || this.retains(context.presentations, tab.id)) { this.report("The original browser operation is unresolved. Check its status before closing the tab."); return false; }
    const draftId = draftBrowserIdFromDock(tab.target), controller = draftId ? context.drafts.get(JSON.stringify([tab.id, instanceId])) : undefined;
    const ready = controller?.ready, previewGuard = controller?.previewGuard;
    const target = draftId && ready ? { workerPid: ready.workerPid, name: ready.tab.name, targetId: ready.tab.targetId } : tab.browserTarget;
    if (!target) {
      const page = draftId && context.pages.find(value => value.instanceId === tab.browserInstanceId && value.owner.hostId === tab.hostId && value.owner.reference.draftId === draftId);
      const state = controller?.state ?? context.launcher(tab) ?? tab.browserNewTab;
      if (!state || state.status === "pending" || state.status === "unknown" || state.request && state.status !== "rejected" || page && (page.launcher.request || page.confirmedTarget)) {
        this.report("Inspect the original browser creation before closing this tab. Its outcome is not confirmed."); return false;
      }
      const current = this.guard(tab.hostId, false);
      this.remove(source, tab, () => {
        const latest = this.context, page = draftId && latest?.pages.find(value => value.instanceId === tab.browserInstanceId
          && value.owner.hostId === tab.hostId && value.owner.reference.draftId === draftId);
        const state = controller?.state ?? latest?.launcher(tab) ?? tab.browserNewTab;
        return Boolean(current() && latest && !latest.protected(tab) && !this.retains(latest.presentations, tab.id)
          && state && state.status !== "pending" && state.status !== "unknown" && (!state.request || state.status === "rejected")
          && !(page && (page.launcher.request || page.confirmedTarget)) && !controller?.ready);
      }, focusId);
      return false;
    }
    const current = this.guard(tab.hostId, true);
    const owner = draftId && ready ? { kind: "draft" as const, ...ready.intent.owner.reference }
      : tab.target.startsWith("session:") ? { kind: "session" as const, sessionId: tab.target.slice(8) } : undefined;
    if (!owner || !current()) { this.report("Reconnect to the original browser owner before closing its page."); return false; }
    try {
      const result = await this.owner.close({ source, owner, target, isCurrent: () => current() && this.original(source, tab) && (!draftId || Boolean(previewGuard?.())) });
      this.finish(result, tab, focusId);
    } catch (cause) { this.report(cause instanceof Error ? cause.message : "Browser Close could not be confirmed."); }
    return false;
  }
  /** A saved request is inspected, never replayed or rebound to a restored tab. */
  async inspect(intent: BrowserCloseWindowIntent) {
    if (this.checking.has(intent.request.requestId)) return;
    const current = this.guard(intent.hostId, true);
    if (!current()) { this.report("Reconnect to the original host to check Browser Close."); return; }
    const tab = this.context?.presentations.snapshot.tabs.find(value => value.id === intent.source.tabId);
    const originalTab = tab && this.original(intent.source, tab) ? structuredClone(tab) : undefined;
    this.checking.add(intent.request.requestId); this.changed();
    try { this.finish(await this.owner.inspect(intent, () => current() && (!originalTab || this.original(intent.source, originalTab))), originalTab); }
    catch (cause) { this.report(cause instanceof Error ? cause.message : "Browser Close status is unavailable."); }
    finally { this.checking.delete(intent.request.requestId); if (this.live) this.changed(); }
  }
  canDismiss(intent: BrowserCloseWindowIntent): boolean {
    return this.owner.canRetire(intent) && (intent.receipt?.outcome === "rejected"
      || Boolean(this.context && !this.context.presentations.snapshot.tabs.some(tab => tab.id === intent.source.tabId)));
  }
  async dismiss(intent: BrowserCloseWindowIntent) {
    if (!this.canDismiss(intent)) { this.report("Keep this record until Close is confirmed, saved and its original tab is gone."); return; }
    this.report("Dismissing the confirmed Close record…");
    const result = await this.owner.retire(intent); this.report(result.message);
  }
  dispose() { this.live = false; this.routeGeneration++; this.owner.dispose(); }
}
