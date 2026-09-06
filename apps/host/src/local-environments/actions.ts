import { nativeActionText } from "../terminals/native-input";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { NativeTerminalInfo } from "../../../../packages/shared/src/terminals";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace";
import type { LocalEnvironmentCatalogItem, LocalEnvironmentActionsState } from "../../../../packages/shared/src/local-environments";
import { LocalEnvironmentStore } from "./index";
import type { HostStore } from "../store";
import type { TmuxTerminalManager } from "../terminals/native-manager";
import { TerminalError } from "../terminals/error";

export interface LocalEnvironmentActionRun { configPath: string; configRevision: string; selectionRevision: number; actionIndex: number }

type Resolved = { cwd: string; configRoot: string; targetKey: string; preparationSessionId?: string; initialConfigPath?: string | null };
const platform = process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
const digest = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const fail = (code: string, message: string): never => { throw new TerminalError(code, message); };

function ownedConfig(root: string, value: string): string {
  if (!isAbsolute(value) || value.includes("\0")) fail("INVALID_ENVIRONMENT_ACTION", "Environment config path must be absolute.");
  const environmentRoot = resolve(root, ".agent-desktop", "environments");
  let path = "";
  try { path = resolve(realpathSync(dirname(value)), basename(value)); } catch { fail("INVALID_ENVIRONMENT_ACTION", "Environment config path no longer exists."); }
  const child = relative(environmentRoot, path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child) || child.includes("/") || child.includes("\\") || !child.endsWith(".toml"))
    fail("INVALID_ENVIRONMENT_ACTION", "Environment config path is outside this project's environment directory.");
  return path;
}

export class LocalEnvironmentActions {
  constructor(
    private readonly store: HostStore,
    private readonly manager: () => TmuxTerminalManager | undefined,
    private readonly reserveRun: (canonicalCwd: string) => () => void = () => () => {},
  ) {}

  private async resolve(target: WorkspaceTarget): Promise<Resolved> {
    if (!target || typeof target !== "object" || Object.keys(target).length !== 1) fail("INVALID_WORKSPACE_TARGET", "One workspace target is required.");
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
    } else {
      if (typeof target.projectId !== "string") fail("INVALID_WORKSPACE_TARGET", "A workspace target id is required.");
      const project = store.getProject(target.projectId);
      if (!project || project.hostId !== store.host.id) throw new TerminalError("WORKSPACE_NOT_FOUND", "The requested project does not exist on this host.");
      cwd = project.path; projectRoot = project.path;
      targetKey = `projectId:${target.projectId}`;
    }
    try { cwd = realpathSync(cwd); projectRoot = realpathSync(projectRoot); if (!statSync(cwd).isDirectory()) throw new Error(); }
    catch { fail("WORKSPACE_NOT_FOUND", "The workspace directory no longer exists."); }
    let configRoot = cwd, initialConfigPath: string | null | undefined;
    if (sessionId) {
      const prep = store.environmentPreparations.list().find(item => item.sessionId === sessionId && item.phase !== "removed");
      if (prep) {
        configRoot = realpathSync(prep.sourceRoot);
        if (configRoot !== projectRoot || realpathSync(prep.worktreePath) !== cwd) fail("WORKSPACE_NOT_FOUND", "The environment preparation does not own this workspace.");
        initialConfigPath = prep.environment?.configPath ?? null;
      }
      else configRoot = projectRoot;
    }
    return { cwd, configRoot, targetKey, preparationSessionId: sessionId, initialConfigPath };
  }

  private async build(target: WorkspaceTarget, resolved?: Resolved): Promise<LocalEnvironmentActionsState> {
    resolved ??= await this.resolve(target);
    const store = this.store;
    const entries = await new LocalEnvironmentStore(resolved.configRoot).catalog();
    const byPath = new Map(entries.map(item => [item.configPath, item]));
    const persisted = store.getActionEnvironmentSelection(resolved.cwd);
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

  catalog(target: WorkspaceTarget): Promise<LocalEnvironmentActionsState> { return this.build(target); }

  async select(target: WorkspaceTarget, configPath: string | null, expectedRevision: number): Promise<LocalEnvironmentActionsState> {
    const resolved = await this.resolve(target), store = this.store;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail("INVALID_ENVIRONMENT_SELECTION", "The environment selection revision is invalid.");
    const selectedPath = configPath === null ? null : ownedConfig(resolved.configRoot, configPath);
    if (selectedPath !== null) {
      const exists = (await new LocalEnvironmentStore(resolved.configRoot).catalog()).some(item => item.configPath === selectedPath);
      if (!exists) fail("INVALID_ENVIRONMENT_SELECTION", "The selected environment configuration no longer exists.");
    }
    store.putActionEnvironmentSelection(resolved.cwd, selectedPath, expectedRevision);
    return this.build(target, resolved);
  }

  async run(target: WorkspaceTarget, input: LocalEnvironmentActionRun): Promise<NativeTerminalInfo> {
    const resolved = await this.resolve(target), store = this.store;
    const environmentStore = new LocalEnvironmentStore(resolved.configRoot);
    const entries = await environmentStore.catalog();
    const persisted = store.getActionEnvironmentSelection(resolved.cwd);
    const effectiveSelection = persisted ? persisted.configPath : resolved.initialConfigPath === undefined ? this.default(entries) : resolved.initialConfigPath;
    const currentRevision = persisted?.revision ?? 0;
    if (input.selectionRevision !== currentRevision || input.configPath !== effectiveSelection) fail("STALE_ENVIRONMENT_SELECTION", "The environment selection changed; refresh and try again.");
    if (!input.configPath) fail("INVALID_ENVIRONMENT_CONFIG", "An environment must be selected before running an action.");
    const path = ownedConfig(resolved.configRoot, input.configPath);
    const item = entries.find(entry => entry.configPath === path);
    if (!item) throw new TerminalError("INVALID_ENVIRONMENT_CONFIG", "The environment configuration no longer exists.");
    if (item.type === "error") throw new TerminalError("INVALID_ENVIRONMENT_CONFIG", item.error);
    if (item.revision !== input.configRevision) fail("STALE_ENVIRONMENT_CONFIG", "The environment configuration changed; refresh and try again.");
    const afterRead = store.getActionEnvironmentSelection(resolved.cwd);
    const afterSelection = afterRead ? afterRead.configPath : resolved.initialConfigPath === undefined ? this.default(entries) : resolved.initialConfigPath;
    if (afterRead?.revision !== persisted?.revision || afterSelection !== effectiveSelection) fail("STALE_ENVIRONMENT_SELECTION", "The environment selection changed; refresh and try again.");
    if (!Number.isSafeInteger(input.actionIndex) || input.actionIndex < 0) throw new TerminalError("INVALID_ENVIRONMENT_ACTION", "The configured action index is invalid.");
    const action = item.environment.actions?.[input.actionIndex];
    if (!action) throw new TerminalError("INVALID_ENVIRONMENT_ACTION", "The configured action is unavailable on this host.");
    if ((action.platform && action.platform !== platform) || !action.name.trim() || !action.command.trim() || action.command.includes("\0")) fail("INVALID_ENVIRONMENT_ACTION", "The configured action is unavailable on this host.");
    const command = action.command.trim();
    nativeActionText(resolved.cwd, command); // Reject oversize assembled input before a first terminal is created.
    const release = this.reserveRun(resolved.cwd);
    try {
    const native = this.manager(); if (!native) throw new TerminalError("NATIVE_TERMINAL_UNAVAILABLE", "Native terminals are unavailable on this host.");
    const actionKey = digest(store.host.id, resolved.targetKey, resolved.cwd, path, String(input.actionIndex));
    const existing = native.getAction(actionKey);
    if (existing?.status === "starting") fail("OUTCOME_UNKNOWN", "The previous environment action is still starting; inspect its terminal before retrying.");
    if (existing?.status === "closing") fail("TERMINAL_BUSY", "This environment action is already closing.");
    if (existing?.status === "error" || existing?.status === "interrupted") fail("OUTCOME_UNKNOWN", "The previous environment action outcome is unknown; inspect its terminal, then close and forget it before starting a new action.");
    const environment = resolved.preparationSessionId ? store.getSessionEnvironment(resolved.preparationSessionId) : undefined;
    if (existing) return await native.restartAction(existing.id, command, environment);
    const created = await native.create({ target, cwd: resolved.cwd }, environment, { actionKey });
    return await native.restartAction(created.id, command, environment);
    } finally { release(); }
  }
}
