import type { GitCheckoutRefusal } from "../../../../packages/shared/src/checkout-refusal";
import type { GitSubmissionReceipt } from "../../../../packages/shared/src/git-submissions";
import type { WorkspaceState } from "./workspace-state";

/** A commit receipt is the sole success authority, never an empty error string,
 * a renderer refresh, a push-only success or somebody else's latest commit. */
export async function continueBranchSwitch(data: WorkspaceState, refusal: GitCheckoutRefusal, commandId: string,
  receipt: GitSubmissionReceipt | undefined, current: () => boolean): Promise<string | undefined> {
  if (!current()) return;
  if (!receipt || receipt.commandId !== commandId || receipt.hostId !== data.hostId
    || JSON.stringify(receipt.target) !== JSON.stringify(data.target)
    || receipt.outcome !== "succeeded" || !receipt.commit)
    throw new Error("The original commit has not been confirmed. Inspect its outcome before switching branches.");
  await data.loadGit();
  if (!current()) return;
  if (!data.connected || data.busy || data.pending || data.cacheWarning || data.errors.git || !data.status
    || data.status.head !== receipt.commit.commit || data.gitSubmission?.commandId !== commandId
    || data.gitSubmission.outcome !== "succeeded")
    throw new Error("Git state changed after the commit. Inspect it before switching branches.");
  // Keep the originally reviewed destination identity. A moved ref/revision is
  // rejected by the host, not silently replaced with another target.
  return data.mutateCommand({ ...refusal.action, expectedRevision: data.status.revision }, undefined, current);
}
