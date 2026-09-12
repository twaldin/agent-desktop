import { parseBrowserCreateRequest } from "@agent-desktop/shared";
import type { WindowViewState } from "../window-state";
import type { DockTab } from "./dock-state";
import type { BrowserNewTabState } from "./browser-new-tab";

type Pending = {
  tab: Pick<DockTab, "id" | "hostId" | "target" | "browserInstanceId">;
  request: string;
  draft: string | undefined;
  resolve(): void;
  reject(error: Error): void;
  cleanup(): void;
};
/** One App/window owner; observes existing saves and never writes a captured view. */
export class BrowserWindowCheckpoint {
  private current?: WindowViewState;
  private acknowledged?: WindowViewState;
  private pending = new Set<Pending>();
  private find(view: WindowViewState | undefined, expected: Pending) {
    return view?.dock?.tabs.find(tab => tab.id === expected.tab.id && tab.hostId === expected.tab.hostId
      && tab.target === expected.tab.target && tab.browserInstanceId === expected.tab.browserInstanceId
      && tab.browserNewTab && !tab.browserTarget);
  }
  private matches(view: WindowViewState | undefined, expected: Pending): boolean {
    const state = this.find(view, expected)?.browserNewTab;
    return Boolean(state?.request && state.draft === expected.draft
      && JSON.stringify(parseBrowserCreateRequest(state.request)) === expected.request);
  }
  private finish(entry: Pending, error?: Error) {
    if (!this.pending.delete(entry)) return;
    entry.cleanup(); if (error) entry.reject(error); else entry.resolve();
  }
  private acknowledge() {
    for (const entry of this.pending) {
      if (this.matches(this.current, entry) && this.matches(this.acknowledged, entry)) this.finish(entry);
    }
  }
  committed(view: WindowViewState) {
    this.current = structuredClone(view);
    for (const entry of this.pending) {
      const tab = this.find(this.current, entry);
      if (!tab) this.finish(entry, new Error("The initiating browser tab is no longer available."));
      else if (tab.browserNewTab?.request && !this.matches(this.current, entry)) this.finish(entry, new Error("The initiating browser request changed before its window save."));
    }
    this.acknowledge();
  }
  saved(view: WindowViewState) {
    this.acknowledged = structuredClone(view);
    for (const entry of this.pending) {
      if (this.matches(this.current, entry) && !this.matches(this.acknowledged, entry))
        this.finish(entry, new Error("The saved window layout did not retain the browser request."));
    }
    this.acknowledge();
  }
  failed(message: string) { for (const entry of this.pending) this.finish(entry, new Error(message)); }
  wait(tab: DockTab, state: BrowserNewTabState, signal: AbortSignal): Promise<void> {
    if (!state.request) return Promise.reject(new Error("A browser request is required before saving."));
    const request = JSON.stringify(parseBrowserCreateRequest(state.request));
    return new Promise((resolve, reject) => {
      const entry: Pending = { tab: { id: tab.id, hostId: tab.hostId, target: tab.target, browserInstanceId: tab.browserInstanceId },
        request, draft: state.draft, resolve, reject, cleanup: () => signal.removeEventListener("abort", abort) };
      const abort = () => this.finish(entry, new Error("The browser request was closed before its window save."));
      this.pending.add(entry); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else if (!this.find(this.current, entry)) this.finish(entry, new Error("The initiating browser tab is not in the committed window."));
      else this.acknowledge();
    });
  }
}
