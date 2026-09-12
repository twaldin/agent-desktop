import type { DraftBrowserPageIntent } from "../draft-browser-page-intent";
import { activateBrowserSearchTab, type CommandBrowserTab } from "./command-browser-tabs";
import { reconcileDockPresentations } from "./dock-presentations";
import type { BrowserReplacementPresentations } from "./browser-replacement-admission";

export interface BrowserSearchAdmission { id: string; entry: CommandBrowserTab; accepted: boolean }
export interface BrowserSearchPresentations extends BrowserReplacementPresentations { browserSearchAdmission?: BrowserSearchAdmission }

/** Runtime commit receipt only; never persisted. No side effects inside updater. */
export function admitBrowserSearch(previous: BrowserSearchPresentations, entry: CommandBrowserTab, pages: readonly DraftBrowserPageIntent[], id: string): BrowserSearchPresentations {
  const state = activateBrowserSearchTab(previous.snapshot, entry, previous, pages);
  const next = state ? reconcileDockPresentations(previous, { ...previous.snapshot, state }, id) : previous;
  return { ...next, browserAdmissions: previous.browserAdmissions, browserSearchAdmission: { id, entry: structuredClone(entry), accepted: Boolean(state) } };
}
interface Route { hostId?: string | null; sessionId: string | null }
interface Context {
  presentations: BrowserSearchPresentations; pages: readonly DraftBrowserPageIntent[];
  route: Route; settingsOpen: boolean; pluginDirectoryOpen: boolean; root: HTMLElement | null;
  navigate(sessionId: string | null, hostId: string, keepSettings: boolean, focusComposer: boolean): void;
}
type Selection = { id: string; entry: CommandBrowserTab; origin: Pick<Context, "route" | "settingsOpen" | "pluginDirectoryOpen">; phase: "admission" | "route" | "focus" };

/** Route and focus are consequences of committed original-key admission. */
export class BrowserSearchSelection {
  private selected?: Selection;
  private context?: Context;
  private frame?: number;
  constructor(private readonly schedule: (callback: () => void) => number, private readonly cancelFrame: (id: number) => void) {}
  begin(id: string, entry: CommandBrowserTab, origin: Pick<Context, "route" | "settingsOpen" | "pluginDirectoryOpen">) {
    this.cancel(); this.selected = { id, entry: structuredClone(entry), origin, phase: "admission" };
  }
  cancel() { if (this.frame !== undefined) this.cancelFrame(this.frame); this.frame = undefined; this.selected = undefined; }
  private current(selected: Selection, context: Context): boolean {
    const receipt = context.presentations.browserSearchAdmission, state = context.presentations.snapshot.state;
    if (!receipt?.accepted || receipt.id !== selected.id || !activateBrowserSearchTab(context.presentations.snapshot, selected.entry, context.presentations, context.pages)) return false;
    return [state.right, state.bottom].some(region => region.open && region.activeTabId === selected.entry.id);
  }
  private routeMatches(selected: Selection, context: Context) {
    return context.route.hostId === selected.entry.hostId && context.route.sessionId === selected.entry.sessionId && !context.settingsOpen && !context.pluginDirectoryOpen;
  }
  commit(context: Context) {
    this.context = context;
    const selected = this.selected; if (!selected) return;
    if (selected.phase === "admission") {
      if (context.route !== selected.origin.route || context.settingsOpen !== selected.origin.settingsOpen || context.pluginDirectoryOpen !== selected.origin.pluginDirectoryOpen) { this.cancel(); return; }
      if (context.presentations.browserSearchAdmission?.id !== selected.id) return;
      if (!this.current(selected, context)) { this.cancel(); return; }
      selected.phase = "route";
      if (!this.routeMatches(selected, context)) { context.navigate(selected.entry.sessionId, selected.entry.hostId, false, false); return; }
    }
    if (!this.current(selected, context)) { this.cancel(); return; }
    if (!this.routeMatches(selected, context)) {
      if (selected.phase === "focus" || context.route !== selected.origin.route
        || context.settingsOpen !== selected.origin.settingsOpen || context.pluginDirectoryOpen !== selected.origin.pluginDirectoryOpen) this.cancel();
      return;
    }
    if (selected.phase === "focus") return;
    const root = context.root;
    if (!root?.isConnected) { this.cancel(); return; }
    const selector = `[data-dock-tab-id="${CSS.escape(selected.entry.id)}"]`;
    const node = root.querySelector<HTMLButtonElement>(selector), active = root.ownerDocument.activeElement;
    if (!node) { this.cancel(); return; }
    selected.phase = "focus";
    this.frame = this.schedule(() => {
      if (this.selected !== selected) return;
      this.frame = undefined; this.selected = undefined;
      const current = this.context;
      if (!current || !this.current(selected, current) || !this.routeMatches(selected, current)
        || current.root !== root || !root.isConnected || root.querySelector(selector) !== node || !node.isConnected
        || node.closest('[hidden], [inert]') || !node.getClientRects().length || root.ownerDocument.activeElement !== active) return;
      node.focus({ preventScroll: true });
    });
  }
}
