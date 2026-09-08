import { parseStandaloneFilePath } from "@agent-desktop/shared";
import type { WorkspaceState } from "./workspace-state";
import type { TranscriptLinkActions, WorkspaceFileLink } from "./transcript-links";

type HostFileWorkspace = Pick<WorkspaceState, "connected" | "query" | "mutate" | "pending" | "errors" | "cacheWarning" | "saveCopy">;

/** Reuse the workspace's durable command queue and its owning host, even with the dock closed. */
export function transcriptHostFileActions(data: Pick<WorkspaceState, "connected" | "query" | "mutate" | "pending" | "errors" | "cacheWarning">): Pick<TranscriptLinkActions, "fileOpenOptions" | "openFileOnHost"> {
  const fileOpenOptions = async (file: WorkspaceFileLink) => {
    if (!data.connected) throw new Error("Reconnect to the owning host to open this file.");
    const result = await data.query({ type: "file.open-options", path: file.path });
    if (result.type !== "file.open-options" || result.path !== file.path) throw new Error("The host returned Open options for a different file.");
    return result;
  };
  return { fileOpenOptions, openFileOnHost: async (file, targetId) => {
    // Editors have no location contract yet. An explicit Reveal action intentionally targets only the file.
    if (targetId !== "fileManager" && (file.line !== undefined || file.column !== undefined || file.endLine !== undefined)) throw new Error("Opening a line location in an external application is not supported yet. Open it in the app instead.");
    const options = await fileOpenOptions(file);
    const selected = targetId ?? options.preferredTargetId ?? "fileManager";
    if (!options.targets.some(target => target.id === selected)) throw new Error(options.availabilityReason ?? "This application is unavailable on the file’s host.");
    if (!data.connected) throw new Error("Reconnect to the owning host to open this file.");
    const admitted = await data.mutate({ type: "file.open", path: file.path, targetId: selected });
    if (!admitted || data.pending || data.errors.action) throw new Error(data.errors.action ?? data.cacheWarning ?? (data.pending ? "The open outcome is unresolved. Inspect the existing workspace action before trying again." : "A pending workspace action must finish before this file can be opened."));
  }};
}

/** Route an absolute transcript path through its exact standalone-file owner.
 * Relative paths retain the session workspace selected by the caller.
 */
export function routedTranscriptHostFileActions(getWorkspace: (file: WorkspaceFileLink) => HostFileWorkspace): Pick<TranscriptLinkActions, "fileOpenOptions" | "openFileOnHost" | "saveFileCopy"> {
  const routed = (file: WorkspaceFileLink) => {
    if (!file.path.startsWith("/")) return { data: getWorkspace(file), file };
    const path = parseStandaloneFilePath(file.path);
    const transport = { ...file, path: path.slice(path.lastIndexOf("/") + 1) };
    return { data: getWorkspace(file), file: transport };
  };
  return {
    fileOpenOptions: async file => {
      const route = routed(file);
      const result = await transcriptHostFileActions(route.data).fileOpenOptions!(route.file);
      return { ...result, path: file.path };
    },
    openFileOnHost: async (file, targetId) => {
      const route = routed(file);
      await transcriptHostFileActions(route.data).openFileOnHost!(route.file, targetId);
    },
    saveFileCopy: async file => {
      const route = routed(file);
      await route.data.saveCopy(route.file.path);
    },
  };
}
