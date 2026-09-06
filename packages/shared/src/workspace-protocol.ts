import type { LocalEnvironmentCatalogItem, LocalEnvironmentSaveResult } from "./local-environments";
import type { CreateWorktreeOptions, FileContent, FileWriteResult, GitBranch, GitDiff, GitStatus, GitWorktree, WorkspaceEntry } from "./workspace";

export type { WorkspaceTarget } from "./workspace";
export type WorkspaceQuery =
  | { type: "environment.read"; configPath: string }
  | { type: "environments.list" }
  | { type: "files.list"; path?: string }
  | { type: "file.stat"; path: string }
  | { type: "file.read"; path: string }
  | { type: "git.status" }
  | { type: "git.branches" }
  | { type: "git.diff"; path?: string; staged?: boolean; context?: number }
  | { type: "git.worktrees" };
export type WorkspaceQueryResult =
  | { type: "environment.read"; configPath: string; revision: string; raw: string }
  | { type: "environments.list"; environments: LocalEnvironmentCatalogItem[] }
  | { type: "files.list"; entries: WorkspaceEntry[] }
  | { type: "file.stat"; entry: WorkspaceEntry }
  | { type: "file.read"; content: FileContent }
  | { type: "git.status"; status: GitStatus }
  | { type: "git.branches"; branches: GitBranch[] }
  | { type: "git.diff"; diff: GitDiff }
  | { type: "git.worktrees"; worktrees: GitWorktree[] };
export type WorkspaceMutation =
  | { type: "environment.save"; configPath?: string | null; expectedRevision: string | null; raw: string }
  | { type: "file.write"; path: string; text: string; expectedRevision: string | null; bom?: boolean }
  | { type: "git.stage"; paths: string[] }
  | { type: "git.unstage"; paths: string[]; expectedRevision?: string }
  | { type: "git.commit"; message: string; expectedRevision?: string }
  | { type: "git.checkout"; branch: string; expectedRevision: string; create?: boolean }
  | { type: "worktree.create"; options: CreateWorktreeOptions }
  | { type: "worktree.remove"; path: string };
export type WorkspaceMutationResult =
  | { type: "environment.save"; result: LocalEnvironmentSaveResult }
  | { type: "file.write"; result: FileWriteResult }
  | { type: "git.stage" | "git.unstage"; status: GitStatus }
  | { type: "git.commit"; commit: string; summary: string }
  | { type: "git.checkout"; status: GitStatus }
  | { type: "worktree.create"; worktree: GitWorktree }
  | { type: "worktree.remove" };
