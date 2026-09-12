export const SIDEBAR_NAVIGATION_PREFERENCE = "sidebar.navigation" as const;
export const SIDEBAR_NAVIGATION_CAPABILITY = { version: 1 } as const;
export const SIDEBAR_DESTINATION_IDS = ["pull-requests", "scheduled", "plugins", "archive"] as const;
export type SidebarDestinationId = typeof SIDEBAR_DESTINATION_IDS[number];
export interface SidebarNavigationPreference {
  version: 1;
  /** Full order, not the currently available projection. */
  order: SidebarDestinationId[];
  hidden: SidebarDestinationId[];
}
export const DEFAULT_SIDEBAR_NAVIGATION: SidebarNavigationPreference = {
  version: 1, order: [...SIDEBAR_DESTINATION_IDS], hidden: ["archive"],
};
export function parseSidebarNavigation(value: unknown): SidebarNavigationPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sidebar navigation preference.");
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || Object.keys(item).some(key => !["version", "order", "hidden"].includes(key))) throw new Error("Unsupported sidebar navigation preference.");
  const ids = (value: unknown): SidebarDestinationId[] => {
    if (!Array.isArray(value) || value.length > SIDEBAR_DESTINATION_IDS.length || new Set(value).size !== value.length
      || value.some(id => !SIDEBAR_DESTINATION_IDS.includes(id))) throw new Error("Invalid sidebar destination order or visibility.");
    return [...value];
  };
  const order = ids(item.order), hidden = ids(item.hidden);
  if (order.length !== SIDEBAR_DESTINATION_IDS.length) throw new Error("Sidebar navigation must retain every destination.");
  return { version: 1, order, hidden };
}
/** Availability is a render projection only. Selecting a hidden destination temporarily promotes it. */
export function sidebarNavigationLayout<T extends { id: SidebarDestinationId; current?: boolean }>(preference: SidebarNavigationPreference, available: readonly T[]) {
  const byId = new Map(available.map(item => [item.id, item]));
  const ordered = preference.order.flatMap(id => { const item = byId.get(id); return item ? [item] : []; });
  const direct = ordered.filter(item => !preference.hidden.includes(item.id));
  const secondary = ordered.filter(item => preference.hidden.includes(item.id));
  return { ordered, direct: [...direct, ...secondary.filter(item => item.current)], more: secondary.filter(item => !item.current) };
}
export function setSidebarDestinationHidden(value: SidebarNavigationPreference, id: SidebarDestinationId, hidden: boolean): SidebarNavigationPreference {
  return { ...value, hidden: value.order.filter(item => item === id ? hidden : value.hidden.includes(item)) };
}
/** Reorder only the available slots; unavailable destinations retain their exact positions. */
export function reorderSidebarDestinations(value: SidebarNavigationPreference, visibleOrder: readonly SidebarDestinationId[]): SidebarNavigationPreference {
  if (new Set(visibleOrder).size !== visibleOrder.length || visibleOrder.some(id => !value.order.includes(id))) throw new Error("Invalid sidebar reorder.");
  const moved = new Set(visibleOrder);
  let next = 0;
  return { ...value, order: value.order.map(id => moved.has(id) ? visibleOrder[next++]! : id) };
}
/** Reset the eligible destinations, never a temporarily unavailable user's choice. */
export function resetSidebarNavigation(value: SidebarNavigationPreference, available: readonly SidebarDestinationId[]): SidebarNavigationPreference {
  const next = reorderSidebarDestinations(value, SIDEBAR_DESTINATION_IDS.filter(id => available.includes(id)));
  return { ...next, hidden: next.order.filter(id => available.includes(id) ? DEFAULT_SIDEBAR_NAVIGATION.hidden.includes(id) : value.hidden.includes(id)) };
}
