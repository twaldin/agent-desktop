import type { BrowserCloseBridge } from "../../../../packages/shared/src/browser-close";

/** No endpoint, credentials, retained callbacks or automatic owner lifecycle. */
export function createBrowserCloseBridge(invoke: (channel: string, ...args: unknown[]) => Promise<any>): BrowserCloseBridge {
  return {
    close: (owner, request, hostId) => invoke("host:browser-owner-close", owner, request, hostId),
    status: (owner, request, hostId) => invoke("host:browser-owner-status", owner, request, hostId),
  };
}
