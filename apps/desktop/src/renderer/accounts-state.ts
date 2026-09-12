import type { AccountInfo, DesktopBridge, LoginSnapshot, ProviderCatalog } from "../../../../packages/shared/src/protocol";
export type AccountsBridge = Pick<DesktopBridge, "getProviders" | "getAccounts" | "getLogins" | "subscribe">;

/** Live account metadata and login snapshots only. Nothing in this controller is persisted. */
export class AccountsState {
  catalog: ProviderCatalog | null = null;
  logins: LoginSnapshot[] = [];
  accounts = new Map<string, AccountInfo[]>();
  catalogError?: string;
  loginError?: string;
  accountErrors = new Map<string, string>();
  loading = false;
  revision = 0;
  loadingAccounts = new Set<string>();
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private refreshPending?: Promise<void>;
  private refreshAgain = false;
  private accountPending = new Map<string, Promise<void>>();
  private accountAgain = new Set<string>();
  private loginVersion = 0;
  private connected = true;
  private generation = 0;
  setConnected(connected: boolean) {
    if (this.connected === connected) return;
    this.connected = connected; this.generation++;
    this.refreshPending = undefined; this.refreshAgain = false;
    this.accountPending.clear(); this.accountAgain.clear();
    this.loading = false; this.loadingAccounts.clear();
    this.changed();
  }
  constructor(private bridge: AccountsBridge, readonly hostId: string, private localHostId?: string) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { this.revision++; for (const listener of this.listeners) listener(); }
  start() {
    this.unsubscribe ??= this.bridge.subscribe(event => {
      if (event.type === "accounts" && (event.hostId ?? this.localHostId) === this.hostId) {
        void this.refresh();
        for (const provider of this.accounts.keys()) void this.loadAccounts(provider);
      }
    });
  }
  stop() { this.unsubscribe?.(); this.unsubscribe = undefined; this.setConnected(false); }
  acceptLogin(login: LoginSnapshot) {
    if (!this.connected) return;
    this.loginVersion++;
    this.logins = [login, ...this.logins.filter(existing => existing.loginId !== login.loginId)].sort((a, b) => b.startedAt - a.startedAt);
    this.changed();
  }
  refresh(): Promise<void> {
    if (!this.connected) return Promise.resolve();
    const generation = this.generation;
    if (this.refreshPending) { this.refreshAgain = true; return this.refreshPending; }
    this.refreshPending = this.load(generation).finally(() => { if (generation !== this.generation) return; this.refreshPending = undefined; if (this.refreshAgain) { this.refreshAgain = false; void this.refresh(); } });
    return this.refreshPending;
  }
  private async load(generation: number) {
    const current = () => this.connected && this.generation === generation;
    const loginVersion = this.loginVersion;
    this.loading = true; this.changed();
    await Promise.allSettled([
      (async () => {
        try {
          if (!this.bridge.getProviders) throw new Error("Provider settings require the current desktop bridge. Restart the app after updating.");
          const catalog = await this.bridge.getProviders(this.hostId);
          if (!current()) return;
          this.catalog = catalog; this.catalogError = undefined;
        } catch (cause) { if (current()) this.catalogError = message(cause); }
      })(),
      (async () => {
        try {
          if (!this.bridge.getLogins) throw new Error("Login status requires the current desktop bridge. Restart the app after updating.");
          const logins = await this.bridge.getLogins(this.hostId);
          if (!current()) return;
          if (loginVersion === this.loginVersion) this.logins = logins.sort((a, b) => b.startedAt - a.startedAt);
          else this.refreshAgain = true;
          this.loginError = undefined;
        } catch (cause) { if (current()) this.loginError = message(cause); }
      })(),
    ]);
    if (current()) { this.loading = false; this.changed(); }
  }
  loadAccounts(providerId: string): Promise<void> {
    if (!this.connected) return Promise.resolve();
    const generation = this.generation;
    const pending = this.accountPending.get(providerId); if (pending) { this.accountAgain.add(providerId); return pending; }
    const request = this.fetchAccounts(providerId, generation).finally(() => { if (generation !== this.generation) return; this.accountPending.delete(providerId); if (this.accountAgain.delete(providerId)) void this.loadAccounts(providerId); });
    this.accountPending.set(providerId, request); return request;
  }
  private async fetchAccounts(providerId: string, generation: number) {
    const current = () => this.connected && this.generation === generation;
    this.loadingAccounts.add(providerId); this.changed();
    try {
      if (!this.bridge.getAccounts) throw new Error("Account metadata requires the current desktop bridge. Restart the app after updating.");
      const accounts = await this.bridge.getAccounts(providerId, this.hostId);
      if (current()) { this.accounts.set(providerId, accounts); this.accountErrors.delete(providerId); }
    } catch (cause) { if (current()) this.accountErrors.set(providerId, message(cause)); }
    finally { if (current()) { this.loadingAccounts.delete(providerId); this.changed(); } }
  }
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
