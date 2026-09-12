import { parseDraftBrowserWindowIntent, parseDraftBrowserWindowIntents, type DraftBrowserWindowIntent } from "../draft-browser-window-intent";
import type { WindowViewState } from "../window-state";
import type { WindowSaveObserver } from "./window-view-state";

type Pending = { intent: DraftBrowserWindowIntent; exact: string; appeared: boolean; resolve(): void; reject(error: Error): void; cleanup(): void };
/** Observe this window's existing save, never write a captured route or acquire
 * a worker. Live draft/connection eligibility remains the dispatch owner's job. */
export class DraftBrowserOwnerCheckpoint implements WindowSaveObserver {
  private current?: DraftBrowserWindowIntent[];
  private acknowledged?: DraftBrowserWindowIntent[];
  private readonly pending = new Set<Pending>();
  private live = true;
  private find(values: DraftBrowserWindowIntent[] | undefined, entry: Pending) {
    return values?.find(value => value.hostId === entry.intent.hostId && value.reference.ownerId === entry.intent.reference.ownerId);
  }
  private matches(values: DraftBrowserWindowIntent[] | undefined, entry: Pending) {
    const found = this.find(values, entry);
    return Boolean(found && JSON.stringify(found) === entry.exact);
  }
  private finish(entry: Pending, error?: Error) {
    if (!this.pending.delete(entry)) return;
    entry.cleanup(); if (error) entry.reject(error); else entry.resolve();
  }
  private acknowledge() {
    for (const entry of this.pending) if (this.matches(this.current, entry) && this.matches(this.acknowledged, entry)) this.finish(entry);
  }
  committed(view: WindowViewState) {
    if (!this.live) return;
    try { this.current = parseDraftBrowserWindowIntents(view.draftBrowserOwners ?? []); }
    catch { this.current = undefined; this.failed("The committed draft browser owner list is invalid."); return; }
    for (const entry of this.pending) {
      const found = this.find(this.current, entry);
      if (found && !this.matches(this.current, entry) || !found && entry.appeared)
        this.finish(entry, new Error("The draft browser owner changed before its window save."));
      else if (found) entry.appeared = true;
    }
    this.acknowledge();
  }
  saved(view: WindowViewState) {
    if (!this.live) return;
    try { this.acknowledged = parseDraftBrowserWindowIntents(view.draftBrowserOwners ?? []); }
    catch { this.acknowledged = undefined; this.failed("The saved draft browser owner list is invalid."); return; }
    for (const entry of this.pending) if (this.matches(this.current, entry) && !this.matches(this.acknowledged, entry))
      this.finish(entry, new Error("The saved window did not retain the draft browser owner."));
    this.acknowledge();
  }
  failed(message: string) {
    this.acknowledged = undefined;
    for (const entry of this.pending) this.finish(entry, new Error(message));
  }
  wait(value: DraftBrowserWindowIntent, signal: AbortSignal): Promise<void> {
    if (!this.live || !this.current) return Promise.reject(new Error("A committed window is required to save a draft browser owner."));
    const intent = parseDraftBrowserWindowIntent(value);
    return new Promise((resolve, reject) => {
      const entry: Pending = { intent, exact: JSON.stringify(intent), appeared: false, resolve, reject,
        cleanup: () => signal.removeEventListener("abort", abort) };
      const abort = () => this.finish(entry, new Error("Draft browser acquisition was cancelled before its window save."));
      this.pending.add(entry); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else {
        const found = this.find(this.current, entry);
        if (found && !this.matches(this.current, entry)) this.finish(entry, new Error("This draft browser owner already has a different binding."));
        else { entry.appeared = Boolean(found); this.acknowledge(); }
      }
    });
  }
  dispose() { this.live = false; this.current = undefined; this.failed("The window closed before draft browser owner persistence."); }
}
