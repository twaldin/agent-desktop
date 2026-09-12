import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { parseBrowserCloseOwner, parseBrowserCloseRequest } from "../../../../packages/shared/src/browser-close";
import { BrowserCloseTransport } from "./browser-close-transport";
import type { HostEndpoint } from "./host-transport";

export function registerBrowserCloseHandlers(ipc: Pick<IpcMain, "handle">,
  assertTrusted: (event: IpcMainInvokeEvent) => void, endpointFor: (hostId: string) => Promise<HostEndpoint>): void {
  for (const action of ["close", "status"] as const) {
    ipc.handle(`host:browser-owner-${action}`, async (event, ownerValue: unknown, requestValue: unknown, hostValue: unknown) => {
      assertTrusted(event);
      if (typeof hostValue !== "string" || !hostValue || hostValue.length > 200 || /[\u0000-\u001f\u007f]/.test(hostValue)) throw new Error("Choose the original browser owning host.");
      const owner = parseBrowserCloseOwner(ownerValue), request = parseBrowserCloseRequest(requestValue);
      const endpoint = await endpointFor(hostValue);
      // Final trust/host checks and fetch admission share this continuation, with no intervening await.
      assertTrusted(event);
      if (endpoint.hostId !== hostValue) throw new Error("The browser owning host changed.");
      const transport = new BrowserCloseTransport(endpoint, owner);
      return action === "close" ? transport.close(request) : transport.status(request);
    });
  }
}
