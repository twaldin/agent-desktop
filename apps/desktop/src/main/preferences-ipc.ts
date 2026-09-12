import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { PreferencesSnapshotV2, PreferencesV2ReadResult } from "../../../../packages/shared/src/preferences-v2";
import { nativeTerminalResult } from "./host-transport";

/** Preserves the HTTP status that Electron would otherwise strip from HostRequestError. */
export function registerPreferencesV2Handler(ipc: Pick<IpcMain, "handle">,
  assertTrusted: (event: IpcMainInvokeEvent) => void,
  request: (path: string) => Promise<unknown>): void {
  ipc.handle("host:preferences-v2", async event => {
    assertTrusted(event);
    return nativeTerminalResult(() => request("/v2/preferences") as Promise<PreferencesSnapshotV2>) as Promise<PreferencesV2ReadResult>;
  });
}
