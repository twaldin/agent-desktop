import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { parseBrowserObservationOwner, parseBrowserObservationTarget } from "../../../../packages/shared/src/browser-observation";
import { BrowserObservationTransport } from "./browser-observation-transport";
import type { HostEndpoint } from "./host-transport";

export function registerBrowserObservationHandlers(ipc: Pick<IpcMain, "handle">,
  assertTrusted: (event: IpcMainInvokeEvent) => void, endpointFor: (hostId: string) => Promise<HostEndpoint>): void {
  ipc.handle("host:browser-owner-inspect", async (event, ownerValue: unknown, targetValue: unknown, hostValue: unknown) => {
    assertTrusted(event);
    if (typeof hostValue !== "string" || !hostValue || hostValue.length > 200 || /[\u0000-\u001f\u007f]/.test(hostValue)) throw new Error("Choose the original browser owning host.");
    const owner = parseBrowserObservationOwner(ownerValue), target = parseBrowserObservationTarget(targetValue);
    const endpoint = await endpointFor(hostValue);
    // Final trust/host checks and fetch admission share one continuation.
    assertTrusted(event);
    if (endpoint.hostId !== hostValue) throw new Error("The browser owning host changed.");
    const result = await new BrowserObservationTransport(endpoint, owner).inspect(target);
    assertTrusted(event);
    return result;
  });
}
