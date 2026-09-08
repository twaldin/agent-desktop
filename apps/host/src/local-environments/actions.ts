import { nativeActionText } from "../terminals/native-input";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { NativeTerminalInfo } from "../../../../packages/shared/src/terminals";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace";
import type { LocalEnvironmentCatalogItem, LocalEnvironmentActionsState } from "../../../../packages/shared/src/local-environments";
import { LocalEnvironmentStore } from "./index";
import type { HostStore } from "../store";
import type { TmuxTerminalManager } from "../terminals/native-manager";
import { TerminalError } from "../terminals/error";
import { verifyWorktreeDirectories } from "./worktree-directory-resolution";
import { WorkspaceService } from "../workspace/service";
import { syncWorktreeEnvironmentSelection } from "./worktree-config";

export interface LocalEnvironmentActionRun { configPath: string; configRevision: string; selectionRevision: number; actionIndex: number }

type Resolved = { cwd: string; configRoot: string; targetKey: string; preparationSessionId?: string; initialConfigPath?: string | null; actionRoot?: string; sourceGitRoot?: string; sourceFallbackConfig?: string; sourceFallbackRoot?: string };
const platform = process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
const digest = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const fail = (code: string, message: string): never => { throw new TerminalError(code, message); };
const execute = promisify(execFile);
const selectionOperations = new Map<string, Promise<void>>();

async function orderedSelection<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const pending = (selectionOperations.get(root) ?? Promise.resolve()).then(operation);
  const settled = pending.then(() => {}, () => {});
  selectionOperations.set(root, settled);
  try { return await pending; }
  finally { if (selectionOperations.get(root) === settled) selectionOperations.delete(root); }
}

async function commonGitDirectory(root: string): Promise<string> {
  try {
    const result = await execute("git", ["--no-pager", "--literal-pathspecs", "-c", "color.ui=false", "-C", root, "rev-parse", "--git-common-dir"],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    const value = result.stdout.replace(/\r?\n$/, "");
    return realpathSync(isAbsolute(value) ? value : resolve(root, value));
  } catch { return fail("WORKSPACE_NOT_FOUND", "The environment preparation no longer belongs to its source Git repository."); }
}

async function ownedConfig(root: string, value: string): Promise<string> {
  try { return await new LocalEnvironmentStore(root).resolveConfigPath(value); }
  catch (cause) { return fail("INVALID_ENVIRONMENT_ACTION", cause instanceof Error ? cause.message : "Environment config path is unavailable."); }
}

export class LocalEnvironmentActions {
  constructor(
    private readonly store: HostStore,
    private readonly manager: () => TmuxTerminalManager | undefined,
    private readonly reserveRun: (canonicalCwd: string) => () => void = () => () => {},
  ) {}

  private async resolve(target: WorkspaceTarget): Promise<Resolved> {
    if (!target || typeof target !== "object" || Object.keys(target).length !== 1) fail("INVALID_WORKSPACE_TARGET", "One workspace target is required.");
    if ("filePath" in target) fail("INVALID_WORKSPACE_TARGET", "A standalone file cannot own environment actions.");
    const store = this.store;
    let cwd: string, projectRoot: string, sessionId: string | undefined;
    let targetKey: string;
    if ("sessionId" in target) {
      if (typeof target.sessionId !== "string") fail("INVALID_WORKSPACE_TARGET", "A workspace target id is required.");
      const session = store.getSession(target.sessionId);
      if (!session || session.hostId !== store.host.id) throw new TerminalError("WORKSPACE_NOT_FOUND", "The requested session does not exist on this host.");
      const project = session.projectId ? store.getProject(session.projectId) : undefined;
      if (session.projectId && (!project || project.hostId !== store.host.id)) throw new TerminalError("WORKSPACE_NOT_FOUND", "The requested session project does not exist on this host.");
      cwd = session.cwd; projectRoot = project?.path ?? session.cwd; sessionId = session.id;
      targetKey = `sessionId:${target.sessionId}`;
    } else if ("projectId" in target) {
      if (typeof target.projectId !== "string") fail("INVALID_WORKSPACE_TARGET", "A workspace target id is required.");
      const project = store.getProject(target.projectId);
      if (!project || project.hostId !== store.host.id) throw new TerminalError("WORKSPACE_NOT_FOUND", "The requested project does not exist on this host.");
      cwd = project.path; projectRoot = project.path;
      targetKey = `projectId:${target.projectId}`;
    } else return fail("INVALID_WORKSPACE_TARGET", "A standalone file cannot own environment actions.");
    try { cwd = realpathSync(cwd); projectRoot = realpathSync(projectRoot); if (!statSync(cwd).isDirectory()) throw new Error(); }
    catch { fail("WORKSPACE_NOT_FOUND", "The workspace directory no longer exists."); }
    let configRoot = cwd, initialConfigPath: string | null | undefined;
    if (sessionId) {
      const prep = store.environmentPreparations.list().find(item => item.phase !== "removed" && (item.sessionId === sessionId
        || item.version === 2 && item.sourceRoot === projectRoot && resolve(item.worktreePath, item.directories.workspaceRelativePath) === cwd));
      if (prep) {
        if (prep.version === 2) {
          if (realpathSync(prep.directories.sourceWorkspaceRoot) !== projectRoot) fail("WORKSPACE_NOT_FOUND", "The environment preparation does not own this project.");
          const sourceWorkspace = new WorkspaceService(prep.directories.sourceWorkspaceRoot, { worktreeRoot: dirname(prep.worktreePath) });
          const registered = (await (await sourceWorkspace.gitRootService()).worktrees())
            .find(tree => tree.path === prep.worktreePath && tree.managed);
          if (!registered || registered.locked)
            fail("WORKSPACE_NOT_FOUND", "The captured checkout is not an unlocked managed worktree of this project.");
          const mapped = await verifyWorktreeDirectories(prep.directories, prep.worktreePath);
          if (await commonGitDirectory(prep.directories.sourceGitRoot) !== await commonGitDirectory(mapped.worktreeGitRoot))
            fail("WORKSPACE_NOT_FOUND", "The environment preparation and managed worktree belong to different Git repositories.");
          const mappedCwd = realpathSync(mapped.worktreeWorkspaceRoot);
          if (mappedCwd !== cwd) fail("WORKSPACE_NOT_FOUND", "The environment preparation does not own this workspace.");
          configRoot = mappedCwd;
          initialConfigPath = prep.environment?.configPath ?? null;
          const sourceFallbackConfig = prep.selectedEnvironment && prep.environment?.configPath === prep.selectedEnvironment.configPath ? prep.selectedEnvironment.configPath : undefined;
          const sourceFallbackRoot = sourceFallbackConfig ? realpathSync(dirname(dirname(dirname(sourceFallbackConfig)))) : undefined;
          return { cwd, configRoot, targetKey, preparationSessionId: prep.sessionId ?? sessionId, initialConfigPath, actionRoot: realpathSync(mapped.worktreeGitRoot), sourceGitRoot: realpathSync(prep.directories.sourceGitRoot), sourceFallbackConfig, sourceFallbackRoot };
        }
        configRoot = realpathSync(prep.sourceRoot);
        if (configRoot !== projectRoot || realpathSync(prep.worktreePath) !== cwd) fail("WORKSPACE_NOT_FOUND", "The environment preparation does not own this workspace.");
        initialConfigPath = prep.environment?.configPath ?? null;
      }
      else configRoot = projectRoot;
    }
    return { cwd, configRoot, targetKey, preparationSessionId: sessionId, initialConfigPath };
  }

  private async build(target: WorkspaceTarget, resolved?: Resolved, mirrored = false): Promise<LocalEnvironmentActionsState> {
    resolved ??= await this.resolve(target);
    const store = this.store;
    const entries = await this.entries(resolved);
    const byPath = new Map(entries.map(item => [item.configPath, item]));
    if (!mirrored) await this.mirror(resolved);
    const persisted = store.getActionEnvironmentSelection(this.selectionCwd(resolved));
    const selected = persisted ? persisted.configPath : resolved.initialConfigPath === undefined ? this.default(entries) : resolved.initialConfigPath;
    const revision = persisted?.revision ?? 0;
    const selectedItem = selected ? byPath.get(selected) : undefined;
    const environments = entries.map(item => item.type === "environment"
      ? { configPath: item.configPath, name: item.environment.name }
      : { configPath: item.configPath, name: null, error: item.error });
    if (selected && !byPath.has(selected)) environments.push({ configPath: selected, name: null, error: "The selected environment configuration no longer exists." });
    const actions = selectedItem?.type === "environment" ? (selectedItem.environment.actions ?? []).flatMap((action, index) =>
      action.platform && action.platform !== platform ? [] : [{ index, name: action.name, icon: action.icon }]) : [];
    return { selectionRevision: revision, selectedConfigPath: selected, configRevision: selectedItem?.type === "environment" ? selectedItem.revision : selectedItem?.type === "error" ? selectedItem.revision ?? null : null, environments, actions, available: this.manager() !== undefined };
  }

  private default(entries: LocalEnvironmentCatalogItem[]): string | null {
    const named = entries.find(item => item.type === "environment" && basename(item.configPath) === "environment.toml");
    return named?.configPath ?? entries.find(item => item.type === "environment")?.configPath ?? null;
  }

  async catalog(target: WorkspaceTarget): Promise<LocalEnvironmentActionsState> {
    const resolved = await this.resolve(target);
    return orderedSelection(this.selectionCwd(resolved), () => this.build(target, resolved));
  }

  async select(target: WorkspaceTarget, configPath: string | null, expectedRevision: number): Promise<LocalEnvironmentActionsState> {
    const resolved = await this.resolve(target);
    return orderedSelection(this.selectionCwd(resolved), () => this.selectResolved(target, resolved, configPath, expectedRevision));
  }

  private async selectResolved(target: WorkspaceTarget, resolved: Resolved, configPath: string | null, expectedRevision: number): Promise<LocalEnvironmentActionsState> {
    const store = this.store;
    const release = this.reserveRun(resolved.actionRoot ?? resolved.cwd);
    try {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail("INVALID_ENVIRONMENT_SELECTION", "The environment selection revision is invalid.");
      const selectedPath = configPath === null ? null : await this.ownedConfig(resolved, configPath);
      if (selectedPath !== null) {
        const exists = (await this.entries(resolved)).some(item => item.configPath === selectedPath);
        if (!exists) fail("INVALID_ENVIRONMENT_SELECTION", "The selected environment configuration no longer exists.");
      }
      store.putActionEnvironmentSelection(this.selectionCwd(resolved), selectedPath, expectedRevision);
      await this.mirror(resolved, true);
      return this.build(target, resolved, true);
    } finally { release(); }
  }

  async run(target: WorkspaceTarget, input: LocalEnvironmentActionRun): Promise<NativeTerminalInfo> {
    const resolved = await this.resolve(target);
    return orderedSelection(this.selectionCwd(resolved), () => this.runResolved(target, resolved, input));
  }

  private async runResolved(target: WorkspaceTarget, resolved: Resolved, input: LocalEnvironmentActionRun): Promise<NativeTerminalInfo> {
    const store = this.store;
    const entries = await this.entries(resolved);
    const persisted = store.getActionEnvironmentSelection(this.selectionCwd(resolved));
    const effectiveSelection = persisted ? persisted.configPath : resolved.initialConfigPath === undefined ? this.default(entries) : resolved.initialConfigPath;
    const currentRevision = persisted?.revision ?? 0;
    if (input.selectionRevision !== currentRevision || input.configPath !== effectiveSelection) fail("STALE_ENVIRONMENT_SELECTION", "The environment selection changed; refresh and try again.");
    if (!input.configPath) fail("INVALID_ENVIRONMENT_CONFIG", "An environment must be selected before running an action.");
    const path = await this.ownedConfig(resolved, input.configPath);
    const item = entries.find(entry => entry.configPath === path);
    if (!item) throw new TerminalError("INVALID_ENVIRONMENT_CONFIG", "The environment configuration no longer exists.");
    if (item.type === "error") throw new TerminalError("INVALID_ENVIRONMENT_CONFIG", item.error);
    if (item.revision !== input.configRevision) fail("STALE_ENVIRONMENT_CONFIG", "The environment configuration changed; refresh and try again.");
    const afterRead = store.getActionEnvironmentSelection(this.selectionCwd(resolved));
    const afterSelection = afterRead ? afterRead.configPath : resolved.initialConfigPath === undefined ? this.default(entries) : resolved.initialConfigPath;
    if (afterRead?.revision !== persisted?.revision || afterSelection !== effectiveSelection) fail("STALE_ENVIRONMENT_SELECTION", "The environment selection changed; refresh and try again.");
    await this.mirror(resolved);
    const latest = store.getActionEnvironmentSelection(this.selectionCwd(resolved));
    const latestSelection = latest ? latest.configPath : resolved.initialConfigPath === undefined ? this.default(entries) : resolved.initialConfigPath;
    if (latest?.revision !== persisted?.revision || latestSelection !== effectiveSelection)
      fail("STALE_ENVIRONMENT_SELECTION", "The environment selection changed; refresh and try again.");
    if (!Number.isSafeInteger(input.actionIndex) || input.actionIndex < 0) throw new TerminalError("INVALID_ENVIRONMENT_ACTION", "The configured action index is invalid.");
    const action = item.environment.actions?.[input.actionIndex];
    if (!action) throw new TerminalError("INVALID_ENVIRONMENT_ACTION", "The configured action is unavailable on this host.");
    if ((action.platform && action.platform !== platform) || !action.name.trim() || !action.command.trim() || action.command.includes("\0")) fail("INVALID_ENVIRONMENT_ACTION", "The configured action is unavailable on this host.");
    const command = action.command.trim();
    const actionCwd = this.actionCwdFor(resolved, path);
    nativeActionText(actionCwd, command); // Reject oversize assembled input before a first terminal is created.
    const release = this.reserveRun(resolved.actionRoot ?? actionCwd);
    try {
    const native = this.manager(); if (!native) throw new TerminalError("NATIVE_TERMINAL_UNAVAILABLE", "Native terminals are unavailable on this host.");
    const actionKey = digest(store.host.id, resolved.targetKey, actionCwd, path, String(input.actionIndex));
    const existing = native.getAction(actionKey);
    if (existing?.status === "starting") fail("OUTCOME_UNKNOWN", "The previous environment action is still starting; inspect its terminal before retrying.");
    if (existing?.status === "closing") fail("TERMINAL_BUSY", "This environment action is already closing.");
    if (existing?.status === "error" || existing?.status === "interrupted") fail("OUTCOME_UNKNOWN", "The previous environment action outcome is unknown; inspect its terminal, then close and forget it before starting a new action.");
    const environment = resolved.preparationSessionId ? store.getSessionEnvironment(resolved.preparationSessionId) : undefined;
    if (existing) return await native.restartAction(existing.id, command, environment, { actionRoot: resolved.actionRoot });
    const created = await native.create({ target, cwd: actionCwd }, environment, { actionKey, actionRoot: resolved.actionRoot });
    return await native.restartAction(created.id, command, environment, { actionRoot: resolved.actionRoot });
    } finally { release(); }
  }

  private async entries(resolved: Resolved): Promise<LocalEnvironmentCatalogItem[]> {
    const entries = await new LocalEnvironmentStore(resolved.configRoot).catalog();
    if (resolved.sourceFallbackConfig && resolved.sourceFallbackRoot && !entries.some(item => item.configPath === resolved.sourceFallbackConfig)) {
      const source = (await new LocalEnvironmentStore(resolved.sourceFallbackRoot).catalog())
        .find(item => item.configPath === resolved.sourceFallbackConfig);
      if (source) entries.push(source);
    }
    return entries;
  }

  private selectionCwd(resolved: Resolved): string { return resolved.actionRoot ?? resolved.cwd; }

  private async mirror(resolved: Resolved, reserved = false): Promise<void> {
    if (!resolved.actionRoot || !resolved.sourceGitRoot) return;
    if (!this.store.getActionEnvironmentSelection(this.selectionCwd(resolved))) return;
    const release = reserved ? undefined : this.reserveRun(resolved.actionRoot);
    try {
      await syncWorktreeEnvironmentSelection(resolved.sourceGitRoot, resolved.actionRoot, () => {
        const current = this.store.getActionEnvironmentSelection(this.selectionCwd(resolved));
        return current?.configPath;
      });
    }
    catch (cause) { throw new TerminalError("OUTCOME_UNKNOWN", `The environment selection mirror could not be verified. ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { release?.(); }
  }

  private ownedConfig(resolved: Resolved, configPath: string): Promise<string> {
    if (configPath === resolved.sourceFallbackConfig && resolved.sourceFallbackRoot)
      return ownedConfig(resolved.sourceFallbackRoot, configPath);
    return ownedConfig(resolved.configRoot, configPath);
  }

  private actionCwdFor(resolved: Resolved, configPath: string): string {
    let owner: string;
    if (resolved.sourceFallbackConfig && configPath === resolved.sourceFallbackConfig) {
      if (!resolved.sourceGitRoot || !resolved.actionRoot) fail("INVALID_ENVIRONMENT_CONFIG", "The retained environment source is unavailable.");
      const sourceGitRoot = resolved.sourceGitRoot!, actionRoot = resolved.actionRoot!;
      const sourceOwner = dirname(dirname(dirname(configPath)));
      const ownerRelative = relative(sourceGitRoot, sourceOwner);
      owner = `${actionRoot}${ownerRelative ? sep + ownerRelative : ""}`;
    } else owner = dirname(dirname(dirname(configPath)));
    try { owner = realpathSync(owner); if (!statSync(owner).isDirectory()) throw new Error(); }
    catch { fail("INVALID_ENVIRONMENT_CONFIG", "The environment action owner is unavailable."); }
    if (resolved.actionRoot && owner !== resolved.actionRoot && !owner.startsWith(`${resolved.actionRoot}${sep}`)) fail("INVALID_ENVIRONMENT_CONFIG", "The environment action owner is outside its managed Git root.");
    return owner;
  }
}
