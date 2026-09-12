import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { defaultWindowView, parseWindowView, type WindowStateBootstrap, type WindowViewState } from "../window-state";
export interface WindowRestoration { ownerSlot?: string; state: WindowViewState; error?: string; migrate?: boolean }
export interface WindowSaveObserver {
  committed(view: WindowViewState): void;
  saved(view: WindowViewState): void;
  failed(message: string): void;
}
export function readWindowRestoration(): WindowRestoration {
  let bootstrap: WindowStateBootstrap | undefined;
  try { bootstrap = window.agentDesktopWindow?.initial; }
  catch { bootstrap = { error: "Window layout storage is unavailable in this window. This window is using defaults." }; }
  const owner = typeof bootstrap?.ownerSlot === "string" && /^[a-z0-9-]{1,80}$/.test(bootstrap.ownerSlot) ? { ownerSlot: bootstrap.ownerSlot } : {};
  if (bootstrap?.state) {
    const state = parseWindowView(bootstrap.state); if (state) return { ...owner, state, error: bootstrap.error };
    bootstrap = { error: bootstrap.error ?? "The saved window layout was invalid. This window is using defaults." };
  }
  const state = defaultWindowView();
  try {
    const raw = JSON.parse(sessionStorage.getItem("agent-desktop:navigation:v2") ?? "null");
    const legacy = parseWindowView({ ...state, route: raw ?? { sessionId: sessionStorage.getItem("agent-desktop:session") } });
    if (legacy && (legacy.route.hostId || legacy.route.sessionId)) return { ...owner, state: legacy, error: bootstrap?.error, migrate: true };
  } catch { /* Corrupt or unavailable legacy tab state is not a startup error. */ }
  return { ...owner, state, error: bootstrap?.error };
}
/** Presentation changes are infrequent and synchronously acknowledged before close. */
export function useWindowViewPersistence(value: WindowViewState, restoration: WindowRestoration, checkpoint?: WindowSaveObserver): string | undefined {
  const [error, setError] = useState(restoration.error);
  const [geometryError, setGeometryError] = useState<string>();
  const latest = useRef(value);
  useLayoutEffect(() => { latest.current = value; checkpoint?.committed(value); }, [value, checkpoint]);
  useEffect(() => () => checkpoint?.failed("The window was closed before request persistence."), [checkpoint]);
  const saved = useRef(restoration.migrate ? "" : JSON.stringify(restoration.state));
  useEffect(() => window.agentDesktopWindow?.subscribe?.(status => setGeometryError(status.error)), []);
  useEffect(() => {
    const save = () => {
      const view = latest.current;
      const serialized = JSON.stringify(view);
      try {
        const persisted = parseWindowView(view);
        if (!persisted) throw new Error("The window layout could not be validated before saving.");
        if (serialized === saved.current) { checkpoint?.saved(persisted); return; }
        const bridge = window.agentDesktopWindow;
        if (!bridge) throw new Error("Window layout persistence is unavailable in this window.");
        const result = bridge.save(persisted); if (result.error) throw new Error(result.error);
        saved.current = serialized; checkpoint?.saved(persisted); setError(undefined);
      } catch (cause) { const message = cause instanceof Error ? cause.message : "This window’s layout could not be saved."; checkpoint?.failed(message); setError(message); }
    };
    save(); window.addEventListener("beforeunload", save);
    return () => window.removeEventListener("beforeunload", save);
  }, [value, checkpoint]);
  return error ?? geometryError;
}
