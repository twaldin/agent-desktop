import { draftBrowserIdFromDock, dockTabId, type DockTab } from "./dock-state";
import type { DockPresentations } from "./dock-presentations";
import type { DraftController } from "./drafts";
import type { DraftBrowserWindowOwner } from "./draft-browser-window-owner";
import type { DraftBrowserWindowPages } from "./draft-browser-window-pages";
import { parseBrowserNewTabState, type BrowserNewTabState } from "./browser-new-tab";
import { browserNavigationAddress } from "./browser-address";
import { parseBrowserNavigationUrl } from "@agent-desktop/shared";

export interface DraftBrowserDockContext {
  drafts: DraftController; draftId: string; connected: boolean; enabled: boolean; presentations: DockPresentations;
}
/** One original dock presentation. The window managers retain every allocated
 * owner/request; this local controller only joins explicit address actions. */
export class DraftBrowserDockController {
  readonly draftId: string;
  private context?: DraftBrowserDockContext;
  private generation = 0;
  private live = true;
  private busy = false;
  private observed = false;
  private cancellation?: AbortController;
  private message?: string;
  private selectedOwner?: string;
  private preview?: { ready: NonNullable<ReturnType<DraftBrowserWindowPages["state"]>>["ready"]; guard(): boolean };
  checking = false;
  constructor(readonly tab: DockTab, private readonly presentationId: string, private readonly drafts: DraftController,
    private readonly owners: DraftBrowserWindowOwner, private readonly pages: DraftBrowserWindowPages, private readonly changed: () => void,
    private readonly updateAddress: (state: BrowserNewTabState, guard: () => boolean) => void) {
    const draftId = draftBrowserIdFromDock(tab.target);
    if (!draftId || tab.kind !== "browser" || !tab.browserInstanceId || !tab.browserNewTab || tab.id !== dockTabId(tab)
      || tab.hostId !== drafts.ownerHostId) throw new Error("Select an original draft browser dock.");
    this.draftId = draftId;
  }
  private valid(context = this.context) {
    const current = context?.presentations.snapshot.tabs.find(value => value.id === this.tab.id);
    return Boolean(this.live && context?.enabled && context.drafts === this.drafts && context.draftId === this.draftId
      && context.presentations.instances.get(this.tab.id) === this.presentationId && current && current.id === dockTabId(current)
      && current.kind === "browser" && current.hostId === this.tab.hostId && current.target === this.tab.target
      && current.browserInstanceId === this.tab.browserInstanceId && current.browserNewTab && !current.browserTarget);
  }
  commit(context: DraftBrowserDockContext) {
    if (!this.live) return;
    const old = this.context;
    const invalidated = !old || this.valid(old) !== this.valid(context) || old.connected !== context.connected || old.drafts !== context.drafts || old.draftId !== context.draftId;
    if (invalidated) {
      this.generation++; this.cancellation?.abort(); this.preview = undefined;
    }
    this.context = { ...context };
    if (invalidated) this.changed();
  }
  beforeSubmission() { if (this.context) this.commit({ ...this.context, enabled: false }); }
  private guard() { const generation = this.generation; return () => this.valid() && generation === this.generation; }
  get connected() { return this.valid() && Boolean(this.context?.connected); }
  get enabled() { return this.valid(); }
  private get page() { return this.pages.intents.find(value => value.instanceId === this.tab.browserInstanceId
    && value.owner.hostId === this.tab.hostId && value.owner.reference.draftId === this.draftId); }
  get canChooseOwner() { return !this.page && !this.busy; }
  get ownerChoices() { return this.owners.intents.filter(value => value.hostId === this.tab.hostId && value.reference.draftId === this.draftId); }
  private ownerId() {
    const fixed = this.page?.owner.reference.ownerId;
    if (fixed) return fixed;
    const choices = this.ownerChoices;
    if (this.selectedOwner && choices.some(value => value.reference.ownerId === this.selectedOwner)) return this.selectedOwner;
    return choices.length === 1 ? choices[0]!.reference.ownerId : undefined;
  }
  get ready() { return this.preview?.guard() ? this.preview.ready : undefined; }
  get previewGuard() { return this.preview?.guard ?? (() => false); }
  get state(): BrowserNewTabState {
    const current = this.context?.presentations.snapshot.tabs.find(value => value.id === this.tab.id) ?? this.tab;
    const page = this.page;
    const base = page ? this.enabled ? this.pages.state(page.instanceId)?.launcher ?? page.launcher : page.launcher
      : parseBrowserNewTabState(current.browserNewTab);
    return { ...base, ...(this.busy ? { status: "pending" as const } : {}), ...(this.message ? { message: this.message } : {}) };
  }
  get needsInspection() {
    const owner = this.ownerId(); return Boolean(this.page?.launcher.status === "unknown" || owner && !this.owners.attachmentGuard(owner)()
      && this.owners.state(owner)?.status !== "absent");
  }
  observePresentation() { if (this.live) this.observed = true; }
  get hasObservedPristinePresentation() { return this.observed && !this.busy && !this.page && this.state.status === "idle" && this.state.draft === undefined; }
  edit(draft: string | undefined) {
    if (!this.valid() || this.busy || this.page?.launcher.status === "unknown") return;
    const state = parseBrowserNewTabState({ status: "idle", ...(draft === undefined ? {} : { draft }) });
    this.message = undefined;
    if (this.page) this.pages.edit(this.page.instanceId, draft);
    else this.updateAddress(state, this.guard());
    this.changed();
  }
  chooseOwner(ownerId: string) {
    if (!this.valid() || this.busy || this.page || !this.ownerChoices.some(value => value.reference.ownerId === ownerId)) return;
    this.selectedOwner = ownerId; this.preview = undefined; this.changed();
  }
  private async run(operation: "submit" | "inspect") {
    if (!this.connected || this.busy) return;
    const guard = this.guard(), cancellation = new AbortController(); this.cancellation = cancellation;
    const assert = () => { if (!guard() || cancellation.signal.aborted) throw new Error("The original draft browser changed. Check again explicitly."); };
    const address = this.state.draft;
    this.busy = true; this.checking = operation === "inspect"; this.message = undefined; this.changed();
    try {
      assert();
      let ownerId = this.ownerId();
      if (!ownerId && this.ownerChoices.length) throw new Error("Choose which saved browser to check.");
      if (operation === "inspect") {
        if (!ownerId) throw new Error("No saved browser owner needs inspection.");
        await this.owners.inspect(ownerId, cancellation.signal); assert();
      } else {
        if (this.page?.launcher.status === "unknown") throw new Error("Check the original creation status before continuing. It was not repeated.");
        if (!address?.trim()) return;
        parseBrowserNavigationUrl(browserNavigationAddress(address));
        if (!ownerId || this.owners.state(ownerId)?.status === "absent") {
          await this.owners.acquire(ownerId, cancellation.signal); assert(); ownerId = this.ownerId();
        }
      }
      if (!ownerId || !this.owners.attachmentGuard(ownerId)()) throw new Error(ownerId ? this.owners.state(ownerId)?.message ?? "Check the saved browser owner before continuing." : "Browser ownership could not be confirmed.");
      assert();
      let page = this.page;
      if (!page && operation === "submit") { page = this.pages.create(ownerId, this.tab.browserInstanceId); this.pages.edit(page.instanceId, address); }
      if (!page) return; // Checking an owner never creates its page.
      if (page.owner.reference.ownerId !== ownerId) throw new Error("The original page owner changed.");
      if (operation === "inspect") await this.pages.inspect(page.instanceId, cancellation.signal);
      else {
        if (page.launcher.status === "idle") await this.pages.waitForLocalPage(page.instanceId, cancellation.signal);
        assert(); await this.pages.submit(page.instanceId, cancellation.signal);
      }
      assert();
      const ready = this.pages.state(page.instanceId)?.ready, pageGuard = this.pages.attachmentGuard(page.instanceId);
      if (ready && pageGuard()) this.preview = { ready, guard: () => guard() && pageGuard() };
    } catch (cause) { if (this.live) this.message = cause instanceof Error ? cause.message : "The browser action could not be confirmed."; }
    finally { this.busy = false; this.checking = false; this.cancellation = undefined; if (this.live) this.changed(); }
  }
  submit() { return this.run("submit"); }
  inspect() { return this.run("inspect"); }
  dispose() { this.live = false; this.generation++; this.cancellation?.abort(); this.preview = undefined; }
}
