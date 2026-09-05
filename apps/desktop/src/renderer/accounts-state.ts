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
  stop() { this.unsubscribe?.(); this.unsubscribe = undefined; }
  acceptLogin(login: LoginSnapshot) {
    this.loginVersion++;
    this.logins = [login, ...this.logins.filter(existing => existing.loginId !== login.loginId)].sort((a, b) => b.startedAt - a.startedAt);
    this.changed();
  }
  refresh(): Promise<void> {
    if (this.refreshPending) { this.refreshAgain = true; return this.refreshPending; }
    this.refreshPending = this.load().finally(() => { this.refreshPending = undefined; if (this.refreshAgain) { this.refreshAgain = false; void this.refresh(); } });
    return this.refreshPending;
  }
  private async load() {
    const loginVersion = this.loginVersion;
    this.loading = true; this.changed();
    await Promise.allSettled([
      (async () => {
        try {
          if (!this.bridge.getProviders) throw new Error("Provider settings require the current desktop bridge. Restart the app after updating.");
          const catalog = await this.bridge.getProviders(this.hostId);
          this.catalog = catalog; this.catalogError = undefined;
        } catch (cause) { this.catalogError = message(cause); }
      })(),
      (async () => {
        try {
          if (!this.bridge.getLogins) throw new Error("Login status requires the current desktop bridge. Restart the app after updating.");
          const logins = await this.bridge.getLogins(this.hostId);
          if (loginVersion === this.loginVersion) this.logins = logins.sort((a, b) => b.startedAt - a.startedAt);
          else this.refreshAgain = true;
          this.loginError = undefined;
        } catch (cause) { this.loginError = message(cause); }
      })(),
    ]);
    this.loading = false; this.changed();
  }
  loadAccounts(providerId: string): Promise<void> {
    const pending = this.accountPending.get(providerId); if (pending) { this.accountAgain.add(providerId); return pending; }
    const request = this.fetchAccounts(providerId).finally(() => { this.accountPending.delete(providerId); if (this.accountAgain.delete(providerId)) void this.loadAccounts(providerId); });
    this.accountPending.set(providerId, request); return request;
  }
  private async fetchAccounts(providerId: string) {
    this.loadingAccounts.add(providerId); this.changed();
    try {
      if (!this.bridge.getAccounts) throw new Error("Account metadata requires the current desktop bridge. Restart the app after updating.");
      this.accounts.set(providerId, await this.bridge.getAccounts(providerId, this.hostId)); this.accountErrors.delete(providerId);
    } catch (cause) { this.accountErrors.set(providerId, message(cause)); }
    finally { this.loadingAccounts.delete(providerId); this.changed(); }
  }
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
