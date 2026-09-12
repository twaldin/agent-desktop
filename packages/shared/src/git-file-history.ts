import type { FileContent } from "./workspace";

/** Repository identity is host-issued; paths are Git tree paths, never local file-open authority. */
export interface GitFileOrigin extends GitFileLocation {
  repositoryId: string;
  workspacePath: string;
  expression: string;
}
export interface GitFileLocation { commit: string; path: string }
/** Immutable date-ordered scan root and rename frontier; no accumulated visited-history payload. */
export interface GitFileHistoryCursor extends GitFileLocation { offset: number; pending: GitFileLocation[] }
export type GitFileChange = "A" | "M" | "D" | "T" | "U" | "X" | "B" | `R${number}` | `C${number}`;
export type GitFileBlameUnavailable = "missing" | "not-regular-file" | "too-large" | "binary" | "unsupported-encoding";
export interface GitFileCommit extends GitFileLocation {
  author: string; email: string; authorTime: number; summary: string;
  change: GitFileChange;
  /** Immutable parent location, including the old name of a rename/deletion. */
  previous: GitFileLocation | null;
}
export interface GitFileBlameLine {
  line: number; originalLine: number; commit: string; path: string;
  author: string; email: string; authorTime: number; summary: string;
}
export interface GitFileHistoryPage {
  origin: GitFileOrigin;
  start: GitFileHistoryCursor;
  commits: GitFileCommit[];
  next: GitFileHistoryCursor | null;
}
export interface GitFileRevision {
  origin: GitFileOrigin;
  location: GitFileLocation;
  content: FileContent | null;
  blame: GitFileBlameLine[];
  blameUnavailable?: GitFileBlameUnavailable;
}
export interface GitFileInspection {
  requested: { path: string; expression: string };
  origin: GitFileOrigin | null;
  unavailable?: "unborn-head" | "revision-not-found";
  working: FileContent | null;
  workingUnavailable?: "denied" | "not-regular-file";
  revision: GitFileRevision | null;
  history: GitFileHistoryPage | null;
}
export const gitObjectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export function parseGitFilePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 16384 || value.startsWith("/") || /[\0\\]/.test(value)
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
    || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("A canonical relative Git file path is required.");
  return value;
}
export function parseGitFileLocation(value: unknown): GitFileLocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("An immutable Git file location is required.");
  const input = value as Record<string, unknown>;
  if (typeof input.commit !== "string" || !gitObjectId.test(input.commit)) throw new Error("An exact Git commit is required.");
  return { commit: input.commit, path: parseGitFilePath(input.path) };
}
export function parseGitFileOrigin(value: unknown): GitFileOrigin {
  const location = parseGitFileLocation(value), input = value as Record<string, unknown>;
  if (typeof input.repositoryId !== "string" || !/^[a-f0-9]{64}$/.test(input.repositoryId)
    || typeof input.expression !== "string" || !input.expression.trim() || input.expression.length > 512 || /[\p{Cc}]/u.test(input.expression)) throw new Error("The original repository and reference identity are required.");
  return { ...location, repositoryId: input.repositoryId, expression: input.expression, workspacePath: parseGitFilePath(input.workspacePath) };
}
export function parseGitFileHistoryCursor(value: unknown): GitFileHistoryCursor {
  const location = parseGitFileLocation(value), input = value as Record<string, unknown>;
  if (!Array.isArray(input.pending) || input.pending.length > 10000 || !Number.isSafeInteger(input.offset) || (input.offset as number) < 0) throw new Error("Invalid file history cursor.");
  return { ...location, offset: input.offset as number, pending: input.pending.map(parseGitFileLocation) };
}
