import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopBridge, SessionActivitySnapshot } from "../../../../packages/shared/src/protocol";

/** One activity observer supplies the selected conversation and its Environment card. */
export function useSessionActivity(bridge: DesktopBridge, hostId: string, sessionId: string | undefined, connected: boolean, visible: boolean, localHostId?: string) {
  const owner = `${hostId}:${sessionId ?? ""}`;
  const [state, setState] = useState<{ owner: string; value?: SessionActivitySnapshot | null; error?: string }>();
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    refreshRef.current = () => {};
    if (!visible || !sessionId || !connected || !bridge.getSessionActivity) return;
    let alive = true, pending = false, again = false;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (!alive) return;
      if (pending) { again = true; return; }
      pending = true;
      try {
        const value = await bridge.getSessionActivity!(sessionId, hostId);
        if (value && (value.hostId !== hostId || value.sessionId !== sessionId || value.protocolVersion !== 1)) throw new Error("The activity response belongs to a different session or unsupported protocol.");
        if (alive) setState({ owner, value });
      } catch (cause) {
        if (alive) setState(previous => ({ owner, value: previous?.owner === owner ? previous.value : undefined, error: cause instanceof Error ? cause.message : String(cause) }));
      } finally {
        pending = false;
        if (alive && again) { again = false; schedule(); }
      }
    };
    function schedule() {
      if (!alive || scheduled) return;
      scheduled = setTimeout(() => { scheduled = undefined; void read(); }, 90);
    }
    refreshRef.current = schedule;
    const unsubscribe = bridge.subscribe(event => {
      if ((event.hostId ?? localHostId) !== hostId) return;
      if (event.type === 'runtime' && event.sessionId === sessionId && event.event !== null && typeof event.event === 'object' && 'activityChanged' in event.event && event.event.activityChanged === true) schedule();
      if (event.type === 'state' && event.state.sessions.some(session => session.id === sessionId)) schedule();
    });
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => { alive = false; clearInterval(timer); clearTimeout(scheduled); unsubscribe(); refreshRef.current = () => {}; };
  }, [bridge, owner, connected, visible, localHostId]);
  // Drop the previous owner's content synchronously; effects run after paint.
  return { ...(state?.owner === owner ? state : { owner }), refresh };
}
