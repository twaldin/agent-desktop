import { createHash } from "node:crypto";
import { parseLocalEnvironment, scriptForPlatform, type LocalEnvironmentPlatform, type ModelChoice, type OmpApprovalMode, type WorktreeStartingState } from "@agent-desktop/shared";
import type { HostStore } from "../store";
import type { HostWorkspaces } from "../workspace-http";
import { LocalEnvironmentStore } from "./index";
import type { LocalEnvironmentPreparation } from "./preparations";
import type { LocalEnvironmentPreparations } from "./preparations";
import { LocalEnvironmentRuns } from "./runs";
import type { LocalEnvironmentRunInput } from "./runner";

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
    const name = `chat-${createHash("sha256").update(input.commandId).digest("hex")}`;
    const worktreePath = await this.workspaces.sessionWorktreeDestination(project.id, name);
    onDestination?.(worktreePath);
    let record = this.store.createEnvironmentPreparation({ id: input.commandId, projectId: project.id, sourceRoot: project.path,
      worktreePath, startingState: input.startingState, draft: input.draft, model: input.model, approvalMode: input.approvalMode,
      environment: configuration });
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
      const worktree = await this.workspaces.createSessionWorktree(record.projectId, name, record.startingState);
      record = this.store.environmentPreparations.transition(record.id, record.revision, { type: "worktree-create.succeeded", worktreePath: worktree.path });
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
    const record = this.store.environmentPreparations.transition(current.id, current.revision, { type: "setup.started" });
    try {
      const config = parseLocalEnvironment(record.environment!.raw);
      const result = await this.runs.run(record, { ...this.runOptions, cwd: record.worktreePath, sourceRoot: record.sourceRoot,
        worktreeRoot: record.worktreePath, lifecycle: "setup", script: scriptForPlatform(config.setup, process.platform as LocalEnvironmentPlatform) ?? "" });
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
    const record = this.store.environmentPreparations.transition(id, expectedRevision, { type: "cleanup.started" });
    try {
      const config = record.environment ? parseLocalEnvironment(record.environment.raw) : null;
      const script = config ? scriptForPlatform(config.cleanup, process.platform as LocalEnvironmentPlatform) : null;
      const result = script ? await this.runs.run(record, { ...this.runOptions, cwd: record.worktreePath, sourceRoot: record.sourceRoot,
        worktreeRoot: record.worktreePath, lifecycle: "cleanup", script }) : undefined;
      if (result && result.status !== "succeeded") return this.store.environmentPreparations.transition(id, record.revision, { type: "cleanup.failed", result });
      return this.store.environmentPreparations.transition(id, record.revision, { type: "cleanup.succeeded", result });
    } catch (error) {
      this.store.environmentPreparations.transition(id, record.revision, { type: "outcome.unknown" });
      throw error;
    }
  }
}
