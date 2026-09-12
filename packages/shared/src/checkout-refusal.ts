import type { WorkspaceMutation } from "./workspace-protocol";

export type GitCheckoutAction = Extract<WorkspaceMutation, { type: "git.checkout" | "git.checkout-ref" | "git.checkout-revision" }>;
export function isGitCheckoutAction(action: WorkspaceMutation): action is GitCheckoutAction {
  return action.type === "git.checkout" || action.type === "git.checkout-ref" || action.type === "git.checkout-revision";
}
export interface GitCheckoutRefusalError {
  code: "GIT_CHECKOUT_BLOCKED";
  message: string;
  checkoutConflict: { conflictedPaths: string[] };
}
/** Ordinary failures have no continuation signal. A claimed but malformed
 * refusal must not release an original command as a confirmed negative. */
export function readGitCheckoutRefusal(error: unknown): GitCheckoutRefusalError | undefined {
  if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== "GIT_CHECKOUT_BLOCKED") return;
  const { message, checkoutConflict } = error as Record<string, unknown>;
  const paths = checkoutConflict && typeof checkoutConflict === "object"
    ? (checkoutConflict as { conflictedPaths?: unknown }).conflictedPaths : undefined;
  if (typeof message !== "string" || !Array.isArray(paths)
    || paths.some(path => typeof path !== "string" || !path || path.includes("\0"))
    || paths.reduce((sum, path: string) => sum + path.length, 0) > 8 * 1024 * 1024)
    throw new Error("The host did not return a valid checkout refusal.");
  return { code: "GIT_CHECKOUT_BLOCKED", message, checkoutConflict: { conflictedPaths: [...paths] } };
}

/** Current owner receipt; opening or continuing UI still needs current owner,
 * connection, original action and explicit user intent checks. */
export interface GitCheckoutRefusal {
  commandId: string;
  action: GitCheckoutAction;
  error: GitCheckoutRefusalError;
}
