/** Isolated renderer adapter. Host lookup and filesystem opening remain in main. */
export function createProjectRevealBridge(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>) {
  return (projectId: string, hostId: string): Promise<void> => invoke("desktop:project-reveal", projectId, hostId).then(() => undefined);
}
