/** The host resolves this catalog identity; clients never supply an absolute root. */
export type WorkspaceTarget = { projectId: string } | { sessionId: string };

export interface FileWriteInput { text: string; expectedRevision: string | null; bom?: boolean }
export interface GitDiffOptions { path?: string; staged?: boolean; context?: number }
export interface GitCommitResult { commit: string; summary: string }

export interface WorkspaceEntry {
  path: string;
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: number;
  mode: number;
  linkTarget?: string;
  linkState?: "inside" | "outside" | "missing";
}

export interface ContentMetadata { path: string; size: number; modifiedAt: number; mode: number }
export interface TextDocument extends ContentMetadata { kind: "text"; text: string; revision: string; bom: boolean; encoding: "utf8" }
export type FileContent = TextDocument
  | (ContentMetadata & { kind: "binary"; revision: string })
  | (ContentMetadata & { kind: "unsupported-encoding"; revision: string; encoding: "utf16le" | "utf16be" | "utf32le" | "utf32be" })
  | (ContentMetadata & { kind: "too-large"; revision: null; maximumBytes: number });
export type FileWriteResult = { ok: true; document: TextDocument } | { ok: false; code: "REVISION_CONFLICT"; current: FileContent | null };
export interface GitStatusEntry { path: string; originalPath?: string; indexStatus: string; worktreeStatus: string; kind: "tracked" | "untracked" | "conflict"; submodule: boolean }
export interface GitStatus { revision: string; branch: string | null; head: string | null; upstream: string | null; ahead: number; behind: number; entries: GitStatusEntry[] }
export interface GitBranch { name: string; ref: string; commit: string; current: boolean; remote: boolean; upstream: string | null; symbolicTarget: string | null }
export interface GitDiff { patch: string; binary: boolean; staged: boolean; path?: string }
export interface GitWorktree { path: string; head: string | null; branch: string | null; detached: boolean; bare: boolean; locked: boolean; lockReason?: string; prunable?: string; managed: boolean; managedRelativePath?: string }
export interface CreateWorktreeOptions { path: string; branch?: string; newBranch?: string; startPoint?: string }
export type WorktreeStartingState = { type: "branch"; branchName: string } | { type: "working-tree" };
