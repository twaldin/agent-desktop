import { useEffect, useMemo, useReducer, useState } from 'react';
import type { DesktopBridge } from '@agent-desktop/shared';
import { LoginPromptForm } from './AccountsSettings';
import { McpAuthorizationState } from './mcp-authorization-state';

export function useMcpAuthorization(bridge: DesktopBridge, hostId: string, sessionId: string, connected: boolean) {
  const state = useMemo(() => new McpAuthorizationState(bridge, hostId, sessionId, localStorage), [bridge, hostId, sessionId]);
  const [, redraw] = useReducer(value => value + 1, 0);
  useEffect(() => { state.activate(); const unsubscribe = state.subscribe(redraw); return () => { unsubscribe(); state.dispose(); }; }, [state]);
  useEffect(() => {
    if (!connected) return;
    void state.read();
    const timer = window.setInterval(() => void state.read(), 2000);
    return () => window.clearInterval(timer);
  }, [state, connected]);
  return state;
}

export function SessionMcpAuthorization({ state, connected }: { state: McpAuthorizationState; connected: boolean }) {
  const [openError, setOpenError] = useState<string | null>(null);
  const value = state.value;
  const running = value?.status === 'running' || value?.status === 'cancelling';
  const writable = connected && !state.writing && value?.status === 'running';
  const login = value?.login;
  if (!state.supported) return null;
  return <>
    {state.error && <p className="inline-error" role="status">{state.error}</p>}
    {(state.pending || state.error || state.sent) && <button type="button" className="secondary-button" disabled={!connected || state.writing} onClick={() => void state.read()}>Check authorization status</button>}
    {value && <section className="settings-card login-card" aria-label={`${value.serverName} authorization`}>
      <div className="settings-card-heading"><h3>{value.serverName} · {{ running: 'Sign-in in progress', cancelling: 'Cancelling sign-in…', succeeded: 'Server connected', failed: 'Connection incomplete', cancelled: 'Sign-in cancelled' }[value.status]}</h3>{running && <span className="spinner" aria-label="Authorization in progress"/>}</div>
      {value.error && <p className="inline-error" role="alert">{value.error}</p>}
      {running && login?.progress && <p className="settings-description" role="status">{login.progress}</p>}
      {value.credentialsStored && !value.reconnected && <p className="settings-description">Credentials saved. {running ? 'Finishing the server connection…' : 'The server has not reconnected.'}</p>}
      {value.credentialWrite === 'unknown' && <p className="inline-error" role="status">The credential write could not be confirmed. Inspect the owning host before starting again.</p>}
      {value.configuration === 'unknown' && <p className="inline-error" role="status">The configuration write could not be confirmed.</p>}
      {running && login?.auth && <>
        <p className="settings-description">Complete authorization in your browser. The callback belongs to this session’s host; paste a redirect or code only when requested below.</p>
        {login.auth.instructions && <p className="login-instructions">{login.auth.instructions}</p>}
        <button type="button" className="secondary-button" disabled={!writable} onClick={async () => { setOpenError(null); try { await state.bridge.openExternal(login.auth!.url); } catch { setOpenError('The authorization page could not be opened.'); } }}>Open sign-in page</button>
        {openError && <p className="inline-error" role="alert">{openError}</p>}
      </>}
      {running && login?.prompts.map(prompt => {
        const sent = state.sent?.authorizationId === value.authorizationId && state.sent.requestId === prompt.requestId;
        return <div key={`${value.authorizationId}:${prompt.requestId}`}>
          <LoginPromptForm prompt={prompt} disabled={!writable || state.responseBlocked || Boolean(state.sent)} respond={text => state.respond({authorizationId:value.authorizationId,requestId:prompt.requestId,response:{value:text}})}/>
          {sent && <p className="settings-description" role="status">Response submitted. Waiting for the host to confirm this prompt was resolved.</p>}
        </div>;
      })}
      {running && <div className="login-cancel"><button type="button" className="secondary-button" disabled={!writable || login?.cancellationRequested} onClick={() => void state.cancel()}>{value.status === 'cancelling' || login?.cancellationRequested ? 'Cancellation requested' : 'Cancel sign-in'}</button></div>}
    </section>}
  </>;
}

/** The callback must remain reachable while a native slash command is waiting,
 * without requiring the user to leave the conversation and find settings. */
export function PendingMcpAuthorization({bridge,hostId,sessionId,connected}: {bridge:DesktopBridge;hostId:string;sessionId:string;connected:boolean}) {
  const state = useMcpAuthorization(bridge,hostId,sessionId,connected);
  const [dismissed,setDismissed] = useState<string|null>(null);
  const value=state.value;
  const [observed,setObserved] = useState<string|null>(null);
  const active=value?.status==='running'||value?.status==='cancelling';
  useEffect(()=>{if(active&&value)setObserved(value.authorizationId);},[active,value?.authorizationId]);
  if (!value || dismissed===value.authorizationId || !active&&observed!==value.authorizationId) return null;
  return <div className="pending-mcp-authorization" aria-label="MCP sign-in request">
    {!connected && <p className="connection-banner" role="status">Reconnect to this session’s host to continue sign-in.</p>}
    <SessionMcpAuthorization key={value.authorizationId} state={state} connected={connected}/>
    {!active && <button type="button" className="secondary-button" onClick={()=>setDismissed(value.authorizationId)}>Dismiss sign-in result</button>}
  </div>;
}
