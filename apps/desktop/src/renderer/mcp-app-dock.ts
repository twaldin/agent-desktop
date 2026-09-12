import { parseNativeMcpAppDescriptor, type NativeMcpAppDescriptor } from "@agent-desktop/shared";
import { dockTabId, type DockTab } from "./dock-state";
export interface McpDockApp extends NativeMcpAppDescriptor { instanceId: string; serverName: string }
export function parseMcpDockApp(value: unknown): McpDockApp {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved MCP app.");
  const { instanceId, serverName, ...descriptor } = value as Record<string, unknown>;
  if (typeof instanceId !== "string" || !/^[a-zA-Z0-9-]{1,200}$/.test(instanceId)
    || typeof serverName !== "string" || !serverName || serverName.length > 1024 || serverName.includes("\0")) throw new Error("Invalid saved MCP app owner.");
  return { ...parseNativeMcpAppDescriptor(descriptor), instanceId, serverName };
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
