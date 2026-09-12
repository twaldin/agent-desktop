import { parseTerminalWindowIntent, type TerminalWindowIntent } from "../terminal-window-intent";
import type { WindowViewState } from "../window-state";
import type { WindowSaveObserver } from "./window-view-state";

type Pending = { intent: TerminalWindowIntent; exact: string; appeared: boolean; resolve(): void; reject(error: Error): void; cleanup(): void };
/** Observes the existing window save; never saves a captured route or creates a
 * terminal. Live connection/action eligibility remains the dispatch owner's job. */
export class TerminalWindowCheckpoint implements WindowSaveObserver {
  private current?: WindowViewState;
  private acknowledged?: WindowViewState;
  private pending = new Set<Pending>();
  private find(view: WindowViewState | undefined, entry: Pending) {
    return view?.terminalCreations?.find(intent => intent.hostId === entry.intent.hostId && intent.request.requestId === entry.intent.request.requestId);
  }
  private matches(view: WindowViewState | undefined, entry: Pending) {
    const found = this.find(view, entry);
    return Boolean(found && JSON.stringify(parseTerminalWindowIntent(found)) === entry.exact);
  }
  private sourceMatches(view: WindowViewState | undefined, entry: Pending) {
    if (!view) return false;
    const source = entry.intent.source;
    if (source.kind === "dock") return true;
    const tabs = view.dock?.tabs.filter(tab => tab.id === source.tabId) ?? [];
    const tab = tabs.length === 1 ? tabs[0] : undefined;
    const locations = (["right", "bottom"] as const).filter(side => view.dock?.state[side].tabIds.includes(source.tabId));
    return Boolean(tab && locations.length === 1 && tab.kind === "browser" && tab.hostId === entry.intent.hostId
      && "sessionId" in entry.intent.request.target && tab.target === `session:${entry.intent.request.target.sessionId}`
      && tab.browserInstanceId === source.browserInstanceId && !tab.browserTarget && tab.title === source.title
      && (tab.browserNewTab?.status === "idle" || tab.browserNewTab?.status === "rejected")
      && tab.browserNewTab.draft === source.draft);
  }
  private finish(entry: Pending, error?: Error) {
    if (!this.pending.delete(entry)) return;
    entry.cleanup(); if (error) entry.reject(error); else entry.resolve();
  }
  private acknowledge() {
    for (const entry of this.pending) if (this.matches(this.current, entry) && this.matches(this.acknowledged, entry)
      && this.sourceMatches(this.current, entry) && this.sourceMatches(this.acknowledged, entry)) this.finish(entry);
  }
  committed(view: WindowViewState) {
    this.current = structuredClone(view);
    for (const entry of this.pending) {
      const found = this.find(view, entry);
      if (!this.sourceMatches(view, entry) || found && !this.matches(view, entry) || !found && entry.appeared)
        this.finish(entry, new Error("The initiating terminal request changed before its window save."));
      else if (found) entry.appeared = true;
    }
    this.acknowledge();
  }
  saved(view: WindowViewState) {
    this.acknowledged = structuredClone(view);
    for (const entry of this.pending) if (this.matches(this.current, entry)
      && (!this.matches(view, entry) || !this.sourceMatches(view, entry)))
      this.finish(entry, new Error("The saved window did not retain the terminal request and its source."));
    this.acknowledge();
  }
  failed(message: string) { for (const entry of this.pending) this.finish(entry, new Error(message)); }
  wait(value: TerminalWindowIntent, signal: AbortSignal): Promise<void> {
    const intent = parseTerminalWindowIntent(value);
    return new Promise((resolve, reject) => {
      const entry: Pending = { intent, exact: JSON.stringify(intent), appeared: false, resolve, reject,
        cleanup: () => signal.removeEventListener("abort", abort) };
      const abort = () => this.finish(entry, new Error("The terminal request was cancelled before its window save."));
      this.pending.add(entry); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else if (!this.sourceMatches(this.current, entry)) this.finish(entry, new Error("The terminal origin is not in this committed window."));
      else {
        const found = this.find(this.current, entry);
        if (found && !this.matches(this.current, entry)) this.finish(entry, new Error("This terminal request already has different saved input."));
        else { entry.appeared = Boolean(found); this.acknowledge(); }
      }
    });
  }
}
