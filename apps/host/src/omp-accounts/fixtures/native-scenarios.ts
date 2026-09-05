// Isolated native-storage contracts. The named providers/credentials below are
// fixtures; no live OAuth account or inference endpoint is used.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker/server";
import { PROVIDER_REGISTRY, registerOAuthProvider, unregisterOAuthProvider } from "@oh-my-pi/pi-ai/registry";
import { OmpAccounts } from "../accounts";
import type { AccountEvent } from "../types";

const base = process.env.CONTRACT_DIRECTORY!;
assert(base);
const actualFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1") throw new Error("Provider fetch blocked in native account contracts");
  return actualFetch(input, init);
}, { preconnect: () => {} }) as typeof fetch;

const agentDir = path.join(base, "local-agent");
await mkdir(agentDir, { recursive: true });
const accounts = await OmpAccounts.open({ agentDir, cwd: base });
const fixtureProvider = "contract-oauth-provider";
const privateAccess = "contract-private-access-token";
const privateRefresh = "contract-private-refresh-token";
const privateInput = "contract-private-entered-value";
const events: AccountEvent[] = [];
try {
  const initial = await accounts.listProviders();
  assert.equal(initial.credentialLocation.mode, "local");
  assert(PROVIDER_REGISTRY.every(provider => initial.providers.some(entry => entry.id === provider.id)));
  assert.equal(initial.sessionSelectionConnected, false);
  await assert.rejects(async () => accounts.listSessionAccounts("unconnected-session"), /owning session worker/);
  await accounts.setApiKey("openai", "contract-api-key-one");
  let keys = await accounts.listAccounts("openai");
  assert.equal(keys.filter(key => !key.disabled).length, 1);
  const originalId = keys.find(key => !key.disabled)!.credentialId;
  await accounts.setApiKey("openai", "contract-api-key-two");
  keys = await accounts.listAccounts("openai");
  assert.equal(keys.find(key => !key.disabled)!.credentialId, originalId);
  assert(!JSON.stringify(keys).includes("contract-api-key"));
  assert.equal((await accounts.listProviders()).providers.find(provider => provider.id === "openai")!.storedApiKeyConfigured, true);

  registerOAuthProvider({
    id: fixtureProvider, name: "Contract OAuth",
    login: async callbacks => {
      assert.equal(await callbacks.onPrompt({ message: "Fixture secret", allowEmpty: false }), privateInput);
      callbacks.onAuth({ url: "https://example.invalid/login?state=contract", instructions: "Contract device code ABCD" });
      assert.equal(await callbacks.onManualCodeInput!(), "contract-redirect-code");
      return { access: privateAccess, refresh: privateRefresh, expires: Date.now() + 86_400_000,
        email: "contract@example.invalid", accountId: "contract-account", orgName: "Contract Organization" };
    },
  });
  accounts.subscribe(event => {
    events.push(event);
    if (event.type === "login.changed") for (const prompt of event.login.prompts) {
      accounts.respond(event.login.loginId, prompt.requestId, { value: prompt.kind === "manual-code" ? "contract-redirect-code" : privateInput });
    }
  });
  const login = accounts.startLogin(fixtureProvider);
  const finished = await login.completion;
  assert.equal(finished.status, "succeeded");
  const oauthAccounts = await accounts.listAccounts(fixtureProvider);
  assert.equal(oauthAccounts[0].email, "contract@example.invalid");
  const serialized = JSON.stringify({ finished, oauthAccounts, events, providers: await accounts.listProviders() });
  for (const secret of [privateAccess, privateRefresh, privateInput, "contract-api-key-two", "contract-redirect-code"]) {
    assert(!serialized.includes(secret));
  }
  assert(!("active" in oauthAccounts[0]));
  await accounts.setApiKey(fixtureProvider, "contract-key-beside-oauth");
  const alongside = await accounts.listAccounts(fixtureProvider);
  assert.equal(alongside.filter(account => !account.disabled).length, 2);
  assert.equal(alongside.find(account => account.type === "oauth")!.credentialId, oauthAccounts[0].credentialId);
  assert.equal(await accounts.removeCredential(fixtureProvider, oauthAccounts[0].credentialId), true);
  assert.equal(await accounts.removeCredential(fixtureProvider, oauthAccounts[0].credentialId), false);
  assert((await accounts.listAccounts(fixtureProvider)).some(account => account.disabled && account.type === "oauth"));
} finally {
  unregisterOAuthProvider(fixtureProvider);
  await accounts.dispose();
}

const brokerStorage = await AuthStorage.create(path.join(base, "broker.db"));
await brokerStorage.reload();
const broker = startAuthBroker({ storage: brokerStorage, bind: "127.0.0.1:0", bearerTokens: ["contract-broker-token"], disableRefresher: true });
const remoteDir = path.join(base, "remote-agent");
await mkdir(remoteDir, { recursive: true });
await writeFile(path.join(remoteDir, "config.yml"), `auth:\n  broker:\n    url: ${broker.url}\n    token: contract-broker-token\n`);
let remote: OmpAccounts | undefined;
try {
  // Real native broker transport and canonical store; fixture credentials stay
  // entirely in temporary storage, including refresh values.
  brokerStorage.upsertCredential("openai", { type: "oauth", access: privateAccess, refresh: privateRefresh,
    expires: Date.now() + 86_400_000, email: "broker-contract@example.invalid", accountId: "broker-account" });
  remote = await OmpAccounts.open({ agentDir: remoteDir, cwd: base });
  assert.equal((await remote.listProviders()).credentialLocation.mode, "broker");
  // Mutate the canonical broker through a different client/store after this
  // process cached its initial snapshot. Catalog/account reads must revalidate.
  brokerStorage.upsertCredential("anthropic", { type: "api_key", key: "contract-external-broker-key" });
  assert.equal((await remote.listProviders()).providers.find(provider => provider.id === "anthropic")?.storedApiKeyConfigured, true);
  const externallyAdded = (await remote.listAccounts("anthropic"))[0];
  assert(externallyAdded);
  assert.equal(await remote.removeCredential("anthropic", externallyAdded.credentialId), true);
  assert.equal(brokerStorage.listStoredCredentials("anthropic").length, 0);
  const originalOAuth = (await remote.listAccounts("openai")).find(account => account.type === "oauth")!;
  await remote.setApiKey("openai", "contract-broker-api-key");
  const remoteAccounts = await remote.listAccounts("openai");
  assert(remoteAccounts.some(account => account.credentialId === originalOAuth.credentialId));
  assert(remoteAccounts.some(account => account.type === "api_key"));
  const canonical = brokerStorage.listStoredCredentials("openai").find(row => row.credential.type === "oauth")!;
  assert(canonical.credential.type === "oauth");
  assert.equal(canonical.credential.refresh, privateRefresh);
  const output = JSON.stringify({ catalog: await remote.listProviders(), accounts: remoteAccounts });
  for (const secret of [privateAccess, privateRefresh, "contract-broker-token", "contract-broker-api-key"]) assert(!output.includes(secret));
  assert.equal(await remote.removeCredential("openai", originalOAuth.credentialId), true);
} finally { await remote?.dispose(); await broker.close(); brokerStorage.close(); }
process.stdout.write("native local and broker account contracts passed\n");
