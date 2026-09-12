import { dockTabId, type DockDestination, type DockTab } from "./dock-state";
import type { DockSnapshot } from "./use-workbench-dock";

/** Runtime presentation identity is separate from durable native/file identity.
 * Keeping both in one React state value observes close/reopen in a batched update. */
export interface DockPresentations {
  snapshot: DockSnapshot;
  instances: ReadonlyMap<string, string>;
}
export interface DockPresentationRef {
  tabId: string;
  instanceId: string;
  destination: DockDestination;
  hostId: string;
  target: DockTab["target"];
  kind: DockTab["kind"];
}

function liveTab(snapshot: DockSnapshot, id: string): { tab: DockTab; destination: DockDestination } | undefined {
  const tabs = snapshot.tabs.filter(tab => tab.id === id);
  const destinations = (["right", "bottom"] as const).filter(destination => snapshot.state[destination].tabIds.includes(id));
  if (tabs.length !== 1 || destinations.length !== 1) return;
  const tab = tabs[0]!;
  if (dockTabId(tab) !== id || snapshot.state[destinations[0]!].tabIds.filter(value => value === id).length !== 1) return;
  return { tab, destination: destinations[0]! };
}

/** seed is allocated once outside the functional updater, so updater re-execution
 * cannot assign different identities for the same state transition. Incoming
 * snapshots cannot import presentation identities from another window. */
export function reconcileDockPresentations(previous: DockPresentations | undefined, snapshot: DockSnapshot, seed: string): DockPresentations {
  if (previous?.snapshot === snapshot) return previous;
  const instances = new Map<string, string>();
  for (const tab of snapshot.tabs) {
    if (!liveTab(snapshot, tab.id)) continue;
    const old = previous && liveTab(previous.snapshot, tab.id)?.tab;
    const retained = old && old.hostId === tab.hostId && old.target === tab.target && old.kind === tab.kind
      ? previous!.instances.get(tab.id) : undefined;
    instances.set(tab.id, retained ?? JSON.stringify([seed, tab.id]));
  }
  return { snapshot, instances };
}

export function captureDockPresentation(state: DockPresentations, tabId: string): DockPresentationRef | undefined {
  const live = liveTab(state.snapshot, tabId), instanceId = state.instances.get(tabId);
  if (!live || !instanceId) return;
  return { tabId, instanceId, destination: live.destination, hostId: live.tab.hostId, target: live.tab.target, kind: live.tab.kind };
}

/** Location and incarnation both matter. Moving preserves the identity, while a
 * saved suggestion for the old region must still fail destination revalidation. */
export function isCurrentDockPresentation(state: DockPresentations, reference: DockPresentationRef): boolean {
  const current = captureDockPresentation(state, reference.tabId);
  return Boolean(current && current.instanceId === reference.instanceId && current.destination === reference.destination
    && current.hostId === reference.hostId && current.target === reference.target && current.kind === reference.kind);
}
