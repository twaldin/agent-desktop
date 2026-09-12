import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { parseBrowserCreateRequest, parseBrowserControlRequest, parseDraftBrowserOwnerReference, validBrowserFrameTarget } from "@agent-desktop/shared";
import { DraftBrowserTransport } from "./draft-browser-transport";
import type { HostEndpoint } from "./host-transport";

/** Register only explicit draft-owner operations. Closing a renderer does not
 * retire a host owner or cancel/replay an already submitted operation. */
export function registerDraftBrowserHandlers(ipc: Pick<IpcMain, "handle">,
  assertTrusted: (event: IpcMainInvokeEvent) => void,
  endpointFor: (hostId: string) => Promise<HostEndpoint>) {
  async function connect(event: IpcMainInvokeEvent, reference: unknown, hostId: unknown) {
    assertTrusted(event);
    if (typeof hostId !== "string" || !hostId || hostId.length > 200 || /[\u0000-\u001f\u007f]/.test(hostId)) throw new Error("Choose the draft browser owning host.");
    const original = parseDraftBrowserOwnerReference(reference);
    const endpoint = await endpointFor(hostId);
    // Discovery may outlive the invoking frame. Do not start a request for it.
    assertTrusted(event);
    if (endpoint.hostId !== hostId) throw new Error("The draft browser host changed.");
    return new DraftBrowserTransport(endpoint, original);
  }
  for (const action of ["acquire", "status", "retire"] as const) {
    ipc.handle(`host:draft-browser-${action}`, async (event, reference: unknown, hostId: unknown) =>
      (await connect(event, reference, hostId)).owner(action));
  }
  ipc.handle("host:draft-browser-metadata", async (event, reference: unknown, hostId: unknown) =>
    (await connect(event, reference, hostId)).metadata());
  ipc.handle("host:draft-browser-create", async (event, reference: unknown, request: unknown, hostId: unknown) => {
    assertTrusted(event);
    const input = parseBrowserCreateRequest(request);
    return (await connect(event, reference, hostId)).create(input);
  });
  ipc.handle("host:draft-browser-creation-status", async (event, reference: unknown, request: unknown, hostId: unknown) => {
    assertTrusted(event);
    const input = parseBrowserCreateRequest(request);
    return (await connect(event, reference, hostId)).creationStatus(input);
  });
  ipc.handle("host:draft-browser-frame", async (event, reference: unknown, target: unknown, hostId: unknown) => {
    assertTrusted(event);
    if (!validBrowserFrameTarget(target)) throw new Error("Choose the original browser viewport.");
    const input = { workerPid: target.workerPid, name: target.name, targetId: target.targetId };
    return (await connect(event, reference, hostId)).frame(input);
  });
  ipc.handle("host:draft-browser-control", async (event, reference: unknown, request: unknown, hostId: unknown) => {
    assertTrusted(event);
    const input = parseBrowserControlRequest(request);
    return (await connect(event, reference, hostId)).control(input);
  });
}
