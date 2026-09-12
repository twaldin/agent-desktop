import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { HostState } from "@agent-desktop/shared";
import type { HostEndpoint } from "./host-transport";

function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Choose a catalogued ${label}.`);
  return value;
}

/** Finder is local to the desktop process. A remote host's path must never be
 * treated as a local path, even when a renderer supplies its project ID. */
export function registerProjectRevealHandler(ipc: Pick<IpcMain, "handle">,
  assertTrusted: (event: IpcMainInvokeEvent) => void,
  localHostId: () => string | undefined,
  endpointFor: (hostId: string) => Promise<HostEndpoint>,
  readState: (endpoint: HostEndpoint) => Promise<HostState>,
  openPath: (path: string) => Promise<string>): void {
  ipc.handle("desktop:project-reveal", async (event, projectValue: unknown, hostValue: unknown) => {
    assertTrusted(event);
    const projectId = identity(projectValue, "project"), hostId = identity(hostValue, "project host");
    if (localHostId() !== hostId) throw new Error("Open this project from its owning desktop host.");
    const endpoint = await endpointFor(hostId);
    assertTrusted(event);
    if (localHostId() !== hostId || endpoint.hostId !== hostId) throw new Error("The selected project host changed. Reconnect before revealing it.");
    const state = await readState(endpoint);
    assertTrusted(event);
    if (localHostId() !== hostId || state.host.id !== hostId) throw new Error("The selected project host changed. Reconnect before revealing it.");
    const project = state.projects.find(candidate => candidate.id === projectId && candidate.hostId === hostId);
    if (!project) throw new Error("The project is no longer in this host's catalog.");
    const error = await openPath(project.path);
    if (error) throw new Error(`Could not open the project directory. ${error}`);
  });
}
