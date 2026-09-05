export type DockDestination = "right" | "bottom";
export type DockTabKind = "review" | "files" | "worktrees" | "terminal" | "browser";
export type DockTarget = `session:${string}` | `project:${string}`;
export interface DockTab { id: string; title: string; kind: DockTabKind; hostId: string; target: DockTarget; terminalId?: string }
export interface DockRegion { tabIds: string[]; activeTabId?: string; open: boolean }
export interface DockState { right: DockRegion; bottom: DockRegion; rightWidthRatio: number; bottomHeight: number }
export interface DockViewport { width: number; height: number; left?: number; top?: number; rightMinWidth?: number }
export const DOCK_BOTTOM_DEFAULT_HEIGHT = 280;
const emptyRegion = (): DockRegion => ({ tabIds: [], open: false });
const other = (destination: DockDestination): DockDestination => destination === "right" ? "bottom" : "right";
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const clone = (state: DockState): DockState => ({ ...state, right: { ...state.right, tabIds: [...state.right.tabIds] }, bottom: { ...state.bottom, tabIds: [...state.bottom.tabIds] } });

export const dockTabId = (tab: Pick<DockTab, "hostId" | "target" | "kind" | "terminalId">) => `${tab.hostId}:${tab.target}:${tab.kind}${tab.terminalId ? `:${tab.terminalId}` : ""}`;
export function createDockState(): DockState { return { right: emptyRegion(), bottom: emptyRegion(), rightWidthRatio: .36, bottomHeight: DOCK_BOTTOM_DEFAULT_HEIGHT }; }
export function validateDockState(value: unknown, tabs: readonly DockTab[], viewport: DockViewport): DockState {
  const fallback = createDockState(); if (!value || typeof value !== "object") return resizeDock(fallback, "bottom", fallback.bottomHeight, viewport);
  const raw = value as Partial<DockState>, known = new Set(tabs.map(tab => tab.id));
  const region = (candidate: unknown): DockRegion => {
    const source = candidate && typeof candidate === "object" ? candidate as Partial<DockRegion> : {};
    const seen = new Set<string>();
    const tabIds = Array.isArray(source.tabIds) ? source.tabIds.filter((id): id is string => typeof id === "string" && known.has(id) && !seen.has(id) && (seen.add(id), true)) : [];
    const activeTabId = typeof source.activeTabId === "string" && tabIds.includes(source.activeTabId) ? source.activeTabId : tabIds[0];
    return { tabIds, activeTabId, open: source.open === true };
  };
  const valid = new Set(tabs.filter(tab => tab.id === dockTabId(tab)).map(tab => tab.id));
  const right = region({ ...(raw.right as object), tabIds: (raw.right as DockRegion | undefined)?.tabIds?.filter(id => valid.has(id)) }), bottom = region({ ...(raw.bottom as object), tabIds: (raw.bottom as DockRegion | undefined)?.tabIds?.filter(id => valid.has(id)) });
  for (const id of right.tabIds) { const at = bottom.tabIds.indexOf(id); if (at >= 0) bottom.tabIds.splice(at, 1); }
  if (bottom.activeTabId && !bottom.tabIds.includes(bottom.activeTabId)) bottom.activeTabId = bottom.tabIds[0];
  const state: DockState = { right, bottom, rightWidthRatio: typeof raw.rightWidthRatio === "number" ? raw.rightWidthRatio : fallback.rightWidthRatio, bottomHeight: typeof raw.bottomHeight === "number" ? raw.bottomHeight : fallback.bottomHeight };
  return resizeDock(resizeDock(state, "right", state.rightWidthRatio * viewport.width, viewport), "bottom", state.bottomHeight, viewport);
}
export function activateDockTab(state: DockState, destination: DockDestination, id: string): DockState { const next = clone(state), region = next[destination]; if (!region.tabIds.includes(id)) return state; region.activeTabId = id; region.open = true; return next; }
export function hideDock(state: DockState, destination: DockDestination): DockState { const next = clone(state); next[destination].open = false; return next; }
export function insertDockTab(state: DockState, tab: DockTab, destination: DockDestination, index?: number, move = false): DockState {
  const currentDestination = state.right.tabIds.includes(tab.id) ? "right" : state.bottom.tabIds.includes(tab.id) ? "bottom" : undefined;
  if (currentDestination && !move) return activateDockTab(state, currentDestination, tab.id);
  const next = clone(state); for (const region of [next.right, next.bottom]) { const current = region.tabIds.indexOf(tab.id); if (current >= 0) region.tabIds.splice(current, 1); if (region.activeTabId === tab.id) region.activeTabId = region.tabIds[current] ?? region.tabIds[current - 1]; }
  const target = next[destination], at = clamp(index ?? target.tabIds.length, 0, target.tabIds.length); target.tabIds.splice(at, 0, tab.id); target.activeTabId = tab.id; target.open = true; return next;
}
export function closeDockTab(state: DockState, destination: DockDestination, id: string): DockState { const next = clone(state), region = next[destination], index = region.tabIds.indexOf(id); if (index < 0) return state; region.tabIds.splice(index, 1); if (region.activeTabId === id) region.activeTabId = region.tabIds[index] ?? region.tabIds[index - 1]; if (!region.tabIds.length) { region.open = false; region.activeTabId = undefined; } return next; }
export function moveDockTab(state: DockState, id: string, destination: DockDestination, index?: number): DockState { const from = state.right.tabIds.includes(id) ? "right" : state.bottom.tabIds.includes(id) ? "bottom" : undefined; if (!from) return state; const next = closeDockTab(state, from, id), target = next[destination], at = clamp(index ?? target.tabIds.length, 0, target.tabIds.length); target.tabIds.splice(at, 0, id); target.activeTabId = id; target.open = true; return next; }
export function reorderDockTab(state: DockState, destination: DockDestination, id: string, index: number): DockState { const region = state[destination], current = region.tabIds.indexOf(id); if (current < 0) return state; const next = clone(state), ids = next[destination].tabIds; ids.splice(current, 1); ids.splice(clamp(index, 0, ids.length), 0, id); return next; }
export function resizeDock(state: DockState, destination: DockDestination, size: number, viewport: DockViewport): DockState { const next = clone(state), width = Math.max(0, viewport.width), height = Math.max(0, viewport.height); if (destination === "bottom") { const max = height / 2, min = Math.min(160, max), fallback = state.bottomHeight; next.bottomHeight = clamp(Number.isFinite(size) ? size : fallback, min, max); } else { const requestedMin = (viewport.rightMinWidth ?? 320) / Math.max(width, 1), requestedMax = 1 - 352 / Math.max(width, 1), max = Math.max(0, requestedMax), min = Math.min(Math.max(0, requestedMin), max), fallback = state.rightWidthRatio * width; next.rightWidthRatio = clamp((Number.isFinite(size) ? size : fallback) / Math.max(width, 1), min, max); } return next; }
export { other as otherDock };
