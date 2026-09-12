import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AccountAction, AccountActionResult, AccountInfo, DesktopBridge, LoginPrompt, LoginSnapshot, ProviderCatalog, ProviderInfo, SessionAccountList, SessionSummary } from "../../../../packages/shared/src/protocol";
import { AccountsState } from "./accounts-state";
import { Icon } from "./Icons";
import { errorMessage } from "./desktop-state";

interface Props { bridge: DesktopBridge; hostId: string; hostName: string; localHostId?: string; connected: boolean; session: SessionSummary | null; onClose(): void; onChanged(): void }
export function AccountsSettings(props: Props) {
  const { bridge, hostId, connected, localHostId } = props;
  const data = useMemo(() => new AccountsState(bridge, hostId, localHostId), [bridge, hostId, localHostId]);
  const [, redraw] = useReducer(value => value + 1, 0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "configured" | "signin">("all");
  const [providerId, setProviderId] = useState<string | null>(null);
  useEffect(() => { const unsubscribe = data.subscribe(redraw); data.start(); return () => { unsubscribe(); data.stop(); }; }, [data]);
  useEffect(() => { if (connected) void data.refresh(); }, [data, connected]);
  const runningLogin = data.logins.some(login => login.status === "running" || login.status === "cancelling");
  useEffect(() => {
    if (!connected || !runningLogin) return;
    const timer = setInterval(() => { void data.refresh(); }, 2_000);
    return () => clearInterval(timer);
  }, [data, connected, runningLogin]);
  const providers = data.catalog?.providers ?? [];
  const selected = providers.find(provider => provider.id === providerId) ?? providers.find(provider => provider.configured) ?? providers[0];
  useEffect(() => { if (connected && selected) void data.loadAccounts(selected.id); }, [data, connected, selected?.id]);
  const visible = [...providers].filter(provider => (!query.trim() || `${provider.id} ${provider.name} ${provider.storesCredentialsAs}`.toLowerCase().includes(query.trim().toLowerCase())) && (filter === "all" || filter === "configured" && provider.configured || filter === "signin" && provider.loginSupported)).sort((a, b) => a.name.localeCompare(b.name));
  function refresh() { void data.refresh(); if (selected) void data.loadAccounts(selected.id); }
  return <section className="settings-page" aria-label="Accounts settings">
    <header className="settings-header drag-region"><button className="icon-button no-drag" onClick={props.onClose} title="Back to conversation" aria-label="Close settings"><Icon name="chevron" className="back-chevron"/></button><div><h1>Accounts</h1><p>Provider credentials on {props.hostName}</p></div><button className="secondary-button no-drag settings-refresh" onClick={refresh} disabled={!connected || data.loading}>{data.loading ? "Refreshing…" : "Refresh"}</button></header>
    {!connected && <div className="connection-banner" role="status">This machine is disconnected. Account and login changes require reconnection.</div>}
    {data.catalogError && <div className="inline-error settings-error" role="alert">Provider registry could not be loaded: {data.catalogError}{data.catalog && " Previously loaded metadata is shown."}</div>}
    {data.loginError && <div className="inline-error settings-error" role="alert">Login status could not be loaded: {data.loginError}</div>}
    {data.catalog && <div className="account-storage"><span className="account-badge">{data.catalog.credentialLocation.mode === "broker" ? "Broker" : "Local credentials"}</span><span>{data.catalog.credentialLocation.mode === "broker" ? origin(data.catalog.credentialLocation.brokerOrigin) : props.hostName}</span><span>{providers.length} providers</span></div>}
    {!data.catalog ? <div className="center-state">{data.loading ? <><span className="spinner"/><p>Loading the host’s provider registry…</p></> : <p>{connected ? "Refresh to load the provider registry." : "Account metadata is not cached on this device."}</p>}</div> : <div className="accounts-layout">
      <aside className="provider-sidebar" aria-label="Providers"><label className="provider-search"><Icon name="search"/><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search providers" aria-label="Search providers"/></label><div className="provider-filters" aria-label="Filter providers">{(["all", "configured", "signin"] as const).map(value => <button key={value} className={filter === value ? "selected" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "signin" ? "Sign-in" : value === "all" ? "All" : "Configured"}</button>)}</div><div className="provider-list">{visible.map(provider => <button key={provider.id} className={`provider-row ${selected?.id === provider.id ? "selected" : ""}`} aria-current={selected?.id === provider.id ? "true" : undefined} onClick={() => setProviderId(provider.id)}><span className="provider-name">{provider.name}<span className={`provider-state ${provider.configured ? "configured" : ""}`} title={provider.configured ? "Configured" : "Not configured"}/></span><span className="provider-subtitle">{provider.disabledInSettings ? "Disabled in settings" : provider.configured ? "Configured" : "Not configured"} · {provider.modelCount} models</span></button>)}{!visible.length && <p className="sidebar-empty">No providers match this filter.</p>}</div></aside>
      {selected ? <ProviderDetails key={`${hostId}:${selected.id}`} {...props} provider={selected} catalog={data.catalog} data={data}/> : <div className="center-state"><p>The host returned no registered providers.</p></div>}
    </div>}
  </section>;
}

export function ProviderDetails({ provider, catalog, data, ...props }: Props & { provider: ProviderInfo; catalog: ProviderCatalog; data: AccountsState }) {
  const [keyVisible, setKeyVisible] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [activeLoginId, setActiveLoginId] = useState<string | null>(null);
  const [selection, setSelection] = useState<SessionAccountList | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const selectionVersion = useRef(0);
  const [removeId, setRemoveId] = useState<number | null>(null);
  const accounts = data.accounts.get(provider.id);
  const login = data.logins.find(login => login.loginId === activeLoginId) ?? data.logins.find(login => login.providerId === provider.id && ["running", "cancelling"].includes(login.status)) ?? data.logins.find(login => login.providerId === provider.id);
  const running = login?.status === "running" || login?.status === "cancelling";
  const loginUnavailable = provider.loginSupported && !provider.available;
  const canPin = catalog.sessionSelectionConnected && props.session?.model?.provider === provider.id;
  const writable = props.connected && !busy;
  useEffect(() => {
    let current = true; const version = selectionVersion.current;
    if (!canPin || !props.connected || !props.session) return;
    void (async () => {
      try {
        if (!props.bridge.getSessionAccounts) throw new Error("Session account details require the current desktop bridge.");
        const next = await props.bridge.getSessionAccounts(props.session!.id, props.hostId);
        if (current && selectionVersion.current === version) { setSelection(next); setSelectionError(null); }
      } catch (cause) { if (current) setSelectionError(errorMessage(cause)); }
    })();
    return () => { current = false; };
  }, [props.bridge, props.hostId, props.session?.id, props.connected, canPin, data.revision]);
  async function act(action: AccountAction): Promise<AccountActionResult | undefined> {
    if (!props.connected || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      if (!props.bridge.accountAction) throw new Error("Account actions require the current desktop bridge. Restart the app after updating.");
      const result = await props.bridge.accountAction(action, props.hostId);
      if (result.login) data.acceptLogin(result.login);
      if (result.selection) { selectionVersion.current++; setSelection(result.selection); setSelectionError(null); }
      await Promise.allSettled([data.refresh(), data.loadAccounts(provider.id)]);
      props.onChanged(); return result;
    } catch (cause) { setError(errorMessage(cause)); return undefined; }
    finally { pending.current = false; setBusy(false); }
  }
  async function startLogin() {
    const result = await act({ type: "login.start", providerId: provider.id });
    if (result?.login) setActiveLoginId(result.login.loginId);
    else if (result) setError("The host did not return a login status. Refresh before starting again.");
  }
  async function saveKey(event: React.FormEvent) {
    event.preventDefault(); if (!apiKey.trim() || !writable) return;
    const key = apiKey; setApiKey("");
    const result = await act({ type: "key.set", providerId: provider.id, key });
    if (result) setKeyVisible(false);
  }
  return <div className="provider-detail">
    <div className="provider-title"><h2>{provider.name}</h2><code>{provider.id}</code></div>
    <p className="settings-description">{authDescription(provider)}{provider.disabledInSettings ? " This provider is disabled in the host’s settings." : ""}</p>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <section className="settings-card" aria-label="Add an account"><h3>Connect an account</h3><div className="account-action-row">{provider.loginSupported && <button className="primary-button" disabled={!writable || running || loginUnavailable} onClick={() => void startLogin()}>{loginUnavailable ? "Sign-in unavailable" : running ? "Sign-in in progress" : "Sign in"}</button>}<button className="secondary-button" disabled={!writable} aria-expanded={keyVisible} onClick={() => { setKeyVisible(value => !value); setApiKey(""); }}>{keyVisible ? "Cancel API key entry" : provider.storedApiKeyConfigured ? "Replace API key" : "Add API key"}</button></div>{loginUnavailable ? <p className="settings-description">Native sign-in is unavailable for this provider on this host.</p> : !provider.loginSupported && <p className="settings-description">This registry entry does not expose a native sign-in flow.</p>}
      {keyVisible && <form className="secret-form" onSubmit={saveKey}><label className="field-label" htmlFor="provider-key">API key</label><input id="provider-key" className="text-field" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" spellCheck={false} autoCapitalize="none" data-1p-ignore data-lpignore="true" autoFocus/><p className="settings-description">Write-only entry. Saved through {catalog.credentialLocation.mode === "broker" ? "the configured broker" : props.hostName}; existing key values are never read back into this field.</p><button type="submit" className="primary-button" disabled={!writable || !apiKey.trim()}>Save API key</button></form>}
    </section>
    {login && <LoginCard key={login.loginId} login={login} provider={provider} hostName={props.hostName} remote={props.hostId !== props.localHostId} writable={writable} act={act} openExternal={url => props.bridge.openExternal(url)}/>}
    {activeLoginId && !login && !data.loading && <p className="inline-error" role="alert">The host no longer reports this login. Refresh its status before starting again.</p>}
    <section className="settings-card" aria-label="Saved accounts"><div className="settings-card-heading"><h3>Saved accounts</h3>{data.loadingAccounts.has(provider.id) && <span className="spinner" aria-label="Loading accounts"/>}</div>
      {data.accountErrors.get(provider.id) && <div className="inline-error" role="alert">Account metadata could not be loaded: {data.accountErrors.get(provider.id)}</div>}
      {accounts?.map(account => <div className="account-row" key={account.credentialId}><AccountIdentity account={account}/><div className="account-row-actions">{canPin && <button className="secondary-button" disabled={!writable || account.disabled || selection?.accounts.some(item => item.credentialId === account.credentialId && item.active)} onClick={() => void act({ type: "session.pin", sessionId: props.session!.id, credentialId: account.credentialId })}>{selection?.accounts.some(item => item.credentialId === account.credentialId && item.active) ? "Used by this session" : "Use for this session"}</button>}<button className="text-danger" disabled={!writable} onClick={() => setRemoveId(account.credentialId)}>Remove</button></div>{removeId === account.credentialId && <div className="account-remove" role="alert"><p>Remove this saved credential from {catalog.credentialLocation.mode === "broker" ? "the configured broker" : props.hostName}?</p><div><button className="secondary-button" onClick={() => setRemoveId(null)}>Cancel</button><button className="secondary-button text-danger" disabled={!writable} onClick={async () => { const result = await act({ type: "credential.remove", providerId: provider.id, credentialId: account.credentialId }); if (result) setRemoveId(null); }}>Remove credential</button></div></div>}</div>)}
      {accounts?.length === 0 && !data.accountErrors.has(provider.id) && <p className="settings-description">No saved account entries were returned for this provider.{provider.configured ? " Authentication is configured through the source shown above." : ""}</p>}
      {!accounts && !data.loadingAccounts.has(provider.id) && !data.accountErrors.has(provider.id) && <p className="settings-description">Account metadata has not been loaded.</p>}
      {selectionError && <p className="inline-error" role="alert">Session account selection could not be read: {selectionError}</p>}
      {canPin && <><p className="settings-description">Account choice applies to “{props.session?.title}”. There is no global active account.</p><button className="secondary-button" disabled={!writable} onClick={() => void act({ type: "session.release", sessionId: props.session!.id })}>Release for next native selection</button><p className="settings-description">Clears the current sticky account choice. Future selection follows the native provider behavior.</p></>}
      {!catalog.sessionSelectionConnected && <p className="settings-description">Session account selection is not connected on this host yet.</p>}
    </section>
    <details className="settings-card provider-advanced"><summary>Provider details</summary><dl><dt>Registry source</dt><dd>{provider.source}</dd><dt>Available in registry</dt><dd>{provider.available ? "Yes" : "No"}</dd><dt>Native login list</dt><dd>{provider.visibleInNativeLoginList ? "Listed" : "Not listed"}</dd><dt>Credential provider</dt><dd>{provider.storesCredentialsAs}</dd><dt>Models</dt><dd>{provider.modelCount}</dd><dt>Enabled saved credentials</dt><dd>{provider.storedCredentialCount}</dd><dt>Disabled saved credentials</dt><dd>{provider.disabledCredentialCount}</dd><dt>Stored API key</dt><dd>{provider.storedApiKeyConfigured ? "Configured" : "Not configured"}</dd><dt>Paste-code flow</dt><dd>{provider.pasteCodeFlow ? "Available when requested by the provider" : "Not exposed"}</dd>{provider.callbackPort !== undefined && <><dt>Callback port</dt><dd>{provider.callbackPort} on {props.hostName}</dd></>}<dt>Transport authentication</dt><dd>{provider.transportMayAuthenticateWithoutKey ? "May authenticate without a stored key" : "No keyless transport declared"}</dd><dt>Extension registry</dt><dd>Providers registered in this host process</dd></dl></details>
  </div>;
}

function LoginCard({ login, provider, hostName, remote, writable, act, openExternal }: { login: LoginSnapshot; provider: ProviderInfo; hostName: string; remote: boolean; writable: boolean; act(action: AccountAction): Promise<AccountActionResult | undefined>; openExternal(url: string): Promise<void> }) {
  const [openError, setOpenError] = useState<string | null>(null);
  const running = login.status === "running" || login.status === "cancelling";
  const status = { running: "Sign-in in progress", cancelling: "Cancelling sign-in…", succeeded: "Account connected", no_credentials: "Sign-in finished without saving credentials", cancelled: "Sign-in cancelled", failed: "Sign-in failed" }[login.status];
  return <section className="settings-card login-card" aria-label="Provider sign-in"><div className="settings-card-heading"><h3>{status}</h3>{running && <span className="spinner"/>}</div>{login.error && <p className="inline-error" role="alert">{login.error.message}</p>}{login.progress && <p className="settings-description" role="status">{login.progress}</p>}{login.identity && <p className="settings-description">{login.identity.email ?? login.identity.accountId ?? login.identity.orgName ?? "The host saved the provider’s credentials."}</p>}
    {running && login.auth && <><p className="settings-description">{remote ? `The browser callback belongs to ${hostName}${provider.callbackPort === undefined ? "" : ` on port ${provider.callbackPort}`}. ${provider.pasteCodeFlow ? "Use a code or redirect input only when this provider requests one below." : "This provider does not expose a paste-code flow; the callback must reach that machine."}` : "Complete the provider’s authorization flow in your browser."}</p>{login.auth.instructions && <p className="login-instructions">{login.auth.instructions}</p>}<button className="secondary-button" disabled={!writable || login.status !== "running"} onClick={async () => { setOpenError(null); try { await openExternal(login.auth!.launchUrl ?? login.auth!.url); } catch (cause) { setOpenError(errorMessage(cause)); } }}>Open sign-in page</button>{openError && <p className="inline-error" role="alert">{openError}</p>}</>}
    {running && login.prompts.map(prompt => <LoginPromptForm key={prompt.requestId} prompt={prompt} disabled={!writable || login.status !== "running"} respond={value => act({ type: "login.respond", loginId: login.loginId, requestId: prompt.requestId, response: { value } })}/>)}
    {running && <div className="login-cancel"><button className="secondary-button" disabled={!writable || login.cancellationRequested || login.status === "cancelling"} onClick={() => void act({ type: "login.cancel", loginId: login.loginId })}>{login.cancellationRequested ? "Cancellation requested" : "Cancel sign-in"}</button></div>}
  </section>;
}
export function LoginPromptForm({ prompt, disabled, respond }: { prompt: LoginPrompt; disabled: boolean; respond(value: string): Promise<unknown> }) {
  const [value, setValue] = useState("");
  return <form className="secret-form" onSubmit={event => { event.preventDefault(); if (disabled || !prompt.allowEmpty && !value) return; const response = value; setValue(""); void respond(response); }}><label className="field-label" htmlFor={`login-${prompt.requestId}`}>{prompt.message}</label><input id={`login-${prompt.requestId}`} className="text-field" type="password" value={value} onChange={event => setValue(event.target.value)} placeholder={prompt.placeholder} disabled={disabled} autoComplete="off" autoCapitalize="none" spellCheck={false} data-1p-ignore data-lpignore="true" autoFocus/><button className="primary-button" type="submit" disabled={disabled || !prompt.allowEmpty && !value}>Continue</button></form>;
}
function AccountIdentity({ account }: { account: AccountInfo }) {
  return <div className="account-identity"><strong>{account.email ?? account.orgName ?? `Account ${account.credentialId}`}</strong><span>{account.type === "oauth" ? "OAuth" : "API key"}{account.disabled ? " · Disabled" : ""}</span><details><summary>Account details</summary><dl><dt>Credential ID</dt><dd>{account.credentialId}</dd>{account.accountId && <><dt>Account ID</dt><dd>{account.accountId}</dd></>}{account.projectId && <><dt>Project ID</dt><dd>{account.projectId}</dd></>}{account.orgId && <><dt>Organization ID</dt><dd>{account.orgId}</dd></>}{account.disabledAt && <><dt>Disabled</dt><dd>{new Date(account.disabledAt).toLocaleString()}</dd></>}{account.position !== undefined && <><dt>Position</dt><dd>{account.position}</dd></>}</dl></details></div>;
}
function origin(value?: string) { if (!value) return "Configured broker"; try { return new URL(value).origin; } catch { return "Configured broker"; } }
function authDescription(provider: ProviderInfo) {
  const source = provider.authOrigin;
  if (!source) return provider.configured ? "Authentication is configured on this host." : "Authentication is not configured on this host.";
  if (source.kind === "env") return `Authentication comes from environment variable ${source.envVar ?? "configured on the host"}.`;
  if (source.commandBacked) return "Authentication comes from a configured command on the host.";
  return `Authentication source: ${{ runtime: "runtime configuration", config: "host configuration", oauth: "saved OAuth account", api_key: "saved API key", fallback: "native fallback", env: "environment" }[source.kind]}.`;
}
