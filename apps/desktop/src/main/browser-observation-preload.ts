import { parseBrowserObservationOwner, parseBrowserObservationTarget, parseBrowserTargetObservation,
  type BrowserObservationBridge } from "../../../../packages/shared/src/browser-observation";

/** No endpoint, token, retained listener, acquisition or registry mutation. */
export function createBrowserObservationBridge(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): BrowserObservationBridge {
  return { inspect: async (ownerValue, targetValue, hostId) => {
    const owner = parseBrowserObservationOwner(ownerValue), target = parseBrowserObservationTarget(targetValue);
    return parseBrowserTargetObservation(await invoke("host:browser-owner-inspect", { ...owner }, { ...target }, hostId), hostId, owner, target);
  } };
}
