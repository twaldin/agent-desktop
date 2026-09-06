import { realpath, stat } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { WorkspaceService } from "../workspace/service";
import { LocalEnvironmentStore } from "./index";
import { mapWorktreeDirectories, validateWorktreeDirectoryContext, type WorktreeDirectoryContext } from "./worktree-directories";

/** Capture directories from the owning workspace and its discovered configuration, before checkout. */
export async function resolveWorktreeDirectoryContext(
  workspace: WorkspaceService,
  configPath: string | null,
): Promise<WorktreeDirectoryContext> {
  const { gitRoot, workspaceRelativePath } = await workspace.gitWorkspaceContext();
  let configCwdRelativePath: string | null = null;
  if (configPath !== null) {
    // The existing store enforces discovery boundaries and refuses storage/file symlinks.
    const config = await new LocalEnvironmentStore(workspace.cwd).read(configPath);
    const owner = await realpath(dirname(dirname(dirname(config.configPath))));
    configCwdRelativePath = relative(gitRoot, owner);
    const current = await workspace.gitWorkspaceContext();
    if (current.gitRoot !== gitRoot || current.workspaceRelativePath !== workspaceRelativePath)
      throw new Error("Source Git context changed during configuration resolution.");
  }
  return validateWorktreeDirectoryContext({
    sourceGitRoot: gitRoot, sourceWorkspaceRoot: workspace.cwd, workspaceRelativePath, configCwdRelativePath,
  });
}

/**
 * Verify directories after the owner has verified the managed worktree's registration.
 * This does not establish host/project ownership and never creates a missing project or uses a root fallback.
 */
export async function verifyWorktreeDirectories(context: WorktreeDirectoryContext, worktreeGitRoot: string) {
  const mapped = mapWorktreeDirectories(context, worktreeGitRoot);
  for (const path of new Set([context.sourceGitRoot, context.sourceWorkspaceRoot, mapped.worktreeGitRoot, mapped.worktreeWorkspaceRoot, mapped.scriptCwd].filter((path): path is string => path !== null))) {
    let canonical: string;
    try {
      canonical = await realpath(path);
      if (!(await stat(path)).isDirectory()) throw new Error("Not a directory");
    } catch {
      throw new Error("A captured worktree directory is missing or is not a directory. Inspect the selected starting state before continuing.");
    }
    if (canonical !== path) throw new Error("A captured worktree directory resolves through a changed or symbolic path.");
  }
  const actual = await new WorkspaceService(mapped.worktreeGitRoot).gitWorkspaceContext();
  if (actual.gitRoot !== mapped.worktreeGitRoot) throw new Error("The managed checkout no longer owns its captured Git root.");
  const source = await new WorkspaceService(context.sourceWorkspaceRoot).gitWorkspaceContext();
  if (source.gitRoot !== context.sourceGitRoot || source.workspaceRelativePath !== context.workspaceRelativePath)
    throw new Error("Source Git context no longer matches the captured project.");
  // This is an observation, not a filesystem lock. The effect owner must recheck before dispatch.
  return mapped;
}
