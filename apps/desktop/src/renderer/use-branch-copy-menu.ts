import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import type { WorkspaceState } from "./workspace-state";

/** The native secondary action copies the row that opened it. A later workspace
 * or branch must not inherit an asynchronous menu selection or clipboard error. */
export function useBranchCopyMenu(workspace: WorkspaceState, branch: string | undefined, enabled: boolean) {
  const epoch = useRef(0), [error, setError] = useState<string>();
  useLayoutEffect(() => {
    epoch.current++; setError(undefined);
    return () => { epoch.current++; };
  }, [workspace, branch, enabled]);
  async function onContextMenu(event: MouseEvent<HTMLButtonElement>) {
    if (!enabled || !branch || event.defaultPrevented) return;
    const view = event.currentTarget.ownerDocument.defaultView;
    const bridge = view?.agentDesktop;
    if (!view || !bridge?.showContextMenu) return;
    event.preventDefault(); event.stopPropagation();
    const token = ++epoch.current;
    setError(undefined);
    try {
      const selected = await bridge.showContextMenu([{ id: "copy-branch-name", label: "Copy branch name" }]);
      if (token !== epoch.current || selected !== "copy-branch-name") return;
      if (!view.navigator.clipboard?.writeText) throw new Error("Clipboard writing is unavailable.");
      await view.navigator.clipboard.writeText(branch);
    } catch (cause) {
      if (token === epoch.current) setError(cause instanceof Error ? cause.message : "Could not copy the branch name.");
    }
  }
  return { onContextMenu, error };
}
