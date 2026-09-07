import type { LocalEnvironmentActions } from "./local-environments/actions";
import { LocalEnvironmentStore } from "./local-environments";
import { join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import type { WorkspaceMutation, WorkspaceMutationResult, WorkspaceQuery, WorkspaceQueryResult, WorkspaceTarget } from "@agent-desktop/shared";
import type { HostStore } from "./store";
import { WorkspaceService } from "./workspace";
import type { WorktreeStartingState, GitWorktree } from '@agent-desktop/shared';
import { resolveWorktreeDirectoryContext, verifyWorktreeDirectories } from "./local-environments/worktree-directory-resolution";
import type { WorktreeDirectoryContext } from "./local-environments/worktree-directories";
import type { SessionSummary } from "@agent-desktop/shared";
import { WorkspaceError } from "./workspace";
import { WorkspaceFileOpen } from "./workspace-open";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workspace request.");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 16_384): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > maximum) throw new Error("Invalid workspace text value.");
  return value;
}
function optionalText(value: unknown): string | undefined { return value === undefined ? undefined : text(value); }
function optionalBoolean(value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") throw new Error("Invalid boolean value.");
  return value as boolean | undefined;
}
export function parseWorkspaceTarget(value: unknown): WorkspaceTarget {
  const target = object(value);
  if (Object.keys(target).length !== 1) throw new Error("Select one workspace owner.");
  if ("projectId" in target) return { projectId: text(target.projectId, 200) };
  if ("sessionId" in target) return { sessionId: text(target.sessionId, 200) };
  throw new Error("A catalogued project or session is required.");
}
export function parseWorkspaceQuery(value: unknown): WorkspaceQuery {
  const query = object(value);
  switch (query.type) {
    case "environment.output":
    case "environment.preparation": return { type: query.type, preparationId: text(query.preparationId, 200) };
    case "environment.read": return { type: query.type, configPath: text(query.configPath) };
    case "files.list": return { type: query.type, path: optionalText(query.path) };
    case "file.stat": case "file.read": case "file.open-options": return { type: query.type, path: text(query.path) };
    case "environment.actions": case "environments.list": case "git.status": case "git.branches": case "git.worktrees": return { type: query.type };
    case "git.diff": {
      if (query.context !== undefined && (!Number.isSafeInteger(query.context) || (query.context as number) < 0 || (query.context as number) > 1000)) throw new Error("Invalid diff context.");
      return { type: query.type, path: optionalText(query.path), staged: optionalBoolean(query.staged), context: query.context as number | undefined };
    }
    default: throw new Error("Unknown workspace query.");
  }
}
export function parseWorkspaceMutation(value: unknown): WorkspaceMutation {
  const action = object(value);
  switch (action.type) {
    case "environment.select": {
      if (!Number.isSafeInteger(action.expectedRevision) || (action.expectedRevision as number) < 0) throw new Error("Invalid environment selection revision.");
      return { type: action.type, configPath: action.configPath === null ? null : text(action.configPath), expectedRevision: action.expectedRevision as number };
    }
    case "environment.action": {
      if (!Number.isSafeInteger(action.selectionRevision) || (action.selectionRevision as number) < 0 || !Number.isSafeInteger(action.actionIndex) || (action.actionIndex as number) < 0)
        throw new Error("Invalid environment action selection.");
      if (typeof action.configRevision !== "string" || !/^[a-f0-9]{64}$/.test(action.configRevision)) throw new Error("The exact environment config revision is required.");
      return { type: action.type, configPath: text(action.configPath), configRevision: action.configRevision, selectionRevision: action.selectionRevision as number, actionIndex: action.actionIndex as number };
    }
    case "environment.save": {
      if (typeof action.raw !== "string" || new TextEncoder().encode(action.raw).length > 1024 * 1024) throw new Error("Invalid environment config or config exceeds 1 MiB.");
      if (action.expectedRevision !== null && (typeof action.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(action.expectedRevision))) throw new Error("The exact environment revision is required.");
      return { type: action.type, raw: action.raw, expectedRevision: action.expectedRevision, ...(action.configPath === null ? { configPath: null } : action.configPath === undefined ? {} : { configPath: text(action.configPath) }) };
    }
    case "file.write": {
      if (typeof action.text !== "string" || action.text.length > 2 * 1024 * 1024) throw new Error("Invalid file contents or file too large.");
      if (action.expectedRevision !== null && (typeof action.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(action.expectedRevision))) throw new Error("The exact file revision is required.");
      return { type: action.type, path: text(action.path), text: action.text, expectedRevision: action.expectedRevision, bom: optionalBoolean(action.bom) };
    }
    case "file.open": return { type: action.type, path: text(action.path), targetId: text(action.targetId, 200) };
    case "git.stage": case "git.unstage": {
      if (!Array.isArray(action.paths) || !action.paths.length || action.paths.length > 20_000) throw new Error("Select between 1 and 20000 paths.");
      const paths = action.paths.map(path => text(path));
      return action.type === "git.unstage" ? { type: action.type, paths, expectedRevision: optionalText(action.expectedRevision) } : { type: action.type, paths };
    }
    case "git.commit": return { type: action.type, message: text(action.message, 1_000_000), expectedRevision: optionalText(action.expectedRevision) };
    case "git.checkout": {
      if (typeof action.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(action.expectedRevision)) throw new Error("The exact Git status revision is required.");
      return { type: action.type, branch: text(action.branch, 200), expectedRevision: action.expectedRevision, create: optionalBoolean(action.create) };
    }
    case "worktree.create": {
      const options = object(action.options);
      return { type: action.type, options: { path: text(options.path), branch: optionalText(options.branch), newBranch: optionalText(options.newBranch), startPoint: optionalText(options.startPoint) } };
    }
    case "worktree.remove": return { type: action.type, path: text(action.path) };
    default: throw new Error("Unknown workspace mutation.");
  }
}

export class HostWorkspaces {
  constructor(private store: HostStore, private dataDirectory: string, private reserveMutation: (path: string) => () => void,
    private removal?: { before(path: string): Promise<void>; committed(sessions: SessionSummary[]): void }, private actions?: LocalEnvironmentActions,
    private fileOpen = new WorkspaceFileOpen()) {}
  #resolve(target: WorkspaceTarget): WorkspaceService {
    const session = "sessionId" in target ? this.store.getSession(target.sessionId) : undefined;
    const projectId = "projectId" in target ? target.projectId : session?.projectId;
    const project = projectId ? this.store.getProject(projectId) : undefined;
    const cwd = session?.cwd ?? project?.path;
    if (!cwd) throw new Error("The workspace owner does not exist on this host.");
    return new WorkspaceService(cwd, { worktreeRoot: join(this.dataDirectory, "worktrees", project?.id ?? session!.id) });
  }
  directoryContext(projectId: string, configPath: string | null): Promise<WorktreeDirectoryContext> {
    return resolveWorktreeDirectoryContext(this.#resolve({ projectId }), configPath);
  }
  private async preparationWorkspace(projectId: string, context?: WorktreeDirectoryContext): Promise<WorkspaceService> {
    const workspace = this.#resolve({ projectId });
    if (!context) return workspace;
    const actual = await workspace.gitWorkspaceContext();
    if (workspace.cwd !== context.sourceWorkspaceRoot || actual.gitRoot !== context.sourceGitRoot || actual.workspaceRelativePath !== context.workspaceRelativePath)
      throw new Error("The captured source project directory changed.");
    return workspace.gitRootService();
  }
  async sessionWorktreeDestination(projectId: string, path: string, context?: WorktreeDirectoryContext): Promise<string> {
    return (await this.preparationWorkspace(projectId, context)).sessionWorktreeDestination(path);
  }
  async createSessionWorktree(projectId: string, path: string, startingState: WorktreeStartingState, context?: WorktreeDirectoryContext): Promise<GitWorktree> {
    return (await this.preparationWorkspace(projectId, context)).createSessionWorktree(path, startingState);
  }
  async verifyPreparedWorktree(projectId: string, path: string, context: WorktreeDirectoryContext) {
    const workspace = await this.preparationWorkspace(projectId, context);
    const registered = (await workspace.worktrees()).find(tree => tree.path === path && tree.managed);
    if (!registered || registered.locked) throw new Error("The captured checkout is not an unlocked managed worktree of this project.");
    return verifyWorktreeDirectories(context, path);
  }
  async query(target: WorkspaceTarget, query: WorkspaceQuery): Promise<WorkspaceQueryResult> {
    const owner = this.#resolve(target);
    // Git controls intentionally address the containing repository; file controls stay project-confined.
    const workspace = query.type.startsWith("git.") ? await owner.gitRootService() : owner;
    switch (query.type) {
      case "environment.actions": {
        if (!this.actions) throw new Error("Configured environment actions are unavailable on this host.");
        return { type: query.type, state: await this.actions.catalog(target) };
      }
      case "environment.output":
      case "environment.preparation": {
        const projectId = 'projectId' in target ? target.projectId : this.store.getSession(target.sessionId)?.projectId;
        const preparation = this.store.environmentPreparations.get(query.preparationId);
        if (!preparation || preparation.projectId !== projectId) throw new Error('Preparation does not belong to this workspace.');
        if (query.type === "environment.output") return { type: query.type, output: this.store.environmentPreparations.getOutput(preparation.id) };
        return { type: query.type, preparation: this.store.environmentPreparations.public(preparation) };
      }
      case "environment.read": return { type: query.type, ...await new LocalEnvironmentStore(workspace.cwd).read(query.configPath) };
      case "environments.list": return { type: query.type, environments: await new LocalEnvironmentStore(workspace.cwd).catalog() };
      case "files.list": return { type: query.type, entries: await workspace.list(query.path) };
      case "file.stat": return { type: query.type, entry: await workspace.stat(query.path) };
      case "file.read": return { type: query.type, content: await workspace.readText(query.path) };
      case "file.open-options": {
        await workspace.externalFilePath(query.path);
        return this.fileOpen.options(query.path);
      }
      case "git.status": return { type: query.type, status: await workspace.gitStatus() };
      case "git.branches": return { type: query.type, branches: await workspace.branches() };
      case "git.diff": return { type: query.type, diff: await workspace.diff(query) };
      case "git.worktrees": return { type: query.type, worktrees: await workspace.worktrees() };
    }
  }
  async mutate(target: WorkspaceTarget, action: WorkspaceMutation, commandId?: string): Promise<WorkspaceMutationResult> {
    const owner = this.#resolve(target);
    const workspace = action.type.startsWith("git.") || action.type.startsWith("worktree.") ? await owner.gitRootService() : owner;
    switch (action.type) {
      case "environment.select": {
        if (!this.actions) throw new Error("Configured environment actions are unavailable on this host.");
        return { type: action.type, state: await this.actions.select(target, action.configPath, action.expectedRevision) };
      }
      case "environment.action": {
        if (!this.actions) throw new Error("Configured environment actions are unavailable on this host.");
        return { type: action.type, terminal: await this.actions.run(target, action) };
      }
      case "environment.save": return { type: action.type, result: await new LocalEnvironmentStore(workspace.cwd).save(action) };
      case "file.write": return { type: action.type, result: await workspace.writeText(action.path, action) };
      case "file.open": return this.fileOpen.open(workspace.cwd, action.targetId, () => workspace.externalFilePath(action.path));
      case "git.stage": return { type: action.type, status: await workspace.stage(action.paths) };
      case "git.unstage": return { type: action.type, status: await workspace.unstage(action.paths, action.expectedRevision) };
      case "git.commit": return { type: action.type, ...await workspace.commit(action.message, action.expectedRevision) };
      case "git.checkout": {
        const release = this.reserveMutation(workspace.cwd);
        try { return { type: action.type, status: await workspace.checkout(action.branch, action.expectedRevision, action.create) }; }
        finally { release(); }
      }
      case "worktree.create": return { type: action.type, worktree: await workspace.createWorktree(action.options) };
      case "worktree.remove": {
        const root = await realpath(workspace.worktreeRoot!);
        const candidate = resolve(root, action.path);
        if (!candidate.startsWith(root + sep)) throw new Error("Only a managed worktree can be removed.");
        const prior = this.store.getWorktreeRemovalIntent(candidate);
        if (prior?.state === "pending") throw new WorkspaceError("OUTCOME_UNKNOWN", "A prior removal of this worktree has an unresolved outcome. Inspect it before trying another removal.");
        if (commandId) {
          const command = this.store.getCommand(commandId);
          if (!command || command.state !== "pending") throw new Error("Worktree removal requires its pending command identity.");
        }
        const path = await realpath(candidate);
        if (!path.startsWith(root + sep)) throw new Error("Only a managed worktree can be removed.");
        const release = this.reserveMutation(path);
        try {
          const registered = (await workspace.worktrees()).find(tree => tree.path === path && tree.managed);
          if (!registered || registered.locked) throw new Error("Only an unlocked registered managed worktree can be removed.");
          // Preserve the pre-cleanup files, including copied environment config,
          // before either the cleanup script or Git removal can delete them.
          const snapshot = await workspace.snapshotWorktreeForRemoval(action.path);
          await this.removal?.before(path);
          const projectId = ownerProjectId(this.store, target), project = this.store.getProject(projectId)!;
          let intent: ReturnType<HostStore["createWorktreeRemovalIntent"]> | undefined;
          await workspace.removeSnapshottedWorktree(action.path, snapshot, commandId ? () => {
            intent = this.store.createWorktreeRemovalIntent({
              id: crypto.randomUUID(), commandId, projectId,
              sourceRoot: project.path, worktreePath: path, snapshot,
            });
          } : undefined);
          if (intent) {
            let finalized;
            try { finalized = this.store.finalizeWorktreeRemoval(intent.id, intent.revision); }
            catch (error) { throw new WorkspaceError("OUTCOME_UNKNOWN", `The worktree was removed, but its host metadata could not be finalized. Inspect before retrying. ${error instanceof Error ? error.message : String(error)}`); }
            this.notifyRemovalCommitted(finalized.sessions);
          }
          return { type: action.type };
        }
        finally { release(); }
      }
    }
  }

  /** Read-only restart reconciliation. It never dispatches Git removal. */
  async reconcileWorktreeRemovals(): Promise<void> {
    for (const intent of this.store.listWorktreeRemovalIntents()) {
      let release: (() => void) | undefined;
      try {
        const project = this.store.getProject(intent.projectId);
        if (!project || project.path !== intent.sourceRoot) continue;
        const workspace = await this.#resolve({ projectId: project.id }).gitRootService();
        release = this.reserveMutation(intent.worktreePath);
        if (!await workspace.inspectSnapshottedWorktreeRemoval(intent.snapshot)) continue;
        const finalized = this.store.finalizeWorktreeRemoval(intent.id, intent.revision);
        this.notifyRemovalCommitted(finalized.sessions);
      } catch (error) {
        console.error(`Worktree removal ${intent.id} remains unresolved:`, error instanceof Error ? error.message : String(error));
      } finally { release?.(); }
    }
  }

  private notifyRemovalCommitted(sessions: SessionSummary[]): void {
    try { this.removal?.committed(sessions); }
    catch (error) { console.error("Worktree removal committed, but its local notifications failed:", error instanceof Error ? error.message : String(error)); }
  }
}

function ownerProjectId(store: HostStore, target: WorkspaceTarget): string {
  const projectId = "projectId" in target ? target.projectId : store.getSession(target.sessionId)?.projectId;
  if (!projectId) throw new Error("A managed worktree must belong to a project.");
  return projectId;
}
