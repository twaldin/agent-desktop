import { parsePullRequestWriteRequest, parsePullRequestWriteReceipt, type PullRequestWritesBridge, type PullRequestWriteReceipt } from "../../../../packages/shared/src/pull-request-write";
import { parsePullRequestComposers, pullRequestComposerKey, type PullRequestComposer } from "../pull-request-composer-state";
import type { WindowViewState } from "../window-state";
import type { WindowSaveObserver } from "./window-view-state";

/** Durable local text and original submission IDs survive view changes. Reopening never posts. */
export class PullRequestComposers implements WindowSaveObserver {
  private entries: PullRequestComposer[];
  private current: PullRequestComposer[] = [];
  private acknowledged: PullRequestComposer[] = [];
  private readonly active = new Set<string>();
  private readonly waiters = new Map<string, { exact: string; appeared: boolean; stage: "admission" | "receipt"; resolve(): void; reject(error: Error): void }>();
  constructor(initial: PullRequestComposer[], private readonly changed: () => void) { this.entries = parsePullRequestComposers(initial); }
  get drafts() { return structuredClone(this.entries); }
  get(key: string) { const entry = this.entries.find(item => pullRequestComposerKey(item) === key); return entry ? structuredClone(entry) : undefined; }
  busy(key: string) { return this.active.has(key); }
  edit(entry: PullRequestComposer) {
    const key = pullRequestComposerKey(entry), prior = this.get(key);
    if (this.active.has(key) || prior?.request && prior.receipt?.outcome !== "succeeded") throw new Error("Resolve the saved submission before editing this draft.");
    this.replace({ ...entry, request: undefined, receipt: undefined });
  }
  private replace(entry: PullRequestComposer) {
    const key = pullRequestComposerKey(entry);
    this.entries = parsePullRequestComposers([...this.entries.filter(item => pullRequestComposerKey(item) !== key), entry]);
    this.changed();
  }
  private acknowledge() {
    for (const [key, waiter] of this.waiters) {
      if (JSON.stringify(this.current.find(item => pullRequestComposerKey(item) === key)) === waiter.exact &&
        JSON.stringify(this.acknowledged.find(item => pullRequestComposerKey(item) === key)) === waiter.exact) {
        this.waiters.delete(key); waiter.resolve();
      }
    }
  }
  committed(view: WindowViewState) {
    this.current = parsePullRequestComposers(view.pullRequestComposers ?? []);
    for (const [key, waiter] of this.waiters) {
      const entry = this.current.find(item => pullRequestComposerKey(item) === key);
      if (JSON.stringify(entry) === waiter.exact) waiter.appeared = true;
      else if (entry || waiter.appeared) { this.waiters.delete(key); waiter.reject(new Error("The original committed pull request draft changed before saving.")); }
    }
    this.acknowledge();
  }
  saved(view: WindowViewState) {
    this.acknowledged = parsePullRequestComposers(view.pullRequestComposers ?? []);
    for (const [key, waiter] of this.waiters) if (waiter.appeared && JSON.stringify(this.acknowledged.find(item => pullRequestComposerKey(item) === key)) !== waiter.exact) {
      this.waiters.delete(key); waiter.reject(new Error("The saved window did not retain the original pull request draft."));
    }
    this.acknowledge();
  }
  failed(message: string) {
    for (const [key, waiter] of this.waiters) { this.waiters.delete(key); waiter.reject(new Error(message)); }
  }
  invalidate(key: string) {
    const waiter = this.waiters.get(key);
    if (waiter?.stage === "admission") { this.waiters.delete(key); waiter.reject(new Error("The original pull request view became unavailable. Your draft is preserved.")); }
  }
  private wait(entry: PullRequestComposer, stage: "admission" | "receipt") {
    const key = pullRequestComposerKey(entry);
    return new Promise<void>((resolve, reject) => {
      this.waiters.set(key, { exact: JSON.stringify(entry), stage, appeared: false, resolve, reject });
      try { this.replace(entry); this.acknowledge(); }
      catch (error) { this.waiters.delete(key); reject(error); }
    });
  }
  async submit(key: string, expectedHeadOid: string, bridge: PullRequestWritesBridge, current: () => boolean): Promise<PullRequestWriteReceipt> {
    const entry = this.get(key);
    if (!entry || !current()) throw new Error("Reconnect to the original pull request before submitting.");
    if (this.active.has(key)) throw new Error("Wait for this submission to finish.");
    if (entry.request) throw new Error("Check the saved submission before starting another attempt.");
    const request = parsePullRequestWriteRequest({ requestId: crypto.randomUUID(), accountId: entry.accountId, pullRequest: entry.pullRequest, action: entry.action, expectedHeadOid, body: entry.body });
    this.active.add(key);
    try {
      await this.wait({ ...entry, request }, "admission");
      if (!current()) throw new Error("The original pull request changed before submission. Your saved request is preserved.");
      const receipt = parsePullRequestWriteReceipt(await bridge.submit(entry.hostId, request), entry.hostId, request);
      await this.wait({ ...entry, request, receipt }, "receipt");
      if (receipt.outcome === "succeeded") this.replace({ ...entry, body: "", request, receipt });
      return receipt;
    } finally { this.active.delete(key); this.changed(); }
  }
  async inspect(key: string, bridge: PullRequestWritesBridge, current: () => boolean): Promise<PullRequestWriteReceipt | null> {
    const entry = this.get(key);
    if (!entry?.request || !current()) throw new Error("Reconnect to the original host before checking this submission.");
    if (this.active.has(key)) throw new Error("Wait for this submission to finish.");
    this.active.add(key); this.changed();
    try {
      const result = await bridge.status(entry.hostId, entry.request);
      const receipt = result === null ? undefined : parsePullRequestWriteReceipt(result, entry.hostId, entry.request);
      // Even an absent host reservation does not post automatically or erase the user's text.
      if (receipt) {
        await this.wait({ ...entry, receipt }, "receipt");
        if (receipt.outcome === "succeeded") this.replace({ ...entry, body: "", receipt });
      }
      return receipt ?? null;
    } finally { this.active.delete(key); this.changed(); }
  }
  /** An explicit user acknowledgement, never a replay of the prior external action. */
  startFresh(key: string) {
    if (this.active.has(key)) throw new Error("Wait for this submission to finish.");
    const entry = this.get(key); if (!entry) return;
    this.replace({ ...entry, request: undefined, receipt: undefined });
  }
}
