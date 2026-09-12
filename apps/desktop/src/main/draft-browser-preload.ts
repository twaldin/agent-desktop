import type { DraftBrowserBridge } from "@agent-desktop/shared";

/** Used by the isolated preload. No endpoint, token, renderer callback or
 * automatic owner lifecycle is retained here. */
export function createDraftBrowserBridge(invoke: (channel: string, ...args: unknown[]) => Promise<any>): DraftBrowserBridge {
  return {
    acquire: (reference, hostId) => invoke("host:draft-browser-acquire", reference, hostId),
    status: (reference, hostId) => invoke("host:draft-browser-status", reference, hostId),
    retire: (reference, hostId) => invoke("host:draft-browser-retire", reference, hostId),
    create: (reference, request, hostId) => invoke("host:draft-browser-create", reference, request, hostId),
    creationStatus: (reference, request, hostId) => invoke("host:draft-browser-creation-status", reference, request, hostId),
    metadata: (reference, hostId) => invoke("host:draft-browser-metadata", reference, hostId),
    history: (reference, request, hostId) => invoke("host:draft-browser-history", reference, request, hostId),
    frame: (reference, target, hostId) => invoke("host:draft-browser-frame", reference, target, hostId),
    control: (reference, request, hostId) => invoke("host:draft-browser-control", reference, request, hostId),
  };
}
