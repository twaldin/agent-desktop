import type { NativeSessionMcpSnapshot } from "@agent-desktop/shared";

export type McpInspection = "resources" | "prompts" | "notifications";

/** The native TUI reads the live manager's cached lists. Do not call ACP's
 * temporary-connection handlers to produce this session-specific output. */
export function formatMcpInspection(kind: McpInspection, snapshot: NativeSessionMcpSnapshot): string {
  if (!snapshot.available) throw new Error(snapshot.reason ?? "Native MCP manager is unavailable.");
  const lines = [`MCP ${kind[0]!.toUpperCase()}${kind.slice(1)}`];
  const servers = snapshot.servers.filter(server => server.status === "connected");
  if (!servers.length) lines.push("No connected MCP servers.");
  for (const server of servers) {
    lines.push("", `${server.name}:`);
    if (kind === "resources") {
      if (server.resources == null) lines.push("  Resources not yet measured.");
      else for (const resource of server.resources) lines.push(`  ${resource.uri}${resource.mimeType ? ` [${resource.mimeType}]` : ""}${resource.description ? ` ${resource.description}` : ""}`);
      if (server.resourceTemplates == null) lines.push("  Resource templates not yet measured.");
      else if (server.resourceTemplates.length) {
        lines.push("  Templates:");
        for (const template of server.resourceTemplates) lines.push(`    ${template.uriTemplate}${template.description ? ` ${template.description}` : ""}`);
      }
      if (server.resources?.length === 0 && server.resourceTemplates?.length === 0) lines.push("  No resources or templates available.");
    } else if (kind === "prompts") {
      if (server.prompts == null) lines.push("  Prompts not yet measured.");
      else if (!server.prompts.length) lines.push("  No prompts available.");
      else for (const prompt of server.prompts) {
        lines.push(`  /${server.name}:${prompt.name}${prompt.description ? ` ${prompt.description}` : ""}`);
        for (const arg of prompt.arguments ?? []) lines.push(`    ${arg.name}=${arg.required ? " (required)" : ""}${arg.description ? ` - ${arg.description}` : ""}`);
      }
    } else {
      const state = server.notifications;
      if (!state) lines.push("  Notification state not measured.");
      else {
        lines.push(`  Status: ${state.enabled ? "enabled" : "disabled"} (mcp.notifications)`);
        if (state.toolsListChanged) lines.push("  tools/list_changed");
        if (state.resourcesListChanged) lines.push("  resources/list_changed");
        if (state.promptsListChanged) lines.push("  prompts/list_changed");
        if (state.resourceSubscribe) {
          lines.push(`  resources/subscribe: ${state.subscriptions.length} active subscriptions`);
          for (const uri of state.subscriptions) lines.push(`    ${uri}`);
        }
        if (!state.toolsListChanged && !state.resourcesListChanged && !state.promptsListChanged && !state.resourceSubscribe)
          lines.push("  No notification capabilities advertised.");
      }
    }
  }
  const output = lines.join("\n");
  if (output.length > 64 * 1024) throw new Error("Native MCP detail output exceeds the command output limit. Inspect individual servers in settings.");
  return output;
}
