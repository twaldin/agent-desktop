import { isAbsolute, join, posix, resolve } from "node:path";

export interface WorktreeDirectoryContext {
  sourceGitRoot: string;
  sourceWorkspaceRoot: string;
  workspaceRelativePath: string;
  configCwdRelativePath: string | null;
}

const absoluteRoot = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value || value.includes("\0") || !isAbsolute(value) || resolve(value) !== value)
    throw new Error(`${label} must be a normalized absolute path.`);
  return value;
};

function relativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\\") || isAbsolute(value))
    throw new Error(`${label} must be a normalized POSIX relative path.`);
  if (value === "") return "";
  if (value.split("/").includes(".."))
    throw new Error(`${label} cannot escape its Git root.`);
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized.startsWith("./") || normalized.endsWith("/") || normalized !== value)
    throw new Error(`${label} must be normalized.`);
  return normalized;
}

/** Validate and return the normalized directory identity used before checkout. */
export function validateWorktreeDirectoryContext(value: WorktreeDirectoryContext): WorktreeDirectoryContext {
  const sourceGitRoot = absoluteRoot(value?.sourceGitRoot, "Source Git root");
  const sourceWorkspaceRoot = absoluteRoot(value?.sourceWorkspaceRoot, "Source workspace root");
  const workspaceRelativePath = relativePath(value?.workspaceRelativePath, "Workspace relative path");
  const configCwdRelativePath = value?.configCwdRelativePath === null ? null : relativePath(value?.configCwdRelativePath, "Config cwd relative path");
  if (join(sourceGitRoot, workspaceRelativePath) !== sourceWorkspaceRoot)
    throw new Error("Source workspace root does not match its Git-relative path.");
  if (configCwdRelativePath !== null) {
    const workspace = workspaceRelativePath ? workspaceRelativePath.split("/") : [];
    const config = configCwdRelativePath ? configCwdRelativePath.split("/") : [];
    if (config.length > workspace.length || config.some((segment, index) => segment !== workspace[index]))
      throw new Error("Config cwd must be the workspace or one of its ancestors.");
  }
  return { sourceGitRoot, sourceWorkspaceRoot, workspaceRelativePath, configCwdRelativePath };
}

/** Map source identities into a future managed checkout. Verify these paths canonically after checkout before execution. */
export function mapWorktreeDirectories(context: WorktreeDirectoryContext, worktreeGitRoot: string): {
  worktreeGitRoot: string; worktreeWorkspaceRoot: string; scriptCwd: string | null; sourceWorkspaceRoot: string;
} {
  const normalized = validateWorktreeDirectoryContext(context);
  const managedRoot = absoluteRoot(worktreeGitRoot, "Worktree Git root");
  if (managedRoot === normalized.sourceGitRoot) throw new Error("Managed worktree must differ from the source checkout.");
  return {
    worktreeGitRoot: managedRoot,
    worktreeWorkspaceRoot: join(managedRoot, normalized.workspaceRelativePath),
    scriptCwd: normalized.configCwdRelativePath === null ? null : join(managedRoot, normalized.configCwdRelativePath),
    sourceWorkspaceRoot: normalized.sourceWorkspaceRoot,
  };
}
