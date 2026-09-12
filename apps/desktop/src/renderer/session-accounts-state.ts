import type { DesktopBridge, ModelChoice, SessionAccountList } from "@agent-desktop/shared";

type Bridge = Pick<DesktopBridge, "getSessionAccounts" | "accountAction" | "subscribe">;
const message = (error: unknown) => error instanceof Error ? error.message : "Account selection could not be confirmed. Refresh before trying again.";

/** One view of the original host/session/model. Mutations are never replayed. */
export class SessionAccountsState {
  selection?: SessionAccountList;
  error?: string;
  loading = false;
  busy = false;
  connected = false;
  private generation = 0;
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private pending?: Promise<void>;
  private refreshAgain = false;
  constructor(private bridge: Bridge, readonly hostId: string, readonly sessionId: string, readonly model: ModelChoice, private localHostId?: string) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { for (const listener of this.listeners) listener(); }
  start() { this.unsubscribe ??= this.bridge.subscribe(event => { if (event.type === "accounts" && (event.hostId ?? this.localHostId) === this.hostId && !this.busy) void this.refresh(); }); }
  stop() { this.unsubscribe?.(); this.unsubscribe = undefined; this.setConnected(false); }
  setConnected(value: boolean) {
    if (value === this.connected) return;
    this.connected = value; this.generation++; this.pending = undefined; this.refreshAgain = false; this.loading = false; this.busy = false; this.changed();
  }
  private accept(value: SessionAccountList) {
    if (value.sessionId !== this.sessionId || value.providerId !== this.model.provider || value.selection && (value.selection.model.provider !== this.model.provider || value.selection.model.id !== this.model.id || !value.selection.revision)) throw new Error("The session model changed. Reopen account selection for its current model.");
    const ids = new Set<number>();
    for (const account of value.accounts) {
      if (account.providerId !== this.model.provider || account.type !== "oauth" || account.disabled || !Number.isSafeInteger(account.credentialId) || account.credentialId <= 0 || ids.has(account.credentialId)) throw new Error("The host returned invalid session account choices.");
      ids.add(account.credentialId);
    }
    this.selection = structuredClone(value);
  }
  refresh(): Promise<void> {
    if (!this.connected || this.busy) return Promise.resolve();
    if (this.pending) { this.refreshAgain = true; return this.pending; }
    const generation = this.generation; this.loading = true; this.changed();
    const current = () => this.connected && generation === this.generation;
    const run = Promise.resolve().then(async () => {
      try { this.acceptCurrent(await this.bridge.getSessionAccounts(this.sessionId, this.hostId), current); }
      catch (error) { if (current()) this.error = message(error); }
      finally { if (current()) { this.loading = false; this.pending = undefined; this.changed(); if (this.refreshAgain) { this.refreshAgain = false; void this.refresh(); } } }
    });
    this.pending = run; return run;
  }
  private acceptCurrent(value: SessionAccountList, current: () => boolean) { if (current()) { this.accept(value); this.error = undefined; } }
  async choose(credentialId: number | null) {
    const selection = this.selection?.selection;
    if (!this.connected || this.busy || this.loading || !selection || this.error) return;
    if (credentialId !== null && !this.selection?.accounts.some(account => account.credentialId === credentialId && !account.disabled)) return;
    const generation = ++this.generation; this.pending = undefined; this.busy = true; this.error = undefined; this.changed();
    const current = () => this.connected && this.generation === generation;
    try {
      const action = credentialId === null ? { type: "session.release" as const, sessionId: this.sessionId, expectedSelection: structuredClone(selection) } : { type: "session.pin" as const, sessionId: this.sessionId, credentialId, expectedSelection: structuredClone(selection) };
      const result = await this.bridge.accountAction(action, this.hostId);
      if (!current()) return;
      if (!result.selection) throw new Error("The host did not confirm account selection. Refresh before trying again.");
      this.accept(result.selection);
    } catch (error) { if (current()) this.error = message(error); }
    finally { if (current()) { this.busy = false; this.changed(); } }
  }
}
