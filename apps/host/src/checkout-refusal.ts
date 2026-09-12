import type { CommandResult, HostCommand } from "../../../packages/shared/src/protocol";
import { isGitCheckoutAction, readGitCheckoutRefusal } from "../../../packages/shared/src/checkout-refusal";
import { GitCheckoutBlockedError } from "./workspace/service";

/** Narrow projection in the existing ordered command/receipt path. It neither
 * executes nor retries Git and cannot turn an unrelated failure into a refusal. */
export function checkoutRefusalResult(commandId: string, command: HostCommand, cause: unknown): CommandResult | undefined {
  if (command.type !== "workspace.mutate" || !isGitCheckoutAction(command.action) || !(cause instanceof GitCheckoutBlockedError)) return;
  const error = readGitCheckoutRefusal({ code: cause.code, message: cause.message, checkoutConflict: { conflictedPaths: cause.conflictedPaths } });
  if (!error) return;
  return { ok: false, commandId, error };
}
