import type { DockAddAction } from "./DockPanel";
import type { DockState } from "./dock-state";

/** Launcher/menu availability only: the Review command still activates its existing tab. */
export function dockEmptyActionCatalogue(
  actions: readonly (DockAddAction | undefined)[],
  state: DockState,
): DockAddAction[] {
  return actions.filter((action): action is DockAddAction => {
    if (!action) return false;
    return action.id !== "review" || !action.singletonTabId || !(
      state.right.tabIds.includes(action.singletonTabId) || state.bottom.tabIds.includes(action.singletonTabId)
    );
  });
}
