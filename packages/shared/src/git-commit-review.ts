import { gitObjectId } from "./git-file-history";

/** Commit review is repository-wide, read-only, and never a working-tree selection. */
export interface GitCommitReviewSelection { repositoryId: string; commit: string }
export interface GitReviewCommit { commit: string; committedAt: string; subject: string; message: string }
export interface GitCommitReviewList {
  repositoryId: string;
  head: string | null;
  mergeBase: string | null;
  commits: GitReviewCommit[];
}
export interface GitCommitReviewFile {
  path: string;
  previousPath: string | null;
  change: "A" | "D" | "M" | "R" | "C" | "T";
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  additions: number | null;
  deletions: number | null;
}
export interface GitCommitReviewSnapshot {
  selection: GitCommitReviewSelection;
  commit: GitReviewCommit;
  /** First parent only; null means Git exposes this commit as a root. */
  parent: string | null;
  files: GitCommitReviewFile[];
}
export interface GitCommitReviewPath { path: string; previousPath?: string }
export interface GitCommitReviewDiff {
  selection: GitCommitReviewSelection;
  parent: string | null;
  path: string;
  patch: string;
}
export function parseGitCommitReviewSelection(value: unknown): GitCommitReviewSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A Commit review selection is required.");
  const input = value as Record<string, unknown>;
  if (typeof input.repositoryId !== "string" || !/^[a-f0-9]{64}$/.test(input.repositoryId)
    || typeof input.commit !== "string" || !gitObjectId.test(input.commit)) throw new Error("The original repository and exact selected commit are required.");
  return { repositoryId: input.repositoryId, commit: input.commit };
}
/** Git tree names are not local-open authority. Like Branch review, preserve literal
 * POSIX backslashes, tabs and newlines; --literal-pathspecs keeps them inert. */
export function parseGitCommitTreePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 16384 || value.startsWith("/") || value.includes("\0")
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
    || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("A canonical relative Git tree path is required.");
  return value;
}
export function parseGitCommitReviewPath(value: unknown): GitCommitReviewPath {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A historical Commit review path is required.");
  const input = value as Record<string, unknown>;
  return { path: parseGitCommitTreePath(input.path), ...(input.previousPath === undefined ? {} : { previousPath: parseGitCommitTreePath(input.previousPath) }) };
}
/** Undefined list means loading/error: retain selection until an authoritative list arrives.
 * A null result tells the shared source controller to leave Commit review, not to choose another commit. */
export function reconcileCommitReviewSelection(selection: GitCommitReviewSelection | null, repositoryId: string,
  commits: readonly GitReviewCommit[] | undefined): GitCommitReviewSelection | null {
  if (!selection || selection.repositoryId !== repositoryId || commits && !commits.some(row => row.commit === selection.commit)) return null;
  return selection;
}
