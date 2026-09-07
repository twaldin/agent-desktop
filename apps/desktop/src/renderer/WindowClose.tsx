import { useEffect, useRef, useState, type RefObject } from "react";
import type { DesktopBridge } from "@agent-desktop/shared";
import "./window-close.css";

type CloseBridge = Pick<DesktopBridge, "subscribeWindowClose" | "answerWindowClose">;
/** Native close is a correlated request, never an unload-time fire-and-forget write. */
export function useWindowClose(bridge: CloseBridge, root: RefObject<HTMLElement | null>, prepare: (signal: AbortSignal) => Promise<boolean>) {
  const latest = useRef(prepare); latest.current = prepare;
  const active = useRef<{ id: string; abort: AbortController; focus: HTMLElement | null } | undefined>(undefined);
  const [closing, setClosing] = useState(false), [error, setError] = useState<string>();
  const reset = (restoreFocus = true) => {
    const current = active.current; active.current = undefined;
    current?.abort.abort();
    if (root.current) root.current.inert = false;
    setClosing(false);
    if (restoreFocus && current?.focus?.isConnected) current.focus.focus();
  };
  const keepOpen = () => {
    const current = active.current; if (!current) return;
    reset();
    void bridge.answerWindowClose?.(current.id, false).catch(cause => setError(String(cause)));
  };
  useEffect(() => {
    if (!bridge.subscribeWindowClose || !bridge.answerWindowClose) return;
    let mounted = true;
    const off = bridge.subscribeWindowClose(request => {
      if (request.cancelled) { if (active.current?.id === request.id) reset(); return; }
      if (active.current?.id === request.id) return;
      reset(false); setError(undefined);
      const current = { id: request.id, abort: new AbortController(), focus: document.activeElement instanceof HTMLElement ? document.activeElement : null };
      active.current = current;
      // Set synchronously before awaiting storage so no later keystroke escapes the save snapshot.
      if (root.current) root.current.inert = true;
      setClosing(true);
      void Promise.resolve().then(() => latest.current(current.abort.signal)).then(async allowed => {
        if (!mounted || active.current !== current || current.abort.signal.aborted) return;
        if (!allowed) { reset(); setError("The window stayed open because a file could not be saved. Review its save or conflict message before closing again."); }
        await bridge.answerWindowClose!(request.id, allowed);
        // On approval stay inert until native close or a cancellation from main.
      }).catch(cause => {
        if (!mounted || active.current !== current) return;
        reset(); setError(cause instanceof Error ? cause.message : "File recovery could not be saved. The window stayed open.");
        void bridge.answerWindowClose!(request.id, false).catch(() => {});
      });
    });
    return () => { mounted = false; off(); active.current?.abort.abort(); active.current = undefined; if (root.current) root.current.inert = false; };
  }, [bridge, root]);
  return closing || error ? <div className="window-close-status" role={error ? "alert" : "status"}>
    <span>{error ?? "Saving before closing…"}</span>
    <button className="secondary-button" onClick={closing ? keepOpen : () => setError(undefined)}>{closing ? "Keep window open" : "Dismiss"}</button>
  </div> : null;
}
