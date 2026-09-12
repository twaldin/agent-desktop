import { hasRemoteExecution } from "../../../../packages/shared/src/new-chat";
import type { Draft, HostState } from "../../../../packages/shared/src/protocol";
import type { PendingSubmission } from "./submissions";

type StartingCapabilities = Pick<HostState, "newChatExecution" | "localEnvironments">;

/** Availability for a new remote operation; host admission remains authoritative. */
export function remoteWorktreeIssue(execution: Draft["execution"], state: StartingCapabilities | null | undefined): string | undefined {
  if (!hasRemoteExecution(execution)) return;
  if (state?.newChatExecution?.commandVersion !== 4 || state.newChatExecution.worktrees !== true
    || state.newChatExecution.startingRefs?.commandVersion !== 12 || state.newChatExecution.startingRefs.remote !== true
    || state.localEnvironments?.execution?.commandVersion !== 5) {
    return "Update the owning host to use remote worktree starting states. Your draft is preserved.";
  }
}

/** Checking an already-sent envelope retains its original version and identity. */
export function remoteWorktreeResumeIssue(pending: PendingSubmission, state: StartingCapabilities | null | undefined): string | undefined {
  if (pending.resume || pending.send || !pending.sessionId && pending.preparation?.phase === "session-created" && pending.create) return;
  return remoteWorktreeIssue(pending.draft.execution, state);
}
