import { browserCloseIntentKey, parseBrowserCloseWindowIntent, parseBrowserCloseWindowIntents,
  type BrowserCloseWindowIntent } from "../browser-close-window-intent";
import type { WindowViewState } from "../window-state";
import type { WindowSaveObserver } from "./window-view-state";

interface Waiting { intent: BrowserCloseWindowIntent; previous?: BrowserCloseWindowIntent | null; appeared: boolean; resolve(): void; reject(error: Error): void; cleanup(): void }
interface Removing { previous: BrowserCloseWindowIntent[]; next: BrowserCloseWindowIntent[]; appeared: boolean; resolve(): void; reject(error: Error): void; cleanup(): void }
const exact = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Observes this window's current commits and acknowledged saves; never writes a captured route or calls a host. */
export class BrowserCloseCheckpoint implements WindowSaveObserver {
  private current?: BrowserCloseWindowIntent[];
  private acknowledged?: BrowserCloseWindowIntent[];
  private readonly waiting = new Set<Waiting>();
  private live = true;
  private removing?: Removing;
  private find(values: BrowserCloseWindowIntent[] | undefined, intent: BrowserCloseWindowIntent) {
    return values?.find(value => browserCloseIntentKey(value) === browserCloseIntentKey(intent));
  }
  private finish(entry: Waiting, error?: Error) {
    if (!this.waiting.delete(entry)) return;
    entry.cleanup(); if (error) entry.reject(error); else entry.resolve();
  }
  private finishRemoval(error?: Error) {
    const entry = this.removing; if (!entry) return;
    this.removing = undefined; entry.cleanup(); if (error) entry.reject(error); else entry.resolve();
  }
  private acknowledge() {
    for (const entry of this.waiting) if (exact(this.find(this.current, entry.intent), entry.intent)
      && exact(this.find(this.acknowledged, entry.intent), entry.intent)) this.finish(entry);
  }
  committed(view: WindowViewState): void {
    if (!this.live) return;
    try { this.current = parseBrowserCloseWindowIntents(view.browserCloses ?? []); }
    catch { this.current = undefined; this.failed("The committed window has invalid browser close history."); return; }
    for (const entry of this.waiting) {
      const current = this.find(this.current, entry.intent);
      if (exact(current, entry.intent)) entry.appeared = true;
      else if (entry.appeared || entry.previous === undefined || !exact(current ?? null, entry.previous))
        this.finish(entry, new Error("The original browser close intent changed before acknowledgement."));
    }
    const removing = this.removing;
    if (removing) {
      if (exact(this.current, removing.next)) removing.appeared = true;
      else if (removing.appeared || !exact(this.current, removing.previous)) this.finishRemoval(new Error("The Close history changed during retirement."));
    }
    // Every committed transition requires its own subsequent save observation.
    // A late acknowledgement from a dropped intent cannot authorize its reappearance.
    this.acknowledged = undefined;
  }
  saved(view: WindowViewState): void {
    if (!this.live) return;
    try { this.acknowledged = parseBrowserCloseWindowIntents(view.browserCloses ?? []); }
    catch { this.failed("The saved window has invalid browser close history."); return; }
    for (const entry of this.waiting) if (exact(this.find(this.current, entry.intent), entry.intent)
      && !exact(this.find(this.acknowledged, entry.intent), entry.intent)) this.finish(entry, new Error("The saved window did not retain the original browser close intent."));
    this.acknowledge();
    if (this.removing && exact(this.current, this.removing.next)) {
      if (exact(this.acknowledged, this.removing.next)) this.finishRemoval();
      else this.finishRemoval(new Error("The retired Close history was not saved exactly."));
    }
  }
  failed(message: string): void {
    this.current = undefined;
    this.acknowledged = undefined;
    for (const entry of this.waiting) this.finish(entry, new Error(message));
    this.finishRemoval(new Error(message));
  }
  /** An explicit predecessor permits one queued publication (null means absent), never restored dispatch authority. */
  wait(value: BrowserCloseWindowIntent, signal: AbortSignal, previous?: BrowserCloseWindowIntent | null): Promise<void> {
    if (!this.live || !this.current) return Promise.reject(new Error("A live committed browser window is required."));
    const intent = parseBrowserCloseWindowIntent(value), current = this.find(this.current, intent);
    const predecessor = previous == null ? previous : parseBrowserCloseWindowIntent(previous);
    if (predecessor) {
      const { receipt: _oldReceipt, ...oldRequest } = predecessor;
      const { receipt: _newReceipt, ...newRequest } = intent;
      if (!exact(oldRequest, newRequest)) return Promise.reject(new Error("The close publication changed its original request or presentation."));
    }
    const appeared = exact(current, intent);
    if (!appeared && (predecessor === undefined || !exact(current ?? null, predecessor))) return Promise.reject(new Error("The exact original close intent is not committed."));
    return new Promise((resolve, reject) => {
      const entry: Waiting = { intent, previous: predecessor, appeared, resolve, reject, cleanup: () => signal.removeEventListener("abort", abort) };
      const abort = () => this.finish(entry, new Error("Browser close acknowledgement was cancelled."));
      this.waiting.add(entry); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else this.acknowledge();
    });
  }
  /** One explicit, already acknowledged terminal record. No trimming, and no
   * sibling projection loss may be acknowledged as successful retirement. */
  waitRemoval(value: BrowserCloseWindowIntent, signal: AbortSignal): Promise<void> {
    const intent = parseBrowserCloseWindowIntent(value);
    if (!this.live || !this.current || this.removing || !intent.receipt || intent.receipt.outcome === "unknown"
      || !exact(this.find(this.current, intent), intent) || !exact(this.current, this.acknowledged))
      return Promise.reject(new Error("Save the exact confirmed Close history before dismissing it."));
    const previous = parseBrowserCloseWindowIntents(this.current);
    const next = previous.filter(row => browserCloseIntentKey(row) !== browserCloseIntentKey(intent));
    return new Promise((resolve, reject) => {
      const abort = () => this.finishRemoval(new Error("Close history retirement was cancelled."));
      this.removing = { previous, next, appeared: false, resolve, reject, cleanup: () => signal.removeEventListener("abort", abort) };
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    });
  }
  dispose(): void { this.live = false; this.current = undefined; this.failed("The browser window closed before acknowledgement."); }
}
