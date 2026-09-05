import { useEffect, useRef, useState } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal, ITheme } from "@xterm/xterm";
import type { TerminalBridge, TerminalInfo, TerminalViewerLease, TerminalChunk, NativeTerminalBridge } from "../../../../packages/shared/src/terminals";
import { TERMINAL_DIMENSIONS } from "../../../../packages/shared/src/terminals";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace";
import { Icon } from "./Icons";
import { binaryTerminalInput, separateXtermReplies } from "./xterm-input";
import { newestTerminalInfo, OrderedTerminalInput, TerminalReplayCursor } from "./terminal-state";
import { hasNativeTerminalBridge, unsupportedNativeTerminal, verifyNativeTerminalCapabilities } from "./native-terminal-state";
import { NativeTerminalPanel } from "./NativeTerminalPanel";
import { nativeTerminalClient } from "./native-terminal-bridge";
import "@xterm/xterm/css/xterm.css";
import "./terminal-panel.css";

export interface TerminalPanelProps { target: WorkspaceTarget; hostId: string; connected: boolean; onClose(): void; bridge?: TerminalBridge & Partial<NativeTerminalBridge> }
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const activeStatus = (terminal: TerminalInfo) => terminal.status === "running" || terminal.status === "starting" || terminal.status === "closing";

export function TerminalPanel(props: TerminalPanelProps) {
  const key = `${props.hostId}:${"projectId" in props.target ? props.target.projectId : props.target.sessionId}`;
  return <NegotiatedTerminalPanel key={key} {...props}/>;
}
function NegotiatedTerminalPanel(props: TerminalPanelProps) {
  const bridge = props.bridge ?? window.agentDesktop;
  const [mode, setMode] = useState<"pending" | "native" | "legacy">("pending"), [error, setError] = useState<string>(), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!props.connected) return;
    let alive = true;
    if (!hasNativeTerminalBridge(bridge)) { setMode("legacy"); return; }
    void nativeTerminalClient(bridge).getNativeTerminalCapabilities(props.hostId).then(value => { verifyNativeTerminalCapabilities(value); if (alive) { setMode("native"); setError(undefined); } }).catch(cause => {
      if (!alive) return;
      if (unsupportedNativeTerminal(cause) && mode !== "native") { setMode("legacy"); setError(undefined); }
      else setError(errorText(cause));
    });
    return () => { alive = false; };
  }, [bridge, props.hostId, props.connected, attempt]);
  if (!error && mode === "native" && hasNativeTerminalBridge(bridge)) return <NativeTerminalPanel {...props} bridge={nativeTerminalClient(bridge)}/>;
  if (!error && mode === "legacy") return <div className="terminal-legacy-container"><p className="terminal-notice">Legacy host terminal · retained output may omit the start of a fullscreen view. Upgrade this host for native pane recovery.</p><TerminalPanelBody {...props}/></div>;
  return <section className="terminal-panel" aria-label="Workspace terminals"><header className="terminal-panel-header"><strong>Terminal</strong><button className="icon-button small" aria-label="Hide terminal panel" onClick={props.onClose}><Icon name="close"/></button></header><p className={`terminal-notice${error ? " error" : ""}`} role={error ? "alert" : "status"}>{error ?? (props.connected ? "Checking native terminal support…" : "Connect to the owning host to negotiate terminal support.")}{error && <button className="secondary-button" disabled={!props.connected} onClick={() => setAttempt(value => value + 1)}>Retry connection</button>}</p></section>;
}
function TerminalPanelBody({ target, hostId, connected, onClose, bridge = window.agentDesktop }: TerminalPanelProps) {
  const targetKey = "projectId" in target ? `project:${target.projectId}` : `session:${target.sessionId}`;
  const selectionKey = `terminal.selected.${hostId}.${targetKey}`;
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [selected, setSelected] = useState<string | undefined>(() => { try { return localStorage.getItem(selectionKey) ?? undefined; } catch { return undefined; } });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [refreshTick, setRefreshTick] = useState(0);
  const createdViewers = useRef(new Map<string, string>());
  const connectedRef = useRef(connected); connectedRef.current = connected;
  const latestTarget = useRef(target); latestTarget.current = target;

  useEffect(() => { if (selected) { try { localStorage.setItem(selectionKey, selected); } catch { /* A storage-disabled window still has its in-memory selection. */ } } }, [selected, selectionKey]);
  useEffect(() => {
    let alive = true; let refreshing = false; let again = false;
    const refresh = async () => {
      if (!alive || !connectedRef.current) return;
      if (refreshing) { again = true; return; }
      refreshing = true; setLoading(true);
      do {
        again = false;
        try {
          const values = await bridge.getTerminals(latestTarget.current, hostId);
          if (alive) { setTerminals(current => values.map(value => newestTerminalInfo(current.find(item => item.id === value.id), value))); setSelected(current => values.some(value => value.id === current) ? current : values[0]?.id); setError(undefined); }
        } catch (cause) { if (alive) setError(errorText(cause)); }
      } while (again && alive && connectedRef.current);
      refreshing = false; if (alive) setLoading(false);
    };
    const off = bridge.subscribeTerminals(event => {
      if (event.hostId !== hostId || event.type === "output") return;
      if (event.type === "removed") { setTerminals(current => current.filter(item => item.id !== event.terminalId)); void refresh(); }
      else {
        const same = "projectId" in event.terminal.target ? `project:${event.terminal.target.projectId}` : `session:${event.terminal.target.sessionId}`;
        if (same === targetKey) { setTerminals(current => current.some(item => item.id === event.terminal.id) ? current.map(item => item.id === event.terminal.id ? newestTerminalInfo(item, event.terminal) : item) : [...current, event.terminal]); }
      }
    });
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { alive = false; off(); clearInterval(timer); };
  }, [bridge, hostId, targetKey, connected, refreshTick]);

  const create = async () => {
    setBusy("create"); setError(undefined);
    try { const viewerId = crypto.randomUUID(); const result = await bridge.terminalAction({ type: "create", viewerId, options: { target, cols: 120, rows: 30 } }, hostId); if (result.terminal) { createdViewers.current.set(result.terminal.id, viewerId); setTerminals(current => [...current.filter(item => item.id !== result.terminal!.id), result.terminal!]); setSelected(result.terminal.id); } }
    catch (cause) { setError(`Terminal creation may be incomplete: ${errorText(cause)} Refresh the list before trying again.`); }
    finally { setBusy(undefined); }
  };
  const stop = async (terminal: TerminalInfo) => {
    setBusy(terminal.id); setError(undefined);
    try {
      if (activeStatus(terminal)) { const result = await bridge.terminalAction({ type: "close", terminalId: terminal.id }, hostId); if (result.terminal) setTerminals(current => current.map(item => item.id === terminal.id ? result.terminal! : item)); }
      else { await bridge.terminalAction({ type: "forget", terminalId: terminal.id }, hostId); setTerminals(current => current.filter(item => item.id !== terminal.id)); setSelected(current => current === terminal.id ? undefined : current); }
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(undefined); }
  };
  const active = terminals.find(item => item.id === selected) ?? terminals[0];
  return <section className="terminal-panel" aria-label="Workspace terminals">
    <header className="terminal-panel-header"><Icon name="terminal"/><strong>Terminal</strong><span className="terminal-connection">{connected ? "Connected" : "Offline"}</span><div className="terminal-panel-actions"><button className="icon-button small" aria-label="New terminal" title="New terminal" disabled={!connected || !!busy} onClick={() => void create()}><Icon name="plus"/></button><button className="icon-button small" aria-label="Refresh terminals" title="Refresh terminals" disabled={!connected || loading} onClick={() => setRefreshTick(value => value + 1)}><Icon name="refresh"/></button><button className="icon-button small" aria-label="Hide terminal panel" title="Hide panel; keep shells running" onClick={onClose}><Icon name="close"/></button></div></header>
    {terminals.length > 0 && <div className="terminal-tabs" role="tablist" aria-label="Terminal sessions">{terminals.map((terminal, index) => <div className={`terminal-tab ${active?.id === terminal.id ? "selected" : ""}`} key={terminal.id}><button role="tab" id={`terminal-tab-${terminal.id}`} aria-controls={`terminal-view-${terminal.id}`} aria-selected={active?.id === terminal.id} onClick={() => setSelected(terminal.id)} title={terminal.cwd}>{terminal.shell} {index + 1}{terminal.status !== "running" && <small>{terminal.status === "exited" ? `Exit ${terminal.exitCode ?? "–"}` : terminal.status}</small>}</button><button className="terminal-tab-close" aria-label={activeStatus(terminal) ? `Close shell ${index + 1}` : `Forget terminal ${index + 1}`} title={activeStatus(terminal) ? "Stop this shell" : "Forget exited terminal"} disabled={!connected || !!busy} onClick={() => void stop(terminal)}><Icon name={activeStatus(terminal) ? "stop" : "close"}/></button></div>)}</div>}
    {error && <p className="terminal-notice error" role="alert">{error}</p>}
    {!connected && <p className="terminal-notice">Offline · the visible output is retained locally. Reconnect to send input.</p>}
    {!terminals.length ? <div className="terminal-empty"><Icon name="terminal"/><p>{loading ? "Loading terminals…" : "Open a shell in this workspace."}</p><button className="secondary-button" disabled={!connected || !!busy || loading} onClick={() => void create()}>{busy === "create" ? "Starting…" : "New terminal"}</button></div> : <div className="terminal-views">{terminals.map(terminal => <TerminalViewport key={`${hostId}:${terminal.id}`} bridge={bridge} hostId={hostId} terminal={terminal} active={active?.id === terminal.id} connected={connected} initialViewerId={createdViewers.current.get(terminal.id)} onState={value => setTerminals(current => current.map(item => item.id === value.id ? newestTerminalInfo(item, value) : item))}/>)}</div>}
  </section>;
}

function TerminalViewport({ bridge, hostId, terminal, active, connected, initialViewerId, onState }: { bridge: TerminalBridge; hostId: string; terminal: TerminalInfo; active: boolean; connected: boolean; initialViewerId?: string; onState(value: TerminalInfo): void }) {
  const element = useRef<HTMLDivElement>(null);
  const handle = useRef<{ term: Terminal; fit: FitAddon; input: OrderedTerminalInput; ready(): boolean; sync(): void; fitNow(): void } | undefined>(undefined);
  const current = useRef({ active, connected, terminal, onState }); current.current = { active, connected, terminal, onState };
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string>(); const [gap, setGap] = useState(false); const [inputTick, setInputTick] = useState(0);
  const [hasSelection, setHasSelection] = useState(false); const [restoring, setRestoring] = useState(true);
  useEffect(() => { if (active) setInitialized(true); }, [active]);

  useEffect(() => {
    if (!initialized || !element.current) return;
    let alive = true; let disposable: (() => void) | undefined;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (!alive || !element.current) return;
      const term = new Terminal({ cols: terminal.cols, rows: terminal.rows, scrollback: 5000, cursorBlink: true, screenReaderMode: true, allowTransparency: true, allowProposedApi: false, disableStdin: true, fontFamily: "monospace", fontSize: 13 });
      const fit = new FitAddon(); term.loadAddon(fit); term.open(element.current);
      term.textarea?.setAttribute("aria-label", `Interactive ${terminal.shell} terminal`);
      let restored = false;
      const input = new OrderedTerminalInput(terminal.id, request => bridge.writeTerminal(request, hostId), () => { if (alive) { setInputTick(value => value + 1); term.options.disableStdin = !restored || !current.current.connected || input.paused || current.current.terminal.status !== "running"; } });
      input.setConnected(current.current.connected);
      let syncing = false; let requested = false; let lease: TerminalViewerLease | undefined;
      const viewerId = initialViewerId ?? crypto.randomUUID();
      const parser = separateXtermReplies(term);
      let replies = new OrderedTerminalInput(terminal.id, request => bridge.writeTerminal(request, hostId), () => {});
      const ownsLease = () => lease?.viewerId === viewerId && lease.expiresAt > Date.now();
      const render = async (chunks: TerminalChunk[]) => {
        const generated = await parser.writeBatch(chunks);
        if (ownsLease()) {
          for (const reply of generated) if (reply.outputSequence > Math.max(lease!.startSequence, lease!.completedSequence)) replies.enqueue(reply.data, "utf8", { leaseId: lease!.leaseId, outputSequence: reply.outputSequence, ordinal: reply.ordinal });
          await replies.settled();
          if (replies.paused) throw new Error("Terminal protocol reply delivery was interrupted. Reconnecting its responder safely.");
        }
      };
      const cursor = new TerminalReplayCursor((data, sequence) => render([{ data, sequence }]), () => term.reset(), () => setGap(true), render);
      const visible = () => current.current.active && document.visibilityState !== "hidden" && !!element.current?.clientWidth && !!element.current?.clientHeight;
      const sync = () => {
        requested = true;
        if (syncing || !current.current.connected || !alive) return;
        syncing = true;
        void (async () => {
          do {
            requested = false;
            if (visible()) {
              const result = await bridge.terminalAction({ type: "viewer", terminalId: terminal.id, viewerId, afterSequence: cursor.sequence, ...(lease?.viewerId === viewerId ? { leaseId: lease.leaseId } : {}) }, hostId);
              if (!alive) return;
              const next = result.viewer;
              if (next?.viewerId === viewerId && next.leaseId !== lease?.leaseId) { cursor.restart(); restored = false; setRestoring(true); term.options.disableStdin = true; replies.dispose(); replies = new OrderedTerminalInput(terminal.id, request => bridge.writeTerminal(request, hostId), () => {}); }
              lease = next;
            } else if (ownsLease()) {
              await bridge.terminalAction({ type: "viewer", terminalId: terminal.id, viewerId, leaseId: lease!.leaseId, afterSequence: cursor.sequence, release: true }, hostId); lease = undefined;
            }
            const replay = await bridge.getTerminalReplay(terminal.id, cursor.sequence, hostId);
            if (!alive) return;
            await cursor.apply(replay);
            if (alive) { restored = true; setRestoring(false); current.current.onState(replay.terminal); term.options.disableStdin = !current.current.connected || input.paused || current.current.terminal.status !== "running"; setError(undefined); if (ownsLease()) fitNow(); }
          } while (requested && alive && current.current.connected);
        })().catch(cause => {
          if (alive) { setError(errorText(cause)); if (replies.paused) { cursor.restart(); restored = false; setRestoring(true); term.options.disableStdin = true; replies.dispose(); replies = new OrderedTerminalInput(terminal.id, request => bridge.writeTerminal(request, hostId), () => {}); } }
        }).finally(() => { syncing = false; });
      };
      let resizeBusy = false; let fitAgain = false;
      const fitNow = () => {
        if (!alive || !ownsLease() || !current.current.active || !current.current.connected || current.current.terminal.status !== "running" || !element.current?.clientWidth) return;
        if (resizeBusy) { fitAgain = true; return; }
        const proposed = fit.proposeDimensions(); if (!proposed) return;
        const cols = Math.max(TERMINAL_DIMENSIONS.minimumCols, Math.min(TERMINAL_DIMENSIONS.maximumCols, proposed.cols));
        const rows = Math.max(TERMINAL_DIMENSIONS.minimumRows, Math.min(TERMINAL_DIMENSIONS.maximumRows, proposed.rows));
        if (term.cols === cols && term.rows === rows && current.current.terminal.cols === cols && current.current.terminal.rows === rows) return;
        resizeBusy = true; term.resize(cols, rows);
        void bridge.terminalAction({ type: "resize", terminalId: terminal.id, cols, rows }, hostId).then(result => { if (alive && result.terminal) { term.resize(result.terminal.cols, result.terminal.rows); current.current.onState(result.terminal); } }).catch(cause => { if (alive) setError(errorText(cause)); }).finally(() => { resizeBusy = false; if (fitAgain) { fitAgain = false; fitNow(); } });
      };
      const data = term.onData(value => { if (current.current.active && current.current.connected && current.current.terminal.status === "running") input.enqueue(value); });
      const binary = term.onBinary(value => { if (current.current.active && current.current.connected && current.current.terminal.status === "running") input.enqueue(binaryTerminalInput(value), "base64"); });
      const selection = term.onSelectionChange(() => setHasSelection(term.hasSelection()));
      term.attachCustomKeyEventHandler(event => {
        if (event.type !== "keydown") return true;
        if ((event.metaKey && !event.ctrlKey || event.ctrlKey && event.shiftKey) && event.key.toLowerCase() === "c" && term.hasSelection()) { event.preventDefault(); void navigator.clipboard.writeText(term.getSelection()).catch(cause => setError(errorText(cause))); return false; }
        if (event.metaKey && event.key.toLowerCase() === "a") { event.preventDefault(); term.selectAll(); return false; }
        return true;
      });
      const colorCanvas = document.createElement("canvas"); colorCanvas.width = 1; colorCanvas.height = 1;
      const colorContext = colorCanvas.getContext("2d", { willReadFrequently: true });
      const theme = () => { const style = getComputedStyle(document.documentElement); const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
        // Normalize browser-supported CSS colors (including lab/oklch) for xterm's narrower parser.
        const color = (value: string) => { if (!colorContext) return value; colorContext.clearRect(0, 0, 1, 1); colorContext.fillStyle = value; colorContext.fillRect(0, 0, 1, 1); const [r, g, b, a] = colorContext.getImageData(0, 0, 1, 1).data; return `rgba(${r},${g},${b},${a! / 255})`; };
        const colors: ITheme = { background: color(token("--terminal-surface", token("--app-surface", "#181818"))), foreground: color(token("--text", "#ededed")), cursor: color(token("--accent", "#72a8ff")), selectionBackground: color(token("--selection-surface", "#ffffff33")) };
        const measure = document.createElement("span"); measure.style.fontSize = token("--terminal-font-size", token("--code-font-size", "13px")); element.current!.append(measure); const size = parseFloat(getComputedStyle(measure).fontSize); measure.remove();
        term.options = { theme: colors, fontFamily: token("--terminal-font", token("--code-font", "monospace")), fontSize: Number.isFinite(size) ? size : 13, fontWeight: Number(token("--code-font-weight", "400")), lineHeight: Number(token("--code-line-height", "1.2")) }; fitNow();
      };
      const resize = new ResizeObserver(() => { fitNow(); sync(); }); resize.observe(element.current);
      const changes = new MutationObserver(theme); changes.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme"] });
      const dark = matchMedia("(prefers-color-scheme: dark)"); dark.addEventListener("change", theme);
      const off = bridge.subscribeTerminals(event => { if (event.hostId !== hostId) return; if (event.type === "output" && event.terminalId === terminal.id && event.lastSequence > cursor.sequence) sync(); if (event.type === "state" && event.terminal.id === terminal.id) { current.current.onState(event.terminal); if (term.cols !== event.terminal.cols || term.rows !== event.terminal.rows) term.resize(event.terminal.cols, event.terminal.rows); sync(); } });
      const poll = setInterval(sync, 2000); document.addEventListener("visibilitychange", sync);
      disposable = () => { off(); clearInterval(poll); document.removeEventListener("visibilitychange", sync); resize.disconnect(); changes.disconnect(); dark.removeEventListener("change", theme); data.dispose(); binary.dispose(); selection.dispose(); input.dispose(); replies.dispose(); parser.dispose(); if (lease?.viewerId === viewerId && current.current.connected) void bridge.terminalAction({ type: "viewer", terminalId: terminal.id, viewerId, leaseId: lease.leaseId, afterSequence: cursor.sequence, release: true }, hostId).catch(() => {}); term.dispose(); handle.current = undefined; };
      handle.current = { term, fit, input, ready: () => restored, sync, fitNow }; theme(); sync(); if (current.current.active) term.focus();
    })().catch(cause => { disposable?.(); if (alive) setError(errorText(cause)); });
    return () => { alive = false; disposable?.(); };
  }, [bridge, hostId, terminal.id, initialized]);
  useEffect(() => { const value = handle.current; if (!value) return; value.input.setConnected(connected); value.term.options.disableStdin = !value.ready() || !connected || value.input.paused || terminal.status !== "running"; value.sync(); if (active) { value.fitNow(); value.term.focus(); } }, [connected, active, terminal.status, inputTick]);
  const input = handle.current?.input;
  return <div className="terminal-view" id={`terminal-view-${terminal.id}`} role="tabpanel" aria-labelledby={`terminal-tab-${terminal.id}`} hidden={!active}>
    {restoring && <p className="terminal-notice" role="status">Restoring terminal view…</p>}
    {(error || gap || input?.error) && <div className="terminal-view-notices">{error && <p className="terminal-notice error" role="alert">{error}</p>}{gap && <p className="terminal-notice">Earlier output exceeded the host buffer. Showing the retained tail; a fullscreen app may need a redraw.</p>}{input?.error && <p className="terminal-notice error" role="alert">{input.error}{input.paused && <button className="secondary-button" disabled={!connected || input.busy} onClick={() => input.resume()}>Resume input</button>}</p>}</div>}
    <div className="terminal-emulator" ref={element}/>
    <footer className="terminal-view-footer"><span className="truncate" title={terminal.cwd}>{terminal.cwd}</span><span>{terminal.cols}×{terminal.rows}</span><button disabled={!hasSelection} onClick={() => { const term = handle.current?.term; if (term) void navigator.clipboard.writeText(term.getSelection()).catch(cause => setError(errorText(cause))); }}>Copy selection</button><button onClick={() => handle.current?.sync()} disabled={!connected}>Refresh output</button></footer>
    {terminal.status === "exited" && <p className="terminal-notice">Shell exited{terminal.exitCode === undefined ? "" : ` with code ${terminal.exitCode}`}{terminal.cancelled ? " after being closed" : ""}.</p>}{terminal.error && <p className="terminal-notice error" role="alert">{terminal.error}</p>}
  </div>;
}
