import type { DraftBrowserBridge } from "@agent-desktop/shared";
import { parseDraftBrowserWindowIntents, type DraftBrowserWindowIntent } from "../draft-browser-window-intent";
import type { WindowViewState } from "../window-state";
import { DraftBrowserOwnerCheckpoint } from "./draft-browser-owner-checkpoint";
import { DraftBrowserOwnerController, type DraftBrowserOwnerState } from "./draft-browser-owner-controller";
import type { DraftController } from "./drafts";
import type { WindowSaveObserver } from "./window-view-state";

export interface DraftBrowserWindowContext { drafts: DraftController; draftId: string; connected: boolean; enabled: boolean }
interface Entry { drafts: DraftController; draftId: string; controller: DraftBrowserOwnerController; running: boolean }
const ownerKey = (intent: DraftBrowserWindowIntent) => JSON.stringify([intent.hostId, intent.reference.ownerId]);
const exact = (intent: DraftBrowserWindowIntent) => JSON.stringify(intent);

/** One window owns recovery knowledge across routes. No controller or request is
 * created by rendering, restoring, committing context or observing persistence. */
export class DraftBrowserWindowOwner implements WindowSaveObserver {
  private readonly checkpoint = new DraftBrowserOwnerCheckpoint();
  private readonly entries = new Set<Entry>();
  private values: DraftBrowserWindowIntent[];
  private context?: DraftBrowserWindowContext;
  private committedValues: DraftBrowserWindowIntent[] = [];
  private savedValues: DraftBrowserWindowIntent[] = [];
  private readonly appeared = new Set<string>();
  private committedError?: string;
  private saveError?: string;
  private live = true;
  private generation = 0;
  constructor(private readonly bridge: Pick<DraftBrowserBridge, "acquire" | "status" | "metadata"> | undefined,
    restored: readonly DraftBrowserWindowIntent[], private readonly changed: () => void, private readonly restorationError?: string) {
    this.values = parseDraftBrowserWindowIntents(restored);
  }
  get intents(): DraftBrowserWindowIntent[] { return parseDraftBrowserWindowIntents(this.values); }
  get error() { return this.restorationError ?? this.saveError; }
  private notify() { if (this.live) this.changed(); }
  private observe(entry: Entry) {
    const context = this.context;
    entry.controller.observe({ hostId: context?.drafts.ownerHostId ?? "", draftId: context?.draftId ?? "",
      connected: Boolean(context?.connected), enabled: Boolean(this.live && !this.error && context?.enabled && context.drafts === entry.drafts) });
  }
  commit(context: DraftBrowserWindowContext) {
    if (!this.live) return;
    const old = this.context;
    if (!old || old.drafts !== context.drafts || old.draftId !== context.draftId || old.connected !== context.connected || old.enabled !== context.enabled) this.generation++;
    this.context = { ...context };
    for (const entry of this.entries) this.observe(entry);
  }
  /** Synchronous admission boundary before Send awaits draft persistence. The
   * next committed context may enable a fresh action, never the old attempt. */
  beforeSubmission() {
    if (this.context) this.commit({ ...this.context, enabled: false });
  }
  private publish(entry: Entry) {
    const intent = entry.controller.intent;
    if (intent) {
      const found = this.values.find(value => ownerKey(value) === ownerKey(intent));
      if (found && exact(found) !== exact(intent)) throw new Error("A saved browser owner cannot change its original draft binding.");
      if (!found) this.values = parseDraftBrowserWindowIntents([...this.values, intent]);
    }
    this.notify();
  }
  private entry(ownerId?: string): Entry {
    const context = this.context;
    if (!this.live || !this.bridge || !context || !context.connected || !context.enabled || this.error)
      throw new Error(this.error ?? "Return to an available draft in this window before opening its browser.");
    const hostId = context.drafts.ownerHostId;
    const candidates = this.values.filter(value => value.hostId === hostId && value.reference.draftId === context.draftId);
    // Multiple historical owners must not be guessed, overwritten or silently
    // replaced. Recovery can explicitly choose one of the retained identities.
    const restored = ownerId === undefined ? candidates.length === 1 ? candidates[0] : undefined
      : candidates.find(value => value.reference.ownerId === ownerId);
    if (ownerId !== undefined && !restored || ownerId === undefined && candidates.length > 1) throw new Error("Choose a saved browser owner explicitly before continuing.");
    const existing = [...this.entries].find(entry => entry.drafts.ownerHostId === hostId && entry.draftId === context.draftId
      && entry.controller.intent?.reference.ownerId === restored?.reference.ownerId);
    if (existing) {
      if (existing.drafts !== context.drafts) throw new Error("The original draft controller changed; retain the saved browser for recovery.");
      return existing;
    }
    const reserved = [...this.entries].filter(value => !value.controller.intent).length;
    if (!restored && this.values.length + reserved >= 64) throw new Error("Resolve existing browser recovery records before opening more owners.");
    const entry = { drafts: context.drafts, draftId: context.draftId, running: false } as Entry;
    entry.controller = new DraftBrowserOwnerController(this.bridge, entry.drafts, entry.draftId, () => this.publish(entry),
      (intent, signal) => this.checkpoint.wait(intent, signal), restored);
    this.entries.add(entry); this.observe(entry); return entry;
  }
  private async run(operation: "acquire" | "inspect", ownerId?: string, signal?: AbortSignal): Promise<DraftBrowserOwnerState> {
    const entry = this.entry(ownerId);
    if (entry.running) return entry.controller.state;
    entry.running = true;
    try { await entry.controller[operation](signal); return entry.controller.state; }
    finally {
      entry.running = false;
      // A failed draft save has not allocated recovery identity. It must not
      // occupy a permanent capacity slot or leave a draft subscription behind.
      if (!entry.controller.intent) {
        entry.controller.dispose(); this.entries.delete(entry);
      }
    }
  }
  acquire(ownerId?: string, signal?: AbortSignal) { return this.run("acquire", ownerId, signal); }
  inspect(ownerId: string, signal?: AbortSignal) { return this.run("inspect", ownerId, signal); }
  state(ownerId: string): DraftBrowserOwnerState | undefined {
    const context = this.context;
    if (!context) return;
    const entry = [...this.entries].find(entry => entry.drafts === context.drafts && entry.draftId === context.draftId && entry.controller.intent?.reference.ownerId === ownerId);
    if (entry?.controller.intent?.reference.ownerId === ownerId) return entry.controller.state;
    return this.values.some(value => value.hostId === context.drafts.ownerHostId && value.reference.draftId === context.draftId && value.reference.ownerId === ownerId)
      ? { status: "unknown" } : undefined;
  }
  attachmentGuard(ownerId: string): () => boolean {
    const context = this.context, generation = this.generation;
    const entry = context && [...this.entries].find(entry => entry.drafts === context.drafts && entry.draftId === context.draftId && entry.controller.intent?.reference.ownerId === ownerId);
    const intent = entry?.controller.intent, guard = entry?.controller.attachmentGuard();
    if (!intent || intent.reference.ownerId !== ownerId || !guard) return () => false;
    return () => this.live && this.generation === generation && !this.error && guard()
      && this.committedValues.some(value => exact(value) === exact(intent)) && this.savedValues.some(value => exact(value) === exact(intent));
  }
  committed(view: WindowViewState) {
    if (!this.live) return;
    // Even rejected projections must replace the checkpoint's current view.
    // A later save acknowledgement cannot restore a dropped committed owner.
    this.checkpoint.committed(view);
    this.committedValues = [];
    try {
      this.committedValues = parseDraftBrowserWindowIntents(view.draftBrowserOwners ?? []);
      for (const value of this.values) {
        if (this.committedValues.some(current => exact(current) === exact(value))) this.appeared.add(ownerKey(value));
        else if (this.appeared.has(ownerKey(value))) throw new Error("The committed window dropped a retained browser owner.");
      }
      this.committedError = undefined;
    } catch (cause) {
      this.committedError = cause instanceof Error ? cause.message : "Invalid draft browser window state.";
      this.failed(this.committedError);
    }
  }
  saved(view: WindowViewState) {
    if (!this.live) return;
    try {
      if (this.committedError) throw new Error(this.committedError);
      const saved = parseDraftBrowserWindowIntents(view.draftBrowserOwners ?? []);
      // A save from before a newly allocated intent's first commit is not its
      // acknowledgement. Previously committed identities may never disappear.
      if (this.values.some(value => this.appeared.has(ownerKey(value)) && !saved.some(current => exact(current) === exact(value))))
        throw new Error("The saved window dropped a retained browser owner.");
      this.savedValues = saved; this.saveError = undefined;
      for (const entry of this.entries) this.observe(entry);
      this.checkpoint.saved(view);
    } catch (cause) { this.failed(cause instanceof Error ? cause.message : "Draft browser persistence failed."); }
  }
  failed(message: string) {
    if (!this.live) return;
    this.generation++; this.saveError = message; this.savedValues = []; this.checkpoint.failed(message);
    for (const entry of this.entries) this.observe(entry);
  }
  dispose() {
    if (!this.live) return;
    this.live = false; this.generation++; this.checkpoint.dispose();
    for (const entry of this.entries) entry.controller.dispose();
    this.entries.clear();
  }
}
