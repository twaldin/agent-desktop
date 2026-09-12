import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import type { DesktopBridge } from "@agent-desktop/shared";
import { McpDirectoryOwner } from "./mcp-directory-owner";
/** Window-local ownership; opening a route or restoring a descriptor does not
 * acquire a native context. Only the explicit Connect/Open call does so. */
export function useMcpDirectoryOwners(bridge: DesktopBridge, connected: (hostId: string, projectId: string | null) => boolean) {
  const state = useMemo(() => ({ owners: new Map<string, McpDirectoryOwner>(), mounted: false }), [bridge.mcpOwner]);
  const committed = useRef(state);
  const [, redraw] = useReducer(value => value + 1, 0);
  useLayoutEffect(() => {
    const previous = committed.current; committed.current = state;
    if (previous !== state) for (const owner of previous.owners.values()) void owner.dispose().catch(() => {});
    for (const owner of state.owners.values()) owner.connected(Boolean(bridge.mcpOwner && owner.bridge === bridge.mcpOwner && connected(owner.hostId, owner.projectId)));
  });
  useEffect(() => {
    state.mounted = true;
    const timer = setInterval(() => { for (const owner of state.owners.values()) void owner.refresh(); }, 500);
    return () => { state.mounted = false; clearInterval(timer); queueMicrotask(() => { if (!state.mounted) { for (const owner of state.owners.values()) void owner.dispose().catch(() => {}); state.owners.clear(); } }); };
  }, [state]);
  return (hostId: string, projectId: string | null): McpDirectoryOwner | undefined => {
    if (!bridge.mcpOwner) return;
    const key = JSON.stringify([hostId, projectId]); let owner = state.owners.get(key);
    if (!owner) { owner = new McpDirectoryOwner(bridge.mcpOwner, hostId, projectId); owner.subscribe(() => { if (state.mounted) redraw(); }); state.owners.set(key, owner); }
    return owner;
  };
}
