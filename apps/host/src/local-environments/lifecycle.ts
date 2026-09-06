import { createHash } from "node:crypto";
import { parseLocalEnvironment, scriptForPlatform, type LocalEnvironmentPlatform, type ModelChoice, type OmpApprovalMode, type WorktreeStartingState } from "@agent-desktop/shared";
import type { HostStore } from "../store";
import type { HostWorkspaces } from "../workspace-http";
import { LocalEnvironmentStore } from "./index";
import type { LocalEnvironmentPreparation } from "./preparations";
import type { LocalEnvironmentPreparations } from "./preparations";
import { LocalEnvironmentRuns } from "./runs";
import type { LocalEnvironmentRunInput } from "./runner";
import { materializeWorktreeEnvironment } from "./worktree-config";
import { dirname, relative } from "node:path";

export interface PrepareEnvironmentWorktree {
  commandId: string;
  projectId: string;
  draft: { id: string; revision: number };
  startingState: WorktreeStartingState;
  model?: ModelChoice;
  approvalMode?: OmpApprovalMode;
  environment: { configPath: string; revision: string } | null;
}

type RunOptions = Pick<LocalEnvironmentRunInput, "signal" | "onOutput" | "timeoutMs" | "maxOutputBytes" | "baseEnvironment">;

/** Owns setup/cleanup ordering. Reobserving an existing identity never dispatches its effects again. */
export class WorktreeEnvironmentLifecycle {
  private runs: LocalEnvironmentRuns;

  constructor(
    private store: HostStore,
    private workspaces: HostWorkspaces,
    private runOptions: RunOptions = {},
    runs?: LocalEnvironmentRuns,
  ) {
    this.runs = runs ?? new LocalEnvironmentRuns(store.environmentPreparations as LocalEnvironmentPreparations);
  }

  async prepare(
    input: PrepareEnvironmentWorktree,
    onDestination?: (path: string) => void,
  ): Promise<LocalEnvironmentPreparation> {
    const existing = this.store.environmentPreparations.get(input.commandId);
    if (existing) {
      if (existing.projectId !== input.projectId) throw new Error("Preparation belongs to a different project.");
      // Command payload equality is also checked by the host command ledger.
      return existing;
    }
    const project = this.store.getProject(input.projectId);
    if (!project) throw new Error("The selected project is not on this host.");
    const configuration = input.environment ? await new LocalEnvironmentStore(project.path).read(input.environment.configPath) : null;
    if (configuration) {
      if (configuration.revision !== input.environment!.revision) throw new Error("The environment changed. Refresh its selection before creating a worktree.");
      parseLocalEnvironment(configuration.raw);
    }
    // Validate the configuration before creating even the managed parent directory.
    const directories = await this.workspaces.directoryContext(project.id, configuration?.configPath ?? null);
    const name = `chat-${createHash("sha256").update(input.commandId).digest("hex")}`;
    const worktreePath = await this.workspaces.sessionWorktreeDestination(project.id, name, directories);
    onDestination?.(worktreePath);
    let record = this.store.createEnvironmentPreparation({ id: input.commandId, projectId: project.id, sourceRoot: project.path,
      worktreePath, startingState: input.startingState, draft: input.draft, model: input.model, approvalMode: input.approvalMode,
      environment: configuration, directories });
    return this.createWorktree(record);
  }

  /** Continue only a caller-authorized, current, known phase. Unknown effects are inspection-only. */
  async continuePreparation(id: string, expectedRevision: number): Promise<LocalEnvironmentPreparation> {
    const record = this.store.environmentPreparations.get(id);
    if (!record || record.revision !== expectedRevision) throw new Error("The worktree preparation changed. Refresh before continuing.");
    switch (record.phase) {
      case "validated": return this.createWorktree(record);
      case "worktree-created": return record.environment ? this.setup(record) : record;
      case "setup-failed": return this.setup(record);
      case "setup-succeeded": return record;
      case "unknown": throw new Error("This preparation has an unknown outcome. Inspect it before choosing a recovery action.");
      default: throw new Error(`Preparation cannot continue while it is ${record.phase}.`);
    }
  }

  private async createWorktree(current: LocalEnvironmentPreparation): Promise<LocalEnvironmentPreparation> {
    let record = this.store.environmentPreparations.transition(current.id, current.revision, { type: "worktree-create.started" });
    try {
      const name = `chat-${createHash("sha256").update(record.id).digest("hex")}`;
      const worktree = await this.workspaces.createSessionWorktree(record.projectId, name, record.startingState, record.directories);
      if (record.directories) {
        await this.workspaces.verifyPreparedWorktree(record.projectId, worktree.path, { ...record.directories, configCwdRelativePath: null });
        const effective = await materializeWorktreeEnvironment({ sourceWorkspaceRoot: record.sourceRoot,
          sourceGitRoot: record.directories.sourceGitRoot, worktreeGitRoot: worktree.path, selected: record.environment });
        await this.workspaces.verifyPreparedWorktree(record.projectId, worktree.path,
          { ...record.directories, configCwdRelativePath: effective.configPath ? record.directories.configCwdRelativePath : null });
        record = this.store.environmentPreparations.transition(record.id, record.revision, { type: "worktree-create.succeeded", worktreePath: worktree.path,
          materializedEnvironment: effective.configPath === null ? null : { configPath: effective.configPath, revision: effective.revision!, raw: effective.raw! } });
      } else record = this.store.environmentPreparations.transition(record.id, record.revision, { type: "worktree-create.succeeded", worktreePath: worktree.path });
    } catch (error) {
      this.store.environmentPreparations.transition(record.id, record.revision, { type: "outcome.unknown" });
      throw error;
    }
    return record.environment ? this.setup(record) : record;
  }

  /** Only an explicit new recovery command with this current revision may retry known failed setup. */
  async retrySetup(id: string, expectedRevision: number): Promise<LocalEnvironmentPreparation> {
    const record = this.store.environmentPreparations.get(id);
    if (!record || record.revision !== expectedRevision || record.phase !== "setup-failed") throw new Error("Only the current failed setup can be retried. Refresh its status first.");
    return this.setup(record);
  }

  private async setup(current: LocalEnvironmentPreparation): Promise<LocalEnvironmentPreparation> {
    const directories = await this.executionDirectories(current);
    const record = this.store.environmentPreparations.transition(current.id, current.revision, { type: "setup.started" });
    try {
      const config = parseLocalEnvironment(record.environment!.raw);
      const result = await this.runs.run(record, { ...this.runOptions, ...directories, lifecycle: "setup", script: scriptForPlatform(config.setup, process.platform as LocalEnvironmentPlatform) ?? "" });
      return this.store.environmentPreparations.transition(record.id, record.revision, { type: result.status === "succeeded" ? "setup.succeeded" : "setup.failed", result });
    } catch (error) {
      this.store.environmentPreparations.transition(record.id, record.revision, { type: "outcome.unknown" });
      throw error;
    }
  }

  /** Caller holds the worktree mutation reservation and removes Git registration only after this succeeds. */
  async cleanup(id: string, expectedRevision: number): Promise<LocalEnvironmentPreparation> {
    const current = this.store.environmentPreparations.get(id);
    if (!current || current.revision !== expectedRevision) throw new Error("The worktree preparation changed. Refresh before cleanup.");
    if (current.phase === "cleanup-succeeded" || current.phase === "removed") return current;
    const selected = await this.cleanupConfiguration(current);
    const record = this.store.environmentPreparations.transition(id, expectedRevision, { type: "cleanup.started" });
    try {
      const config = selected.raw ? parseLocalEnvironment(selected.raw) : null;
      const script = config ? scriptForPlatform(config.cleanup, process.platform as LocalEnvironmentPlatform) : null;
      const result = script ? await this.runs.run(record, { ...this.runOptions, ...selected.directories, lifecycle: "cleanup", script }) : undefined;
      if (result && result.status !== "succeeded") return this.store.environmentPreparations.transition(id, record.revision, { type: "cleanup.failed", result });
      return this.store.environmentPreparations.transition(id, record.revision, { type: "cleanup.succeeded", result });
    } catch (error) {
      this.store.environmentPreparations.transition(id, record.revision, { type: "outcome.unknown" });
      throw error;
    }
  }

  private async cleanupConfiguration(record: LocalEnvironmentPreparation) {
    if (!record.directories) return { raw: record.environment?.raw, directories: await this.executionDirectories(record) };
    const mapped = await this.workspaces.verifyPreparedWorktree(record.projectId, record.worktreePath, { ...record.directories, configCwdRelativePath: null });
    const selection = this.store.getActionEnvironmentSelection(mapped.worktreeGitRoot);
    const configPath = selection ? selection.configPath : record.environment?.configPath ?? null;
    let raw: string | undefined, configCwdRelativePath: string | null = null;
    if (configPath !== null) {
      const sourceFallback = configPath === record.environment?.configPath && configPath === record.selectedEnvironment?.configPath;
      const config = await new LocalEnvironmentStore(sourceFallback ? record.sourceRoot : mapped.worktreeWorkspaceRoot).read(configPath);
      raw = config.raw;
      configCwdRelativePath = relative(sourceFallback ? record.directories.sourceGitRoot : record.worktreePath, dirname(dirname(dirname(config.configPath))));
    }
    const directories = await this.workspaces.verifyPreparedWorktree(record.projectId, record.worktreePath, { ...record.directories, configCwdRelativePath });
    const latest = this.store.getActionEnvironmentSelection(mapped.worktreeGitRoot);
    if (latest?.revision !== selection?.revision || latest?.configPath !== selection?.configPath)
      throw new Error("The selected cleanup environment changed. Refresh before removing the worktree.");
    return { raw, directories: { cwd: directories.scriptCwd ?? directories.worktreeWorkspaceRoot, sourceRoot: record.sourceRoot,
      worktreeRoot: directories.worktreeWorkspaceRoot, worktreeGitRoot: directories.worktreeGitRoot } };
  }

  private async executionDirectories(record: LocalEnvironmentPreparation) {
    if (!record.directories) return { cwd: record.worktreePath, sourceRoot: record.sourceRoot, worktreeRoot: record.worktreePath };
    const mapped = await this.workspaces.verifyPreparedWorktree(record.projectId, record.worktreePath,
      { ...record.directories, configCwdRelativePath: record.environment ? record.directories.configCwdRelativePath : null });
    return { cwd: mapped.scriptCwd ?? mapped.worktreeWorkspaceRoot, sourceRoot: record.sourceRoot,
      worktreeRoot: mapped.worktreeWorkspaceRoot, worktreeGitRoot: mapped.worktreeGitRoot };
  }
}
