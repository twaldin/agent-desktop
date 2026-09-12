import { parseAutomationMutation, parseAutomationMutationResult, type AutomationMutation, type AutomationsBridge } from '../../../../packages/shared/src/automations';
import { parseAutomationWindowRequests, type AutomationWindowRequest } from '../automation-window-state';
import type { WindowViewState } from '../window-state';
import type { WindowSaveObserver } from './window-view-state';

/** One window owner. Saving the exact request precedes transport; reopening never dispatches automatically. */
export class AutomationRequests implements WindowSaveObserver {
  private entries: AutomationWindowRequest[];
  private current: AutomationWindowRequest[] = [];
  private acknowledged: AutomationWindowRequest[] = [];
  private waiters = new Map<string, { exact: string; appeared: boolean; resolve(): void; reject(error: Error): void }>();
  private active = new Set<string>();
  constructor(initial: AutomationWindowRequest[], private readonly changed: () => void) {
    this.entries = parseAutomationWindowRequests(initial);
  }
  get intents() { return structuredClone(this.entries); }
  pending(hostId: string) { return this.intents.find(entry => entry.hostId === hostId); }
  busy(hostId: string) { return this.active.has(hostId); }
  private acknowledge() {
    for (const [hostId, waiter] of this.waiters) {
      const current = this.current.find(entry => entry.hostId === hostId);
      const saved = this.acknowledged.find(entry => entry.hostId === hostId);
      if (current && saved && JSON.stringify(current) === waiter.exact && JSON.stringify(saved) === waiter.exact) {
        this.waiters.delete(hostId); waiter.resolve();
      }
    }
  }
  committed(view: WindowViewState) {
    this.current = parseAutomationWindowRequests(view.automationRequests ?? []);
    for (const [hostId, waiter] of this.waiters) {
      const current = this.current.find(entry => entry.hostId === hostId);
      if (current && JSON.stringify(current) === waiter.exact) waiter.appeared = true;
      else if (current || waiter.appeared) {
        this.waiters.delete(hostId); waiter.reject(new Error('The committed scheduled task request changed before its save.'));
      }
    }
    this.acknowledge();
  }
  saved(view: WindowViewState) {
    this.acknowledged = parseAutomationWindowRequests(view.automationRequests ?? []);
    for (const [hostId, waiter] of this.waiters) if (waiter.appeared
      && JSON.stringify(this.acknowledged.find(entry => entry.hostId === hostId)) !== waiter.exact) {
      this.waiters.delete(hostId); waiter.reject(new Error('The saved window did not retain the scheduled task request.'));
    }
    this.acknowledge();
  }
  invalidate(hostId: string) {
    const waiter = this.waiters.get(hostId);
    if (waiter) { this.waiters.delete(hostId); waiter.reject(new Error('The original scheduled task view became unavailable before dispatch. The saved request was preserved.')); }
  }
  failed(message: string) {
    for (const [hostId, waiter] of this.waiters) { this.waiters.delete(hostId); waiter.reject(new Error(message)); }
  }
  async submit(hostId: string, value: AutomationMutation, bridge: AutomationsBridge, current: () => boolean) {
    if (this.active.has(hostId)) throw new Error('Wait for this host’s scheduled task request.');
    const mutation = parseAutomationMutation(value), entry = { hostId, mutation };
    const prior = this.pending(hostId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) throw new Error('Resolve the original scheduled task request before submitting another.');
    if (!current()) throw new Error('Reconnect to the original host before submitting this request.');
    if (!prior && this.entries.length >= 20) throw new Error('Resolve an outstanding scheduled task request first.');
    this.active.add(hostId);
    try {
      if (!prior) this.entries.push(entry);
      const saved = new Promise<void>((resolve, reject) => this.waiters.set(hostId, { exact: JSON.stringify(entry), appeared: false, resolve, reject }));
      this.changed(); this.acknowledge(); await saved;
      if (!current()) throw new Error('The original host became unavailable before dispatch. The request was preserved.');
      const result = parseAutomationMutationResult(await bridge.mutate(hostId, mutation), hostId, mutation);
      this.entries = this.entries.filter(item => item.hostId !== hostId || item.mutation.requestId !== mutation.requestId);
      this.changed(); return result;
    } finally { this.active.delete(hostId); this.changed(); }
  }
  /** Explicit acknowledgement after inspecting the owning host; never performs or retries the action. */
  discard(hostId: string, requestId: string) {
    if (this.active.has(hostId)) throw new Error('Wait for the request to settle before dismissing it.');
    this.entries = this.entries.filter(entry => entry.hostId !== hostId || entry.mutation.requestId !== requestId);
    this.changed();
  }
}
