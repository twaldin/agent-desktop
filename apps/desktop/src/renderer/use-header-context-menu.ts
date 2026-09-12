import { useEffect, useRef, type MouseEvent } from "react";
import type { DesktopBridge } from "@agent-desktop/shared";
import type { PreferencesState } from "./preferences-state";

/** The menu changes launcher visibility, never the open panel or its tabs. */
export function useHeaderContextMenu(bridge: DesktopBridge, preferences: PreferencesState, active: boolean, onError: (message: string) => void) {
  const epoch = useRef(0), current = useRef({ bridge, preferences, active });
  current.current = { bridge, preferences, active };
  useEffect(() => () => { epoch.current++; }, [bridge, preferences, active]);
  return async (event: MouseEvent) => {
    if (!active || !bridge.showContextMenu || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    const token = ++epoch.current, hostId = preferences.localHostId;
    const checked = preferences.get("general.bottomPanel") !== false;
    const writable = () => preferences.ready && preferences.connected && !preferences.busy && !preferences.pending.length;
    const enabled = writable();
    const ownsMenu = () => token === epoch.current && current.current.active && current.current.bridge === bridge && current.current.preferences === preferences && preferences.localHostId === hostId;
    try {
      const id = await bridge.showContextMenu([{ id: "toggle-bottom-panel-launcher", label: "Bottom panel", type: "checkbox", checked, enabled }]);
      if (!ownsMenu() || id !== "toggle-bottom-panel-launcher" || !enabled || !writable() || (preferences.get("general.bottomPanel") !== false) !== checked) return;
      await preferences.put({ key: "general.bottomPanel", value: !checked });
      if (ownsMenu() && preferences.error) onError(preferences.error);
    } catch (cause) {
      if (ownsMenu()) onError(cause instanceof Error ? cause.message : String(cause));
    }
  };
}
