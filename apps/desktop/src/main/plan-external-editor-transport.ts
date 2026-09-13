import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { parsePlanExternalEditorRequest } from "../../../../packages/shared/src/plan-external-editor";
import { parsePlanExternalEditorCursor } from "../../../../packages/shared/src/plan-external-editor";
import type { HostEndpoint } from "./host-transport";
import { cancelPlanExternalEditor, recoverPlanExternalEditor, requestPlanExternalEditorCapabilities,
  requestPlanExternalEditorList, requestPlanExternalEditorStatus, startPlanExternalEditor } from "./plan-external-editor-client";

const encoder = new TextEncoder();
function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || encoder.encode(value).byteLength > 200 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`Select the Plan editor request's owning ${label}.`);
  return value;
}
function sameEndpoint(value: HostEndpoint, captured: HostEndpoint): boolean {
  return value.origin === captured.origin && value.hostId === captured.hostId && value.token === captured.token;
}

export function registerPlanExternalEditorHandlers(ipc: Pick<IpcMain, "handle">,
  assertTrusted: (event: IpcMainInvokeEvent) => void,
  endpointFor: (hostId: string) => Promise<HostEndpoint>): void {
  const endpoint = async (event: IpcMainInvokeEvent, hostId: string): Promise<{ live: HostEndpoint; captured: HostEndpoint }> => {
    const live = await endpointFor(hostId);
    assertTrusted(event);
    if (live.hostId !== hostId) throw new Error("The Plan editor request host changed. Refresh its owning host.");
    return { live, captured: { origin: live.origin, hostId: live.hostId, token: live.token } };
  };
  const finish = <T>(event: IpcMainInvokeEvent, live: HostEndpoint, captured: HostEndpoint, value: T): T => {
    assertTrusted(event);
    if (!sameEndpoint(live, captured)) throw new Error("The Plan editor endpoint changed. Refresh its owning host.");
    return value;
  };

  ipc.handle("host:plan-editor-capabilities", async (event, sessionValue: unknown, hostValue: unknown) => {
    assertTrusted(event);
    const sessionId = identity(sessionValue, "conversation"), hostId = identity(hostValue, "host");
    const owner = await endpoint(event, hostId);
    const value = await requestPlanExternalEditorCapabilities(owner.captured, sessionId);
    return finish(event, owner.live, owner.captured, value);
  });
  ipc.handle("host:plan-editor-list", async (event, sessionValue: unknown, hostValue: unknown, cursorValue?: unknown) => {
    assertTrusted(event);
    const sessionId = identity(sessionValue, "conversation"), hostId = identity(hostValue, "host");
    const cursor = cursorValue === undefined ? undefined : parsePlanExternalEditorCursor(cursorValue);
    const owner = await endpoint(event, hostId);
    const value = await requestPlanExternalEditorList(owner.captured, sessionId, cursor);
    return finish(event, owner.live, owner.captured, value);
  });
  for (const [channel, operation] of [
    ["host:plan-editor-start", startPlanExternalEditor],
    ["host:plan-editor-status", requestPlanExternalEditorStatus],
    ["host:plan-editor-cancel", cancelPlanExternalEditor],
    ["host:plan-editor-recovery", recoverPlanExternalEditor],
  ] as const) ipc.handle(channel, async (event, raw: unknown, hostValue: unknown) => {
    assertTrusted(event);
    const request = parsePlanExternalEditorRequest(raw), hostId = identity(hostValue, "host");
    const owner = await endpoint(event, hostId);
    const value = await operation(owner.captured, request);
    return finish(event, owner.live, owner.captured, value);
  });
}
