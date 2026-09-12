import { cloneMcpJson, mcpUiResourceUri, type McpArtifact, type McpJson, type TranscriptMessage } from "@agent-desktop/shared";

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Reads the actual persisted result. Live catalogues and formatted tool text
 * cannot manufacture metadata that was not retained for this invocation. */
export function nativeMcpArtifact(entryId: string, message: unknown): McpArtifact | undefined {
  const source = record(message), outer = record(source?.details);
  if (source?.role !== "toolResult" || !outer) return;
  // Native xd:// execution preserves the actual MCP details in its explicit
  // dispatch envelope. Help/read output and display text are not invocations.
  const dispatch = record(outer.xdev);
  const details = dispatch ? dispatch.mode === "execute" && typeof dispatch.tool === "string" && dispatch.tool.startsWith("mcp__") ? record(dispatch.inner) : undefined : outer;
  if (!details) return;
  const resourceUri = mcpUiResourceUri(details.mcpMeta) ?? mcpUiResourceUri(details.mcpToolMeta);
  if (!resourceUri) return;
  const identity = (value: unknown): string => {
    if (typeof value !== "string" || !value || value.includes("\0") || new TextEncoder().encode(value).length > 1024) throw new Error("The saved MCP app identity is invalid.");
    return value;
  };
  if (!Array.isArray(details.rawContent)) throw new Error("This result has no retained MCP content.");
  const raw = { content: details.rawContent,
    ...(details.structuredContent === undefined ? {} : { structuredContent: details.structuredContent }),
    ...(details.mcpMeta === undefined ? {} : { _meta: details.mcpMeta }),
    ...(typeof source.isError === "boolean" ? { isError: source.isError } : typeof details.isError === "boolean" ? { isError: details.isError } : {}),
  };
  const value: McpArtifact = { entryId, serverName: identity(details.serverName), toolName: identity(details.mcpToolName), resourceUri,
    result: cloneMcpJson(raw) as Record<string, McpJson> };
  if (details.mcpArguments !== undefined) {
    if (!record(details.mcpArguments)) throw new Error("The saved MCP invocation arguments are invalid.");
    value.arguments = cloneMcpJson(details.mcpArguments, 32_768) as Record<string, McpJson>;
  }
  return value;
}

export function projectMcpArtifacts(messages: TranscriptMessage[], entries: readonly { id: string; type: string; message?: unknown }[]): void {
  const visible = new Map(messages.filter(message => message.nativeId && message.role === "toolResult").map(message => [message.nativeId!, message]));
  for (const entry of entries) {
    const target = visible.get(entry.id);
    if (entry.type !== "message" || !target) continue;
    try { const artifact = nativeMcpArtifact(entry.id, entry.message); if (artifact) target.mcpArtifact = artifact; }
    catch { target.mcpArtifactError = "The saved app result is unavailable or exceeds its display limit. The tool has not been rerun."; }
  }
}
