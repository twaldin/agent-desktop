import { useEffect, useRef, useState } from "react";
import type { NativeTerminalHistory, NativeTerminalInfo } from "../../../../packages/shared/src/terminals";
import type { NativeTerminalClient } from "./native-terminal-bridge";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace";
import { Icon } from "./Icons";
import { newestNativeTerminal } from "./native-terminal-state";
import type { NativeTerminalView, NativeTerminalViewState } from "./native-terminal-view";
import "./native-terminal-panel.css";

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const targetKey = (target: WorkspaceTarget) => "projectId" in target ? `project:${target.projectId}` : `session:${target.sessionId}`;
const running = (terminal: NativeTerminalInfo) => ["starting", "running", "closing"].includes(terminal.status);
export function NativeTerminalPanel({ bridge, target, hostId, connected, onClose }: { bridge: NativeTerminalClient; target: WorkspaceTarget; hostId: string; connected: boolean; onClose(): void }) {
  const key = targetKey(target), storageKey = `terminal.native.selected.${hostId}.${key}`;
  const [terminals, setTerminals] = useState<NativeTerminalInfo[]>([]), [selected, setSelected] = useState<string | undefined>(() => { try { return localStorage.getItem(storageKey) ?? undefined; } catch { return; } });
  const [error, setError] = useState<string>(), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const latest = useRef({ target, connected }); latest.current = { target, connected };
  useEffect(() => { if (selected) { try { localStorage.setItem(storageKey, selected); } catch { /* Retain in-memory selection. */ } } }, [selected, storageKey]);
  useEffect(() => {
    let alive = true, loading = false, again = false;
    const load = async () => {
      if (!alive || !latest.current.connected) return;
      if (loading) { again = true; return; }
      loading = true; setLoading(true);
      do {
        again = false;
        try {
          const result = await bridge.nativeTerminalQuery({ type: "list", target: latest.current.target }, hostId);
          if (result.type !== "list") throw new Error("The host returned an invalid native terminal catalog.");
          if (alive) { setTerminals(current => result.terminals.map(terminal => newestNativeTerminal(current.find(item => item.id === terminal.id), terminal))); setSelected(current => result.terminals.some(item => item.id === current) ? current : result.terminals[0]?.id); setError(undefined); }
        } catch (cause) { if (alive) setError(errorText(cause)); }
      } while (again && alive && latest.current.connected);
      loading = false; if (alive) setLoading(false);
    };
    const off = bridge.subscribeNativeTerminals(event => {
      if (event.hostId !== hostId) return;
      if (event.type === "removed") { setTerminals(current => current.filter(item => item.id !== event.terminalId)); void load(); }
      else if (event.type === "state" && targetKey(event.terminal.target) === key) setTerminals(current => current.some(item => item.id === event.terminal.id) ? current.map(item => item.id === event.terminal.id ? newestNativeTerminal(item, event.terminal) : item) : [...current, event.terminal]);
    });
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { alive = false; off(); clearInterval(timer); };
  }, [bridge, hostId, key, connected, refresh]);
  const create = async () => {
    setBusy(true); setError(undefined);
    try {
      const result = await bridge.nativeTerminalAction({ type: "create", options: { target, cols: 120, rows: 30 } }, hostId);
      if (!result.terminal) throw new Error("The host did not return the created pane.");
      setTerminals(current => [...current.filter(item => item.id !== result.terminal!.id), result.terminal!]); setSelected(result.terminal.id);
    } catch (cause) { setError(`Terminal creation was not confirmed: ${errorText(cause)} Refresh the catalog before trying again.`); }
    finally { setBusy(false); }
  };
  const stop = async (terminal: NativeTerminalInfo) => {
    setBusy(true); setError(undefined);
    try {
      const result = await bridge.nativeTerminalAction({ type: running(terminal) ? "close" : "forget", terminalId: terminal.id }, hostId);
      if (result.terminal) setTerminals(current => current.map(item => item.id === terminal.id ? result.terminal! : item));
      else if (!running(terminal)) setTerminals(current => current.filter(item => item.id !== terminal.id));
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };
  const active = terminals.find(item => item.id === selected) ?? terminals[0];
  return <section className="terminal-panel native-terminal-panel" aria-label="Workspace terminals">
    <header className="terminal-panel-header"><Icon name="terminal"/><strong>Terminal</strong><span className="terminal-connection">{connected ? "Connected" : "Offline"} · tmux</span><div className="terminal-panel-actions"><button className="icon-button small" aria-label="New terminal" title="New terminal" disabled={!connected || busy} onClick={() => void create()}><Icon name="plus"/></button><button className="icon-button small" aria-label="Refresh terminals" disabled={!connected || loading} onClick={() => setRefresh(value => value + 1)}><Icon name="refresh"/></button><button className="icon-button small" aria-label="Hide terminal panel" title="Hide panel; keep panes running" onClick={onClose}><Icon name="close"/></button></div></header>
    {terminals.length > 0 && <div className="terminal-tabs" role="tablist" aria-label="Terminal sessions">{terminals.map((terminal, index) => <div className={`terminal-tab ${active?.id === terminal.id ? "selected" : ""}`} key={terminal.id}><button role="tab" id={`native-terminal-tab-${terminal.id}`} aria-controls={`native-terminal-view-${terminal.id}`} aria-selected={active?.id === terminal.id} onClick={() => setSelected(terminal.id)} title={terminal.cwd}>{terminal.shell} {index + 1}{terminal.status !== "running" && <small>{terminal.status === "exited" ? `Exit ${terminal.exitCode ?? "–"}` : terminal.status}</small>}</button><button className="terminal-tab-close" aria-label={running(terminal) ? `Close shell ${index + 1}` : `Forget terminal ${index + 1}`} title={running(terminal) ? "Stop this shell for every viewer" : "Forget stopped terminal"} disabled={!connected || busy} onClick={() => void stop(terminal)}><Icon name={running(terminal) ? "stop" : "close"}/></button></div>)}</div>}
    {error && <p className="terminal-notice error" role="alert">{error}</p>}
    {!connected && <p className="terminal-notice">Offline · input is disabled. Reconnecting restores a fresh view of the same pane.</p>}
    {!active ? <div className="terminal-empty"><Icon name="terminal"/><p>{loading ? "Loading terminals…" : "Open a shell in this workspace."}</p><button className="secondary-button" disabled={!connected || busy || loading} onClick={() => void create()}>{busy ? "Starting…" : "New terminal"}</button></div>
      : <NativeTerminalViewport key={`${hostId}:${active.id}`} bridge={bridge} hostId={hostId} terminal={active} connected={connected}/>}
  </section>;
}

function NativeTerminalViewport({ bridge, hostId, terminal, connected }: { bridge: NativeTerminalClient; hostId: string; terminal: NativeTerminalInfo; connected: boolean }) {
  const element = useRef<HTMLDivElement>(null), handle = useRef<NativeTerminalView | undefined>(undefined);
  const current = useRef({ terminal, connected }); current.current = { terminal, connected };
  const [state, setState] = useState<NativeTerminalViewState>({ terminal, ready: false, restoring: running(terminal), inputPaused: false, inputBusy: false, hasSelection: false });
  const [history, setHistory] = useState<NativeTerminalHistory>(), [historyOpen, setHistoryOpen] = useState(false), [historyError, setHistoryError] = useState<string>(), [historyBusy, setHistoryBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void import("./native-terminal-view").then(({ NativeTerminalView }) => { if (alive && element.current) handle.current = new NativeTerminalView(element.current, bridge, hostId, current.current.terminal, current.current.connected, setState); }).catch(cause => { if (alive) setState(value => ({ ...value, error: errorText(cause), restoring: false })); });
    return () => { alive = false; handle.current?.dispose(); handle.current = undefined; };
  }, [bridge, hostId, terminal.id]);
  useEffect(() => { handle.current?.setConnected(connected); }, [connected]);
  useEffect(() => { handle.current?.updateTerminal(terminal); }, [terminal.status, terminal.geometryRevision, terminal.inputEpoch, terminal.serverGeneration, terminal.attachable]);
  const loadHistory = async () => {
    setHistoryOpen(true); setHistoryBusy(true); setHistoryError(undefined);
    try { const result = await bridge.nativeTerminalQuery({ type: "history", terminalId: terminal.id }, hostId); if (result.type !== "history") throw new Error("Invalid terminal history response."); setHistory(result.history); }
    catch (cause) { setHistoryError(errorText(cause)); }
    finally { setHistoryBusy(false); }
  };
  return <div className="terminal-view native-terminal-view" role="tabpanel" id={`native-terminal-view-${terminal.id}`} aria-labelledby={`native-terminal-tab-${terminal.id}`}>
    {state.restoring && <p className="terminal-notice" role="status">Attaching to the native pane…</p>}
    {(state.error || state.inputError) && <div className="terminal-view-notices">{state.error && <p className="terminal-notice error" role="alert">{state.error}</p>}{state.inputError && <p className="terminal-notice error" role="alert">{state.inputError}{state.inputPaused && <button className="secondary-button" disabled={!connected || state.inputBusy || !state.ready} onClick={() => handle.current?.resumeInput()}>Resume input</button>}</p>}</div>}
    <div className="native-terminal-scrollport" hidden={historyOpen}><div className="native-terminal-grid" ref={element}/></div>
    {historyOpen && <div className="native-terminal-history"><div className="native-terminal-history-toolbar"><strong>Native scrollback</strong><button className="secondary-button" onClick={() => { setHistoryOpen(false); handle.current?.focus(); }}>Return to terminal</button><button disabled={!connected || historyBusy} onClick={() => void loadHistory()}>Refresh history</button></div><p className="terminal-notice">{historyBusy ? "Reading native history…" : history?.live ? "Read-only capture from the live pane." : "Read-only saved history; the owning pane is no longer live."}{history?.truncated ? " The capture is bounded; older lines may be omitted." : ""}</p>{historyError && <p className="terminal-notice error" role="alert">{historyError}</p>}<div className="native-terminal-history-content"><pre tabIndex={0} aria-label="Native scrollback text">{history?.history ?? ""}</pre>{history?.screen !== undefined && <><p className="terminal-notice">Captured screen</p><pre tabIndex={0} aria-label="Captured native screen">{history.screen}</pre></>}{history?.savedNormalScreen && <><p className="terminal-notice">Saved normal screen</p><pre tabIndex={0} aria-label="Saved normal screen">{history.savedNormalScreen}</pre></>}</div></div>}
    <footer className="terminal-view-footer"><span className="truncate" title={terminal.cwd}>{terminal.cwd}</span><span title="Shared accepted grid for every viewer">{state.terminal.cols}×{state.terminal.rows}</span><button disabled={!connected || !state.ready || state.terminal.status !== "running"} onClick={() => void handle.current?.usePanelSize()} title="Resize the shared pane for all viewers">Use this panel’s size</button><button disabled={!state.hasSelection} onClick={() => handle.current?.copySelection()}>Copy selection</button><button disabled={!connected || historyBusy} onClick={() => void loadHistory()}>History</button><button disabled={!connected} onClick={() => handle.current?.refresh()}>Refresh output</button></footer>
    {!running(state.terminal) && <p className="terminal-notice">{state.terminal.status === "interrupted" ? "The owning terminal was interrupted. Its saved history remains available." : `Shell ${state.terminal.status}${state.terminal.exitCode === undefined ? "" : ` with code ${state.terminal.exitCode}`}.`}</p>}{state.terminal.error && <p className="terminal-notice error" role="alert">{state.terminal.error}</p>}
  </div>;
}
