import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountInfo, DesktopBridge, ProviderCatalog, ProviderInfo, SessionSummary } from "@agent-desktop/shared";
import { ProviderDetails } from "./AccountsSettings";
import { AccountsState } from "./accounts-state";

const provider = (patch: Partial<ProviderInfo> = {}): ProviderInfo => ({ id: "native", name: "Native provider", source: "builtin", available: true, disabledInSettings: false, loginSupported: true, visibleInNativeLoginList: true, storesCredentialsAs: "native", pasteCodeFlow: false, apiKeyStorageSupported: true, transportMayAuthenticateWithoutKey: false, configured: false, storedCredentialCount: 0, storedApiKeyConfigured: false, disabledCredentialCount: 0, modelCount: 1, ...patch });
const catalog: ProviderCatalog = { credentialLocation: { mode: "local" }, providers: [], sessionSelectionConnected: true, extensionProviderCoverage: "registered-in-this-process-only" };
const session = { id: "session", title: "Owned session", status: "idle", model: { provider: "native", id: "model" } } as SessionSummary;
const bridge = { subscribe: () => () => {} } as unknown as DesktopBridge;
function view(item: ProviderInfo, connected = true) {
  const data = new AccountsState(bridge, "owner");
  const account: AccountInfo = { providerId: "native", credentialId: 7, type: "oauth", disabled: false, email: "account@example.invalid" };
  data.accounts.set(item.id, [account]);
  return renderToStaticMarkup(<ProviderDetails bridge={bridge} hostId="owner" hostName="Owner" connected={connected} session={session} onClose={() => {}} onChanged={() => {}} provider={item} catalog={catalog} data={data}/>);
}

test("unavailable native sign-in is described without an action that will fail", () => {
  const html = view(provider({ available: false }));
  expect(html).toContain("Sign-in unavailable");
  expect(html).toContain("Native sign-in is unavailable for this provider on this host.");
  expect(html).toContain("disabled");
});

test("saved account selection and removal stay scoped to the connected owner", () => {
  const html = view(provider());
  expect(html).toContain("account@example.invalid");
  expect(html).not.toContain("Use for this session");
  expect(html).toContain("Refresh accounts");
  expect(html).toContain("Remove");
  expect(html).toContain("There is no global active account.");
});

test("offline account actions remain visibly unavailable", () => {
  const html = view(provider(), false);
  expect(html).toContain("Sign in");
  expect(html).toContain("disabled");
});
