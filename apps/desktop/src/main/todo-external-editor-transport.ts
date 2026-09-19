import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { parseTodoExternalEditorRequest } from "../../../../packages/shared/src/todo-external-editor";
import { parseTodoExternalEditorCursor } from "../../../../packages/shared/src/todo-external-editor";
import type { HostEndpoint } from "./host-transport";
import { cancelTodoExternalEditor, recoverTodoExternalEditor, requestTodoExternalEditorCapabilities,
  requestTodoExternalEditorList, requestTodoExternalEditorStatus, startTodoExternalEditor } from "./todo-external-editor-client";

const encoder = new TextEncoder();
function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || encoder.encode(value).byteLength > 200 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`Select the Todo editor request's owning ${label}.`);
  return value;
}
function sameEndpoint(value: HostEndpoint, captured: HostEndpoint): boolean {
  return value.origin === captured.origin && value.hostId === captured.hostId && value.token === captured.token;
}

export function registerTodoExternalEditorHandlers(ipc: Pick<IpcMain, "handle">,
  assertTrusted: (event: IpcMainInvokeEvent) => void,
  endpointFor: (hostId: string) => Promise<HostEndpoint>): void {
  const endpoint = async (event: IpcMainInvokeEvent, hostId: string): Promise<{ live: HostEndpoint; captured: HostEndpoint }> => {
    const live = await endpointFor(hostId);
    assertTrusted(event);
    if (live.hostId !== hostId) throw new Error("The Todo editor request host changed. Refresh its owning host.");
    return { live, captured: { origin: live.origin, hostId: live.hostId, token: live.token } };
  };
  const finish = <T>(event: IpcMainInvokeEvent, live: HostEndpoint, captured: HostEndpoint, value: T): T => {
    assertTrusted(event);
    if (!sameEndpoint(live, captured)) throw new Error("The Todo editor endpoint changed. Refresh its owning host.");
    return value;
  };

  ipc.handle("host:todo-editor-capabilities", async (event, sessionValue: unknown, hostValue: unknown) => {
    assertTrusted(event);
    const sessionId = identity(sessionValue, "conversation"), hostId = identity(hostValue, "host");
    const owner = await endpoint(event, hostId);
    const value = await requestTodoExternalEditorCapabilities(owner.captured, sessionId);
    return finish(event, owner.live, owner.captured, value);
  });
  ipc.handle("host:todo-editor-list", async (event, sessionValue: unknown, hostValue: unknown, cursorValue?: unknown) => {
    assertTrusted(event);
    const sessionId = identity(sessionValue, "conversation"), hostId = identity(hostValue, "host");
    const cursor = cursorValue === undefined ? undefined : parseTodoExternalEditorCursor(cursorValue);
    const owner = await endpoint(event, hostId);
    const value = await requestTodoExternalEditorList(owner.captured, sessionId, cursor);
    return finish(event, owner.live, owner.captured, value);
  });
  for (const [channel, operation] of [
    ["host:todo-editor-start", startTodoExternalEditor],
    ["host:todo-editor-status", requestTodoExternalEditorStatus],
    ["host:todo-editor-cancel", cancelTodoExternalEditor],
    ["host:todo-editor-recovery", recoverTodoExternalEditor],
  ] as const) ipc.handle(channel, async (event, raw: unknown, hostValue: unknown) => {
    assertTrusted(event);
    const request = parseTodoExternalEditorRequest(raw), hostId = identity(hostValue, "host");
    const owner = await endpoint(event, hostId);
    const value = await operation(owner.captured, request);
    return finish(event, owner.live, owner.captured, value);
  });
}
