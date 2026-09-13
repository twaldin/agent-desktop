import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { isDeepStrictEqual } from "node:util";
import { parseForceToolReceipt, type ForceToolState } from "../../../packages/shared/src/force-tool";
import type { HostCommand } from "../../../packages/shared/src/protocol";
import type { CommandRecord } from "./store";

/** A live directive locates its original journal entry; renderer text is never
 * authority to recover an armed command. Native admission rechecks this same
 * epoch/revision after asynchronous setup. This does not reorder native FIFO. */
export function assertForceToolRecoveryCommand(
  command: Extract<HostCommand, { type: "session.prompt" }>,
  state: ForceToolState,
  readCommand: (id: string) => CommandRecord | undefined,
): void {
  const reject = (): never => { throw new Error("The original force command does not authorize this prompt recovery. Inspect its receipt without rearming it."); };
  const guard = command.forceRecovery;
  if (!guard || state.epoch !== guard.epoch || state.revision !== guard.expectedRevision) return reject();
  const directive = state.directives.find(item => item.id === guard.directiveId);
  if (!directive?.commandId || !["pending-tool", "pending-final-response"].includes(directive.phase)) return reject();
  const entry = readCommand(directive.commandId), original = entry?.command, result = entry?.result;
  if (entry?.id !== directive.commandId || entry.state !== "done" || !result || result.commandId !== entry.id
    || result.ok || result.error.code === "OUTCOME_UNKNOWN" || original?.type !== "session.prompt"
    || original.sessionId !== command.sessionId || original.forceRecovery || !result.forceToolReceipt) return reject();
  const receipt = parseForceToolReceipt(result.forceToolReceipt, entry.id);
  if (receipt.arm !== "armed" || receipt.prompt !== "not-recorded" || receipt.epoch !== guard.epoch
    || receipt.directiveId !== guard.directiveId || receipt.toolName !== directive.toolName) return reject();
  const parsed = parseSlashCommand(original.text);
  if (!parsed || lookupBuiltinSlashCommand(parsed.name)?.name !== "force") return reject();
  const space = parsed.args.indexOf(" ");
  if (space < 0 || parsed.args.slice(0, space) !== receipt.toolName
    || !parsed.args.slice(space + 1).trim() || command.text !== parsed.args.slice(space + 1).trim()) return reject();
  if (original.attachments?.length || original.selectedTextAttachments?.length || original.wholeFileAttachments?.length
    || command.attachments?.length || command.selectedTextAttachments?.length || command.wholeFileAttachments?.length
    || command.draft || !isDeepStrictEqual(command.model, original.model)
    || command.thinkingLevel !== original.thinkingLevel || command.approvalMode !== original.approvalMode) return reject();
}
