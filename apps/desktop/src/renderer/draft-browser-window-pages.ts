import type { DraftBrowserBridge } from "@agent-desktop/shared";
import { createDraftBrowserPageIntent, parseDraftBrowserPageIntent, parseDraftBrowserPageIntents, type DraftBrowserPageIntent } from "../draft-browser-page-intent";
import type { DraftBrowserWindowIntent } from "../draft-browser-window-intent";
import type { WindowViewState } from "../window-state";
import type { DraftController } from "./drafts";
import { DraftBrowserPageController, type DraftBrowserPageReady } from "./draft-browser-page";
import { DraftBrowserPageCheckpoint } from "./draft-browser-page-checkpoint";
import type { DraftBrowserWindowContext, DraftBrowserWindowOwner } from "./draft-browser-window-owner";
import type { WindowSaveObserver } from "./window-view-state";

const exact = (value: unknown) => JSON.stringify(value);
const key = (page: DraftBrowserPageIntent) => exact([page.owner.hostId, page.instanceId]);
interface Entry {
  drafts: DraftController; page: DraftBrowserPageIntent; controller: DraftBrowserPageController;
  project: string | null;
  running: boolean; completed: boolean; cancellation?: AbortController;
  admission?: () => boolean; unsubscribe(): void;
  ready?: { value: DraftBrowserPageReady; guard(): boolean };
}

/** Own local page intents across routes; no controller, inspection or native
 * acquisition is created by construction, restoration or committed renders. */
export class DraftBrowserWindowPages implements WindowSaveObserver {
  private readonly checkpoint = new DraftBrowserPageCheckpoint();
  private readonly entries = new Map<string, Entry>();
  private values: DraftBrowserPageIntent[];
  private context?: DraftBrowserWindowContext;
  private current: DraftBrowserPageIntent[] = [];
  private acknowledged: DraftBrowserPageIntent[] = [];
  private readonly appeared = new Set<string>();
  private readonly requests = new Map<string, string>();
  private readonly targets = new Map<string, string>();
  private committedError?: string;
  private saveError?: string;
  private generation = 0;
  private live = true;
  constructor(private readonly bridge: DraftBrowserBridge | undefined, private readonly owners: DraftBrowserWindowOwner,
    restored: readonly DraftBrowserPageIntent[], private readonly changed: () => void, private readonly restorationError?: string) {
    this.values = parseDraftBrowserPageIntents(restored, owners.intents);
  }
  get intents() { return parseDraftBrowserPageIntents(this.values, this.owners.intents); }
  get error() { return this.restorationError ?? this.saveError ?? this.owners.error; }
  private notify() { if (this.live) this.changed(); }
  private sameOwner(a: DraftBrowserPageIntent, b: DraftBrowserPageIntent) { return key(a) === key(b) && exact(a.owner) === exact(b.owner); }
  private find(values: DraftBrowserPageIntent[], page: DraftBrowserPageIntent) { return values.find(value => key(value) === key(page)); }
  private enabled(entry: Entry) {
    const context = this.context;
    return Boolean(this.live && !this.error && context?.enabled && context.drafts === entry.drafts
      && context.drafts.ownerHostId === entry.page.owner.hostId && context.draftId === entry.page.owner.reference.draftId);
  }
  private observe() {
    // A restored page can subscribe before its owner controller. Read the actual
    // draft here so project loss does not depend on listener order.
    let changed = false;
    for (const entry of this.entries.values()) {
      const view = entry.drafts.get(entry.page.owner.reference.draftId);
      if (entry.project !== view.draft.projectId) {
        entry.project = view.draft.projectId; changed = true;
      }
    }
    if (changed) this.invalidate();
    for (const entry of this.entries.values()) {
      const enabled = this.enabled(entry) && (!entry.admission || entry.admission()), connected = Boolean(this.context?.connected);
      entry.controller.observe({ connected, enabled });
      if (!enabled || !connected || entry.admission && !entry.admission()) entry.cancellation?.abort();
    }
  }
  private invalidate() { this.generation++; for (const entry of this.entries.values()) entry.cancellation?.abort(); }
  commit(context: DraftBrowserWindowContext) {
    if (!this.live) return;
    const old = this.context;
    if (!old || old.drafts !== context.drafts || old.draftId !== context.draftId || old.connected !== context.connected || old.enabled !== context.enabled) this.invalidate();
    this.context = { ...context }; this.observe();
  }
  beforeSubmission() { if (this.context) this.commit({ ...this.context, enabled: false }); }
  /** Called after explicit owner preparation. A separate local blank launcher
   * can supply its original instance ID; this does not acquire an owner/page. */
  create(ownerId: string, instanceId?: string): DraftBrowserPageIntent {
    const context = this.context;
    if (!this.live || !this.bridge || !context?.enabled || !context.connected || this.error) throw new Error(this.error ?? "Return to the available original draft.");
    const owner = this.owners.intents.find(value => value.hostId === context.drafts.ownerHostId
      && value.reference.draftId === context.draftId && value.reference.ownerId === ownerId);
    if (!owner || !this.owners.attachmentGuard(ownerId)()) throw new Error("Inspect the original browser owner before adding its page.");
    const page = createDraftBrowserPageIntent(owner, instanceId);
    if (this.values.some(value => key(value) === key(page))) throw new Error("This draft page identity already exists.");
    this.values = parseDraftBrowserPageIntents([...this.values, page], this.owners.intents); this.notify(); return parseDraftBrowserPageIntent(page);
  }
  private entry(instanceId: string): Entry {
    const context = this.context;
    if (!this.live || !this.bridge || !context?.enabled || this.error) throw new Error(this.error ?? "Return to the original draft page.");
    const page = this.values.find(value => value.instanceId === instanceId && value.owner.hostId === context.drafts.ownerHostId
      && value.owner.reference.draftId === context.draftId);
    if (!page) throw new Error("The original draft page is not in this window.");
    const found = this.entries.get(key(page));
    if (found && found.drafts !== context.drafts) throw new Error("The original draft controller changed; retain this page for recovery.");
    if (found && (!found.completed || found.running)) return found;
    found?.controller.dispose(); found?.unsubscribe();
    const view = context.drafts.get(page.owner.reference.draftId);
    const entry = { drafts: context.drafts, page, project: view.draft.projectId, running: false, completed: false } as Entry;
    entry.controller = new DraftBrowserPageController(this.bridge, page, value => this.publish(entry, value),
      (value, signal) => this.checkpoint.wait(value, signal), owner => entry.admission = this.guard(entry, owner),
      (result, guard) => this.materialize(entry, result, guard));
    this.entries.set(key(page), entry);
    entry.unsubscribe = entry.drafts.subscribe(() => this.observe());
    this.observe(); return entry;
  }
  private guard(entry: Entry, owner: DraftBrowserWindowIntent): () => boolean {
    const generation = this.generation, ownerGuard = this.owners.attachmentGuard(owner.reference.ownerId);
    return () => {
      const page = this.find(this.values, entry.page), current = this.find(this.current, entry.page);
      return Boolean(generation === this.generation && this.enabled(entry) && this.context?.connected
        && this.entries.get(key(entry.page)) === entry && exact(entry.page.owner) === exact(owner) && ownerGuard()
        && page && current && this.sameOwner(page, entry.page) && this.sameOwner(current, entry.page)
        && (!page.launcher.request || this.requests.get(key(page)) !== exact(page.launcher.request)
          || exact(current.launcher.request) === exact(page.launcher.request)));
    };
  }
  private publish(entry: Entry, value: DraftBrowserPageIntent) {
    if (!this.live || this.entries.get(key(entry.page)) !== entry) return;
    const old = this.find(this.values, entry.page);
    if (!old || !this.sameOwner(old, value)) throw new Error("The original draft page cannot be replaced by a callback.");
    const parsed = parseDraftBrowserPageIntent(value);
    // Keep confirmed history during read-only recovery. An explicit confirmed
    // rejection/new request can clear it; unknown recovery must not discard it.
    if (old.confirmedTarget && parsed.launcher.status === "unknown" && exact(old.launcher.request) === exact(parsed.launcher.request)) parsed.confirmedTarget = old.confirmedTarget;
    this.values = parseDraftBrowserPageIntents(this.values.map(page => key(page) === key(parsed) ? parsed : page), this.owners.intents);
    entry.ready = undefined; this.notify();
  }
  private async materialize(entry: Entry, result: DraftBrowserPageReady, guard: () => boolean): Promise<boolean> {
    const current = this.find(this.values, entry.page);
    if (!guard() || !current || !this.sameOwner(current, result.intent)
      || exact(current.launcher.request) !== exact(result.intent.launcher.request) || current.launcher.draft !== result.intent.launcher.draft) return false;
    const previous = current.confirmedTarget;
    if (previous && (previous.workerPid !== result.workerPid || previous.tab.name !== result.tab.name
      || previous.tab.targetId !== result.tab.targetId || previous.tab.backend !== result.tab.backend || previous.tab.kindTag !== result.tab.kindTag)) return false;
    const target = parseDraftBrowserPageIntent({ ...result.intent, confirmedTarget: { workerPid: result.workerPid, tab: result.tab } });
    this.values = parseDraftBrowserPageIntents(this.values.map(page => key(page) === key(target) ? target : page), this.owners.intents); this.notify();
    await this.checkpoint.waitTarget(target, entry.cancellation!.signal);
    if (!guard() || !this.enabled(entry) || exact(this.find(this.current, target)) !== exact(target)
      || exact(this.find(this.acknowledged, target)) !== exact(target)) return false;
    entry.ready = { value: structuredClone(result), guard: this.guard(entry, result.intent.owner) };
    entry.completed = true; this.notify(); return true;
  }
  waitForLocalPage(instanceId: string, signal: AbortSignal) {
    const context = this.context, page = this.values.find(value => value.instanceId === instanceId && value.owner.hostId === context?.drafts.ownerHostId && value.owner.reference.draftId === context?.draftId);
    if (!page) return Promise.reject(new Error("The original local draft page is unavailable."));
    return this.checkpoint.waitLocal(page, signal);
  }
  edit(instanceId: string, draft: string | undefined) { this.entry(instanceId).controller.edit(draft); }
  private async run(instanceId: string, operation: "submit" | "inspect", signal?: AbortSignal) {
    if (signal?.aborted) return this.state(instanceId)?.launcher;
    const entry = this.entry(instanceId);
    if (entry.running) return entry.controller.state;
    entry.running = true; entry.cancellation = new AbortController();
    const cancel = () => { entry.controller.observe({ connected: false, enabled: false }); entry.cancellation?.abort(); };
    signal?.addEventListener("abort", cancel, { once: true });
    this.observe();
    try { await entry.controller[operation](); return entry.controller.state; }
    finally { signal?.removeEventListener("abort", cancel); entry.running = false; entry.cancellation = undefined; entry.admission = undefined; }
  }
  submit(instanceId: string, signal?: AbortSignal) { return this.run(instanceId, "submit", signal); }
  inspect(instanceId: string, signal?: AbortSignal) { return this.run(instanceId, "inspect", signal); }
  /** A preview retains this exact readiness, not a boolean that can revive
   * after route/connection loss and a later successful inspection. */
  attachmentGuard(instanceId: string): () => boolean {
    const page = this.values.find(value => value.instanceId === instanceId && value.owner.hostId === this.context?.drafts.ownerHostId
      && value.owner.reference.draftId === this.context?.draftId);
    const entry = page && this.entries.get(key(page)), ready = entry?.ready;
    return () => Boolean(page && entry && ready && this.entries.get(key(page)) === entry && entry.ready === ready && ready.guard()
      && exact(this.find(this.values, page)) === exact(page) && exact(this.find(this.current, page)) === exact(page)
      && exact(this.find(this.acknowledged, page)) === exact(page));
  }
  state(instanceId: string) {
    const page = this.values.find(value => value.instanceId === instanceId && value.owner.hostId === this.context?.drafts.ownerHostId
      && value.owner.reference.draftId === this.context?.draftId);
    if (!page) return;
    const entry = this.entries.get(key(page));
    return { launcher: entry?.controller.state ?? structuredClone(page.launcher), checking: entry?.controller.checking ?? false,
      ...(entry?.ready && this.attachmentGuard(instanceId)() ? { ready: structuredClone(entry.ready.value) } : {}) };
  }
  private parse(view: WindowViewState) { return parseDraftBrowserPageIntents(view.draftBrowserPages ?? [], view.draftBrowserOwners ?? []); }
  private checkRetained(values: DraftBrowserPageIntent[], committed: boolean) {
    for (const page of this.values) {
      const id = key(page), value = this.find(values, page);
      if (value && !this.sameOwner(value, page) || !value && this.appeared.has(id)) throw new Error("The window dropped or replaced an original draft page.");
      if (!value) continue;
      if (committed) this.appeared.add(id);
      if (page.launcher.request && this.requests.get(id) === exact(page.launcher.request) && exact(value.launcher.request) !== exact(page.launcher.request)) throw new Error("The window dropped or replaced an original draft page request.");
      if (page.confirmedTarget && this.targets.get(id) === exact(page.confirmedTarget) && exact(value.confirmedTarget) !== exact(page.confirmedTarget)) throw new Error("The window dropped or replaced a confirmed draft target.");
      if (committed && exact(value.launcher.request) === exact(page.launcher.request)) this.requests.set(id, exact(page.launcher.request));
      if (committed && exact(value.confirmedTarget) === exact(page.confirmedTarget)) this.targets.set(id, exact(page.confirmedTarget));
    }
  }
  committed(view: WindowViewState) {
    if (!this.live) return;
    this.checkpoint.committed(view); this.current = [];
    try { this.current = this.parse(view); this.checkRetained(this.current, true); this.committedError = undefined; }
    catch (cause) { this.committedError = cause instanceof Error ? cause.message : "Invalid committed draft pages."; this.failed(this.committedError); }
  }
  saved(view: WindowViewState) {
    if (!this.live) return;
    try {
      if (this.committedError) throw new Error(this.committedError);
      const saved = this.parse(view); this.checkRetained(saved, false);
      this.acknowledged = saved; this.saveError = undefined; this.observe(); this.checkpoint.saved(view);
    } catch (cause) { this.failed(cause instanceof Error ? cause.message : "Draft page persistence failed."); }
  }
  failed(message: string) {
    if (!this.live) return;
    this.saveError = message; this.acknowledged = []; this.invalidate(); this.checkpoint.failed(message); this.observe();
  }
  dispose() {
    if (!this.live) return;
    this.live = false; this.invalidate(); this.checkpoint.dispose();
    for (const entry of this.entries.values()) { entry.controller.dispose(); entry.unsubscribe(); }
    this.entries.clear();
  }
}
