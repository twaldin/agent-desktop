import { useLayoutEffect } from "react";
import type { WorkspaceState } from "./workspace-state";

/** Only committed enabled query observers acquire. Popup visibility is not a
 * substitute for the owning hook's retained/ever-open eligibility. */
export function useRepositoryWatch(workspace: WorkspaceState | undefined, active: boolean): void {
  useLayoutEffect(() => active && workspace ? workspace.retainRepositoryWatch() : undefined, [workspace, active]);
}
