import type { GitActionContext, GitPushDestination, GitSelectionSummary } from "@agent-desktop/shared";
import type { WorkspaceState } from "./workspace-state";

export type GitAction = "commit" | "commit-and-push" | "push";
export type { GitSelectionSummary } from "@agent-desktop/shared";

/** Read one host-prepared tree summary; never reconstruct a selection from renderer diffs. */
export async function readGitSelectionSummary(data: Pick<WorkspaceState, "query">, context: GitActionContext, includeUnstaged: boolean, signal?: AbortSignal): Promise<GitSelectionSummary> {
  signal?.throwIfAborted();
  const selectionMode = includeUnstaged ? "include-unstaged" : "staged";
  const result = await data.query({ type: "git.selection-summary", contextRevision: context.revision, selectionMode });
  signal?.throwIfAborted();
  if (result.type !== "git.selection-summary") throw new Error("The host returned the wrong change summary response.");
  const value = result.summary;
  if (result.contextRevision !== context.revision || value.reviewedRevision !== context.status.revision || value.selectionMode !== selectionMode)
    throw new Error("Git state changed. Refresh the selected changes.");
  if (!value.selectedTree || ![value.additions, value.deletions, value.binaryFiles, value.files].every(count => Number.isSafeInteger(count) && count >= 0))
    throw new Error("The host returned an invalid change summary.");
  return value;
}

export function gitDestinations(context?: GitActionContext): GitPushDestination[] {
  return context ? [...(context.push.state === "available" ? [context.push.destination] : []), ...context.push.alternatives] : [];
}
export function destinationKey(value: GitPushDestination) { return JSON.stringify([value.remote, value.targetRef]); }

/** Each disabled action retains its concrete blocker for the same dialog row. */
export function gitActionReasons(input: {
  context?: GitActionContext; includeUnstaged: boolean; destination?: GitPushDestination;
  blocked?: string; selectionUnavailable?: string; newBranch?: string; branchError?: string;
}): Record<GitAction, string | undefined> {
  const { context, destination, includeUnstaged, newBranch } = input;
  const common = input.blocked ?? (!context ? "Loading Git state…" : undefined) ?? input.branchError;
  if (common || !context) return { commit: common, "commit-and-push": common, push: common };
  const entries = context.status.entries;
  const selected = entries.some(entry => includeUnstaged || ![" ", ".", "?"].includes(entry.indexStatus));
  const commit = entries.some(entry => entry.kind === "conflict") ? "Resolve conflicts before committing." : input.selectionUnavailable ?? (!selected ? "No changes to commit." : undefined);
  const push = !context.status.head ? "Create a commit before pushing." : !context.status.branch ? "Choose a branch before pushing." : !destination ? "Choose an available push destination." : undefined;
  // A missing local tracking ref is unknown, not evidence of zero commits.
  const nothingToPush = !newBranch && destination?.commitsAhead === 0 && !destination.requiresUpstreamSetup ? "No commits to push." : undefined;
  return { commit, "commit-and-push": commit ?? push, push: push ?? nothingToPush };
}
