import { useEffect, useRef, useState } from "react";
import type { DesktopBridge, NativeSessionMcpSnapshot, WorkspaceTarget } from "@agent-desktop/shared";
import { Icon } from "./Icons";
import { matchesMcpServer, SessionMcpDetails } from "./SessionMcpDetails";

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "The owning host could not read native MCP state."; }
export function SessionMcp({ bridge, hostId, sessionId, connected, idle = false, mutationPending = false, query = "", target, onBack }: { bridge: DesktopBridge; hostId: string; sessionId: string; connected: boolean; idle?: boolean; mutationPending?: boolean; query?: string; target?: WorkspaceTarget; onBack?(): void }) {
  const [snapshot, setSnapshot] = useState<NativeSessionMcpSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0), writing = useRef(false), readRevision = useRef(0);
  const storageKey = `mcp.reload.${hostId}.${sessionId}`;
  const targetKey = JSON.stringify(target);
  useEffect(() => {
    const current = ++generation.current;
    let alive = true, reading = false;
    let pendingId: string | null = null;
    try { pendingId = localStorage.getItem(storageKey); } catch { /* Reload refuses if its durable marker cannot be written. */ }
    setPending(pendingId); setSnapshot(null); setUnavailable(null); setCommandError(null); setReloading(false); setReconnecting(null); writing.current=false;
    const read = async () => {
      if (!alive || !connected || writing.current || mutationPending || reading) return;
      if (!bridge.getSessionMcp) { setUnavailable('This desktop cannot read live MCP state.'); setLoading(false); return; }
      reading=true;
      const revision=++readRevision.current;
      try {
        const value=await bridge.getSessionMcp(sessionId,hostId,pendingId ?? undefined);
        if (!alive || current!==generation.current || revision!==readRevision.current) return;
        setSnapshot(value.value); setUnavailable(value.unavailable ?? null);
        if (value.receipt) {
          if (value.receipt.state==='succeeded' || value.receipt.state==='failed') {
            try { localStorage.removeItem(storageKey); } catch { setCommandError('Could not clear the saved MCP receipt.'); return; }
            pendingId=null; setPending(null);
            setCommandError(value.receipt.state==='failed' ? value.receipt.message ?? 'Native MCP operation failed.' : null);
          } else setCommandError(value.receipt.state==='pending' ? 'Waiting for the original MCP operation to finish.' : 'The previous MCP operation outcome is unconfirmed. It has not been replayed. Inspect the owning host before starting another MCP operation.');
        }
      } catch(error) {
        if(alive && current===generation.current && revision===readRevision.current) {setSnapshot(null);setUnavailable(errorMessage(error));}
      } finally {
        reading=false;
        if(alive && current===generation.current) setLoading(false);
      }
    };
    setLoading(connected); void read();
    const timer=window.setInterval(()=>void read(),2000);
    return ()=>{alive=false;generation.current++;readRevision.current++;window.clearInterval(timer);};
  },[bridge,hostId,sessionId,connected,targetKey,mutationPending,refresh]);
  const mutate = async (serverName?: string) => {
    if (!connected || !idle || mutationPending || unavailable || !snapshot?.available || writing.current || pending) return;
    if (serverName !== undefined && (!snapshot.canReconnect || !snapshot.servers.some(server => server.name === serverName))) return;
    const current=generation.current, id=crypto.randomUUID();
    try { localStorage.setItem(storageKey,id); } catch {setCommandError('Cannot preserve an MCP receipt on this device. No operation was sent.');return;}
    writing.current=true;readRevision.current++;setReloading(serverName === undefined);setReconnecting(serverName ?? null);setPending(id);setCommandError(null);
    try {
      const result=await bridge.command({id,command:serverName === undefined ? {type:'session.mcp.reload',sessionId,epoch:snapshot.epoch,expectedRevision:snapshot.revision} : {type:'session.mcp.reconnect',sessionId,epoch:snapshot.epoch,expectedRevision:snapshot.revision,serverName}},hostId);
      if(current!==generation.current)return;
      if(result.commandId!==id)throw new Error('The host returned another command receipt.');
      if(!result.ok)throw new Error(result.error.message);
      if(!result.value || !('type' in result.value) || result.value.type!=='session.mcp')throw new Error('The host returned no native MCP operation snapshot.');
      setSnapshot(result.value.snapshot);
    } catch(error) {if(current===generation.current)setCommandError(errorMessage(error));}
    finally {
      if(current===generation.current){writing.current=false;setReloading(false);setReconnecting(null);setRefresh(value=>value+1);}
    }
  };
  return <section className="session-mcp" aria-label="Live MCP servers">
    {onBack && <button className="integration-back" type="button" onClick={onBack}><Icon name="browserBack"/> MCP servers</button>}
    <div className="integration-list-heading"><div><h2>Live MCP servers</h2><p className="integration-note">Native state for this session. Reload to apply saved configuration to this idle session.</p></div><button className="secondary-button" type="button" disabled={!connected || !idle || mutationPending || Boolean(unavailable) || !snapshot?.available || reloading || Boolean(pending)} onClick={() => void mutate()}>{reloading ? "Reloading…" : "Reload servers"}</button></div>
    {commandError && <p className="inline-error" role="status">{commandError}</p>}
    {pending && !reloading && !reconnecting && <button className="secondary-button" disabled={!connected} onClick={()=>setRefresh(value=>value+1)}>Check MCP result</button>}
    {!connected && <p className="connection-banner" role="status">This machine is disconnected. Reconnect to read live MCP state.</p>}
    {loading && <p role="status">Reading native MCP state…</p>}
    {unavailable && <p className="inline-error" role="alert">{unavailable} Refresh session state before changing native connections.</p>}
    {!loading && !unavailable && !snapshot && <p className="integration-note" role="status">Live MCP state has not been measured for this session.</p>}
    {snapshot && !snapshot.available && <p className="integration-note" role="status">{snapshot.reason ?? "Live MCP state is unavailable for this session."}</p>}
    {snapshot?.available && !snapshot.servers.length && <p className="integration-note">No native MCP servers are registered for this session.</p>}
    {snapshot?.available && snapshot.servers.filter(server=>matchesMcpServer(server,query)).map(server => <article className="session-mcp-row" key={server.name}><div className="session-mcp-body"><strong>{server.name}</strong><small>{server.source} · {server.status}</small>{server.error && <p className="inline-error">{server.error}</p>}{server.tools.length>0 && <details><summary><Icon name="chevron"/>Tools</summary><ul>{server.tools.map(name=><li key={name}>{name}</li>)}</ul></details>}<SessionMcpDetails server={server}/></div><div className="session-mcp-counts"><span>{server.tools.length} {server.tools.length===1?"tool":"tools"}</span><span>{server.resourceCount === null ? "Resources unmeasured" : `${server.resourceCount} ${server.resourceCount===1?"resource":"resources"}`}</span><span>{server.promptCount === null ? "Prompts unmeasured" : `${server.promptCount} ${server.promptCount===1?"prompt":"prompts"}`}</span><button className="secondary-button" type="button" aria-label={`Reconnect ${server.name}`} title={snapshot.canReconnect ? undefined : "This host does not expose native reconnect yet."} disabled={!snapshot.canReconnect || !connected || !idle || mutationPending || Boolean(unavailable) || Boolean(pending)} onClick={()=>void mutate(server.name)}>{reconnecting===server.name ? "Reconnecting…" : "Reconnect"}</button></div></article>)}
  </section>;
}
