import { useRepositoryWatch } from "./use-repository-watch";
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { BranchInventory, type BranchInventorySnapshot } from "./branch-inventory";
import type { WorkspaceState } from "./workspace-state";

const empty: BranchInventorySnapshot = { recent: [], loading: false, loaded: false };
const emptySnapshot = () => empty;
const noSubscription = () => () => {};

/** The composer owns these reads after its first explicit open. Closing only
 * retires search/selection; owner replacement, mode exit and unmount stop reads. */
export function useStartingStateInventory(workspace: WorkspaceState | undefined, active: boolean, open: boolean) {
  useRepositoryWatch(workspace, active);
  const controller = useMemo(() => workspace ? new BranchInventory(workspace, "starting-state") : undefined, [workspace]);
  const snapshot = useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getSnapshot ?? emptySnapshot, controller?.getSnapshot ?? emptySnapshot);
  const previous = useRef<{ controller: BranchInventory | undefined; active: boolean; open: boolean } | undefined>(undefined);
  useLayoutEffect(() => {
    const before = previous.current;
    controller?.configure(active);
    if (active && open && before && before.controller === controller && before.active && !before.open) controller?.retry();
    previous.current = { controller, active, open };
  }, [controller, active, open]);
  useLayoutEffect(() => () => controller?.configure(false), [controller]);
  return { controller, snapshot };
}
