import type { CreateWorktreeOptions, FileContent, FileWriteResult, GitBranch, GitDiff, GitStatus, GitWorktree, WorkspaceEntry } from "./workspace";

export type { WorkspaceTarget } from "./workspace";
export type WorkspaceQuery =
  | { type: "files.list"; path?: string }
  | { type: "file.stat"; path: string }
  | { type: "file.read"; path: string }
  | { type: "git.status" }
  | { type: "git.branches" }
  | { type: "git.diff"; path?: string; staged?: boolean; context?: number }
  | { type: "git.worktrees" };
export type WorkspaceQueryResult =
  | { type: "files.list"; entries: WorkspaceEntry[] }
  | { type: "file.stat"; entry: WorkspaceEntry }
  | { type: "file.read"; content: FileContent }
  | { type: "git.status"; status: GitStatus }
  | { type: "git.branches"; branches: GitBranch[] }
  | { type: "git.diff"; diff: GitDiff }
  | { type: "git.worktrees"; worktrees: GitWorktree[] };
export type WorkspaceMutation =
  | { type: "file.write"; path: string; text: string; expectedRevision: string | null; bom?: boolean }
  | { type: "git.stage"; paths: string[] }
  | { type: "git.unstage"; paths: string[]; expectedRevision?: string }
  | { type: "git.commit"; message: string; expectedRevision?: string }
  | { type: "worktree.create"; options: CreateWorktreeOptions }
  | { type: "worktree.remove"; path: string };
export type WorkspaceMutationResult =
  | { type: "file.write"; result: FileWriteResult }
  | { type: "git.stage" | "git.unstage"; status: GitStatus }
  | { type: "git.commit"; commit: string; summary: string }
  | { type: "worktree.create"; worktree: GitWorktree }
  | { type: "worktree.remove" };
