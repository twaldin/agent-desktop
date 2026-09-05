import path from "node:path";
import { getAgentDir, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { resolveConfigValue } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import { discoverAuthStorage, resolveAuthBrokerConfig } from "@oh-my-pi/pi-ai/auth-broker/discover";
import { getOAuthProviders, PROVIDER_REGISTRY, type ProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { NativeLogin } from "./login";
import { disabledAccount, publicAuthError, storedAccount } from "./projection";
import type { AccountEvent, AccountInfo, AccountSelectionBridge, AuthOrigin, LoginResponse, LoginRun, LoginSnapshot, ProviderCatalog, ProviderInfo, SessionAccountList } from "./types";

export interface OmpAccountsOptions {
  agentDir?: string;
  cwd?: string;
  selectionBridge?: AccountSelectionBridge;
  loginTimeoutMs?: number;
}

export class AccountOperationError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(error: ReturnType<typeof publicAuthError>) {
    super(error.message); this.name = "AccountOperationError"; this.code = error.code; this.status = error.status;
  }
}

/** Native account operations; no credentials are exposed through public return values. */
export class OmpAccounts {
  #auth: AuthStorage;
  #registry: ModelRegistry;
  #settings: Settings;
  #options: OmpAccountsOptions;
  #configuredProviderIds: string[];
  #broker?: AuthBrokerClient;
  #location: ProviderCatalog["credentialLocation"];
  #listeners = new Set<(event: AccountEvent) => void>();
  #logins = new Map<string, NativeLogin>();
  #writing = new Set<string>();
  #mutations = new Set<Promise<unknown>>();
  #disposed = false;
  #disposeCall?: Promise<void>;

  private constructor(
    options: OmpAccountsOptions, auth: AuthStorage, registry: ModelRegistry, settings: Settings,
    broker: AuthBrokerClient | undefined, location: ProviderCatalog["credentialLocation"],
    configuredProviderIds: string[],
  ) {
    this.#options = options; this.#auth = auth; this.#registry = registry; this.#settings = settings;
    this.#broker = broker; this.#location = location;
    this.#configuredProviderIds = configuredProviderIds;
  }

  static async open(options: OmpAccountsOptions = {}): Promise<OmpAccounts> {
    const agentDir = options.agentDir ?? getAgentDir();
    let auth: AuthStorage | undefined;
    try {
      const settings = await Settings.loadReadOnly({ cwd: options.cwd ?? process.cwd(), agentDir });
      const brokerConfig = await resolveAuthBrokerConfig({ agentDir, configValueResolver: resolveConfigValue });
      auth = await discoverAuthStorage({
        agentDir, configValueResolver: resolveConfigValue,
        ...(options.agentDir ? { cachePath: path.join(agentDir, "auth-broker-account-cache") } : {}),
      });
      const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
      if (registry.getError()) throw new Error("Invalid native model configuration");
      await registry.hydrateCredentialScopedModelCaches();
      return new OmpAccounts(options, auth, registry, settings,
        brokerConfig ? new AuthBrokerClient(brokerConfig) : undefined,
        brokerConfig ? { mode: "broker", brokerOrigin: new URL(brokerConfig.url).origin } : { mode: "local" },
        Object.keys(ModelsConfigFile.relocate(path.join(agentDir, "models.yml")).load()?.providers ?? {}));
    } catch (error) {
      auth?.close();
      throw new AccountOperationError(publicAuthError(error, "account initialization"));
    }
  }

  #active(): void { if (this.#disposed) throw new Error("OMP accounts backend is disposed"); }
  #emit(event: AccountEvent): void {
    for (const listener of this.#listeners) {
      try { listener(structuredClone(event)); }
      catch { console.error("OMP account event observer threw an exception"); }
    }
  }
  subscribe(listener: (event: AccountEvent) => void): () => void {
    this.#active(); this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #definitions(): Map<string, { definition: ProviderDefinition; source: ProviderInfo["source"] }> {
    const definitions = new Map(PROVIDER_REGISTRY.map(definition => [definition.id, { definition, source: "builtin" as ProviderInfo["source"] }]));
    for (const provider of getOAuthProviders()) {
      if (!definitions.has(provider.id)) definitions.set(provider.id, {
        definition: { id: provider.id, name: provider.name, available: provider.available, storeCredentialsAs: provider.storeCredentialsAs },
        source: "runtime-oauth",
      });
    }
    for (const model of this.#registry.getAll()) {
      if (!definitions.has(model.provider)) definitions.set(model.provider, {
        definition: { id: model.provider, name: model.provider }, source: "configured-model",
      });
    }
    // Disabled and discovery-only custom providers may have no materialized
    // models. Preserve the names from OMP's validated canonical config loader.
    for (const id of this.#configuredProviderIds) {
      if (!definitions.has(id)) definitions.set(id, {
        definition: { id, name: id }, source: "configured-model",
      });
    }
    for (const providerId of this.#registry.getDiscoverableProviders()) {
      if (!definitions.has(providerId)) definitions.set(providerId, {
        definition: { id: providerId, name: providerId }, source: "configured-model",
      });
    }
    for (const providerId of this.#auth.list()) {
      if (!definitions.has(providerId)) definitions.set(providerId, {
        definition: { id: providerId, name: providerId }, source: "stored-only",
      });
    }
    return definitions;
  }

  async listProviders(): Promise<ProviderCatalog> {
    this.#active();
    try {
      await this.#auth.revalidateCredentials();
      const definitions = this.#definitions();
      const disabled = await this.#auth.listDisabledCredentials();
      for (const row of disabled) {
        if (!definitions.has(row.provider)) definitions.set(row.provider, {
          definition: { id: row.provider, name: row.provider }, source: "stored-only",
        });
      }
      const models = this.#registry.getAll();
      const loginIds = new Set(getOAuthProviders().map(provider => provider.id));
      const disabledInSettings = new Set(this.#settings.get("disabledProviders"));
      const providers: ProviderInfo[] = [];
      for (const [id, { definition, source }] of definitions) {
        const storedAs = definition.storeCredentialsAs ?? id;
        const rows = this.#auth.listStoredCredentials(storedAs);
        const commandBacked = this.#registry.hasCommandBackedApiKey(storedAs);
        const nativeOrigin = commandBacked ? { kind: "config" as const, commandBacked: true } : this.#auth.getCredentialOrigin(storedAs);
        const authOrigin: AuthOrigin | undefined = nativeOrigin ? {
          kind: nativeOrigin.kind,
          ...("envVar" in nativeOrigin && nativeOrigin.envVar ? { envVar: nativeOrigin.envVar } : {}),
          ...(commandBacked ? { commandBacked: true } : {}),
        } : undefined;
        const providerModels = models.filter(model => model.provider === storedAs);
        providers.push({
          id, name: definition.name, source, available: definition.available ?? true,
          disabledInSettings: disabledInSettings.has(id),
          loginSupported: !!definition.login || loginIds.has(id),
          visibleInNativeLoginList: loginIds.has(id), storesCredentialsAs: storedAs,
          ...(definition.callbackPort !== undefined ? { callbackPort: definition.callbackPort } : {}),
          pasteCodeFlow: definition.pasteCodeFlow ?? false, apiKeyStorageSupported: true,
          transportMayAuthenticateWithoutKey: definition.allowsMissingApiKey ?? false,
          configured: commandBacked || !!authOrigin || providerModels.some(model => this.#registry.hasConfiguredAuth(model)),
          ...(authOrigin ? { authOrigin } : {}), storedCredentialCount: rows.length,
          storedApiKeyConfigured: rows.some(row => row.credential.type === "api_key"),
          disabledCredentialCount: disabled.filter(row => row.provider === storedAs).length,
          modelCount: providerModels.length,
        });
      }
      return {
        credentialLocation: { ...this.#location }, providers,
        sessionSelectionConnected: !!this.#options.selectionBridge,
        extensionProviderCoverage: "registered-in-this-process-only",
      };
    } catch (error) { throw new AccountOperationError(publicAuthError(error, "provider catalog read")); }
  }

  async listAccounts(providerId: string): Promise<AccountInfo[]> {
    this.#active();
    const provider = this.#definitions().get(providerId)?.definition;
    const storedAs = provider?.storeCredentialsAs ?? providerId;
    try {
      await this.#auth.revalidateCredentials();
      return [
        ...this.#auth.listStoredCredentials(storedAs).map(storedAccount),
        ...(await this.#auth.listDisabledCredentials(storedAs)).map(disabledAccount),
      ];
    } catch (error) { throw new AccountOperationError(publicAuthError(error, "account metadata read")); }
  }

  #mutate<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    this.#active();
    if (this.#writing.has(providerId)) throw new Error("A native account operation is already pending for this provider");
    this.#writing.add(providerId);
    const pending = operation();
    this.#mutations.add(pending);
    const finish = () => { this.#writing.delete(providerId); this.#mutations.delete(pending); };
    void pending.then(finish, finish);
    return pending;
  }

  /** Native upsert semantics preserve other OAuth accounts. The key is never returned. */
  setApiKey(providerId: string, key: string): Promise<void> {
    this.#active();
    const definition = this.#definitions().get(providerId)?.definition;
    if (!definition) throw new Error("Unknown OMP provider");
    const storedAs = definition.storeCredentialsAs ?? providerId;
    if (!key.trim() || key.length > 1024 * 1024) throw new Error("A non-empty API key is required");
    return this.#mutate(storedAs, async () => {
      try {
        // AuthStorage.set() replaces ALL provider credentials, and a remote
        // snapshot contains redacted refresh tokens. Never round-trip that
        // snapshot. These native upserts preserve canonical broker refresh data.
        if (this.#broker) {
          await this.#broker.uploadCredential(storedAs, { type: "api_key", key, source: "login" });
          await this.#auth.revalidateCredentials();
        } else { this.#auth.upsertCredential(storedAs, { type: "api_key", key, source: "login" }); }
        this.#emit({ type: "accounts.changed", providerId: storedAs });
      } catch (error) { throw new AccountOperationError(publicAuthError(error, "API key storage")); }
    });
  }

  removeCredential(providerId: string, credentialId: number): Promise<boolean> {
    this.#active();
    if (!Number.isSafeInteger(credentialId) || credentialId <= 0) throw new Error("Invalid native credential ID");
    const storedAs = this.#definitions().get(providerId)?.definition.storeCredentialsAs ?? providerId;
    return this.#mutate(storedAs, async () => {
      try {
        await this.#auth.revalidateCredentials();
        const removed = await this.#auth.removeCredential(storedAs, credentialId);
        if (removed) this.#emit({ type: "accounts.changed", providerId: storedAs });
        return removed;
      } catch (error) { throw new AccountOperationError(publicAuthError(error, "credential removal")); }
    });
  }

  startLogin(providerId: string): LoginRun {
    this.#active();
    const candidate = this.#definitions().get(providerId);
    if (!candidate || (!candidate.definition.login && !getOAuthProviders().some(provider => provider.id === providerId))) {
      throw new Error("This provider has no native interactive login flow");
    }
    if (candidate.definition.available === false) throw new Error("This native login provider is unavailable");
    const storedAs = candidate.definition.storeCredentialsAs ?? providerId;
    if (this.#writing.has(storedAs)) throw new Error("A native account operation is already pending for this provider");
    // Bound retained in-memory login records; active flows are never evicted.
    for (const [id, login] of this.#logins) {
      if (this.#logins.size < 32) break;
      if (!["running", "cancelling"].includes(login.snapshot().status)) this.#logins.delete(id);
    }
    if (this.#logins.size >= 32) throw new Error("Too many native login flows are pending");
    this.#writing.add(storedAs);
    const login = new NativeLogin(providerId, async callbacks => {
      const result = await this.#auth.login(providerId, callbacks);
      if (result) this.#emit({ type: "accounts.changed", providerId: storedAs });
      return result;
    }, snapshot => this.#emit({ type: "login.changed", login: snapshot }), this.#options.loginTimeoutMs);
    this.#logins.set(login.id, login);
    this.#mutations.add(login.completion);
    const finish = () => { this.#writing.delete(storedAs); this.#mutations.delete(login.completion); };
    void login.completion.then(finish, finish);
    return { loginId: login.id, completion: login.completion };
  }

  pendingLogin(loginId: string): LoginSnapshot {
    this.#active();
    const login = this.#logins.get(loginId);
    if (!login) throw new Error("Unknown native login ID");
    return login.snapshot();
  }
  respond(loginId: string, requestId: string, response: LoginResponse): void {
    this.#active();
    const login = this.#logins.get(loginId);
    if (!login) throw new Error("Unknown native login ID");
    login.respond(requestId, response);
  }
  cancelLogin(loginId: string): void {
    this.#active();
    const login = this.#logins.get(loginId);
    if (!login) throw new Error("Unknown native login ID");
    login.cancel();
  }

  listSessionAccounts(sessionId: string): Promise<SessionAccountList> {
    this.#active();
    if (!this.#options.selectionBridge) throw new Error("Native account selection must be connected to the owning session worker");
    return this.#options.selectionBridge.list(sessionId);
  }
  pinSessionAccount(sessionId: string, credentialId: number): Promise<SessionAccountList> {
    this.#active();
    if (!this.#options.selectionBridge) throw new Error("Native account selection must be connected to the owning session worker");
    return this.#options.selectionBridge.pin(sessionId, credentialId);
  }

  dispose(): Promise<void> {
    if (this.#disposeCall) return this.#disposeCall;
    this.#disposed = true;
    for (const login of this.#logins.values()) login.cancel();
    this.#disposeCall = (async () => {
      await Promise.allSettled([...this.#mutations]);
      this.#auth.close(); this.#listeners.clear(); this.#logins.clear();
    })();
    return this.#disposeCall;
  }
}
