/** Read-only merge-base to working-tree review. Omitted base selects the remote default. */
export interface BranchReviewRequest { baseBranch?: string; path?: string; context?: number }
export interface BranchReviewFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
  untracked: boolean;
}
interface BranchReviewContext {
  requestedBase: string | null;
  baseBranch: string | null;
  currentBranch: string | null;
  path?: string;
}
export type BranchReview = BranchReviewContext & (
  | { state: "available"; /** Full inventory, bytes, owning repository and resolved references at this observation. */
      revision: string; head: string; baseCommit: string; mergeBase: string;
      /** Always the full branch inventory; path scopes only the patch. */
      files: BranchReviewFile[]; patch: string; binary: boolean }
  | { state: "unavailable"; reason: "default_branch_unavailable" | "head_unavailable" | "base_ref_unavailable" | "merge_base_unavailable" }
);
export function parseBranchReviewRequest(value: unknown): BranchReviewRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A branch review request is required.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["baseBranch", "path", "context"].includes(key))) throw new Error("Unknown branch review request field.");
  const result: BranchReviewRequest = {};
  if (input.baseBranch !== undefined) {
    if (typeof input.baseBranch !== "string" || !input.baseBranch.trim() || input.baseBranch.length > 512 || /[\p{Cc}]/u.test(input.baseBranch))
      throw new Error("A Git base reference of at most 512 characters is required.");
    result.baseBranch = input.baseBranch.trim();
  }
  if (input.path !== undefined) {
    if (typeof input.path !== "string" || !input.path || input.path.length > 16_384 || input.path.startsWith("/") || input.path.includes("\0") || input.path.split("/").some(part => part === ".."))
      throw new Error("A relative path within the owning workspace is required.");
    result.path = input.path;
  }
  if (input.context !== undefined) {
    if (!Number.isSafeInteger(input.context) || (input.context as number) < 0 || (input.context as number) > 1000) throw new Error("Diff context must be between 0 and 1000 lines.");
    result.context = input.context as number;
  }
  return result;
}
