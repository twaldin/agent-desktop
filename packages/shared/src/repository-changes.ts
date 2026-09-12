export type GitRepositoryChange = "config" | "head" | "index" | "local-refs" | "remote-refs" | "worktree-topology" | "working-tree" | "synced-branch";
export const branchQueryTypes = ["git.recent-branches", "git.default-branch", "git.base-branch", "git.search-branches", "git.search-starting-branches"] as const;
export type BranchQueryType = typeof branchQueryTypes[number];

/** Missing/unknown kinds are a full invalidation, including older host events.
 * Starting search follows the same branch-ref dependencies as checkout search. */
export function repositoryChangeAffects(query: BranchQueryType, kind: unknown): boolean {
  switch (kind) {
    case "head": case "remote-refs": return true;
    case "local-refs": return query !== "git.default-branch" && query !== "git.base-branch";
    case "config": return query !== "git.search-branches" && query !== "git.search-starting-branches";
    case "index": case "worktree-topology": case "working-tree": case "synced-branch": return false;
    default: return true;
  }
}
