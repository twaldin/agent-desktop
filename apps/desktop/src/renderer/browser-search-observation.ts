import { parseBrowserObservationOwner, parseBrowserObservationTarget, parseBrowserTargetObservation,
  type BrowserObservationBridge, type BrowserObservationOwner, type BrowserFrameTarget, type BrowserTargetObservation } from "@agent-desktop/shared";
import { readBrowserMetadataLimited } from "./browser-metadata-admission";

export interface BrowserSearchObservationTarget {
  key: string;
  hostId: string;
  owner: BrowserObservationOwner;
  target: BrowserFrameTarget;
}

/** Existing search refresh only. A failed read is not absence; this is not a
 * native event subscription, reconnect lease or complete browser inventory. */
export async function readBrowserSearchObservations(targets: readonly BrowserSearchObservationTarget[], connected: ReadonlySet<string>,
  bridge: BrowserObservationBridge | undefined, signal: AbortSignal): Promise<Map<string, BrowserTargetObservation>> {
  const result = new Map<string, BrowserTargetObservation>();
  if (!bridge || signal.aborted) return result;
  const inspect = bridge.inspect.bind(bridge);
  const pending = targets.filter(value => connected.has(value.hostId)).map(value => ({ key: value.key, hostId: value.hostId,
    owner: parseBrowserObservationOwner(value.owner), target: parseBrowserObservationTarget(value.target) }));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (!signal.aborted) {
      const item = pending[next++]; if (!item) return;
      try {
        const value = await readBrowserMetadataLimited(() => inspect({ ...item.owner }, { ...item.target }, item.hostId), signal);
        if (!signal.aborted) result.set(item.key, parseBrowserTargetObservation(value, item.hostId, item.owner, item.target));
      } catch { /* Retain historical search text; no metadata/acquisition/close fallback. */ }
    }
  }));
  return result;
}
