import { useEffect, useRef, useState } from "react";
import type { NativeTerminalInfo, WorkspaceTarget } from "../../../../packages/shared/src/protocol";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import { nativeTerminalClient } from "./native-terminal-bridge";
import { NativeTerminalViewport } from "./NativeTerminalPanel";
import { hasNativeTerminalBridge } from "./native-terminal-state";
import { newestNativeTerminal } from "./native-terminal-state";
import { Icon } from "./Icons";
import { workspaceKey } from "./workspace-state";

/** A dock tab observes exactly one existing native pane. Mounting/restoring a tab
 * never creates, restarts, closes, or implicitly resizes its owning shell. */
export function DockTerminal(props: { bridge: DesktopBridge; hostId: string; target: WorkspaceTarget; terminalId: string; connected: boolean }) {
  if (!hasNativeTerminalBridge(props.bridge)) return <p className="terminal-notice" role="status">Update this desktop to restore native terminal tabs.</p>;
  return <DockTerminalBody {...props} client={nativeTerminalClient(props.bridge)}/>;
}
function DockTerminalBody({ client, hostId, target, terminalId, connected }: { client: ReturnType<typeof nativeTerminalClient>; hostId: string; target: WorkspaceTarget; terminalId: string; connected: boolean }) {
  const [terminal, setTerminal] = useState<NativeTerminalInfo>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const owner = `${hostId}:${workspaceKey(target)}:${terminalId}`;
  const current = useRef(owner); current.current = owner;
  useEffect(() => {
    let alive = true, loading = false;
    const read = async () => {
      if (!alive || !connected || loading) return;
      loading = true;
      try {
        const result = await client.nativeTerminalQuery({ type: "list", target }, hostId);
        if (result.type !== "list") throw new Error("The host returned an invalid terminal catalog.");
        const value = result.terminals.find(item => item.id === terminalId && workspaceKey(item.target) === workspaceKey(target));
        if (alive && current.current === owner) {
          if (value) { setTerminal(old => newestNativeTerminal(old, value)); setError(undefined); }
          else { setTerminal(undefined); setError("This terminal is no longer in its owning workspace. Closing this tab will not start a replacement shell."); }
        }
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { loading = false; }
    };
    const off = client.subscribeNativeTerminals(event => {
      if (event.hostId !== hostId) return;
      if (event.type === "state" && event.terminal.id === terminalId && workspaceKey(event.terminal.target) === workspaceKey(target)) setTerminal(old => newestNativeTerminal(old, event.terminal));
      else if (event.type === "removed" && event.terminalId === terminalId) { setTerminal(undefined); setError("This terminal was removed by its owning host."); }
    });
    void read(); const timer = setInterval(() => void read(), 5000);
    return () => { alive = false; off(); clearInterval(timer); };
  }, [client, hostId, owner, connected, refresh]);
  async function stopOrForget() {
    if(!terminal || !connected || busy) return;
    setBusy(true);setError(undefined);
    try {
      const result = await client.nativeTerminalAction({type:["starting","running","closing"].includes(terminal.status) ? "close" : "forget",terminalId},hostId);
      if(result.terminal) setTerminal(old => newestNativeTerminal(old,result.terminal!));
      else {setTerminal(undefined);setError("This stopped terminal was forgotten by its owning host.");}
    } catch(cause) {setError(cause instanceof Error ? cause.message : String(cause));}
    finally {setBusy(false);}
  }
  return <section className="terminal-panel native-terminal-panel dock-native-terminal" aria-label="Native terminal">
    {terminal && <details className="dock-terminal-actions"><summary aria-label="Terminal actions" title="Terminal actions"><Icon name="more"/></summary><div><span>{terminal.status}</span><button disabled={!connected || busy} onClick={() => void stopOrForget()}>{["starting","running","closing"].includes(terminal.status) ? "Stop shell for all viewers" : "Forget stopped terminal"}</button></div></details>}
    {error && <p className="terminal-notice error" role="alert">{error}<button disabled={!connected} onClick={() => setRefresh(value => value + 1)}>Retry</button></p>}
    {!connected && <p className="terminal-notice">Offline · reconnect to use this terminal.</p>}
    {terminal ? <NativeTerminalViewport key={owner} bridge={client} hostId={hostId} terminal={terminal} connected={connected} embedded/> : !error && <p className="terminal-notice" role="status">{connected ? "Restoring terminal…" : "Terminal details are unavailable offline."}</p>}
  </section>;
}
