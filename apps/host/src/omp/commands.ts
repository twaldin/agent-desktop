import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { expandPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { expandSlashCommand } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
import { parseCommandArgs } from "@oh-my-pi/pi-coding-agent/utils/command-args";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import { OmpPromptAdmissionError, type NativePromptDispatchResult } from "./prompt";
import { builtinAvailability } from "./composer-actions";
import type { NativeSkillPrompt } from "./skills";
import type { ImageContent } from "@oh-my-pi/pi-ai";

/** Pinned 18.1.10 public native handlers/contexts. AgentSession.prompt catches
 * command exceptions and returns false for both handled commands and abandoned
 * prompts, so its boolean cannot prove command admission. Invoke known native
 * handlers once with their native context to observe the actual return/throw.
 * Only reviewed native text handlers are enabled; ownership transitions remain gated.
 */
export async function dispatchNativePrompt(session: AgentSession, text: string, images?: ImageContent[], skill?: NativeSkillPrompt): Promise<NativePromptDispatchResult> {
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
      const availability = builtinAvailability(builtin.name, parsed.args);
      if (availability.availability !== "executable" || !builtin.handle) throw new Error(`Native /${builtin.name} is not connected to the desktop command dispatcher for this invocation. ${availability.reason ?? ""} This input was not executed or sent to a model.`);
      const chunks: string[] = []; let length = 0;
      try {
        const result = await builtin.handle(parsed, {
          session, sessionManager: session.sessionManager, settings: session.settings, cwd: session.sessionManager.getCwd(),
          output: value => { const remaining = 64 * 1024 - length; if (remaining > 0) { const part = value.slice(0, remaining); chunks.push(part); length += part.length + 1; } },
          refreshCommands: () => {}, reloadPlugins: async () => { throw new Error("Coordinated native plugin reload is not connected."); },
        });
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
