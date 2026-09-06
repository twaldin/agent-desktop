import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { LocalEnvironmentConfig } from "@agent-desktop/shared";
import { parseLocalEnvironment } from "@agent-desktop/shared";
import { WorkspaceService } from "../workspace/service";
import { LocalEnvironmentStore } from "./index";

const execute = promisify(execFile);
const selectionKey = "agentDesktop.localEnvironmentConfigPath";
const noSelection = "__none__";
const revision = (raw: string) => createHash("sha256").update(raw).digest("hex");

export interface WorktreeEnvironmentSnapshot { configPath: string; revision: string; raw: string }
export interface WorktreeEnvironmentMaterializationInput {
  sourceWorkspaceRoot: string;
  sourceGitRoot: string;
  worktreeGitRoot: string;
  selected: WorktreeEnvironmentSnapshot | null;
}
export interface WorktreeEnvironmentMaterialization {
  configPath: string | null;
  revision: string | null;
  raw: string | null;
  environment: LocalEnvironmentConfig | null;
  source: "none" | "existing" | "copied" | "source";
}

export class WorktreeEnvironmentConfigError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WorktreeEnvironmentConfigError"; }
}

async function git(cwd: string, args: string[], validExitCodes: number[] = []): Promise<{ stdout: string; code: number }> {
  try {
    const result = await execute("git", ["--no-pager", "--literal-pathspecs", "-c", "color.ui=false", "-C", cwd, ...args],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    return { stdout: result.stdout, code: 0 };
  } catch (cause) {
    const failure = cause as Error & { code?: number; stderr?: string; killed?: boolean };
    if (typeof failure.code === "number" && validExitCodes.includes(failure.code)) return { stdout: "", code: failure.code };
    if (failure.killed) throw new WorktreeEnvironmentConfigError("GIT_TIMEOUT", "Git exceeded its time limit while selecting the worktree environment.");
    throw new WorktreeEnvironmentConfigError("GIT_FAILED", failure.stderr?.trim() || failure.message);
  }
}

async function ignored(cwd: string, path: string): Promise<boolean> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of ["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) delete env[name];
  const child = Bun.spawn(["git", "-C", cwd, "check-ignore", "-z", "--stdin"], {
    stdin: Buffer.from(`${path}\0`), stdout: "ignore", stderr: "pipe", env, signal: AbortSignal.timeout(30_000),
  });
  const code = await child.exited;
  if (code === 0) return true;
  if (code === 1) return false;
  throw new WorktreeEnvironmentConfigError("GIT_FAILED", (await new Response(child.stderr).text()).trim() || "Git failed while checking environment ignore rules.");
}

function within(root: string, path: string) { return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep); }
async function exactDirectory(path: string, label: string) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new WorktreeEnvironmentConfigError("INVALID_DIRECTORY", `${label} must be an existing canonical directory.`);
  let canonical: string, info;
  try { canonical = await realpath(path); info = await stat(path); }
  catch { throw new WorktreeEnvironmentConfigError("INVALID_DIRECTORY", `${label} must be an existing canonical directory.`); }
  if (canonical !== path || !info.isDirectory())
    throw new WorktreeEnvironmentConfigError("INVALID_DIRECTORY", `${label} must be an existing canonical directory.`);
}

async function validateRoots(input: WorktreeEnvironmentMaterializationInput) {
  await exactDirectory(input.sourceGitRoot, "Source Git root");
  await exactDirectory(input.sourceWorkspaceRoot, "Source workspace root");
  await exactDirectory(input.worktreeGitRoot, "Managed Git root");
  if (!within(input.sourceGitRoot, input.sourceWorkspaceRoot)) throw new WorktreeEnvironmentConfigError("OUTSIDE_GIT_ROOT", "The source workspace is outside its Git root.");
  if (input.sourceGitRoot === input.worktreeGitRoot) throw new WorktreeEnvironmentConfigError("INVALID_WORKTREE", "The managed worktree must differ from the source checkout.");
  const source = await new WorkspaceService(input.sourceWorkspaceRoot).gitWorkspaceContext();
  const managed = await new WorkspaceService(input.worktreeGitRoot).gitWorkspaceContext();
  if (source.gitRoot !== input.sourceGitRoot || managed.gitRoot !== input.worktreeGitRoot)
    throw new WorktreeEnvironmentConfigError("GIT_ROOT_CHANGED", "A source or managed Git root does not match its checkout.");
  const [sourceCommon, managedCommon] = await Promise.all([
    commonGitDirectory(input.sourceGitRoot), commonGitDirectory(input.worktreeGitRoot),
  ]);
  if (sourceCommon !== managedCommon)
    throw new WorktreeEnvironmentConfigError("UNRELATED_WORKTREE", "The managed worktree belongs to a different Git repository.");
  return join(input.worktreeGitRoot, source.workspaceRelativePath);
}

async function safeParents(root: string, parent: string, create: boolean) {
  const child = relative(root, parent);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new WorktreeEnvironmentConfigError("OUTSIDE_WORKTREE", "The environment target is outside the managed worktree.");
  let current = root;
  for (const part of child.split(sep)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new WorktreeEnvironmentConfigError("SYMLINKED_TARGET", "The environment target traverses a symbolic or non-directory path.");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      if (!create) return false;
      await mkdir(current, { mode: 0o700 });
    }
  }
  if (await realpath(parent) !== parent) throw new WorktreeEnvironmentConfigError("SYMLINKED_TARGET", "The environment target traverses a symbolic path.");
  return true;
}

async function readSelected(workspaceRoot: string, configPath: string): Promise<WorktreeEnvironmentMaterialization> {
  const current = await new LocalEnvironmentStore(workspaceRoot).read(configPath);
  return { configPath: current.configPath, revision: current.revision, raw: current.raw,
    environment: parseLocalEnvironment(current.raw), source: "existing" };
}

async function commonGitDirectory(gitRoot: string) {
  const value = (await git(gitRoot, ["rev-parse", "--git-common-dir"])).stdout.replace(/\r?\n$/, "");
  const common = isAbsolute(value) ? value : resolve(gitRoot, value);
  return realpath(common);
}

async function commonConfigPath(gitRoot: string) {
  return join(await commonGitDirectory(gitRoot), "config");
}

async function configValue(cwd: string, args: string[]) {
  const value = await git(cwd, ["config", ...args], [1]);
  return value.code === 0 ? value.stdout.replace(/\r?\n$/, "") : null;
}

async function persistSelection(sourceGitRoot: string, worktreeGitRoot: string, value: string) {
  const common = await commonConfigPath(worktreeGitRoot);
  const commonBefore = await configValue(worktreeGitRoot, ["--file", common, "--get", selectionKey]);
  const extension = await configValue(worktreeGitRoot, ["--file", common, "--type=bool", "--get", "extensions.worktreeConfig"]);
  if (extension?.toLowerCase() !== "true") {
    const coreWorktree = await configValue(worktreeGitRoot, ["--file", common, "--get", "core.worktree"]);
    const coreBare = await configValue(worktreeGitRoot, ["--file", common, "--type=bool", "--get", "core.bare"]);
    if (coreWorktree !== null || coreBare?.toLowerCase() === "true") {
      throw new WorktreeEnvironmentConfigError("UNSAFE_WORKTREE_CONFIG", "Git worktree-specific config cannot be enabled without changing existing core.worktree or core.bare semantics.");
    }
    await git(worktreeGitRoot, ["config", "extensions.worktreeConfig", "true"]);
  }
  const sourceBefore = await configValue(sourceGitRoot, ["--worktree", "--get", selectionKey]);
  try { await git(worktreeGitRoot, ["config", "--worktree", selectionKey, value]); }
  catch (cause) { throw new WorktreeEnvironmentConfigError("OUTCOME_UNKNOWN", `The worktree environment selection could not be recorded reliably. ${cause instanceof Error ? cause.message : String(cause)}`); }
  const [written, sourceAfter, commonAfter] = await Promise.all([
    configValue(worktreeGitRoot, ["--worktree", "--get", selectionKey]),
    configValue(sourceGitRoot, ["--worktree", "--get", selectionKey]),
    configValue(worktreeGitRoot, ["--file", common, "--get", selectionKey]),
  ]);
  if (written !== value || sourceAfter !== sourceBefore || commonAfter !== commonBefore)
    throw new WorktreeEnvironmentConfigError("OUTCOME_UNKNOWN", "The worktree environment selection was written but could not be isolated and verified.");
}

const selectionTails = new Map<string, Promise<void>>();
type SelectionValue = string | null | undefined | (() => string | null | undefined | Promise<string | null | undefined>);
/** Serialize and verify the native Git worktree selection mirror. */
export async function syncWorktreeEnvironmentSelection(sourceGitRoot: string, worktreeGitRoot: string, desired: SelectionValue): Promise<void> {
  const prior = selectionTails.get(worktreeGitRoot) ?? Promise.resolve();
  const operation = prior.catch(() => {}).then(async () => {
    const value = typeof desired === "function" ? await desired() : desired;
    if (value === undefined) return;
    const common = await commonConfigPath(worktreeGitRoot);
    const extension = await configValue(worktreeGitRoot, ["--file", common, "--type=bool", "--get", "extensions.worktreeConfig"]);
    const native = extension?.toLowerCase() === "true"
      ? await configValue(worktreeGitRoot, ["--worktree", "--get", selectionKey])
      : null;
    const encoded = value ?? noSelection;
    if (native === encoded) return;
    await persistSelection(sourceGitRoot, worktreeGitRoot, encoded);
  });
  selectionTails.set(worktreeGitRoot, operation);
  try { await operation; }
  finally { if (selectionTails.get(worktreeGitRoot) === operation) selectionTails.delete(worktreeGitRoot); }
}

/** Materialize one exact selected environment and persist its effective path only in the managed worktree. */
export async function materializeWorktreeEnvironment(input: WorktreeEnvironmentMaterializationInput): Promise<WorktreeEnvironmentMaterialization> {
  const worktreeWorkspaceRoot = await validateRoots(input);
  let result: WorktreeEnvironmentMaterialization;
  if (input.selected === null) result = { configPath: null, revision: null, raw: null, environment: null, source: "none" };
  else {
    if (!/^[a-f0-9]{64}$/.test(input.selected.revision) || revision(input.selected.raw) !== input.selected.revision)
      throw new WorktreeEnvironmentConfigError("INVALID_SNAPSHOT", "The selected environment snapshot revision is invalid.");
    const sourceStore = new LocalEnvironmentStore(input.sourceWorkspaceRoot);
    const current = await sourceStore.read(input.selected.configPath);
    if (current.revision !== input.selected.revision || current.raw !== input.selected.raw)
      throw new WorktreeEnvironmentConfigError("CONFIG_CHANGED", "The selected environment changed after it was captured.");
    parseLocalEnvironment(current.raw);
    const pathFromGitRoot = relative(input.sourceGitRoot, current.configPath);
    if (!pathFromGitRoot || pathFromGitRoot === ".." || pathFromGitRoot.startsWith(`..${sep}`) || isAbsolute(pathFromGitRoot))
      throw new WorktreeEnvironmentConfigError("OUTSIDE_GIT_ROOT", "The selected environment is outside the source Git root.");
    const target = join(input.worktreeGitRoot, pathFromGitRoot);
    const parentsExist = await safeParents(input.worktreeGitRoot, dirname(target), false);
    const targetInfo = parentsExist ? await lstat(target).catch(cause => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }) : null;
    if (targetInfo) {
      if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) throw new WorktreeEnvironmentConfigError("INVALID_TARGET", "The selected worktree environment is not a regular file.");
      result = await readSelected(worktreeWorkspaceRoot, target);
    } else {
      const tracked = await git(input.sourceGitRoot, ["ls-files", "--error-unmatch", "--", pathFromGitRoot], [1]);
      if (tracked.code === 0) result = { configPath: null, revision: null, raw: null, environment: null, source: "none" };
      else {
        const sourceIgnored = await ignored(input.sourceGitRoot, pathFromGitRoot);
        const targetIgnored = sourceIgnored && await ignored(input.worktreeGitRoot, pathFromGitRoot);
        if (sourceIgnored && !targetIgnored) result = { configPath: current.configPath, revision: current.revision, raw: current.raw, environment: parseLocalEnvironment(current.raw), source: "source" };
        else {
          await safeParents(input.worktreeGitRoot, dirname(target), true);
          const file = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          const created = await file.stat();
          try { await file.writeFile(current.raw, "utf8"); await file.sync(); }
          catch (cause) {
            await file.close();
            const latest = await lstat(target).catch(() => null);
            if (latest?.dev === created.dev && latest.ino === created.ino) await unlink(target).catch(() => {});
            throw cause;
          }
          await file.close();
          result = { ...await readSelected(worktreeWorkspaceRoot, target), source: "copied" };
        }
      }
    }
  }
  await persistSelection(input.sourceGitRoot, input.worktreeGitRoot, result.configPath ?? noSelection);
  return result;
}

export const worktreeEnvironmentConfigKey = selectionKey;
