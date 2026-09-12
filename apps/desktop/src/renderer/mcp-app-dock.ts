import { mcpViewerExtension, parseNativeMcpAppDescriptor, parseNativeMcpAppSource, type McpArtifact, type NativeMcpAppDescriptor, type NativeMcpAppSource, type NativeSessionMcpSnapshot, type NativeMcpFileViewer } from "@agent-desktop/shared";
import { dockTabId, type DockTab } from "./dock-state";
export interface McpDockApp extends NativeMcpAppDescriptor { instanceId: string; serverName: string; source?: NativeMcpAppSource }
export function parseMcpDockApp(value: unknown): McpDockApp {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved MCP app.");
  const { instanceId, serverName, source, ...descriptor } = value as Record<string, unknown>;
  if (typeof instanceId !== "string" || !/^[a-zA-Z0-9-]{1,200}$/.test(instanceId)
    || typeof serverName !== "string" || !serverName || serverName.length > 1024 || serverName.includes("\0")) throw new Error("Invalid saved MCP app owner.");
  return { ...parseNativeMcpAppDescriptor(descriptor), instanceId, serverName, ...(source === undefined ? {} : { source: parseNativeMcpAppSource(source) }) };
}
export function mcpAppDockTab(hostId: string, sessionId: string, app: NativeMcpAppDescriptor, serverName: string): DockTab {
  const mcpApp = parseMcpDockApp({ ...app, serverName, instanceId: crypto.randomUUID() });
  const value = { kind: "mcp-app" as const, hostId, target: `session:${sessionId}` as const, title: app.title, mcpApp };
  return { ...value, id: dockTabId(value) };
}

/** Catalogue action identity is separate from each newly opened presentation. */
export function mcpAppActionId(hostId: string, sessionId: string, serverName: string, toolName: string): string {
  return JSON.stringify(["mcp-app", hostId, sessionId, serverName, toolName]);
}
export function mcpArtifactDockTab(hostId: string, sessionId: string, artifact: McpArtifact): DockTab {
  const tab = mcpAppDockTab(hostId, sessionId, { toolName: artifact.toolName, title: `${artifact.toolName} result`, resourceUri: artifact.resourceUri }, artifact.serverName);
  tab.mcpApp = parseMcpDockApp({ ...tab.mcpApp, source: { type: "artifact", entryId: artifact.entryId } });
  return tab;
}

export function mcpFileViewerForPath(snapshot: NativeSessionMcpSnapshot | undefined, path: string): { serverName: string; viewer: NativeMcpFileViewer } | undefined {
  if (!snapshot?.canOpenApps) return;
  let selected: { serverName: string; viewer: NativeMcpFileViewer } | undefined, length = 0;
  for (const server of snapshot.servers) {
    if (server.status !== "connected") continue;
    for (const viewer of server.fileViewers ?? []) {
      const match = mcpViewerExtension(path, viewer.extensions);
      if (match && match.length > length) { selected = { serverName: server.name, viewer }; length = match.length; }
    }
  }
  return selected;
}
export function mcpFileViewerDockTab(hostId: string, sessionId: string, path: string, viewer: NativeMcpFileViewer, serverName: string): DockTab {
  const { extensions: _extensions, ...app } = viewer;
  const tab = mcpAppDockTab(hostId, sessionId, { ...app, title: path.split("/").at(-1)! }, serverName);
  tab.mcpApp = parseMcpDockApp({ ...tab.mcpApp, source: { type: "file", path, resourceUri: `codex-resource://${crypto.randomUUID()}` } });
  return tab;
}
