import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { ForceToolState, type ForceToolOwner, type ForceToolPorts, type ForceToolRecovery } from "./force-tool-state";

export function useForceTool(owner: ForceToolOwner, ports: ForceToolPorts, options: {
  connected: boolean; active: boolean; draftText: string; recovery?: ForceToolRecovery;
}) {
  const state = useMemo(() => new ForceToolState(owner, ports, options.draftText), [owner.hostId, owner.sessionId]);
  const view = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  useLayoutEffect(() => {
    state.setPorts(ports);
    state.configure(options.connected, options.active, options.draftText, options.recovery);
  }, [state, ports, options.connected, options.active, options.draftText, options.recovery]);
  useEffect(() => {
    if (options.connected && options.active) void state.refresh();
  }, [state, options.connected, options.active]);
  useEffect(() => {
    if (!options.connected || !options.active || view.mutation || !view.snapshot?.directives.length && !view.uncertain) return;
    const interval = setInterval(() => { if (!state.getSnapshot().loading) void state.refresh(); }, 1000);
    return () => clearInterval(interval);
  }, [state, options.connected, options.active, view.mutation, view.snapshot?.directives.length, view.uncertain]);
  // Effect cleanup invalidates requests through configure; retaining the same
  // object permits React StrictMode's setup/cleanup/setup without dead stores.
  useLayoutEffect(() => () => { state.configure(false, false, state.getSnapshot().latestDraft, state.getSnapshot().recovery); }, [state]);
  return { state, view };
}
