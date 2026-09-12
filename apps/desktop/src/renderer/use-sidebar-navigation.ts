import { useEffect, useMemo, useReducer } from "react";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import { offlineCache } from "./offline-cache";
import { SidebarNavigationState } from "./sidebar-navigation-state";

export function useSidebarNavigation(bridge: DesktopBridge, localHostId: string | undefined, connected: boolean, supported: boolean) {
  const [, redraw] = useReducer(value => value + 1, 0);
  const data = useMemo(() => localHostId ? new SidebarNavigationState(localHostId, bridge, offlineCache, {
    read: key => localStorage.getItem(key), write: (key, value) => localStorage.setItem(key, value),
  }) : undefined, [bridge, localHostId]);
  useEffect(() => {
    if (!data) return;
    const off = data.subscribe(redraw);
    data.setConnection(localHostId, connected, supported);
    data.start();
    void data.refresh();
    return () => { off(); data.stop(); };
  }, [data, localHostId, connected, supported]);
  return data;
}
