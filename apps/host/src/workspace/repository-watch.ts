import type { GitRepositoryChange } from "@agent-desktop/shared";
export type { GitRepositoryChange } from "@agent-desktop/shared";
import { isAbsolute, join, relative, sep } from "node:path";

/** Host-private metadata. A future subscription must additionally bind its host
 * and catalog owner; these filesystem paths grant no client file authority. */
export interface GitRepositoryWatchContext {
  root: string;
  gitDir: string;
  commonDir: string;
  headPath: string;
  indexPath: string;
  /** Undefined means the active metadata reader cannot confirm this watch's HEAD. */
  headRef: string | null | undefined;
}



function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

/** Classify absolute changed paths, never arbitrary relative client strings.
 * After a HEAD event the watcher must pass undefined until it rereads HEAD:
 * while unknown every local ref is conservatively a head dependency. */
export function repositoryMetadataChanges(context: GitRepositoryWatchContext, path: string, headRef: string | null | undefined): GitRepositoryChange[] {
  if (!isAbsolute(path)) return [];
  const changes = new Set<GitRepositoryChange>();
  const heads = join(context.commonDir, "refs", "heads"), remotes = join(context.commonDir, "refs", "remotes");
  if (path === context.headPath || path === join(context.commonDir, "HEAD")) changes.add("head");
  if (path === context.indexPath) changes.add("index");
  if (path === heads) { changes.add("head"); changes.add("local-refs"); }
  else if (within(heads, path) && !path.endsWith(".lock")) {
    if (headRef === undefined || headRef !== null && path === join(context.commonDir, headRef)) changes.add("head");
    else changes.add("local-refs");
  }
  if (within(remotes, path) && !path.endsWith(".lock") || path === join(context.commonDir, "FETCH_HEAD") || path === join(context.commonDir, "packed-refs")) changes.add("remote-refs");
  if ([join(context.commonDir, "config"), join(context.commonDir, "shallow"), join(context.commonDir, "info", "exclude"),
    join(context.commonDir, "info", "attributes"), join(context.gitDir, "config.worktree")].includes(path)) changes.add("config");
  // The parent watcher sees removal/replacement of these metadata directories.
  if (path === join(context.commonDir, "refs")) { changes.add("head"); changes.add("local-refs"); changes.add("remote-refs"); }
  if (path === join(context.commonDir, "info")) changes.add("config");
  const worktrees = join(context.commonDir, "worktrees"), suffix = relative(worktrees, path).split(sep);
  if (within(worktrees, path) && (path === worktrees || suffix.length === 1
    || suffix.length === 2 && ["HEAD", "commondir", "gitdir", "locked"].includes(suffix[1]!))) changes.add("worktree-topology");
  return [...changes];
}
