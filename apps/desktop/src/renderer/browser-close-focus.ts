import { removeClosedBrowser } from "./browser-close-dock-owner";
import type { BrowserSearchPresentations } from "./browser-search-activation";
import { captureDockPresentation, isCurrentDockPresentation, reconcileDockPresentations, type DockPresentationRef } from "./dock-presentations";
import type { DockTab } from "./dock-state";

export interface BrowserCloseAdmission {
  id: string; accepted: boolean; source: DockPresentationRef; next?: DockPresentationRef;
}
export interface BrowserClosePresentations extends BrowserSearchPresentations { browserCloseAdmission?: BrowserCloseAdmission }
/** Receipt and resulting identities are committed together; never persisted. */
export function admitBrowserClose(previous: BrowserClosePresentations, source: DockPresentationRef, tab: DockTab, allowed: () => boolean, id: string): BrowserClosePresentations {
  const snapshot = removeClosedBrowser(previous, source, tab, allowed);
  const next = reconcileDockPresentations(previous, snapshot, id);
  const active = snapshot.state[source.destination].activeTabId;
  return { ...previous, ...next, browserCloseAdmission: { id, accepted: snapshot !== previous.snapshot, source: { ...source },
    ...(active ? { next: captureDockPresentation(next, active) } : {}) } };
}
interface Context {
  presentations: BrowserClosePresentations; root: HTMLElement | null; route: string; enabled: boolean;
  connected: ReadonlySet<string>;
}
interface Selection {
  id: string; source: DockPresentationRef; root: HTMLElement; active: Element; route: string; connected: boolean;
  queued: boolean; stopListening(): void; phase: "admission" | "frame";
}
/** Physical focus is an effect of the committed removal receipt, never an effect
 * inside a React updater or an optimistic consequence of the host response. */
export class BrowserCloseFocus {
  private context?: Context;
  private selection?: Selection;
  private frame?: number;
  constructor(private readonly schedule: (callback: () => void) => number, private readonly cancelFrame: (id: number) => void) {}
  commit(context: Context) {
    this.context = { ...context, connected: new Set(context.connected) };
    const selected = this.selection;
    if (!selected) return;
    if (!this.currentOwner(selected) || !this.ownsFocus(selected)) { this.cancel(); return; }
    const receipt = context.presentations.browserCloseAdmission;
    if (receipt?.id !== selected.id) {
      if (selected.phase === "frame" || !isCurrentDockPresentation(context.presentations, selected.source)) this.cancel();
      return;
    }
    if (!this.accepted(selected, receipt)) { this.cancel(); return; }
    if (selected.phase === "frame") return;
    const selector = receipt.next ? `[data-dock-tab-id="${CSS.escape(receipt.next.tabId)}"]` : "[data-main-task-chat]";
    const node = selected.root.querySelector<HTMLElement>(selector);
    if (!node || !this.visible(node)) { this.cancel(); return; }
    selected.phase = "frame";
    this.frame = this.schedule(() => {
      if (this.selection !== selected) return;
      const current = this.context?.presentations.browserCloseAdmission;
      const allowed = this.currentOwner(selected) && this.ownsFocus(selected) && current?.id === selected.id
        && this.accepted(selected, current) && selected.root.querySelector(selector) === node && this.visible(node);
      this.cancel();
      if (allowed) node.focus({ preventScroll: true });
    });
  }
  begin(tabId: string, instanceId: string | undefined): string | undefined {
    this.cancel();
    const context = this.context, root = context?.root, source = context && captureDockPresentation(context.presentations, tabId);
    const active = root?.ownerDocument.activeElement;
    if (!context?.enabled || !root?.isConnected || !source || source.kind !== "browser" || source.instanceId !== instanceId || !active) return;
    const id = CSS.escape(tabId), pill = root.querySelector(`[data-dock-content-tab][data-dock-tab-id="${id}"]`), content = root.querySelector(`[data-dock-content-id="${id}"]`);
    if (!pill?.closest(".dock-pill")?.contains(active) && !content?.contains(active)) return;
    const selection: Selection = { id: crypto.randomUUID(), source, root, active, route: context.route,
      connected: context.connected.has(source.hostId), queued: false, phase: "admission", stopListening: () => root.ownerDocument.removeEventListener("focusin", changed, true) };
    const changed = () => { if (this.selection === selection && !this.ownsFocus(selection)) this.cancel(); };
    this.selection = selection; root.ownerDocument.addEventListener("focusin", changed, true);
    return selection.id;
  }
  /** The caller marks only after enqueueing the keyed removal. Its eventual
   * receipt, including rejection, owns settlement from that point onward. */
  queued(id: string | undefined): void {
    if (id !== undefined && this.selection?.id === id) this.selection.queued = true;
  }
  async runClose(tabId: string, instanceId: string | undefined, operation: (id: string | undefined) => Promise<boolean>): Promise<boolean> {
    const id = this.begin(tabId, instanceId);
    try { return await operation(id); }
    finally {
      if (id !== undefined && this.selection?.id === id && !this.selection.queued && this.selection.phase === "admission") this.cancel();
    }
  }
  private currentOwner(selected: Selection) {
    const context = this.context;
    return Boolean(context?.enabled && context.root === selected.root && selected.root.isConnected && context.route === selected.route
      && context.connected.has(selected.source.hostId) === selected.connected);
  }
  private ownsFocus(selected: Selection) {
    const active = selected.root.ownerDocument.activeElement;
    return active === selected.active || active === selected.root.ownerDocument.body
      && (!selected.active.isConnected || selected.active.matches("[data-app-shell-tab-close-button]:disabled"));
  }
  private visible(node: HTMLElement) { return node.isConnected && !node.closest("[hidden], [inert]") && node.getClientRects().length > 0; }
  private accepted(selected: Selection, receipt: BrowserCloseAdmission) {
    const context = this.context!;
    const source = receipt.source, original = selected.source;
    if (source.tabId !== original.tabId || source.instanceId !== original.instanceId || source.hostId !== original.hostId
      || source.target !== original.target || source.kind !== original.kind || source.destination !== original.destination) return false;
    if (!receipt.accepted || context.presentations.snapshot.tabs.some(tab => tab.id === selected.source.tabId)) return false;
    const region = context.presentations.snapshot.state[selected.source.destination];
    return receipt.next ? isCurrentDockPresentation(context.presentations, receipt.next) && region.open && region.activeTabId === receipt.next.tabId
      : !region.open && region.tabIds.length === 0;
  }
  cancel() { if (this.frame !== undefined) this.cancelFrame(this.frame); this.frame = undefined; this.selection?.stopListening(); this.selection = undefined; }
}
