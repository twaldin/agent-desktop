import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { SessionSummary } from "../../../../packages/shared/src/protocol";
import type { PreferencesState } from "./preferences-state";
import { SessionReadState } from "./session-read-state";

/** Only a focused, visible, loaded conversation is automatically read. */
export function useSessionReadState(preferences: PreferencesState, selected: SessionSummary | null | undefined, visible: boolean, transcriptLoaded: boolean) {
  const owner = useMemo(() => new SessionReadState(preferences), [preferences]);
  const [, redraw] = useReducer(value => value + 1, 0);
  const [focused, setFocused] = useState(() => document.visibilityState === "visible" && document.hasFocus());
  const viewed = useRef<string | undefined>(undefined);
  useEffect(() => owner.subscribe(redraw), [owner]);
  useEffect(() => {
    const changed = () => setFocused(document.visibilityState === "visible" && document.hasFocus());
    window.addEventListener("focus", changed); window.addEventListener("blur", changed); document.addEventListener("visibilitychange", changed);
    changed();
    return () => { window.removeEventListener("focus", changed); window.removeEventListener("blur", changed); document.removeEventListener("visibilitychange", changed); };
  }, []);
  const key = selected ? JSON.stringify([selected.hostId, selected.id, selected.activitySequence ?? 0]) : undefined;
  useEffect(() => {
    if (!selected || !visible || !focused || !transcriptLoaded) { viewed.current = undefined; return; }
    if (viewed.current === key || !preferences.ready || !preferences.connected || preferences.busy || preferences.pending.length || owner.busy) return;
    viewed.current = key;
    if (owner.isUnread(selected)) void owner.mark(selected, false);
  }, [owner, key, visible, focused, transcriptLoaded, preferences.ready, preferences.connected, preferences.busy, preferences.pending.length, owner.busy]);
  return owner;
}
