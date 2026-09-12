import type { McpJson } from "./session-mcp-app";

/** A retained native invocation, not a request to execute that tool again. */
export interface McpArtifact {
  entryId: string;
  serverName: string;
  toolName: string;
  resourceUri: string;
  arguments?: Record<string, McpJson>;
  result: Record<string, McpJson>;
}

/** Result metadata takes precedence over the invocation's declared UI. */
export function mcpUiResourceUri(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
  const meta = metadata as Record<string, unknown>;
  const ui = meta.ui && typeof meta.ui === "object" && !Array.isArray(meta.ui) ? meta.ui as Record<string, unknown> : undefined;
  const uri = ui?.resourceUri ?? meta["ui/resourceUri"] ?? meta["openai/outputTemplate"];
  return typeof uri === "string" && uri.startsWith("ui://") && new TextEncoder().encode(uri).byteLength <= 16_384 && !uri.includes("\0") ? uri : undefined;
}
