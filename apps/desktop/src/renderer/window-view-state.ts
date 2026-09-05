import { useEffect, useRef, useState } from "react";
import { defaultWindowView, parseWindowView, type WindowStateBootstrap, type WindowViewState } from "../window-state";
export interface WindowRestoration { state: WindowViewState; error?: string; migrate?: boolean }
export function readWindowRestoration(): WindowRestoration {
  let bootstrap: WindowStateBootstrap | undefined;
  try { bootstrap = window.agentDesktopWindow?.initial; }
  catch { bootstrap = { error: "Window layout storage is unavailable in this window. This window is using defaults." }; }
  if (bootstrap?.state) {
    const state = parseWindowView(bootstrap.state); if (state) return { state, error: bootstrap.error };
    bootstrap = { error: bootstrap.error ?? "The saved window layout was invalid. This window is using defaults." };
  }
  const state = defaultWindowView();
  try {
    const raw = JSON.parse(sessionStorage.getItem("agent-desktop:navigation:v2") ?? "null");
    const legacy = parseWindowView({ ...state, route: raw ?? { sessionId: sessionStorage.getItem("agent-desktop:session") } });
    if (legacy && (legacy.route.hostId || legacy.route.sessionId)) return { state: legacy, error: bootstrap?.error, migrate: true };
  } catch { /* Corrupt or unavailable legacy tab state is not a startup error. */ }
  return { state, error: bootstrap?.error };
}
/** Presentation changes are infrequent and synchronously acknowledged before close. */
export function useWindowViewPersistence(value: WindowViewState, restoration: WindowRestoration): string | undefined {
  const [error, setError] = useState(restoration.error);
  const [geometryError, setGeometryError] = useState<string>();
  const latest = useRef(value); latest.current = value;
  const saved = useRef(restoration.migrate ? "" : JSON.stringify(restoration.state));
  useEffect(() => window.agentDesktopWindow?.subscribe?.(status => setGeometryError(status.error)), []);
  useEffect(() => {
    const save = () => {
      const serialized = JSON.stringify(latest.current); if (serialized === saved.current) return;
      try {
        const bridge = window.agentDesktopWindow;
        if (!bridge) throw new Error("Window layout persistence is unavailable in this window.");
        const result = bridge.save(latest.current); if (result.error) throw new Error(result.error);
        saved.current = serialized; setError(undefined);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "This window’s layout could not be saved."); }
    };
    save(); window.addEventListener("beforeunload", save);
    return () => window.removeEventListener("beforeunload", save);
  }, [value]);
  return error ?? geometryError;
}
