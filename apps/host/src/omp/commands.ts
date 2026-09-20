import type { NativeForceToolAdmission, NativeForceInvocationScope } from "./force-tool-admission";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { expandPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { expandSlashCommand } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
import { parseCommandArgs } from "@oh-my-pi/pi-coding-agent/utils/command-args";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand, parseSubcommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import { OmpPromptAdmissionError, type NativePromptDispatchResult } from "./prompt";
import { builtinAvailability } from "./composer-actions";
import type { NativeSkillPrompt } from "./skills";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { NativeMcpAuthorizationSnapshot, NativeSessionMcpSnapshot } from "@agent-desktop/shared";
import { formatMcpInspection, type McpInspection } from "./mcp-output";
import type { TodoMutationResult } from "../../../../packages/shared/src/session-todos";

/** Pinned 18.1.10 public native handlers/contexts. AgentSession.prompt catches
 * command exceptions and returns false for both handled commands and abandoned
 * prompts, so its boolean cannot prove command admission. Invoke known native
 * handlers once with their native context to observe the actual return/throw.
 * Only reviewed native text handlers are enabled; ownership transitions remain gated.
 */
export interface NativeCommandBridges {
  forceTool?: Pick<NativeForceToolAdmission, "options" | "dispatch">;
  withNativeForceInvocation?: NativeForceInvocationScope;
  /** Invoked only after exact native extension/custom precedence. */
  plan?: (text: string) => Promise<NativePromptDispatchResult>;
  /** Invoked only after exact native extension/custom precedence. Rejections
   * (TODOS_REJECTED) executed nothing; OUTCOME_UNKNOWN follows admission. */
  todo?: (text: string) => Promise<TodoMutationResult>;
  reloadPlugins?(): Promise<void>;
  reloadMcp(): Promise<void>;
  inspectMcp(): NativeSessionMcpSnapshot;
  reconnectMcp(serverName: string): Promise<NativeSessionMcpSnapshot>;
  authorizeMcp(serverName: string): Promise<NativeMcpAuthorizationSnapshot>;
  unauthorizeMcp?(serverName: string): Promise<{ changed: boolean }>;
}

function formatMcpAuthorization(serverName: string, snapshot: NativeMcpAuthorizationSnapshot): string {
  const success = snapshot.status === "succeeded" && snapshot.reconnected;
  const heading = success ? `Reauthorized "${serverName}"`
    : snapshot.status === "cancelled" ? `Reauthorization cancelled for "${serverName}"`
    : `Reauthorization incomplete for "${serverName}"`;
  const credentials = snapshot.credentialWrite === "stored" ? "stored"
    : snapshot.credentialWrite === "unknown" ? "outcome unknown" : "unchanged";
  const configuration = snapshot.configuration === "not-needed" ? "not needed" : snapshot.configuration;
  return [heading, `Status: ${snapshot.status}`, `Credentials: ${credentials}`, `Configuration: ${configuration}`, `Server: ${snapshot.reconnected ? "connected" : "not connected"}`].join("\n");
}
export async function dispatchNativePrompt(session: AgentSession, text: string, images?: ImageContent[], skill?: NativeSkillPrompt, bridges?: NativeCommandBridges): Promise<NativePromptDispatchResult> {
  if (bridges?.forceTool?.options.forceTool && (!text.startsWith("/") || skill))
    throw new Error("The prepared force command changed before dispatch; no input was executed.");
  if (images?.length && text.trimStart().startsWith("/")) throw new Error("Image attachments are not supported on slash commands yet; no command was executed");
  if (skill) { if (images?.length) throw new Error("Images on native skill invocations are not connected yet; the draft was retained."); return { agentInvoked: await skill.dispatch() }; }
  if (!text.startsWith("/") && text.trimStart().startsWith("/")) throw new Error("Native slash commands must begin at the start of the draft. This input was not sent to a model.");
  if (!text.startsWith("/")) return { agentInvoked: await session.prompt(text, images?.length ? { images } : undefined) };
  // Match the SDK's exact parser; do not trim or reinterpret namespaces/newlines.
  const space = text.indexOf(" ");
  const name = space === -1 ? text.slice(1) : text.slice(1, space);
  const args = space === -1 ? "" : text.slice(space + 1);
  const runner = session.extensionRunner;
  const extension = runner?.getCommand(name);
  if (bridges?.forceTool?.options.forceTool) {
    const selected = parseSlashCommand(text);
    if (extension || session.customCommands.some(command => command.command.name === name)
      || !selected || lookupBuiltinSlashCommand(selected.name)?.name !== "force")
      throw new Error("The prepared native force command no longer owns this input. Refresh before sending.");
  }
  // Native prompt waits on a private manual-compaction cleanup promise. That
  // promise is not a public SDK hook; never run a handler across active native
  // maintenance or abort from this explicit dispatch boundary.
  if (session.isCompacting || session.isAborting) throw new Error("Native session maintenance is still settling; this command was not executed");
  if (extension && runner) {
    try {
      const context = runner.createCommandContext();
      await runner.runScoped(() => extension.handler(args, context));
      return { agentInvoked: false, handledCommand: name };
    } catch (error) {
      runner.emitError({ extensionPath: `command:${name}`, event: "command", error: error instanceof Error ? error.message : String(error) });
      throw new OmpPromptAdmissionError(error);
    }
  }
  const custom = session.customCommands.find(command => command.command.name === name);
  if (!custom) {
    const parsed = parseSlashCommand(text);
    const builtin = parsed && lookupBuiltinSlashCommand(parsed.name);
    if (parsed && builtin) {
      if (builtin.name === "export") throw new Error("Use the owning host HTML export service; direct worker export dispatch is unavailable.");
      if (builtin.name === "plan" || builtin.name === "plan-review") {
        if (!bridges?.plan) throw new Error("The native Plan owner is unavailable; this command was not executed.");
        return bridges.plan(text);
      }
      if (builtin.name === "todo") {
        if (!bridges?.todo) throw new Error("The native Todos owner is unavailable; this command was not executed.");
        let result: TodoMutationResult;
        try { result = await bridges.todo(text); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "OUTCOME_UNKNOWN") throw new OmpPromptAdmissionError(error);
          throw error;
        }
        // The TUI-only verbs return the pinned native usage text; the desktop
        // panel action is a separate durable route, never a claimed TUI run.
        try {
          const commandEntryId = result.output ? session.sessionManager.appendCustomEntry("agent-desktop.command-output", { command: "todo", output: result.output }) : undefined;
          return { agentInvoked: false, handledCommand: "todo", ...(commandEntryId ? { commandEntryId, output: result.output } : {}) };
        } catch (error) { throw new OmpPromptAdmissionError(error); }
      }
      if (builtin.name === "usage" && parseSubcommand(parsed.args).verb === "reset")
        throw new Error("Use Provider usage to select and explicitly confirm a saved reset. This command was not executed.");
      const availability = builtinAvailability(builtin.name, parsed.args);
      const verb = parsed.args.trim().split(/\s+/, 1)[0]?.toLowerCase();
      const desktopMcpAuthorization = builtin.name === "mcp" && verb === "reauth";
      const desktopMcpUnauthorization = builtin.name === "mcp" && verb === "unauth";
      if (availability.availability !== "executable" || !builtin.handle && !desktopMcpAuthorization && !desktopMcpUnauthorization) throw new Error(`Native /${builtin.name} is not connected to the desktop command dispatcher for this invocation. ${availability.reason ?? ""} This input was not executed or sent to a model.`);
      if (builtin.name === "mcp" && verb === "reconnect") {
        if (!bridges) throw new Error("The native MCP reconnect bridge is unavailable; no command was executed.");
        const serverName = parsed.args.trim().split(/\s+/)[1];
        if (!serverName) throw new Error("Server name required. Usage: /mcp reconnect <name>");
        const before = bridges.inspectMcp();
        if (!before.canReconnect || !before.servers.some(server => server.name === serverName))
          throw new Error("The requested server is not available for reconnect in this native session.");
        try {
          const value = await bridges.reconnectMcp(serverName);
          const server = value.servers.find(server => server.name === serverName);
          const output = `Reconnected to "${serverName}"\nTools: ${server?.tools.length ?? 0}`;
          const commandEntryId = session.sessionManager.appendCustomEntry("agent-desktop.command-output", { command: "mcp", output });
          return { agentInvoked: false, handledCommand: "mcp", commandEntryId, output };
        } catch (error) { throw new OmpPromptAdmissionError(error); }
      }
      if (builtin.name === "mcp" && ["resources", "prompts", "notifications"].includes(verb!)) {
        if (!bridges) throw new Error("The native MCP inspection bridge is unavailable; no command was executed.");
        const output = formatMcpInspection(verb as McpInspection, bridges.inspectMcp());
        try {
          const commandEntryId = session.sessionManager.appendCustomEntry("agent-desktop.command-output", { command: "mcp", output });
          return { agentInvoked: false, handledCommand: "mcp", commandEntryId, output };
        } catch (error) { throw new OmpPromptAdmissionError(error); }
      }
      if (desktopMcpUnauthorization) {
        const serverName = parsed.args.trim().split(/\s+/)[1];
        if (!serverName) throw new Error("Server name required. Usage: /mcp unauth <name>");
        if (!bridges?.unauthorizeMcp) throw new Error("The native MCP authorization clearing bridge is unavailable; no command was executed.");
        const before = bridges.inspectMcp();
        if (!before.canForgetAuthorization || !before.servers.some(server => server.name === serverName))
          throw new Error("The requested server is not available for authorization clearing in this native session.");
        try {
          const result = await bridges.unauthorizeMcp(serverName);
          const output = result.changed ? `Cleared stored OAuth authorization for "${serverName}".` : `No stored OAuth authorization to remove for "${serverName}".`;
          const commandEntryId = session.sessionManager.appendCustomEntry("agent-desktop.command-output", { command: "mcp", output });
          return { agentInvoked: false, handledCommand: "mcp", commandEntryId, output };
        } catch (error) { throw new OmpPromptAdmissionError(error); }
      }
      if (desktopMcpAuthorization) {
        // The pinned TUI tokenizes the trimmed command and uses exactly its third
        // token as the server name. Extra tokens are ignored by that controller.
        const serverName = parsed.args.trim().split(/\s+/)[1];
        if (!serverName) throw new Error("Server name required. Usage: /mcp reauth <name>");
        if (!bridges) throw new Error("The native MCP authorization bridge is unavailable; no command was executed.");
        const before = bridges.inspectMcp();
        if (!before.servers.some(server => server.name === serverName && server.canAuthorize)) {
          throw new Error("The requested server is not available for OAuth authorization in this native session.");
        }
        try {
          const snapshot = await bridges.authorizeMcp(serverName);
          const output = formatMcpAuthorization(serverName, snapshot);
          const commandEntryId = session.sessionManager.appendCustomEntry("agent-desktop.command-output", { command: "mcp", output });
          return { agentInvoked: false, handledCommand: "mcp", commandEntryId, output };
        } catch (error) { throw new OmpPromptAdmissionError(error); }
      }
      if (!builtin.handle) throw new Error(`Native /${builtin.name} has no connected command handler; no command was executed.`);
      const reloadMcp = builtin.name === "mcp" && verb === "reload";
      if (reloadMcp && !bridges) throw new Error("The native MCP runtime reload bridge is unavailable; no command was executed.");
      const reloadPlugins = builtin.name === "reload-plugins" || builtin.name === "plugins" && (verb === "enable" || verb === "disable");
      if (reloadPlugins && !bridges?.reloadPlugins) throw new Error("The native plugin reload bridge is unavailable; no command was executed.");
      const chunks: string[] = []; let length = 0;
      const invokeNativeHandler = () => builtin.handle!(parsed, {
        session, sessionManager: session.sessionManager, settings: session.settings, cwd: session.sessionManager.getCwd(),
        output: value => { const remaining = 64 * 1024 - length; if (remaining > 0) { const part = value.slice(0, remaining); chunks.push(part); length += part.length + 1; } },
        refreshCommands: reloadMcp ? () => bridges!.reloadMcp() : () => {}, reloadPlugins: reloadPlugins ? () => bridges!.reloadPlugins!() : async () => {},
      });
      if (builtin.name === "force") {
        if (!bridges?.forceTool) throw new Error("Native force admission is unavailable; no command was executed.");
        const originalHandler = builtin.handle;
        const withResolvedNativeInvocation: NativeForceInvocationScope = operation => {
          // The raw token owns extension/custom precedence; the parser's
          // canonical name alone cannot identify an inline force alias.
          if (session.extensionRunner?.getCommand(name)
            || session.customCommands.some(command => command.command.name === name)
            || lookupBuiltinSlashCommand(parsed.name) !== builtin || builtin.handle !== originalHandler)
            throw new Error("The original native force invocation changed before prompt entry.");
          return bridges.withNativeForceInvocation ? bridges.withNativeForceInvocation(operation) : operation();
        };
        return bridges.forceTool.dispatch(parsed, builtin, invokeNativeHandler, () => chunks.join("\n"), withResolvedNativeInvocation);
      }
      try {
        const result = await invokeNativeHandler();
        if (result && "prompt" in result) return { agentInvoked: await session.prompt(result.prompt) };
        const output = chunks.join("\n");
        const commandEntryId = output ? session.sessionManager.appendCustomEntry("agent-desktop.command-output", { command: builtin.name, output }) : undefined;
        return { agentInvoked: result?.agentInvoked ?? false, handledCommand: builtin.name,
          ...(commandEntryId ? { commandEntryId, output } : {}) };
      } catch (error) { throw new OmpPromptAdmissionError(error); }
    }
    if (session.slashCommands.some(command => command.name === name) || session.promptTemplates.some(command => command.name === name)) return { agentInvoked: await session.prompt(text) };
    throw new Error(`Native /${name.slice(0, 200)} is not a loaded command. Refresh its catalog; this input was not sent to a model.`);
  }
  if (!runner) throw new Error("Native custom-command context is unavailable; the command was not executed");
  let result: string | undefined;
  try {
    const context = runner.createCommandContext();
    result = await custom.command.execute(parseCommandArgs(args), { ...context, hasQueuedMessages: context.hasPendingMessages });
  } catch (error) {
    runner.emitError({ extensionPath: `custom-command:${name}`, event: "command", error: error instanceof Error ? error.message : String(error) });
    throw new OmpPromptAdmissionError(error);
  }
  if (result === undefined || result === "") return { agentInvoked: false, handledCommand: name };
  // Native custom strings are prompt input, not another executable command.
  // Preserve native markdown/template expansion, then skip command re-dispatch.
  const expanded = expandPromptTemplate(expandSlashCommand(result, [...session.slashCommands]), [...session.promptTemplates]);
  return { agentInvoked: await session.prompt(expanded, { expandPromptTemplates: false }) };
}
