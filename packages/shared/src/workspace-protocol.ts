import type { NativeTerminalInfo } from "./terminals";
import type { GitSelectionSummary, GitSubmissionIntent, GitSubmissionReceipt } from "./git-submissions";
export type * from "./git-submissions";
import type { LocalEnvironmentActionsState, LocalEnvironmentCatalogItem, LocalEnvironmentSaveResult } from "./local-environments";
import type { LocalEnvironmentPreparationPublic, LocalEnvironmentExecutionOutput } from "./environment-preparations";
import type { CreateWorktreeOptions, FileContent, FileWriteResult, GitActionContext, GitBranch, GitDiff, GitReviewSummary, GitStatus, GitWorktree, WorkspaceEntry, WorkspacePathContext } from "./workspace";

export type { WorkspaceTarget } from "./workspace";
export const WORKSPACE_OWNER_HEADER = "X-Agent-Host-Id";
/** A reviewed literal ref; remote selection explicitly names the new local branch. */
export interface GitBranchSelection { ref: string; commit: string; localBranch?: string }
export function parseGitBranchSelection(value: unknown): GitBranchSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A reviewed branch reference is required.");
  const { ref, commit, localBranch } = value as Record<string, unknown>;
  if (typeof ref !== "string" || ref.length > 512 || !/^refs\/(heads|remotes)\/.+/.test(ref) || /[\p{Cc}]/u.test(ref)) throw new Error("A literal local or remote branch reference is required.");
  if (typeof commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("The selected branch commit is required.");
  if (ref.startsWith("refs/remotes/")) {
    if (typeof localBranch !== "string" || !localBranch || localBranch.length > 200 || localBranch.startsWith("-") || /[\p{Cc}]/u.test(localBranch)) throw new Error("A new local branch name is required for a remote selection.");
    return { ref, commit, localBranch };
  }
  if (localBranch !== undefined) throw new Error("A local branch selection cannot rename or create a branch.");
  return { ref, commit };
}
/** Text terms for branch presentation, not revision resolution. Older caller
 * limits up to100 remain valid but clamp to the native20 result cap. */
export function parseGitBranchSearch(query: unknown, limit: unknown = 20): { query: string; limit: number } {
  if (typeof query !== "string" || !query.trim() || query.length > 512 || /[\p{Cc}]/u.test(query))
    throw new Error("A nonempty branch search query of at most 512 characters is required.");
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100)
    throw new Error("A branch search limit must be between 1 and 100.");
  return { query: query.trim(), limit: Math.min(limit as number, 20) };
}
/** Match the pinned recent-list cap; malformed values are protocol errors. */
export function parseGitRecentBranchesLimit(value: unknown = 100): number {
  if (!Number.isSafeInteger(value)) throw new Error("A recent branch limit must be an integer.");
  return Math.max(1, Math.min(value as number, 100));
}
/** A local Git revision expression. Resolution is read-only, not checkout admission. */
export function parseGitRevisionExpression(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\p{Cc}]/u.test(value))
    throw new Error("A Git revision of at most 512 characters is required.");
  return value.trim();
}
export interface GitResolvedRevision { expression: string; commit: string }
export function parseGitResolvedRevision(value: unknown): GitResolvedRevision {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A resolved Git revision is required.");
  const input = value as Record<string, unknown>;
  const expression = parseGitRevisionExpression(input.expression);
  if (typeof input.commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit))
    throw new Error("The exact resolved commit identity is required.");
  return { expression, commit: input.commit };
}
/** Checkout intent resolved independently of the bounded presentation search. */
export type GitCheckoutTarget =
  | { kind: "branch"; expression: string; selection: GitBranchSelection }
  | { kind: "revision"; expression: string; commit: string };
export function parseGitCheckoutTarget(value: unknown): GitCheckoutTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A resolved checkout target is required.");
  const input = value as Record<string, unknown>;
  if (input.kind === "revision") return { kind: "revision", ...parseGitResolvedRevision(input) };
  if (input.kind !== "branch") throw new Error("The checkout target kind is invalid.");
  const expression = parseGitRevisionExpression(input.expression), selection = parseGitBranchSelection(input.selection);
  // A branch result is the exact local name or a unique remote with that same
  // local name. Full refs and other expressions belong to revision resolution.
  const remoteSuffix = `/${expression}`;
  if (selection.ref.startsWith("refs/heads/") ? selection.ref !== `refs/heads/${expression}`
    : selection.localBranch !== expression || !selection.ref.endsWith(remoteSuffix)
      || selection.ref.length <= "refs/remotes/".length + remoteSuffix.length)
    throw new Error("The resolved branch does not match the checkout expression.");
  return { kind: "branch", expression, selection };
}
export interface WorkspaceOpenTarget {
  id: string;
  label: string;
  kind: "editor" | "terminal" | "file-manager";
}
export type WorkspaceQuery =
  | { type: "file.operations" }
  | { type: "environment.actions" }
  | { type: "environment.output"; preparationId: string }
  | { type: "environment.preparation"; preparationId: string }
  | { type: "environment.read"; configPath: string }
  | { type: "environments.list" }
  | { type: "files.list"; path?: string }
  | { type: "files.search"; query: string; limit?: number }
  | { type: "file.stat"; path: string }
  | { type: "file.operation-context"; path: string }
  | { type: "file.read"; path: string }
  | { type: "file.open-options"; path: string }
  | { type: "file.copy-info"; path: string }
  | { type: "file.copy-chunk"; path: string; revision: string; offset: number }
  | { type: "git.status" }
  | { type: "git.action-context" }
  | { type: "git.selection-summary"; contextRevision: string; selectionMode: GitSelectionSummary["selectionMode"] }
  | { type: "git.submission"; commandId?: string }
  | { type: "git.branches" }
  | { type: "git.recent-branches"; limit?: number }
  | { type: "git.base-branch" }
  | { type: "git.default-branch" }
  | { type: "git.search-branches"; query: string; limit?: number }
  | { type: "git.search-starting-branches"; query: string; limit?: number }
  | { type: "git.resolve-revision"; expression: string }
  | { type: "git.resolve-checkout"; expression: string }
  | { type: "git.diff"; path?: string; staged?: boolean; context?: number }
  | { type: "git.review-summary"; source: GitReviewSummary["source"] }
  | { type: "git.worktrees" };
export type WorkspaceQueryResult =
  | { type: "file.operations"; version: 1 }
  | { type: "environment.actions"; state: LocalEnvironmentActionsState }
  | { type: "environment.output"; output: LocalEnvironmentExecutionOutput | null }
  | { type: "environment.preparation"; preparation: LocalEnvironmentPreparationPublic }
  | { type: "environment.read"; configPath: string; revision: string; raw: string }
  | { type: "environments.list"; environments: LocalEnvironmentCatalogItem[] }
  | { type: "files.list"; entries: WorkspaceEntry[] }
  | { type: "files.search"; entries: Array<WorkspaceEntry & { score: number }>; nativeTotalMatches: number; status: "complete" | "truncated" }
  | { type: "file.stat"; entry: WorkspaceEntry }
  | { type: "file.operation-context"; context: WorkspacePathContext }
  | { type: "file.read"; content: FileContent }
  | { type: "file.open-options"; path: string; targets: WorkspaceOpenTarget[]; preferredTargetId?: string; availabilityReason?: string }
  | { type: "file.copy-info"; path: string; absolutePath: string; size: number; revision: string }
  | { type: "file.copy-chunk"; path: string; size: number; revision: string; offset: number; dataBase64: string }
  /** A host-proven absence of repository metadata is distinct from a Git read failure. */
  | { type: "git.status"; availability?: "repository"; status: GitStatus }
  | { type: "git.status"; availability: "not-repository" }
  | { type: "git.action-context"; context: GitActionContext }
  | { type: "git.selection-summary"; contextRevision: string; summary: GitSelectionSummary }
  | { type: "git.submission"; receipt: GitSubmissionReceipt | null }
  | { type: "git.branches"; branches: GitBranch[] }
  | { type: "git.recent-branches"; branches: string[] }
  | { type: "git.base-branch"; base: { local: string; remote: string } | null }
  | { type: "git.default-branch"; branch: string | null }
  /** Cap attainment, not proof of any additional match. */
  | { type: "git.search-branches"; branches: GitBranch[]; limitReached: boolean }
  /** Starting-state remote names retain their remote qualifier and exact ref. */
  | { type: "git.search-starting-branches"; branches: GitBranch[]; limitReached: boolean }
  | { type: "git.resolve-revision"; revision: GitResolvedRevision | null }
  | { type: "git.resolve-checkout"; target: GitCheckoutTarget | null }
  | { type: "git.diff"; diff: GitDiff }
  | { type: "git.review-summary"; summary: GitReviewSummary }
  | { type: "git.worktrees"; worktrees: GitWorktree[] };
export type WorkspaceMutation =
  | { type: "environment.select"; configPath: string | null; expectedRevision: number }
  | { type: "environment.action"; configPath: string; configRevision: string; selectionRevision: number; actionIndex: number }
  | { type: "environment.save"; configPath?: string | null; expectedRevision: string | null; raw: string }
  | { type: "file.write"; path: string; text: string; expectedRevision: string | null; bom?: boolean }
  | { type: "file.create"; path: string }
  | { type: "directory.create"; path: string }
  | { type: "path.rename"; path: string; destination: string; expectedRevision: string }
  | { type: "path.delete"; path: string; expectedRevision: string }
  | { type: "file.open"; path: string; targetId: string }
  | { type: "git.stage"; paths: string[] }
  | { type: "git.unstage"; paths: string[]; expectedRevision?: string }
  | { type: "git.commit"; message: string; expectedRevision?: string }
  | { type: "git.submit"; intent: GitSubmissionIntent }
  | { type: "git.submit.cancel"; commandId: string }
  | { type: "git.submit.acknowledge"; commandId: string }
  | { type: "git.checkout"; branch: string; expectedRevision: string; create?: boolean }
  | { type: "git.checkout-ref"; selection: GitBranchSelection; expectedRevision: string }
  | { type: "git.checkout-revision"; revision: GitResolvedRevision; expectedRevision: string }
  | { type: "worktree.create"; options: CreateWorktreeOptions }
  | { type: "worktree.remove"; path: string };
export type WorkspaceMutationResult =
  | { type: "environment.select"; state: LocalEnvironmentActionsState }
  | { type: "environment.action"; terminal: NativeTerminalInfo }
  | { type: "environment.save"; result: LocalEnvironmentSaveResult }
  | { type: "file.write"; result: FileWriteResult }
  | { type: "file.create" | "directory.create"; context: WorkspacePathContext }
  | { type: "path.rename"; previousPath: string; context: WorkspacePathContext }
  | { type: "path.delete"; deletedPath: string }
  | { type: "file.open"; targetId: string }
  | { type: "git.stage" | "git.unstage"; status: GitStatus }
  | { type: "git.commit"; commit: string; summary: string }
  | { type: "git.submit" | "git.submit.cancel" | "git.submit.acknowledge"; receipt: GitSubmissionReceipt }
  | { type: "git.checkout"; status: GitStatus }
  | { type: "git.checkout-ref"; status: GitStatus }
  | { type: "git.checkout-revision"; status: GitStatus }
  | { type: "worktree.create"; worktree: GitWorktree }
  | { type: "worktree.remove" };
