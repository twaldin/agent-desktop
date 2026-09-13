import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandResult, LocalEnvironmentSelection, NewChatExecution, SessionForkOperation, SessionForkSnapshot, SessionSummary } from "@agent-desktop/shared";
import type { HostStore } from "./store";
import type { HostWorkspaces } from "./workspace-http";
import type { WorkerRuntime, WorkerSession } from "./omp-workers/runtime";
import type { LocalEnvironmentWorkerEnvironment } from "./local-environments/environment";
import { WorktreeEnvironmentLifecycle } from "./local-environments/lifecycle";
import type { LocalEnvironmentRuns } from "./local-environments/runs";
import { readSessionHeader } from "./omp/session-files";
import { WorkspaceService } from "./workspace/service";

export interface SessionForkIntent {
  version: 1;
  commandId: string;
  source: SessionSummary;
  execution: NewChatExecution;
  state: SessionForkOperation["state"];
  targetFile: string;
  targetCwd?: string;
  worktreePath?: string;
  selectedEnvironment: LocalEnvironmentSelection;
  environment?: LocalEnvironmentWorkerEnvironment;
  child?: SessionSummary;
  error?: string;
}

export const sessionForkIntentKey = (sessionId: string): string => `session-fork.v1:${sessionId}`;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
export class SessionForkError extends Error {
  constructor(readonly code: string, text: string) { super(text); }
}
const refusal = (code: string, text: string): SessionForkError => new SessionForkError(code, text);

/** Owns the native-copy boundary. The retained source worker is only flushed, never forked or retired. */
export class SessionForkService {
  private readonly active = new Set<string>();
  private readonly lifecycle: WorktreeEnvironmentLifecycle;

  isActive(sessionId: string): boolean { return this.active.has(sessionId); }

  constructor(private readonly options: {
    store: HostStore;
    workspaces: HostWorkspaces;
    runtime: WorkerRuntime;
    dataDirectory: string;
    existing(sessionId: string): Promise<WorkerSession | undefined>;
    busy(sessionId: string): boolean;
    reserve(path: string): () => void;
    environment(projectId: string): Promise<LocalEnvironmentSelection>;
    changed(snapshot: SessionForkSnapshot): void;
    runs?: LocalEnvironmentRuns;
    signal?: AbortSignal;
  }) {
    this.lifecycle = new WorktreeEnvironmentLifecycle(options.store, options.workspaces, { signal: options.signal }, options.runs);
    // Startup observes interrupted effects; it never redispatches them.
    for (const source of options.store.listSessions()) {
      const intent = this.intent(source.id);
      if (!intent) continue;
      const preparation = options.store.environmentPreparations.get(intent.commandId);
      if (intent.state === "forking" || intent.state === "preparing" && preparation?.phase === "unknown")
        this.save({ ...intent, state: "unknown", error: "The interrupted Fork has an unconfirmed outcome. Inspect its recorded files; it will not be replayed." });
    }
  }

  private intent(sessionId: string): SessionForkIntent | undefined {
    return this.options.store.readMetadata<SessionForkIntent>(sessionForkIntentKey(sessionId));
  }

  private save(intent: SessionForkIntent): void {
    this.options.store.writeMetadata(sessionForkIntentKey(intent.source.id), intent);
  }

  private source(sessionId: string): SessionSummary {
    const source = this.options.store.getSession(sessionId);
    if (!source || source.hostId !== this.options.store.host.id) throw refusal("SESSION_NOT_FOUND", "This conversation is not owned by the connected host.");
    return source;
  }

  private resumable(intent: SessionForkIntent): boolean {
    if (this.active.has(intent.source.id)) return false;
    if (intent.state === "binding") return Boolean(intent.child);
    if (intent.state !== "preparing") return false;
    const preparation = this.options.store.environmentPreparations.get(intent.commandId);
    return !preparation || ["validated", "worktree-created", "setup-failed", "setup-succeeded"].includes(preparation.phase);
  }

  async get(sessionId: string): Promise<SessionForkSnapshot> {
    const source = this.source(sessionId), intent = this.intent(sessionId);
    let reason = source.archived ? "Unarchive this conversation before forking it."
      : source.status !== "idle" || this.options.busy(sessionId) ? "Wait for the conversation to become idle before forking it." : undefined;
    let isWorktree = false, worktreeReason: string | undefined, fingerprint = "unavailable";
    try {
      const [header, file] = await Promise.all([readSessionHeader(source.sessionFile), stat(source.sessionFile)]);
      if (header.id !== source.id || header.cwd !== source.cwd) throw new Error("The native session file no longer matches this conversation.");
      await realpath(source.cwd);
      fingerprint = `${file.size}:${file.mtimeMs}`;
    } catch (error) { reason ??= message(error); }
    try {
      const workspace = new WorkspaceService(source.cwd), context = await workspace.gitWorkspaceContext();
      const repository = await (await workspace.gitRootService()).repositoryWatchContext();
      isWorktree = repository.gitDir !== repository.commonDir;
      const project = source.projectId ? this.options.store.getCataloguedProject(source.projectId) : undefined;
      if (!project || project.hostId !== source.hostId) throw new Error("Add this workspace as a project before creating a worktree.");
      const projectWorkspace = new WorkspaceService(project.path), projectContext = await projectWorkspace.gitWorkspaceContext();
      const projectRepository = await (await projectWorkspace.gitRootService()).repositoryWatchContext();
      if (repository.commonDir !== projectRepository.commonDir || context.workspaceRelativePath !== projectContext.workspaceRelativePath)
        throw new Error("This conversation no longer belongs to its project's workspace.");
    } catch (error) { worktreeReason = message(error); }
    if (intent && intent.state !== "complete" && intent.state !== "failed")
      reason = intent.state === "unknown" ? "Inspect the original Fork outcome; an unknown operation cannot be replayed." : "Finish the original Fork operation before starting another.";
    const operation: SessionForkOperation | undefined = intent ? {
      commandId: intent.commandId, execution: intent.execution, state: intent.state, canResume: this.resumable(intent),
      ...(intent.error ? { error: intent.error } : {}),
      ...(intent.child ? { sessionId: intent.child.id, sessionFile: intent.child.sessionFile } : {}),
      ...(intent.worktreePath ? { worktreePath: intent.worktreePath } : {}),
    } : undefined;
    const revision = createHash("sha256").update(JSON.stringify({ source, fingerprint, reason, worktreeReason, isWorktree, operation })).digest("hex");
    return { version: 1, hostId: source.hostId, sessionId, revision,
      local: { available: !reason, ...(reason ? { reason } : {}), cwd: source.cwd, isWorktree },
      worktree: { available: !reason && !worktreeReason, ...((reason ?? worktreeReason) ? { reason: reason ?? worktreeReason } : {}) },
      ...(operation ? { operation } : {}) };
  }

  private async notify(sessionId: string): Promise<void> {
    this.options.changed(await this.get(sessionId));
  }

  async fork(commandId: string, sessionId: string, expectedRevision: string, execution: NewChatExecution): Promise<CommandResult> {
    const snapshot = await this.get(sessionId);
    if (snapshot.revision !== expectedRevision) throw refusal("FORK_CONFLICT", "The conversation or Fork destination changed. Refresh before choosing again.");
    if (execution.type === "worktree" && execution.startingState.type !== "working-tree") throw refusal("INVALID_FORK_DESTINATION", "Fork creates a worktree from the current working tree.");
    const destination = execution.type === "local" ? snapshot.local : snapshot.worktree;
    if (!destination.available) throw refusal("FORK_UNAVAILABLE", destination.reason ?? "This Fork destination is unavailable.");
    const source = this.source(sessionId);
    const selectedEnvironment = execution.type === "worktree" ? await this.options.environment(source.projectId!) : null;
    const directory = join(await realpath(this.options.dataDirectory), "forks");
    const intent: SessionForkIntent = { version: 1, commandId, source, execution, state: "preparing", selectedEnvironment,
      targetFile: join(directory, `${createHash("sha256").update(commandId).digest("hex")}.jsonl`) };
    const claim = this.options.store.getCommand(commandId);
    if (claim?.state !== "pending" || claim.command?.type !== "session.fork" || claim.command.sessionId !== sessionId)
      throw new Error("Fork requires its original durable command claim.");
    // Recheck after asynchronous admission. Never overwrite a newly admitted or unknown operation.
    if ((await this.get(sessionId)).revision !== expectedRevision) throw refusal("FORK_CONFLICT", "Fork ownership changed during admission.");
    return this.run(commandId, intent, true);
  }

  async resume(commandId: string, sessionId: string, operationId: string): Promise<CommandResult> {
    this.source(sessionId);
    const intent = this.intent(sessionId);
    if (!intent || intent.commandId !== operationId) throw refusal("FORK_CONFLICT", "The original Fork operation is no longer current.");
    if (intent.state === "complete") return this.options.store.finishSessionFork(commandId, intent);
    if (!this.resumable(intent)) throw refusal("FORK_NOT_RESUMABLE", "This Fork outcome cannot be safely replayed. Inspect the recorded operation.");
    return this.run(commandId, intent, false);
  }

  private async run(commandId: string, initial: SessionForkIntent, fresh: boolean): Promise<CommandResult> {
    const { store } = this.options;
    if (this.active.has(initial.source.id)) throw refusal("FORK_BUSY", "The original Fork is still running.");
    let intent = initial, releaseSource: (() => void) | undefined, releaseDestination: (() => void) | undefined;
    this.active.add(intent.source.id);
    try {
      if (intent.state === "binding") return store.finishSessionFork(commandId, intent);
      const source = this.source(intent.source.id);
      if (source.sessionFile !== intent.source.sessionFile || source.cwd !== intent.source.cwd || source.projectId !== intent.source.projectId)
        throw new Error("The captured Fork source moved or changed identity.");
      if (source.archived || source.status !== "idle" || this.options.busy(source.id)) throw new Error("The original conversation must be idle before continuing Fork.");
      releaseSource = this.options.reserve(source.cwd);
      const handle = await this.options.existing(source.id);
      if (handle) {
        if (handle.workerFailure || handle.id !== source.id || handle.sessionFile !== source.sessionFile || handle.cwd !== source.cwd)
          throw new Error("The retained native source owner is unavailable or changed.");
        const flushed = await handle.flushSession();
        if (flushed.sessionId !== source.id || flushed.sessionFile !== source.sessionFile || flushed.cwd !== source.cwd)
          throw new Error("The flushed native session does not match the captured Fork source.");
      }
      intent = { ...intent, source, error: undefined };
      this.save(intent); // Before worktree or native-copy effects; never consume the source draft.
      await this.notify(source.id);
      if (intent.execution.type === "worktree") {
        let preparation = store.environmentPreparations.get(intent.commandId);
        if (preparation) {
          releaseDestination = this.options.reserve(preparation.worktreePath);
          preparation = await this.lifecycle.continuePreparation(preparation.id, preparation.revision);
        } else {
          preparation = await this.lifecycle.prepare({ commandId: intent.commandId, projectId: source.projectId!,
            startingState: intent.execution.startingState, environment: intent.selectedEnvironment,
            model: source.model ?? undefined, approvalMode: source.approvalOverride,
            draft: { id: `fork:${intent.commandId}`, revision: 0 },
            forkSource: { id: source.id, cwd: source.cwd, sessionFile: source.sessionFile },
          }, path => { releaseDestination = this.options.reserve(path); });
        }
        intent = { ...intent, worktreePath: preparation.worktreePath };
        this.save(intent);
        if (preparation.phase === "setup-failed") throw new Error("Worktree setup failed. Inspect its output, then explicitly resume this Fork.");
        if (preparation.phase !== "worktree-created" && preparation.phase !== "setup-succeeded") throw new Error(`Fork preparation stopped in ${preparation.phase}.`);
        const directories = await this.options.workspaces.verifyPreparedWorktree(preparation.projectId, preparation.worktreePath,
          { ...preparation.directories!, configCwdRelativePath: preparation.environment ? preparation.directories!.configCwdRelativePath : null });
        intent = { ...intent, targetCwd: directories.worktreeWorkspaceRoot,
          environment: preparation.environment ? { sourceRoot: preparation.sourceRoot, worktreeRoot: directories.worktreeWorkspaceRoot,
            environmentDelta: preparation.environmentDelta ?? null } : undefined };
        this.save(intent);
        store.environmentPreparations.transition(preparation.id, preparation.revision, { type: "native-create.started" });
      } else {
        intent = { ...intent, targetCwd: source.cwd, environment: store.getSessionEnvironment(source.id) };
      }
      await mkdir(dirname(intent.targetFile), { recursive: true, mode: 0o700 });
      this.options.signal?.throwIfAborted();
      intent = { ...intent, state: "forking" };
      this.save(intent);
      await this.notify(source.id);
      const native = await this.options.runtime.forkSession({ sourceSessionId: source.id, sourceSessionFile: source.sessionFile,
        cwd: intent.targetCwd!, sessionDirectory: dirname(intent.targetFile), sessionFile: intent.targetFile });
      if (native.parentSessionId !== source.id || native.sessionId === source.id || native.sessionFile !== intent.targetFile || native.cwd !== intent.targetCwd)
        throw new Error("Native Fork returned an unexpected child authority.");
      const child: SessionSummary = { id: native.sessionId, hostId: source.hostId, projectId: source.projectId,
        sessionFile: native.sessionFile, cwd: native.cwd, title: source.title, model: handle?.model ?? source.model,
        createdAt: native.createdAt, updatedAt: Date.now(), status: "idle", archived: false, approvalOverride: source.approvalOverride };
      intent = { ...intent, state: "binding", child };
      this.save(intent); // Copy worker has acknowledged shutdown. Binding can now resume without native replay.
      return store.finishSessionFork(commandId, intent);
    } catch (error) {
      const durable = this.intent(intent.source.id);
      if (durable?.commandId === intent.commandId && durable.state === "complete") return store.finishSessionFork(commandId, durable);
      if (durable?.commandId === intent.commandId) {
        const preparation = store.environmentPreparations.get(intent.commandId);
        const unknown = durable.state === "forking" || durable.state !== "binding"
          && (preparation?.phase === "unknown" || preparation?.phase === "native-creating");
        intent = { ...durable, state: unknown ? "unknown" : durable.state === "binding" ? "binding" : preparation ? "preparing" : "failed",
          error: message(error), ...(preparation ? { worktreePath: preparation.worktreePath } : {}) };
        this.save(intent);
        if (unknown) throw refusal("OUTCOME_UNKNOWN", `${message(error)} The original Fork will not be replayed.`);
      } else if (!fresh) throw refusal("FORK_CONFLICT", "The original Fork ownership changed.");
      throw error;
    } finally {
      releaseDestination?.(); releaseSource?.(); this.active.delete(initial.source.id);
      await this.notify(initial.source.id);
    }
  }
}
