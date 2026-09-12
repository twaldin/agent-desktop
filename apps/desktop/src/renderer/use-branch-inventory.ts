import { useRepositoryWatch } from "./use-repository-watch";
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { BranchInventory } from "./branch-inventory";
import type { WorkspaceState } from "./workspace-state";

export function useBranchInventory(workspace: WorkspaceState, active: boolean, mode: "checkout" | "starting-state" = "checkout") {
  useRepositoryWatch(workspace, active);
  const controller = useMemo(() => new BranchInventory(workspace, mode), [workspace, mode]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => {
    controller.configure(active);
    return () => controller.configure(false);
  }, [controller, active]);
  return { controller, snapshot };
}
