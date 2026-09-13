import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { NativeTerminalHistory, NativeTerminalInfo } from "../../../../packages/shared/src/terminals";
import type { NativeTerminalClient } from "./native-terminal-bridge";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace";
import { Icon } from "./Icons";
import { newestNativeTerminal } from "./native-terminal-state";
import type { NativeTerminalView, NativeTerminalViewState } from "./native-terminal-view";
import { activeNativeHistoryMatch, findNativeHistory, stepNativeHistoryMatch, type NativeHistorySelection } from "./native-terminal-history-find";
import "@xterm/xterm/css/xterm.css";
import "./terminal-panel.css";
import "./native-terminal-panel.css";

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
type TerminalWorkspaceTarget = Exclude<WorkspaceTarget, { filePath: string }>;
const targetKey = (target: TerminalWorkspaceTarget) => "projectId" in target ? `project:${target.projectId}` : `session:${target.sessionId}`;
const running = (terminal: NativeTerminalInfo) => ["starting", "running", "closing"].includes(terminal.status);
export function NativeTerminalPanel({ bridge, target, hostId, connected, onClose }: { bridge: NativeTerminalClient; target: TerminalWorkspaceTarget; hostId: string; connected: boolean; onClose(): void }) {
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
      else if (event.type === "state" && !("filePath" in event.terminal.target) && targetKey(event.terminal.target) === key) setTerminals(current => current.some(item => item.id === event.terminal.id) ? current.map(item => item.id === event.terminal.id ? newestNativeTerminal(item, event.terminal) : item) : [...current, event.terminal]);
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
      : <NativeTerminalViewport key={`${hostId}:${active.id}`} bridge={bridge} hostId={hostId} terminal={active} connected={connected} onNewTerminal={() => { if (connected && !busy) void create(); }}/>}
  </section>;
}

type NativeHistoryRead = { owner: string; capture?: NativeTerminalHistory; busy: boolean; error?: string };

export function NativeTerminalViewport({ bridge, hostId, terminal, connected, embedded = false, onNewTerminal }: { bridge: NativeTerminalClient; hostId: string; terminal: NativeTerminalInfo; connected: boolean; embedded?: boolean; onNewTerminal?(): void }) {
  const element = useRef<HTMLDivElement>(null), handle = useRef<NativeTerminalView | undefined>(undefined);
  const current = useRef({ terminal, connected }); current.current = { terminal, connected };
  const [state, setState] = useState<NativeTerminalViewState>({ terminal, ready: false, restoring: running(terminal), inputPaused: false, inputBusy: false, hasSelection: false });
  const historyOwner = JSON.stringify([hostId, terminal.id]), historyOwnerRef = useRef(historyOwner), historyRequest = useRef(0);
  historyOwnerRef.current = historyOwner;
  const [historyRead, setHistoryRead] = useState<NativeHistoryRead>({ owner: historyOwner, busy: false }), [historyOpen, setHistoryOpen] = useState(false);
  const ownedHistory = historyRead.owner === historyOwner ? historyRead : undefined;
  const history = ownedHistory?.capture, historyError = ownedHistory?.error, historyBusy = ownedHistory?.busy ?? false;
  useEffect(() => {
    let alive = true;
    void import("./native-terminal-view").then(({ NativeTerminalView }) => { if (alive && element.current) handle.current = new NativeTerminalView(element.current, bridge, hostId, current.current.terminal, current.current.connected, setState); }).catch(cause => { if (alive) setState(value => ({ ...value, error: errorText(cause), restoring: false })); });
    return () => { alive = false; handle.current?.dispose(); handle.current = undefined; };
  }, [bridge, hostId, terminal.id]);
  useEffect(() => { handle.current?.setConnected(connected); }, [connected]);
  useEffect(() => { handle.current?.updateTerminal(terminal); }, [terminal.status, terminal.geometryRevision, terminal.inputEpoch, terminal.serverGeneration, terminal.attachable]);
  useEffect(() => {
    historyRequest.current++; setHistoryRead({ owner: historyOwner, busy: false }); setHistoryOpen(false);
    return () => { historyRequest.current++; };
  }, [bridge, historyOwner]);
  useEffect(() => {
    if (!connected) {
      historyRequest.current++;
      setHistoryRead(value => value.owner === historyOwner ? { ...value, busy: false } : value);
    }
  }, [connected, historyOwner]);
  const loadHistory = async () => {
    if (!current.current.connected || historyOwnerRef.current !== historyOwner) return;
    const request = ++historyRequest.current;
    const stillOwned = () => request === historyRequest.current && historyOwnerRef.current === historyOwner && current.current.connected;
    setHistoryOpen(true);
    setHistoryRead(value => ({ owner: historyOwner, capture: value.owner === historyOwner ? value.capture : undefined, busy: true }));
    try {
      const result = await bridge.nativeTerminalQuery({ type: "history", terminalId: terminal.id }, hostId);
      if (!stillOwned()) return;
      if (result.type !== "history" || result.history.terminalId !== terminal.id) throw new Error("Invalid terminal history response.");
      setHistoryRead({ owner: historyOwner, capture: result.history, busy: false });
    } catch (cause) {
      if (stillOwned()) setHistoryRead(value => ({ owner: historyOwner, capture: value.owner === historyOwner ? value.capture : undefined, busy: false, error: errorText(cause) }));
    }
  };
  return <div className="terminal-view native-terminal-view" role={embedded ? undefined : "tabpanel"} id={`native-terminal-view-${terminal.id}`} aria-labelledby={embedded ? undefined : `native-terminal-tab-${terminal.id}`} onKeyDownCapture={event => {
    if (!onNewTerminal || event.nativeEvent.isComposing || event.key !== "t" || !event.metaKey || event.altKey || event.ctrlKey || event.shiftKey
      || !(event.target instanceof Element) || !event.target.closest(".xterm")) return;
    event.preventDefault(); event.stopPropagation(); onNewTerminal();
  }}>
    {state.restoring && <p className="terminal-notice" role="status">Attaching to the native pane…</p>}
    {(state.error || state.inputError) && <div className="terminal-view-notices">{state.error && <p className="terminal-notice error" role="alert">{state.error}</p>}{state.inputError && <p className="terminal-notice error" role="alert">{state.inputError}{state.inputPaused && <button className="secondary-button" disabled={!connected || state.inputBusy || !state.ready} onClick={() => handle.current?.resumeInput()}>Resume input</button>}</p>}</div>}
    <div className="native-terminal-scrollport" hidden={historyOpen}><div className="native-terminal-grid" ref={element}/></div>
    {historyOpen && <NativeTerminalHistoryCapture key={historyOwner} hostId={hostId} capture={history} busy={historyBusy} error={historyError} connected={connected} serverGeneration={terminal.serverGeneration} onRefresh={() => void loadHistory()} onReturn={() => { setHistoryOpen(false); handle.current?.focus(); }}/>}
    <footer className="terminal-view-footer"><span className="truncate" title={terminal.cwd}>{terminal.cwd}</span><span title="Shared accepted grid for every viewer">{state.terminal.cols}×{state.terminal.rows}</span><button disabled={!connected || !state.ready || state.terminal.status !== "running"} onClick={() => void handle.current?.usePanelSize()} title="Resize the shared pane for all viewers">Use this panel’s size</button><button disabled={!state.hasSelection} onClick={() => handle.current?.copySelection()}>Copy selection</button><button disabled={!connected || historyBusy} onClick={() => void loadHistory()}>History</button><button disabled={!connected} onClick={() => handle.current?.refresh()}>Refresh output</button></footer>
    {!running(state.terminal) && <p className="terminal-notice">{state.terminal.status === "interrupted" ? "The owning terminal was interrupted. Its saved history remains available." : `Shell ${state.terminal.status}${state.terminal.exitCode === undefined ? "" : ` with code ${state.terminal.exitCode}`}.`}</p>}{state.terminal.error && <p className="terminal-notice error" role="alert">{state.terminal.error}</p>}
  </div>;
}

function NativeTerminalHistoryCapture({ hostId, capture, busy, error, connected, serverGeneration, onRefresh, onReturn }: {
  hostId: string; capture?: NativeTerminalHistory; busy: boolean; error?: string; connected: boolean; serverGeneration: string;
  onRefresh(): void; onReturn(): void;
}) {
  const [findOpen, setFindOpen] = useState(false), [query, setQuery] = useState(""), [selection, setSelection] = useState<NativeHistorySelection>();
  const opener = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null), activeElement = useRef<HTMLElement>(null), findId = useId();
  const search = useMemo(() => capture ? findNativeHistory(hostId, capture, query) : undefined, [hostId, capture, query]);
  const active = search && findOpen ? activeNativeHistoryMatch(search, selection) : undefined;
  useEffect(() => { activeElement.current?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [active?.key, active?.index]);
  const closeFind = () => { setFindOpen(false); setQuery(""); setSelection(undefined); opener.current?.focus(); };
  const move = (direction: 1 | -1) => { if (search) setSelection(stepNativeHistoryMatch(search, selection, direction)); };
  const sectionLabel = search?.sections.find(section => section.id === active?.section)?.label;
  return <div className="native-terminal-history" aria-busy={busy} data-history-generation={capture?.serverGeneration} data-history-revision={capture?.revision} data-history-captured-at={capture?.capturedAt} onKeyDown={event => {
    if (!findOpen || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeFind(); }
    else if (event.target === input.current && event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1);
    }
  }}>
    <div className="native-terminal-history-toolbar">
      <strong>Native scrollback</strong>
      <button type="button" ref={opener} disabled={!capture} aria-expanded={findOpen} aria-controls={findId} onClick={() => { if (findOpen) closeFind(); else setFindOpen(true); }}><Icon name="search"/>Find</button>
      <button type="button" className="secondary-button" onClick={onReturn}>Return to terminal</button>
      <button type="button" disabled={!connected || busy} onClick={onRefresh}>Refresh history</button>
    </div>
    {findOpen && <div id={findId} className="native-terminal-history-find" role="search" aria-label="Find in native history">
      <input ref={input} autoFocus type="search" aria-label="Find in captured terminal text" aria-describedby={`${findId}-status`} placeholder="Find in captured text" title="Literal text, case-insensitive" value={query} onChange={event => { setQuery(event.target.value); setSelection(undefined); }}/>
      <button type="button" disabled={!search?.total} aria-label="Previous match" title="Previous match (Shift Enter in Find)" onClick={() => move(-1)}>Previous</button>
      <button type="button" disabled={!search?.total} aria-label="Next match" title="Next match (Enter in Find)" onClick={() => move(1)}>Next</button>
      <button type="button" disabled={query === ""} onClick={() => { setQuery(""); setSelection(undefined); input.current?.focus(); }}>Clear</button>
      <button type="button" className="icon-button" aria-label="Close Find" title="Close Find (Escape)" onClick={closeFind}><Icon name="close"/></button>
      <span id={`${findId}-status`} className="native-terminal-history-find-status" role="status" aria-live="polite" aria-atomic="true">{query === "" ? "Enter text to find" : !active ? "No matches in this capture" : `${active.index + 1} of ${search?.total} matches · ${sectionLabel}`}</span>
    </div>}
    <p className="terminal-notice">{busy ? `Reading native history…${capture ? " Showing the previous capture until refresh completes." : ""}` : capture ? capture.live ? "Read-only capture from the live pane." : "Read-only saved history; the owning pane is no longer live." : "No native history capture has been loaded."}{capture?.truncated ? " The capture is bounded; older lines may be omitted." : ""}</p>
    {capture && <p className="terminal-notice native-terminal-history-capture" title={`Server generation ${capture.serverGeneration}; revision ${capture.revision}`}>Captured {new Date(capture.capturedAt).toLocaleString()} · Revision {capture.revision}</p>}
    {!connected && <p className="terminal-notice" role="status">Owning host offline. Find searches only the last captured text; reconnect to refresh.</p>}
    {capture && capture.serverGeneration !== serverGeneration && <p className="terminal-notice" role="status">The terminal generation changed. This is the previous capture; refresh to read the current owner.</p>}
    {error && <p className="terminal-notice error" role="alert">{error}{capture ? " The previous capture is retained." : ""}</p>}
    <div className="native-terminal-history-content">{search?.sections.map(section => <div key={section.id}>
      {section.id !== "history" && <p className="terminal-notice">{section.id === "screen" ? "Captured screen" : "Saved normal screen"}</p>}
      <pre tabIndex={0} aria-label={section.label}>{active?.section === section.id ? <>{section.text.slice(0, active.start)}<mark className="native-terminal-history-match" ref={activeElement} aria-current="true">{section.text.slice(active.start, active.end)}</mark>{section.text.slice(active.end)}</> : section.text}</pre>
    </div>)}</div>
  </div>;
}
