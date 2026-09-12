import type { DockAddAction } from "./DockPanel";
import type { DockState } from "./dock-state";

/** Launcher/menu availability only: the Review command still activates its existing tab. */
export function dockEmptyActionCatalogue(
  actions: readonly (DockAddAction | undefined)[],
  state: DockState,
  gitRepository = false,
): DockAddAction[] {
  const available = actions.filter((action): action is DockAddAction => {
    if (!action) return false;
    return action.id !== "review" || !action.singletonTabId || !(
      state.right.tabIds.includes(action.singletonTabId) || state.bottom.tabIds.includes(action.singletonTabId)
    );
  });
  if (!gitRepository) return available;
  // Unranked contributions keep their declaration order after the Git tools.
  const order = ["review", "terminal", "browser", "files"];
  const rank = (action: DockAddAction) => {
    const index = order.indexOf(action.id);
    return index < 0 ? order.length : index;
  };
  return available.sort((a, b) => rank(a) - rank(b));
}
