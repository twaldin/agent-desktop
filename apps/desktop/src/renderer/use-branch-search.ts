import type { WorkspaceState } from "./workspace-state";
import { useRepositoryWatch } from "./use-repository-watch";
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { BranchSearch, type BranchPickerMode } from "./branch-search";

export function useBranchSearch(workspace: WorkspaceState, query: string, active: boolean, mode: BranchPickerMode = "checkout") {
  useRepositoryWatch(workspace, active && Boolean(query.trim()));
  const controller = useMemo(() => new BranchSearch(workspace, mode), [workspace, mode]);
  const observed = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => {
    controller.configure(query, active);
    return () => controller.configure("", false);
  }, [controller, query, active]);
  // Never display the prior query's rows in the render preceding its commit.
  const snapshot = active && observed.query === query.trim() ? observed
    : { query: query.trim(), branches: [], loading: active && Boolean(query.trim()), limitReached: false };
  return { controller, snapshot };
}
