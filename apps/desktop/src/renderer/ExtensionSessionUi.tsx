import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import { ExtensionUiState, type ExtensionUiView } from "./extension-ui-state";
import { extensionTextRuns } from "./extension-text";
import "./extension-session-ui.css";
export function useExtensionSessionUi(bridge: DesktopBridge, hostId: string, sessionId: string | undefined, connected: boolean, visible: boolean, localHostId?: string) {
  const state = useMemo(() => new ExtensionUiState(hostId, sessionId ?? "", () => bridge.getExtensionUi?.(sessionId!, hostId) ?? Promise.resolve(null)), [bridge, hostId, sessionId]);
  const view = useSyncExternalStore(state.subscribe, state.snapshot);
  useEffect(() => {
    if (!sessionId || !connected || !visible) return;
    let lastSequence = -1;
    const unsubscribe = bridge.subscribe(event => {
      if ((event.hostId ?? localHostId) !== hostId) return;
      if (event.type === "extension-ui" && event.sessionId === sessionId && event.sequence > lastSequence) {
        lastSequence = event.sequence; state.changed(event.epoch, event.revision);
      } else if (event.type === "state") void state.refresh();
    });
    state.start();
    const timer = setInterval(() => void state.refresh(), 3000);
    return () => { state.stop(); unsubscribe(); clearInterval(timer); };
  }, [bridge, hostId, sessionId, connected, visible, localHostId, state]);
  return view;
}
export function ExtensionWidgets({ view, placement, connected }: { view: ExtensionUiView; placement: "aboveEditor" | "belowEditor"; connected: boolean }) {
  const widgets = view.value?.widgets.filter(widget => widget.placement === placement && widget.lines.length > 0) ?? [];
  if (!widgets.length) return null;
  return <section className="extension-text-widgets" aria-label={placement === "aboveEditor" ? "Extension widgets above composer" : "Extension widgets below composer"}>
    {!connected && <small>Offline extension display</small>}
    {widgets.map(widget => <div className="extension-text-widget" key={widget.key} data-extension-key={widget.key}>
      {widget.lines.map((line, index) => <div className="extension-widget-line" key={index}>{extensionTextRuns(line).map((run, part) => <span key={part} style={run.style}>{run.text}</span>)}</div>)}
      {widget.truncated && <div className="extension-widget-truncated">... (widget truncated)</div>}
    </div>)}
  </section>;
}
export function ExtensionStatuses({ view, connected }: { view: ExtensionUiView; connected: boolean }) {
  const statuses = view.value?.statuses.filter(status => status.text) ?? [];
  const notice = !connected ? "Offline extension display" : view.error ?? view.unavailable;
  if (!statuses.length && !(view.observed && notice)) return null;
  return <section className="extension-statuses" aria-label="Extension status" role="status">
    {statuses.map(status => <span key={status.key} data-extension-key={status.key}>{status.text}</span>)}
    {view.observed && notice && <small>{notice}</small>}
  </section>;
}
