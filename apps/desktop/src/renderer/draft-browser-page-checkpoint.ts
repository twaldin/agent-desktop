import { parseDraftBrowserPageIntent, parseDraftBrowserPageIntents, type DraftBrowserConfirmedTarget, type DraftBrowserPageIntent } from "../draft-browser-page-intent";
import type { WindowViewState } from "../window-state";
import type { WindowSaveObserver } from "./window-view-state";
interface Pending { intent: DraftBrowserPageIntent; request: string; local?: true; target?: DraftBrowserConfirmedTarget; appeared: boolean; resolve(): void; reject(error: Error): void; cleanup(): void }
/** Read the current window's committed/acknowledged values. Never save a captured
 * route, create a target or use another window's acknowledgement. */
export class DraftBrowserPageCheckpoint implements WindowSaveObserver {
  private current?: DraftBrowserPageIntent[];
  private acknowledged?: DraftBrowserPageIntent[];
  private readonly pending = new Set<Pending>();
  private live = true;
  private find(values: DraftBrowserPageIntent[] | undefined, entry: Pending) {
    return values?.find(value => value.instanceId === entry.intent.instanceId && value.owner.hostId === entry.intent.owner.hostId);
  }
  private sameOwner(page: DraftBrowserPageIntent, entry: Pending) { return JSON.stringify(page.owner) === JSON.stringify(entry.intent.owner); }
  private sameRequest(values: DraftBrowserPageIntent[] | undefined, entry: Pending) {
    const page = this.find(values, entry);
    return Boolean(page && this.sameOwner(page, entry) && page.launcher.status === "unknown" && page.launcher.draft === entry.intent.launcher.draft
      && page.launcher.request && JSON.stringify(page.launcher.request) === entry.request);
  }
  private sameTargetIdentity(a: DraftBrowserConfirmedTarget, b: DraftBrowserConfirmedTarget) {
    return a.workerPid === b.workerPid && a.tab.name === b.tab.name && a.tab.targetId === b.tab.targetId
      && a.tab.backend === b.tab.backend && a.tab.kindTag === b.tab.kindTag;
  }
  private matches(values: DraftBrowserPageIntent[] | undefined, entry: Pending) {
    if (entry.local) return JSON.stringify(this.find(values, entry)) === JSON.stringify(entry.intent);
    return this.sameRequest(values, entry) && (!entry.target || JSON.stringify(this.find(values, entry)?.confirmedTarget) === JSON.stringify(entry.target));
  }
  private finish(entry: Pending, error?: Error) {
    if (!this.pending.delete(entry)) return;
    entry.cleanup(); if (error) entry.reject(error); else entry.resolve();
  }
  private acknowledge() {
    for (const entry of this.pending) if (this.matches(this.current, entry) && this.matches(this.acknowledged, entry)) this.finish(entry);
  }
  private parse(view: WindowViewState) { return parseDraftBrowserPageIntents(view.draftBrowserPages ?? [], view.draftBrowserOwners ?? []); }
  committed(view: WindowViewState) {
    if (!this.live) return;
    try { this.current = this.parse(view); }
    catch { this.current = undefined; this.failed("The committed window has invalid draft browser page ownership."); return; }
    for (const entry of this.pending) {
      const page = this.find(this.current, entry);
      if (entry.local) {
        if (!page && !entry.appeared) continue;
        if (!this.matches(this.current, entry)) this.finish(entry, new Error("The initiating local draft page changed before saving."));
        else entry.appeared = true;
        continue;
      }
      if (!page || !this.sameOwner(page, entry)) this.finish(entry, new Error("The initiating draft page or owner left this window."));
      else if (page.launcher.request && !this.sameRequest(this.current, entry) || !page.launcher.request && (entry.appeared || entry.target)) this.finish(entry, new Error("The initiating draft page request changed before saving."));
      else if (entry.target) {
        if (page.confirmedTarget && !this.sameTargetIdentity(page.confirmedTarget, entry.target)
          || entry.appeared && !this.matches(this.current, entry)) this.finish(entry, new Error("The confirmed draft browser target changed before saving."));
        else if (this.matches(this.current, entry)) entry.appeared = true;
      } else if (page.launcher.request) entry.appeared = true;
    }
    this.acknowledge();
  }
  saved(view: WindowViewState) {
    if (!this.live) return;
    try { this.acknowledged = this.parse(view); }
    catch { this.failed("The saved window has invalid draft browser page ownership."); return; }
    for (const entry of this.pending) if (this.matches(this.current, entry) && !this.matches(this.acknowledged, entry))
      this.finish(entry, new Error("The saved window did not retain the original draft page request."));
    this.acknowledge();
  }
  failed(message: string) {
    this.acknowledged = undefined;
    for (const entry of this.pending) this.finish(entry, new Error(message));
  }
  wait(value: DraftBrowserPageIntent, signal: AbortSignal): Promise<void> {
    return this.waitFor(value, signal, "request");
  }
  /** A confirmed target is publishable only after the existing window save
   * acknowledges its full projection. It never authorizes a restored worker. */
  waitTarget(value: DraftBrowserPageIntent, signal: AbortSignal): Promise<void> {
    return this.waitFor(value, signal, "target");
  }
  waitLocal(value: DraftBrowserPageIntent, signal: AbortSignal): Promise<void> { return this.waitFor(value, signal, "local"); }
  private waitFor(value: DraftBrowserPageIntent, signal: AbortSignal, mode: "local" | "request" | "target"): Promise<void> {
    if (!this.live) return Promise.reject(new Error("This draft page window is closed."));
    const intent = parseDraftBrowserPageIntent(value);
    const local = mode === "local", target = mode === "target";
    if (local && (intent.launcher.status !== "idle" || intent.launcher.request || intent.confirmedTarget)) return Promise.reject(new Error("An idle local draft page is required."));
    if (!local && (!intent.launcher.request || intent.launcher.status !== "unknown")) return Promise.reject(new Error("An original pending draft page request is required."));
    if (target && !intent.confirmedTarget) return Promise.reject(new Error("A confirmed draft browser target is required."));
    return new Promise((resolve, reject) => {
      const entry: Pending = { intent, request: JSON.stringify(intent.launcher.request), ...(local ? { local: true } : {}), ...(target ? { target: intent.confirmedTarget } : {}), appeared: false, resolve, reject, cleanup: () => signal.removeEventListener("abort", abort) };
      const abort = () => this.finish(entry, new Error("Draft page creation was cancelled before window acknowledgement."));
      this.pending.add(entry); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else {
        const current = this.find(this.current, entry);
        if (local) {
          if (!this.current) this.finish(entry, new Error("A committed draft page window is required."));
          else if (current && !this.matches(this.current, entry)) this.finish(entry, new Error("A different local draft page is already committed."));
          else { entry.appeared = Boolean(current); this.acknowledge(); }
        } else if (!current || !this.sameOwner(current, entry)) this.finish(entry, new Error("A committed original draft page is required before acquisition."));
        else if (current.launcher.request && !this.sameRequest(this.current, entry) || target && !current.launcher.request) this.finish(entry, new Error("A different draft page request is already committed."));
        else if (entry.target && current.confirmedTarget && !this.sameTargetIdentity(current.confirmedTarget, entry.target)) this.finish(entry, new Error("A different draft browser target is already committed."));
        else { entry.appeared = target ? this.matches(this.current, entry) : Boolean(current.launcher.request); this.acknowledge(); }
      }
    });
  }
  dispose() { this.live = false; this.current = undefined; this.failed("The draft page window closed before acknowledgement."); }
}
