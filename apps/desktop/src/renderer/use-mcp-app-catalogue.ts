import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesktopBridge, NativeSessionMcpSnapshot } from "@agent-desktop/shared";
/** Read only the selected, already loaded session. Completion never changes owner. */
export function useMcpAppCatalogue(bridge: DesktopBridge, hostId: string, sessionId: string | undefined, connected: boolean) {
  const [snapshot, setSnapshot] = useState<{ key: string; value: NativeSessionMcpSnapshot }>();
  const key = JSON.stringify([hostId, sessionId]), generation = useRef(0), committed = useRef({ key, connected, bridge });
  useLayoutEffect(() => { committed.current = { key, connected, bridge }; generation.current++; }, [key, connected, bridge]);
  useEffect(() => {
    if (!sessionId || !connected || !bridge.getSessionMcp || !bridge.sessionMcpApp) return;
    let alive = true, reading = false;
    const read = async () => {
      if (!alive || reading) return;
      reading = true; const observed = generation.current;
      try {
        const result = await bridge.getSessionMcp!(sessionId, hostId);
        if (alive && observed === generation.current) setSnapshot(result.value ? { key, value: result.value } : undefined);
      } catch { if (alive && observed === generation.current) setSnapshot(undefined); }
      finally { reading = false; }
    };
    void read(); const timer = setInterval(() => void read(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [bridge, hostId, sessionId, connected, key]);
  const value = snapshot?.key === key && connected ? snapshot.value : undefined;
  const token = generation.current;
  return { snapshot: value, current: () => committed.current.key === key && committed.current.connected && committed.current.bridge === bridge && token === generation.current };
}
