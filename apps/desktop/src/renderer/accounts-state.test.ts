import { describe, expect, test } from "bun:test";
import type { DesktopEvent, LoginSnapshot, ProviderCatalog, ProviderInfo } from "../../../../packages/shared/src/protocol";
import { AccountsState, type AccountsBridge } from "./accounts-state";

const provider = (id: string, patch: Partial<ProviderInfo> = {}): ProviderInfo => ({ id, name: id, source: "builtin", available: true, disabledInSettings: false, loginSupported: true, visibleInNativeLoginList: true, storesCredentialsAs: id, pasteCodeFlow: true, apiKeyStorageSupported: true, transportMayAuthenticateWithoutKey: false, configured: false, storedCredentialCount: 0, storedApiKeyConfigured: false, disabledCredentialCount: 0, modelCount: 1, ...patch });
const catalog: ProviderCatalog = { credentialLocation: { mode: "broker", brokerOrigin: "http://broker.test:8080" }, providers: [provider("builtin"), provider("custom", { source: "runtime-oauth", visibleInNativeLoginList: false }), provider("stored", { source: "stored-only", available: false, disabledInSettings: true })], sessionSelectionConnected: true, extensionProviderCoverage: "registered-in-this-process-only" };
const login: LoginSnapshot = { loginId: "login", providerId: "builtin", status: "running", startedAt: 1, updatedAt: 1, cancellationRequested: false, prompts: [{ requestId: "request", kind: "manual-code", message: "Paste the code", allowEmpty: false, sensitive: true }] };
function bridge(overrides: Partial<AccountsBridge> = {}): AccountsBridge {
  return { getProviders: async () => catalog, getAccounts: async () => [], getLogins: async () => [], subscribe: () => () => {}, ...overrides };
}

describe("live account metadata", () => {
  test("preserves every native registry entry and its storage/capability metadata", async () => {
    const calls: Array<string | undefined> = [];
    const data = new AccountsState(bridge({ getProviders: async hostId => { calls.push(hostId); return catalog; }, getLogins: async hostId => { calls.push(hostId); return [login]; } }), "work", "local");
    await data.refresh();
    expect(calls).toEqual(["work", "work"]);
    expect(data.catalog?.providers.map(provider => provider.id)).toEqual(["builtin", "custom", "stored"]);
    expect(data.catalog?.providers[1]?.visibleInNativeLoginList).toBe(false);
    expect(data.catalog?.credentialLocation.mode).toBe("broker");
    expect(data.logins[0]?.prompts[0]?.sensitive).toBe(true);
  });
  test("backend failures remain errors rather than empty successful registries", async () => {
    const data = new AccountsState(bridge({ getProviders: async () => { throw new Error("HTTP 404: accounts service unavailable"); }, getLogins: async () => { throw new Error("HTTP 503: host disconnected"); }, getAccounts: async () => { throw new Error("Provider metadata unavailable"); } }), "work");
    await data.refresh(); await data.loadAccounts("builtin");
    expect(data.catalog).toBeNull();
    expect(data.catalogError).toContain("404");
    expect(data.loginError).toContain("503");
    expect(data.accounts.has("builtin")).toBe(false);
    expect(data.accountErrors.get("builtin")).toContain("unavailable");
  });
  test("account invalidations are scoped to the selected owner", async () => {
    let listener!: (event: DesktopEvent) => void; let calls = 0;
    const data = new AccountsState(bridge({ getProviders: async () => { calls++; return catalog; }, subscribe: callback => { listener = callback; return () => {}; } }), "work", "local");
    data.start(); listener({ type: "accounts", sequence: 1, hostId: "other" }); listener({ type: "accounts", sequence: 2 });
    expect(calls).toBe(0);
    listener({ type: "accounts", sequence: 3, hostId: "work" });
    expect(calls).toBe(1);
    data.stop();
  });
  test("a stale login read cannot erase a just-started native login", async () => {
    let complete!: (value: LoginSnapshot[]) => void; let reads = 0;
    const data = new AccountsState(bridge({ getLogins: async () => { reads++; return reads === 1 ? new Promise(resolve => { complete = resolve; }) : [login]; } }), "work");
    const fetching = data.refresh();
    data.acceptLogin(login); complete([]); await fetching;
    expect(data.logins[0]?.loginId).toBe("login");
    expect(reads).toBe(2);
  });
  test("an invalidation during account loading causes a fresh read after the pending request", async () => {
    let complete!: (value: []) => void; let reads = 0;
    const data = new AccountsState(bridge({ getAccounts: async () => { reads++; return reads === 1 ? new Promise<[]>(resolve => { complete = resolve; }) : [{ providerId: "builtin", credentialId: 2, type: "oauth", disabled: false }]; } }), "work");
    const fetching = data.loadAccounts("builtin"); void data.loadAccounts("builtin");
    complete([]); await fetching; await Promise.resolve();
    expect(reads).toBe(2);
    expect(data.accounts.get("builtin")?.[0]?.credentialId).toBe(2);
  });
  test("a failed refresh preserves previously loaded metadata with an explicit error", async () => {
    let fail = false;
    const data = new AccountsState(bridge({ getProviders: async () => { if (fail) throw new Error("Disconnected"); return catalog; } }), "work");
    await data.refresh(); fail = true; await data.refresh();
    expect(data.catalog?.providers).toHaveLength(3);
    expect(data.catalogError).toBe("Disconnected");
  });
});
