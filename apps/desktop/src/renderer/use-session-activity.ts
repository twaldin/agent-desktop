import { useEffect, useState } from "react";
import type { DesktopBridge, SessionActivitySnapshot } from "../../../../packages/shared/src/protocol";
export function useSessionActivity(bridge: DesktopBridge, hostId: string, sessionId: string | undefined, connected: boolean, visible: boolean) {
  const owner = `${hostId}:${sessionId ?? ""}`;
  const [state, setState] = useState<{ owner: string; value?: SessionActivitySnapshot | null; error?: string }>();
  useEffect(() => {
    if (!visible || !sessionId || !connected || !bridge.getSessionActivity) return;
    let alive = true, pending = false;
    const read = async () => {
      if (!alive || pending) return;
      pending = true;
      try {
        const value = await bridge.getSessionActivity!(sessionId, hostId);
        if (value && (value.hostId !== hostId || value.sessionId !== sessionId || value.protocolVersion !== 1)) throw new Error("The activity response belongs to a different session or unsupported protocol.");
        if (alive) setState({ owner, value });
      } catch (cause) { if (alive) setState({ owner, error: cause instanceof Error ? cause.message : String(cause) }); }
      finally { pending = false; }
    };
    void read(); const timer = setInterval(() => void read(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [bridge, owner, connected, visible]);
  return state?.owner === owner ? state : undefined;
}
