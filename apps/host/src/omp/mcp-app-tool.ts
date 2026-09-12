import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { callTool } from "@oh-my-pi/pi-coding-agent/mcp/client";
import type { MCPServerConnection, MCPToolDefinition, MCPToolCallResult } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { OmpInteractionBridge } from "./interactions";
import { cloneMcpJson } from "../../../../packages/shared/src/session-mcp-app";

/** App calls have JSON protocol arguments, not model-generated harness arguments.
 * They still pass the native extension hooks and the original session's exact
 * tool policy. Only the final transport is bound to the captured connection. */
export async function executeMcpAppTool(session: AgentSession, ui: OmpInteractionBridge | undefined,
  connection: MCPServerConnection, definition: MCPToolDefinition, args: Record<string, unknown>,
  signal: AbortSignal, assertOwner: () => void, metadata?: Record<string, unknown>): Promise<unknown> {
  const ownedMetadata = metadata === undefined ? undefined : cloneMcpJson(metadata, 32_768);
  const runner = session.extensionRunner;
  if (!runner || !ui) throw new Error("This session cannot approve MCP app tool calls.");
  const native = new MCPTool(connection, definition);
  let originalContent: Array<{ type: "text"; text: string }> | undefined;
  const tool = {
    name: native.name, label: native.label, description: native.description,
    parameters: native.parameters, approval: native.approval, strict: native.strict,
    async execute(_id: string, input: unknown) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid MCP app tool arguments.");
      signal.throwIfAborted(); assertOwner();
      const result = ownedMetadata === undefined
        ? await callTool(connection, definition.name, input as Record<string, unknown>, { signal })
        : await connection.transport.request<MCPToolCallResult>("tools/call", { name: definition.name, arguments: input, _meta: ownedMetadata }, { signal });
      // Extensions receive the complete result as details, and a text projection
      // they can replace. Never discard a tool_result content override.
      const details = cloneMcpJson(result) as unknown as MCPToolCallResult;
      originalContent = [{ type: "text" as const, text: JSON.stringify(details) }];
      return { content: originalContent, details, ...(details.isError ? { isError: true } : {}) };
    },
  };
  const result = await ui.runWithSignal(signal, () => new ExtensionToolWrapper(tool, runner).execute(
    crypto.randomUUID(), args, signal, undefined,
    { settings: session.settings, sessionManager: session.sessionManager, cwd: session.sessionManager.getCwd() },
  )).catch(error => { signal.throwIfAborted(); throw error; });
  signal.throwIfAborted(); assertOwner();
  if (result.content !== originalContent) {
    // A native extension changed the visible result (including a blocked/error
    // response). Its replacement wins over the provider's structured payload.
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  }
  return { ...result.details, ...(result.isError ? { isError: true } : {}) };
}
