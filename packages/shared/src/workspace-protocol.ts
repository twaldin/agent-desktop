import type { NativeTerminalInfo } from "./terminals";
import type { LocalEnvironmentActionsState, LocalEnvironmentCatalogItem, LocalEnvironmentSaveResult } from "./local-environments";
import type { LocalEnvironmentPreparationPublic, LocalEnvironmentExecutionOutput } from "./environment-preparations";
import type { CreateWorktreeOptions, FileContent, FileWriteResult, GitBranch, GitDiff, GitStatus, GitWorktree, WorkspaceEntry } from "./workspace";

export type { WorkspaceTarget } from "./workspace";
export interface WorkspaceOpenTarget {
  id: string;
  label: string;
  kind: "editor" | "terminal" | "file-manager";
}
export type WorkspaceQuery =
  | { type: "environment.actions" }
  | { type: "environment.output"; preparationId: string }
  | { type: "environment.preparation"; preparationId: string }
  | { type: "environment.read"; configPath: string }
  | { type: "environments.list" }
  | { type: "files.list"; path?: string }
  | { type: "file.stat"; path: string }
  | { type: "file.read"; path: string }
  | { type: "file.open-options"; path: string }
  | { type: "git.status" }
  | { type: "git.branches" }
  | { type: "git.diff"; path?: string; staged?: boolean; context?: number }
  | { type: "git.worktrees" };
export type WorkspaceQueryResult =
  | { type: "environment.actions"; state: LocalEnvironmentActionsState }
  | { type: "environment.output"; output: LocalEnvironmentExecutionOutput | null }
  | { type: "environment.preparation"; preparation: LocalEnvironmentPreparationPublic }
  | { type: "environment.read"; configPath: string; revision: string; raw: string }
  | { type: "environments.list"; environments: LocalEnvironmentCatalogItem[] }
  | { type: "files.list"; entries: WorkspaceEntry[] }
  | { type: "file.stat"; entry: WorkspaceEntry }
  | { type: "file.read"; content: FileContent }
  | { type: "file.open-options"; path: string; targets: WorkspaceOpenTarget[]; preferredTargetId?: string; availabilityReason?: string }
  | { type: "git.status"; status: GitStatus }
  | { type: "git.branches"; branches: GitBranch[] }
  | { type: "git.diff"; diff: GitDiff }
  | { type: "git.worktrees"; worktrees: GitWorktree[] };
export type WorkspaceMutation =
  | { type: "environment.select"; configPath: string | null; expectedRevision: number }
  | { type: "environment.action"; configPath: string; configRevision: string; selectionRevision: number; actionIndex: number }
  | { type: "environment.save"; configPath?: string | null; expectedRevision: string | null; raw: string }
  | { type: "file.write"; path: string; text: string; expectedRevision: string | null; bom?: boolean }
  | { type: "file.open"; path: string; targetId: string }
  | { type: "git.stage"; paths: string[] }
  | { type: "git.unstage"; paths: string[]; expectedRevision?: string }
  | { type: "git.commit"; message: string; expectedRevision?: string }
  | { type: "git.checkout"; branch: string; expectedRevision: string; create?: boolean }
  | { type: "worktree.create"; options: CreateWorktreeOptions }
  | { type: "worktree.remove"; path: string };
export type WorkspaceMutationResult =
  | { type: "environment.select"; state: LocalEnvironmentActionsState }
  | { type: "environment.action"; terminal: NativeTerminalInfo }
  | { type: "environment.save"; result: LocalEnvironmentSaveResult }
  | { type: "file.write"; result: FileWriteResult }
  | { type: "file.open"; targetId: string }
  | { type: "git.stage" | "git.unstage"; status: GitStatus }
  | { type: "git.commit"; commit: string; summary: string }
  | { type: "git.checkout"; status: GitStatus }
  | { type: "worktree.create"; worktree: GitWorktree }
  | { type: "worktree.remove" };
