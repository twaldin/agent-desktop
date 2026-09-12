/** A standalone file grants authority to that exact path, never its parent directory. */
export function parseStandaloneFilePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 16_384 || value === "/" || !value.startsWith("/")
    || /[\p{Cc}\\]/u.test(value)
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value))
    throw new Error("A canonical absolute standalone file path is required.");
  const segments = value.slice(1).split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".."))
    throw new Error("A canonical absolute standalone file path is required.");
  return value;
}

/** The host resolves catalog identities; a filePath owns only that literal file. */
export type WorkspaceTarget = { projectId: string } | { sessionId: string } | { filePath: string };

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
export type GitPushUnavailableReason = "unborn-head" | "detached-head" | "missing-remote" | "ambiguous-remote" | "push-target-unresolved";
export interface GitPushDestination {
  remote: string;
  targetRef: string;
  requiresUpstreamSetup: boolean;
  revision: string;
  localTrackingRef: string | null;
  /** Counts against a locally cached destination ref; null means unknown, not zero. */
  commitsAhead: number | null;
  commitsBehind: number | null;
}
export interface GitActionContext {
  status: GitStatus;
  /** Local branch/index/destination revision; not a snapshot of unstaged file bytes. */
  revision: string;
  push: ({ state: "available"; destination: GitPushDestination } | { state: "unavailable"; reason: GitPushUnavailableReason }) & {
    alternatives: GitPushDestination[];
    freshness: "local-config-and-refs";
  };
}
export interface GitBranch { name: string; ref: string; commit: string; current: boolean; remote: boolean; upstream: string | null; symbolicTarget: string | null }
export interface GitDiff { patch: string; binary: boolean; staged: boolean; path?: string }
/** Display observations from one owning-host read, not a future commit selection. */
export interface GitReviewSummary {
  source: "staged" | "unstaged";
  /** HEAD/index identity only; working bytes may change after this observation. */
  revision: string;
  files: Array<{ path: string; previousPath: string | null; additions: number | null; deletions: number | null }>;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
}
export interface GitWorktree { path: string; head: string | null; branch: string | null; detached: boolean; bare: boolean; locked: boolean; lockReason?: string; prunable?: string; managed: boolean; managedRelativePath?: string }
export interface CreateWorktreeOptions { path: string; branch?: string; newBranch?: string; startPoint?: string }
export type WorktreeStartingState = { type: "branch"; branchName: string; remoteRef?: string } | { type: "working-tree" };
