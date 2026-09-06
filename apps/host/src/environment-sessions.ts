import { createHash } from "node:crypto";
import type {
  CommandEnvelope,
  CommandResult,
  HostCommand,
  SessionSummary,
} from "@agent-desktop/shared";
import {
  sameEnvironmentSelection,
  sameNewChatExecution,
} from "@agent-desktop/shared";
import type { HostStore } from "./store";
import type { HostWorkspaces } from "./workspace-http";
import type { WorkerRuntime, WorkerSession } from "./omp-workers/runtime";
import type { WorkerEvent } from "./omp-workers/events";
import {
  WorktreeEnvironmentLifecycle,
} from "./local-environments/lifecycle";
import type { LocalEnvironmentPreparation } from "./local-environments/preparations";

export type EnvironmentSessionCreateCommand = Extract<
  HostCommand,
  { type: "session.create" }
>;

export type EnvironmentSessionCreateEnvelope = Omit<CommandEnvelope, "command"> & {
  command: EnvironmentSessionCreateCommand;
};

export interface EnvironmentSessionsOptions {
  store: HostStore;
  workspaces: HostWorkspaces;
  runtime: WorkerRuntime;
  reserve: (path: string) => () => void;
  onEvent: (sessionId: string, event: unknown) => void;
  onHandle: (handle: WorkerSession) => void;
  changed: () => void;
  signal?: AbortSignal;
}

const commandHash = (command: HostCommand): string =>
  createHash("sha256").update(JSON.stringify(command)).digest("hex");

const sameModel = (
  left: { provider: string; id: string } | null | undefined,
  right: { provider: string; id: string } | null | undefined,
): boolean =>
  left == null
    ? right == null
    : right != null && left.provider === right.provider && left.id === right.id;

export class EnvironmentSessions {
  private readonly store: HostStore;
  private readonly workspaces: HostWorkspaces;
  private readonly runtime: WorkerRuntime;
  private readonly reserve: (path: string) => () => void;
  private readonly onEvent: (sessionId: string, event: unknown) => void;
  private readonly onHandle: (handle: WorkerSession) => void;
  private readonly changed: () => void;
  private readonly signal?: AbortSignal;
  private readonly lifecycle: WorktreeEnvironmentLifecycle;

  constructor(options: EnvironmentSessionsOptions) {
    this.store = options.store;
    this.workspaces = options.workspaces;
    this.runtime = options.runtime;
    this.reserve = options.reserve;
    this.onEvent = options.onEvent;
    this.onHandle = options.onHandle;
    this.changed = options.changed;
    this.signal = options.signal;
    this.lifecycle = new WorktreeEnvironmentLifecycle(
      options.store,
      options.workspaces,
      { signal: options.signal },
    );
  }

  async create(envelope: EnvironmentSessionCreateEnvelope): Promise<CommandResult> {
    const command = envelope.command;
    const hash = commandHash(command);
    const completed = this.requireClaim(envelope.id, hash);
    if (completed) return completed;

    this.validateCreate(envelope);

    const prior = this.store.environmentPreparations.get(envelope.id);
    if (prior) {
      return this.finishPreparationReceipt(envelope.id, hash, prior);
    }

    const projectId = command.projectId!;
    let release: (() => void) | undefined;
    try {
      const prepared = await this.lifecycle.prepare({
        commandId: envelope.id,
        projectId,
        startingState: command.worktree!,
        environment: command.environment!,
        model: command.model,
        approvalMode: command.approvalMode,
        draft: command.draft!,
      }, path => { release = this.reserve(path); });
      this.changed();
      return await this.finishPrepared(envelope.id, hash, prepared);
    } catch (error) {
      const current = this.store.environmentPreparations.get(envelope.id);
      if (current?.phase === "unknown") {
        this.changed();
        return this.finishPreparationReceipt(envelope.id, hash, current);
      }
      throw error;
    } finally {
      release?.();
    }
  }

  async resume(
    commandId: string,
    preparationId: string,
    expectedRevision: number,
  ): Promise<CommandResult> {
    const command: Extract<HostCommand, { type: "session.environment.resume" }> = {
      type: "session.environment.resume",
      preparationId,
      expectedRevision,
    };
    const hash = commandHash(command);
    const completed = this.requireClaim(commandId, hash);
    if (completed) return completed;

    const current = this.store.environmentPreparations.get(preparationId);
    if (!current) {
      return this.finishFailure(
        commandId,
        hash,
        "ENVIRONMENT_PREPARATION_NOT_FOUND",
        `Environment preparation ${preparationId} was not found`,
      );
    }
    if (current.revision !== expectedRevision) {
      return this.finishFailure(
        commandId,
        hash,
        "ENVIRONMENT_PREPARATION_CONFLICT",
        `Environment preparation revision changed from ${expectedRevision} to ${current.revision}`,
      );
    }
    if (current.phase === "unknown") {
      return this.finishFailure(
        commandId,
        hash,
        "ENVIRONMENT_OUTCOME_UNKNOWN",
        "Inspect the worktree before choosing a new action; an unknown preparation is never replayed",
      );
    }
    if (
      current.phase !== "validated" &&
      current.phase !== "worktree-created" &&
      current.phase !== "setup-failed" &&
      current.phase !== "setup-succeeded"
    ) {
      return this.finishFailure(
        commandId,
        hash,
        "ENVIRONMENT_PREPARATION_NOT_RESUMABLE",
        `Environment preparation in phase ${current.phase} cannot be resumed`,
      );
    }

    this.requireCurrentOwnership(current);
    const release = this.reserve(current.worktreePath);
    try {
      const prepared = await this.lifecycle.continuePreparation(
        preparationId,
        expectedRevision,
      );
      this.changed();
      return await this.finishPrepared(commandId, hash, prepared);
    } catch (error) {
      const latest = this.store.environmentPreparations.get(preparationId);
      if (latest?.phase === "unknown") {
        this.changed();
        return this.finishPreparationReceipt(commandId, hash, latest);
      }
      throw error;
    } finally {
      release();
    }
  }

  private validateCreate(envelope: EnvironmentSessionCreateEnvelope): void {
    const command = envelope.command;
    if (envelope.commandVersion !== 5) {
      throw new Error("Environment session creation requires command version 5");
    }
    if (
      !command.projectId ||
      command.cwd !== undefined ||
      !command.worktree ||
      command.environment === undefined ||
      !command.draft
    ) {
      throw new Error(
        "Environment session creation requires project, worktree, environment, and draft ownership",
      );
    }
    const project = this.store.getProject(command.projectId);
    if (!project || project.hostId !== this.store.host.id) {
      throw new Error(`Project ${command.projectId} is not owned by this host`);
    }
    const draft = this.store.getDraft(command.draft.id);
    if (!draft || draft.revision !== command.draft.revision) {
      throw new Error("The captured draft revision is unavailable");
    }
    if (
      draft.projectId !== command.projectId ||
      !sameModel(draft.model, command.model) ||
      draft.approvalMode !== command.approvalMode ||
      !sameNewChatExecution(draft.execution, {
        type: "worktree",
        startingState: command.worktree,
      }) ||
      draft.environment === undefined ||
      !sameEnvironmentSelection(draft.environment, command.environment)
    ) {
      throw new Error("The session command no longer matches its captured draft");
    }
  }

  private requireCurrentOwnership(record: LocalEnvironmentPreparation): void {
    if (record.hostId !== this.store.host.id) {
      throw new Error(`Environment preparation ${record.id} belongs to another host`);
    }
    const project = this.store.getProject(record.projectId);
    if (!project || project.hostId !== this.store.host.id || project.path !== record.sourceRoot) {
      throw new Error(`Project ownership changed for environment preparation ${record.id}`);
    }
  }

  private async finishPrepared(
    commandId: string,
    hash: string,
    record: LocalEnvironmentPreparation,
  ): Promise<CommandResult> {
    if (record.phase === "setup-failed" || record.phase === "unknown") {
      return this.finishPreparationReceipt(commandId, hash, record);
    }
    if (record.phase !== "worktree-created" && record.phase !== "setup-succeeded") {
      throw new Error(`Environment preparation stopped in phase ${record.phase}`);
    }
    return this.createNativeSession(commandId, hash, record);
  }

  private async createNativeSession(
    commandId: string,
    hash: string,
    record: LocalEnvironmentPreparation,
  ): Promise<CommandResult> {
    if (this.signal?.aborted) {
      throw this.signal.reason instanceof Error
        ? this.signal.reason
        : new Error("Host is stopping");
    }
    const started = this.store.environmentPreparations.transition(
      record.id,
      record.revision,
      { type: "native-create.started" },
    );
    this.changed();

    let handle: WorkerSession | undefined;
    let durable = false;
    let sessionId: string | undefined;
    try {
      handle = await this.runtime.create(
        {
          cwd: started.worktreePath,
          model: started.model,
          approvalOverride: started.approvalMode,
          interactions: true,
          onEvent: (event: WorkerEvent) => {
            if (sessionId) this.onEvent(sessionId, event);
          },
        },
        started.environment
          ? {
              environmentDelta: started.environmentDelta ?? null,
              sourceRoot: started.sourceRoot,
              worktreeRoot: started.worktreePath,
            }
          : undefined,
      );
      sessionId = handle.id;
      const session = this.toSessionSummary(handle, started);
      const result = this.store.finishEnvironmentSessionCreation(
        commandId,
        hash,
        session,
        { id: started.id, expectedRevision: started.revision },
      );
      durable = true;
      this.onHandle(handle);
      this.changed();
      return result;
    } catch (error) {
      if (handle && !durable) {
        await handle.dispose().catch(() => undefined);
      }
      if (durable) throw error;

      const current = this.store.environmentPreparations.get(started.id);
      if (current?.phase === "native-creating" && current.revision === started.revision) {
        const unknown = this.store.environmentPreparations.transition(
          current.id,
          current.revision,
          { type: "outcome.unknown" },
        );
        this.changed();
        return this.finishPreparationReceipt(commandId, hash, unknown);
      }
      throw error;
    }
  }

  private toSessionSummary(
    handle: WorkerSession,
    record: LocalEnvironmentPreparation,
  ): SessionSummary {
    const now = Date.now();
    return {
      id: handle.id,
      hostId: this.store.host.id,
      projectId: record.projectId,
      cwd: handle.cwd,
      title: handle.title || "New conversation",
      status: "idle",
      sessionFile: handle.sessionFile,
      model: handle.model,
      createdAt: Number.isFinite(handle.createdAt) ? handle.createdAt : now,
      updatedAt: now,
      archived: false,
      error: handle.modelFallbackMessage,
      approvalOverride: record.approvalMode,
    };
  }

  private requireClaim(commandId: string, hash: string): CommandResult | undefined {
    const claim = this.store.getCommand(commandId);
    if (!claim || claim.requestHash !== hash) {
      throw new Error(`Command ${commandId} was not claimed with the expected request`);
    }
    if (claim.state === "pending") return undefined;
    if (!claim.result) {
      throw new Error(`Completed command ${commandId} has no durable result`);
    }
    return claim.result;
  }

  private finishPreparationReceipt(
    commandId: string,
    hash: string,
    record: LocalEnvironmentPreparation,
  ): CommandResult {
    const result: CommandResult = {
      ok: true,
      commandId,
      value: {
        type: "environment.preparation",
        preparation: this.store.environmentPreparations.public(record),
      },
    };
    this.store.finishCommand(commandId, hash, result);
    this.changed();
    return result;
  }

  private finishFailure(
    commandId: string,
    hash: string,
    code: string,
    message: string,
  ): CommandResult {
    const result: CommandResult = {
      ok: false,
      commandId,
      error: { code, message },
    };
    this.store.finishCommand(commandId, hash, result);
    this.changed();
    return result;
  }
}
