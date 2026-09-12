import { useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import type { DesktopBridge, SessionSummary } from "@agent-desktop/shared";
import { SessionAccountsState } from "./session-accounts-state";

export interface SessionAccountChoicesProps { bridge: DesktopBridge; hostId: string; localHostId?: string; session: SessionSummary; connected: boolean; disabled?: boolean; refreshRevision?: number }
export function SessionAccountChoices({ bridge, hostId, localHostId, session, connected, disabled = false, refreshRevision }: SessionAccountChoicesProps) {
  const model = session.model;
  const data = useMemo(() => model ? new SessionAccountsState(bridge, hostId, session.id, { ...model }, localHostId) : undefined, [bridge, hostId, localHostId, session.id, model?.provider, model?.id]);
  const [, redraw] = useReducer(value => value + 1, 0);
  useLayoutEffect(() => {
    if (!data) return;
    const unsubscribe = data.subscribe(redraw); data.start(); data.setConnected(connected);
    return () => { unsubscribe(); data.stop(); };
  }, [data, connected]);
  useEffect(() => { if (data && connected) void data.refresh(); }, [data, connected, session.status, refreshRevision]);
  if (!data || !model) return <p role="status">Select a native session model before choosing an account.</p>;
  const writable = connected && !disabled && session.status === "idle" && !session.archived && !data.busy && !data.loading && !data.error && Boolean(data.selection?.selection);
  return <section className="session-account-choices" aria-label="Session account">
    <p>Accounts for {model.provider} · {session.title}</p><p>There is no global active account.</p>
    {!connected && <p role="status">Disconnected. Last reported accounts are shown.</p>}
    {session.status !== "idle" && <p role="status">Wait for this session to finish before switching accounts.</p>}
    {data.error && <p className="inline-error" role="alert">{data.error}</p>}
    <button type="button" className="secondary-button" disabled={!connected || data.loading || data.busy} onClick={() => void data.refresh()}>{data.loading ? "Loading accounts…" : "Refresh accounts"}</button>
    {data.selection?.accounts.map(account => <button type="button" className="session-account-choice" key={account.credentialId} aria-pressed={Boolean(account.active)} disabled={!writable || account.active} onClick={() => void data.choose(account.credentialId)}><span>{account.label ?? account.email ?? account.orgName ?? account.accountId ?? `OAuth credential #${account.credentialId}`}</span><small>{account.active ? "Used by this session" : "Use for this session"}</small></button>)}
    {data.selection?.accounts.length === 0 && <p role="status">No stored OAuth accounts for this model provider. API keys and other configured authentication follow the host’s native settings.</p>}
    {data.selection && !data.selection.selection && <p role="status">Update the owning host to safely switch accounts from this view.</p>}
    {Boolean(data.selection?.accounts.length) && <><button type="button" className="secondary-button" disabled={!writable || !data.selection?.accounts.some(account => account.active)} onClick={() => void data.choose(null)}>Release for next native selection</button><p>Clears this session’s live choice. Native routing chooses the next account; the saved preference can return on resume.</p></>}
    {data.busy && <p role="status">Applying account selection…</p>}
  </section>;
}
