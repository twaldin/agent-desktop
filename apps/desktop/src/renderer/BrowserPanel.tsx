import { useEffect, useRef, useState } from "react";
import { BROWSER_FRAME_PROTOCOL_VERSION, validBrowserFrameTarget, type BrowserFrameSnapshot, type BrowserFrameTarget,
  type BrowserMetadataSnapshot, type DesktopBridge, type NativeBrowserTabMetadata } from "../../../../packages/shared/src/protocol";
import "./browser-panel.css";

interface Props { bridge: DesktopBridge; hostId: string; sessionId: string; active: boolean }
const same = (a: BrowserFrameTarget | undefined, b: BrowserFrameTarget) => Boolean(a && a.workerPid === b.workerPid && a.name === b.name && a.targetId === b.targetId);
const storageKey = (hostId: string, sessionId: string) => `browser.preview.selected.${hostId}.${sessionId}`;
function readSelection(key: string): BrowserFrameTarget | undefined {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null"); return validBrowserFrameTarget(value) ? value : undefined; } catch { return undefined; }
}
function saveSelection(key: string, target: BrowserFrameTarget) {
  try { localStorage.setItem(key, JSON.stringify(target)); } catch { /* Selection remains usable in this window. */ }
}

export function BrowserPanel(props: Props) {
  // Changing owners must synchronously discard pixels from the previous owner.
  return <SessionBrowserPreview key={JSON.stringify([props.hostId, props.sessionId])} {...props}/>;
}
function SessionBrowserPreview({ bridge, hostId, sessionId, active }: Props) {
  const key = storageKey(hostId, sessionId);
  const [metadata, setMetadata] = useState<BrowserMetadataSnapshot | null>();
  const [selected, setSelected] = useState(() => readSelection(key));
  const selectedRef = useRef(selected);
  const [frame, setFrame] = useState<BrowserFrameSnapshot>();
  const [error, setError] = useState<string>();
  const [paused, setPaused] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const selectionRevision = useRef(0), inFlight = useRef(false), nextRead = useRef(0);
  const chooseTarget = (target: BrowserFrameTarget) => {
    selectionRevision.current++;
    selectedRef.current = target; setSelected(target); setFrame(undefined); setError(undefined); saveSelection(key, target);
  };

  useEffect(() => {
    if (!active || paused || !bridge.getBrowserMetadata || !bridge.getBrowserFrame) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      if (disposed) return;
      clearTimeout(timer); timer = setTimeout(() => void poll(), delay);
    };
    async function poll() {
      if (disposed) return;
      if (document.visibilityState === "hidden") { schedule(1000); return; }
      // An old selection/effect may still have an uncancellable IPC request.
      // Wait for it to settle before starting another capture.
      if (inFlight.current) { schedule(100); return; }
      if (Date.now() < nextRead.current) { schedule(nextRead.current - Date.now()); return; }
      inFlight.current = true;
      const revision = selectionRevision.current;
      const current = () => !disposed && revision === selectionRevision.current;
      try {
        const next = await bridge.getBrowserMetadata!(sessionId, hostId);
        if (!current()) return;
        if (next && (next.hostId !== hostId || next.sessionId !== sessionId || next.protocolVersion !== 1)) throw new Error("Browser tab metadata belongs to a different session.");
        setMetadata(next);
        if (!next || next.availability !== "running") { setFrame(undefined); setError(undefined); return; }
        const previous = selectedRef.current;
        const tab = next.tabs.find(tab => tab.state === "alive" && same(previous, { workerPid: next.workerPid, name: tab.name, targetId: tab.targetId }))
          ?? next.tabs.find(tab => tab.state === "alive" && tab.backend === "worker") ?? next.tabs.find(tab => tab.state === "alive");
        if (!tab) { setFrame(undefined); setError(undefined); return; }
        const target = { workerPid: next.workerPid, name: tab.name, targetId: tab.targetId };
        if (!same(previous, target)) {
          selectedRef.current = target; setSelected(target); setFrame(undefined); saveSelection(key, target);
        }
        if (tab.backend !== "worker") { setFrame(undefined); setError("This native browser backend does not support viewport previews yet."); return; }
        const image = await bridge.getBrowserFrame!(sessionId, target, hostId);
        if (!current()) return;
        if (image.protocolVersion !== BROWSER_FRAME_PROTOCOL_VERSION || image.hostId !== hostId || image.sessionId !== sessionId
          || !same(image, target) || image.mimeType !== "image/jpeg") throw new Error("The browser viewport belongs to a different session or tab.");
        setFrame(image); setError(undefined);
      } catch (cause) {
        if (current()) setError(cause instanceof Error ? cause.message : "Browser preview is unavailable.");
      } finally {
        inFlight.current = false; nextRead.current = Date.now() + 1000; schedule(1000);
      }
    }
    const visibility = () => { if (document.visibilityState === "visible") schedule(0); };
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [active, paused, bridge, hostId, sessionId, refresh, key]);

  const running = metadata?.availability === "running" ? metadata : undefined;
  const tabs = running?.tabs.filter(tab => tab.state === "alive") ?? [];
  const choose = (tab: NativeBrowserTabMetadata) => { if (running) chooseTarget({ workerPid: running.workerPid, name: tab.name, targetId: tab.targetId }); };
  const unsupported = !bridge.getBrowserMetadata || !bridge.getBrowserFrame ? "Update this desktop to preview native browser tabs."
    : metadata === null ? "Update this host to preview native browser tabs." : undefined;
  const reason = unsupported ?? (metadata && metadata.availability !== "running" ? metadata.reason : undefined);
  const stale = Boolean(frame && (reason || error || paused || !active));
  return <section className="browser-panel" aria-label="Read-only browser preview">
    <header><span className="browser-preview-label">Read-only preview</span><div className="browser-preview-actions">
      <button aria-label="Refresh browser preview" disabled={Boolean(unsupported) || !active || paused} onClick={() => setRefresh(value => value + 1)}>Refresh</button>
      <button disabled={Boolean(unsupported)} onClick={() => setPaused(value => !value)}>{paused ? "Resume" : "Pause"}</button>
    </div></header>
    <div className="browser-tabs" role="tablist" aria-label="Native browser tabs">{tabs.map(tab => <button role="tab" aria-selected={Boolean(running && same(selected, { workerPid: running.workerPid, name: tab.name, targetId: tab.targetId }))}
      key={`${tab.name}:${tab.targetId}`} onClick={() => choose(tab)} title={tab.url}>{tab.title || tab.url || tab.name}{tab.backend !== "worker" ? " · unavailable" : ""}</button>)}</div>
    {frame && <input className="browser-preview-address" aria-label="Page address" readOnly value={frame.url}/>}
    {(reason || error || paused) && <p className="browser-status" role="status">{reason ?? error ?? "Preview paused."}</p>}
    {frame ? <figure><div className="browser-viewport"><img src={`data:${frame.mimeType};base64,${frame.data}`} width={frame.width} height={frame.height}
      alt={frame.title || "Native browser viewport"} onError={() => { setFrame(undefined); setError("The browser viewport image could not be displayed."); }}/></div>
      <figcaption>{frame.title || frame.url}{stale ? " · stale preview" : ""}</figcaption></figure>
      : <div className="browser-empty">{reason || error ? "No current preview." : metadata === undefined ? "Loading native browser tabs…" : "Tabs opened by this session’s browser tool appear here."}</div>}
  </section>;
}
