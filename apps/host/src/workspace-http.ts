import { parseGitFileOrigin, parseGitFileLocation, parseGitFilePath, parseGitFileHistoryCursor } from "@agent-desktop/shared";
import { createHash } from "node:crypto";
import type { LocalEnvironmentActions } from "./local-environments/actions";
import { LocalEnvironmentStore } from "./local-environments";
import { basename, dirname, join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { parseGitRecentBranchesLimit, parseGitResolvedRevision, parseGitRevisionExpression, parseGitBranchSearch, parseGitBranchSelection, parseStandaloneFilePath, type WorkspaceMutation, type WorkspaceMutationResult, type WorkspaceQuery, type WorkspaceQueryResult, type WorkspaceTarget } from "@agent-desktop/shared";
import type { HostStore } from "./store";
import { WorkspaceService } from "./workspace";
import type { WorktreeStartingState, GitWorktree } from '@agent-desktop/shared';
import { resolveWorktreeDirectoryContext, verifyWorktreeDirectories } from "./local-environments/worktree-directory-resolution";
import type { WorktreeDirectoryContext } from "./local-environments/worktree-directories";
import type { SessionSummary } from "@agent-desktop/shared";
import { WorkspaceError } from "./workspace";
import { WorkspaceFileOpen } from "./workspace-open";
import { readGitActionContext } from "./workspace/git-action-context";
import { RepositoryWatchSubscriptions, type RepositoryWatchLease, type RepositoryWatchContextLease } from "./workspace/repository-watch-subscriptions";
import { RecentBranchCache } from "./workspace/recent-branch-cache";
import { DefaultBranchCache } from "./workspace/default-branch-cache";
import { BranchLiveQueries, type BranchLiveQuery, type BranchQueryUpdate } from "./workspace/branch-live-queries";
import type { MetadataWatchIO } from "./workspace/repository-metadata-watcher";
import { WorkspaceSubmissions, type GitSubmissionDependencies } from "./workspace-submissions";
import type { GitSubmissionIntent, GitSubmissionTarget } from "@agent-desktop/shared";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workspace request.");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 16_384): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > maximum) throw new Error("Invalid workspace text value.");
  return value;
}
function optionalText(value: unknown): string | undefined { return value === undefined ? undefined : text(value); }
export function parseGitSubmissionIntent(value: unknown): GitSubmissionIntent {
  const input = object(value);
  if (typeof input.operation !== "string" || !["commit", "commit-and-push", "push"].includes(input.operation)
    || typeof input.selectionMode !== "string" || !["staged", "include-unstaged"].includes(input.selectionMode)
    || typeof input.contextRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.contextRevision)
    || typeof input.message !== "string" || input.message.length > 1_000_000 || input.message.includes("\0")) throw new Error("Invalid Git submission intent.");
  const intent: GitSubmissionIntent = { operation: input.operation as GitSubmissionIntent["operation"], selectionMode: input.selectionMode as GitSubmissionIntent["selectionMode"],
    contextRevision: input.contextRevision, message: input.message };
  if (input.branch !== undefined) {
    const branch = object(input.branch);
    if (typeof branch.create !== "boolean" || intent.operation === "push") throw new Error("Invalid commit branch choice.");
    intent.branch = { name: text(branch.name, 200), create: branch.create };
  }
  if (input.destination !== undefined) {
    const destination = object(input.destination);
    if (typeof destination.revision !== "string" || !/^[a-f0-9]{64}$/.test(destination.revision) || typeof destination.requiresUpstreamSetup !== "boolean") throw new Error("Invalid Git push destination.");
    intent.destination = { remote: text(destination.remote, 200), targetRef: text(destination.targetRef, 1024), revision: destination.revision, requiresUpstreamSetup: destination.requiresUpstreamSetup };
  }
  if (intent.operation !== "commit" && !intent.destination) throw new Error("Choose a push destination before submitting.");
  return intent;
}
function optionalBoolean(value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") throw new Error("Invalid boolean value.");
  return value as boolean | undefined;
}
function searchQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\0\r\n]/.test(value)) throw new Error("A nonempty file search query of at most 512 characters is required.");
  return value.trim();
}
function searchLimit(value: unknown): number | undefined {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) throw new Error("A file search limit must be between 1 and 100.");
  return value as number;
}
export function parseWorkspaceTarget(value: unknown): WorkspaceTarget {
  const target = object(value);
  if (Object.keys(target).length !== 1) throw new Error("Select one workspace owner.");
  if ("projectId" in target) return { projectId: text(target.projectId, 200) };
  if ("sessionId" in target) return { sessionId: text(target.sessionId, 200) };
  if ("filePath" in target) return { filePath: parseStandaloneFilePath(target.filePath) };
  throw new Error("A catalogued project, session, or standalone file is required.");
}
export function parseWorkspaceQuery(value: unknown): WorkspaceQuery {
  const query = object(value);
  switch (query.type) {
    case "environment.output":
    case "environment.preparation": return { type: query.type, preparationId: text(query.preparationId, 200) };
    case "environment.read": return { type: query.type, configPath: text(query.configPath) };
    case "files.list": return { type: query.type, path: optionalText(query.path) };
    case "files.search": return { type: query.type, query: searchQuery(query.query), limit: searchLimit(query.limit) };
    case "git.base-branch":
    case "git.default-branch": return { type: query.type };
    case "git.recent-branches": return { type: query.type, limit: parseGitRecentBranchesLimit(query.limit) };
    case "git.resolve-checkout": return { type: query.type, expression: parseGitRevisionExpression(query.expression) };
    case "git.resolve-revision": return { type: query.type, expression: parseGitRevisionExpression(query.expression) };
    case "git.file-inspect": return { type: query.type, path: parseGitFilePath(query.path), expression: parseGitRevisionExpression(query.expression) };
    case "git.file-history": return { type: query.type, origin: parseGitFileOrigin(query.origin), start: parseGitFileHistoryCursor(query.start) };
    case "git.file-revision": return { type: query.type, origin: parseGitFileOrigin(query.origin), location: parseGitFileLocation(query.location) };
    case "git.search-branches":
    case "git.search-starting-branches": return { type: query.type, ...parseGitBranchSearch(query.query, query.limit) };
    case "file.operations": return { type: query.type };
    case "file.stat": case "file.operation-context": case "file.read": case "file.open-options": case "file.copy-info": return { type: query.type, path: text(query.path) };
    case "file.copy-chunk": {
      if (typeof query.revision !== "string" || !/^[a-f0-9]{64}$/.test(query.revision)
        || !Number.isSafeInteger(query.offset) || (query.offset as number) < 0) throw new Error("Invalid file copy revision or offset.");
      return { type: query.type, path: text(query.path), revision: query.revision, offset: query.offset as number };
    }
    case "environment.actions": case "environments.list": case "git.status": case "git.action-context": case "git.branches": case "git.worktrees": return { type: query.type };
    case "git.selection-summary": {
      if (typeof query.contextRevision !== "string" || !/^[a-f0-9]{64}$/.test(query.contextRevision)
        || query.selectionMode !== "staged" && query.selectionMode !== "include-unstaged") throw new Error("An exact Git context revision and selection mode are required.");
      return { type: query.type, contextRevision: query.contextRevision, selectionMode: query.selectionMode };
    }
    case "git.diff": {
      if (query.context !== undefined && (!Number.isSafeInteger(query.context) || (query.context as number) < 0 || (query.context as number) > 1000)) throw new Error("Invalid diff context.");
      return { type: query.type, path: optionalText(query.path), staged: optionalBoolean(query.staged), context: query.context as number | undefined };
    }
    case "git.review-summary": {
      if (query.source !== "staged" && query.source !== "unstaged") throw new Error("Choose staged or unstaged review changes.");
      return { type: query.type, source: query.source };
    }
    case "git.submission": return { type: query.type, commandId: optionalText(query.commandId) };
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
    case "file.create": case "directory.create": return { type: action.type, path: text(action.path) };
    case "path.rename": {
      if (typeof action.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(action.expectedRevision)) throw new Error("The exact path revision is required.");
      return { type: action.type, path: text(action.path), destination: text(action.destination), expectedRevision: action.expectedRevision };
    }
    case "path.delete": {
      if (typeof action.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(action.expectedRevision)) throw new Error("The exact path revision is required.");
      return { type: action.type, path: text(action.path), expectedRevision: action.expectedRevision };
    }
    case "file.open": return { type: action.type, path: text(action.path), targetId: text(action.targetId, 200) };
    case "git.stage": case "git.unstage": {
      if (!Array.isArray(action.paths) || !action.paths.length || action.paths.length > 20_000) throw new Error("Select between 1 and 20000 paths.");
      const paths = action.paths.map(path => text(path));
      return action.type === "git.unstage" ? { type: action.type, paths, expectedRevision: optionalText(action.expectedRevision) } : { type: action.type, paths };
    }
    case "git.commit": return { type: action.type, message: text(action.message, 1_000_000), expectedRevision: optionalText(action.expectedRevision) };
    case "git.submit": return { type: action.type, intent: parseGitSubmissionIntent(action.intent) };
    case "git.submit.cancel": case "git.submit.acknowledge": return { type: action.type, commandId: text(action.commandId, 200) };
    case "git.checkout": {
      if (typeof action.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(action.expectedRevision)) throw new Error("The exact Git status revision is required.");
      return { type: action.type, branch: text(action.branch, 200), expectedRevision: action.expectedRevision, create: optionalBoolean(action.create) };
    }
    case "git.checkout-revision": {
      if (typeof action.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(action.expectedRevision)) throw new Error("The exact Git status revision is required.");
      return { type: action.type, revision: parseGitResolvedRevision(action.revision), expectedRevision: action.expectedRevision };
    }
    case "git.checkout-ref": {
      if (typeof action.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(action.expectedRevision)) throw new Error("The exact Git status revision is required.");
      return { type: action.type, selection: parseGitBranchSelection(action.selection), expectedRevision: action.expectedRevision };
    }
    case "worktree.create": {
      const options = object(action.options);
      return { type: action.type, options: { path: text(options.path), branch: optionalText(options.branch), newBranch: optionalText(options.newBranch), startPoint: optionalText(options.startPoint) } };
    }
    case "worktree.remove": return { type: action.type, path: text(action.path) };
    default: throw new Error("Unknown workspace mutation.");
  }
}

export interface BranchQueryLease { readonly subscriptionId: string; readonly closed: Promise<void>; readonly signal: AbortSignal; recover(): Promise<void>; dispose(): Promise<void> }
interface AdmittedBranchQuery {
  id: string; target: GitSubmissionTarget; stamp: string; abort: AbortController; ended: boolean;
  closed: Promise<void>; resolveClosed(): void; sourceSignal: AbortSignal; onAbort(): void; start: Promise<void>; release?: Promise<void>;
  reader?: WorkspaceService; watch?: RepositoryWatchContextLease; query?: { dispose(): void };
}

export class HostWorkspaces {
  private submissions: WorkspaceSubmissions;
  private repositoryWatches: RepositoryWatchSubscriptions;
  private branchQueries: BranchLiveQueries;
  private branchReads = new RecentBranchCache();
  private defaultReads = new DefaultBranchCache();
  private branchSubscriptions = new Set<AdmittedBranchQuery>();
  private branchQueriesStopped = false;
  private watchShutdown?: Promise<void>;
  constructor(private store: HostStore, private dataDirectory: string, private reserveMutation: (path: string) => () => void,
    private removal?: { before(path: string): Promise<void>; committed(sessions: SessionSummary[]): void }, private actions?: LocalEnvironmentActions,
    private fileOpen = new WorkspaceFileOpen(), submission?: Pick<GitSubmissionDependencies, "generate" | "changed">, watchIO?: MetadataWatchIO) {
    this.branchQueries = new BranchLiveQueries({
      run: async (query, location, signal) => {
        signal.throwIfAborted();
        const entry = [...this.branchSubscriptions].find(entry => this.branchCurrent(entry) && entry.reader
          && entry.watch?.context.root === location.root && entry.watch.context.commonDir === location.commonDir);
        if (!entry?.reader) throw new WorkspaceError("WORKSPACE_CHANGED", "The branch query no longer has an admitted repository owner.");
        const workspace = entry.reader;
        const reads = { cache: this.branchReads, defaults: this.defaultReads, isLive: (context: import("./workspace/repository-watch").GitRepositoryWatchContext) => this.repositoryWatches.isHealthy(context) };
        switch (query.type) {
          case "git.recent-branches": return { type: query.type, branches: await workspace.recentBranches(query.limit, signal, reads) };
          case "git.default-branch": return { type: query.type, branch: await workspace.defaultBranch(signal, reads) };
          case "git.base-branch": return { type: query.type, base: await workspace.baseBranch(signal, this.defaultReads) };
        }
      },
      prepareRecovery: location => {
        this.branchReads.invalidate(location.root);
        this.defaultReads.invalidate(location.root);
        const seen = new Set<string>();
        for (const entry of this.branchSubscriptions) {
          if (!this.branchCurrent(entry) || entry.watch?.context.root !== location.root) continue;
          const key = JSON.stringify(entry.target); if (seen.has(key)) continue; seen.add(key);
          submission?.changed?.({ ...entry.target });
        }
      },
    });
    this.repositoryWatches = new RepositoryWatchSubscriptions({
      resolve: target => {
        const stamp = this.ownerStamp(target), workspace = this.#resolve(target);
        const isCurrent = () => { try { return stamp === this.ownerStamp(target); } catch { return false; } };
        return { isCurrent, readContext: async () => {
          if (!isCurrent()) throw new WorkspaceError("WORKSPACE_CHANGED", "The repository watch owner changed.");
          const context = await workspace.repositoryWatchContext();
          if (!isCurrent()) throw new WorkspaceError("WORKSPACE_CHANGED", "The repository watch owner changed during discovery.");
          return context;
        } };
      },
      changed: (target, kind) => submission?.changed?.(target, kind),
      repositoryReleased: context => {
        this.branchReads.invalidate(context.root); this.defaultReads.invalidate(context.root);
      },
      repositoryChanged: (context, kind) => {
        this.branchReads.invalidate(context.root, kind);
        this.defaultReads.invalidate(context.root, kind);
        void this.branchQueries.changed({ ...context, hostId: this.store.host.id }, kind).catch(error => console.error("Branch query invalidation failed:", error));
      },
      repositoryRecoveryChanged: (context, error) => {
        this.branchReads.watchHealthChanged(context.root);
        void this.branchQueries.setRequiresRecovery(this.store.host.id, context.root, error !== undefined).catch(cause => console.error("Branch query recovery update failed:", cause));
      },
      recoveryChanged: target => submission?.changed?.(target),
    }, watchIO);
    this.submissions = new WorkspaceSubmissions(store, {
      generate: submission?.generate ?? (() => Promise.reject(new WorkspaceError("COMMIT_GENERATION_UNAVAILABLE", "Native commit generation is unavailable on this host."))),
      changed: (target, kind, gitRoot) => {
        if (gitRoot) this.branchReads.invalidate(gitRoot);
        submission?.changed?.(target, kind);
      }, reserveBranch: reserveMutation,
      resolve: async target => {
        const ownerStamp = this.ownerStamp(target), owner = this.#resolve(target);
        const workspace = await owner.gitRootService();
        if (ownerStamp !== this.ownerStamp(target)) throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace owner changed while resolving Git.");
        return { workspace, ownerCwd: owner.cwd, ownerStamp, assertCurrent: () => {
          if (ownerStamp !== this.ownerStamp(target)) throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace owner changed before Git dispatch.");
        } };
      },
    });
  }
  private ownerStamp(target: GitSubmissionTarget): string {
    if ("sessionId" in target) {
      const session = this.store.getSession(target.sessionId);
      if (!session || session.hostId !== this.store.host.id) throw new WorkspaceError("WORKSPACE_CHANGED", "The session is unavailable on this host.");
      return JSON.stringify([session.id, session.projectId, session.cwd, session.sessionFile]);
    }
    const project = this.store.getProject(target.projectId);
    if (!project || project.hostId !== this.store.host.id) throw new WorkspaceError("WORKSPACE_CHANGED", "The project is unavailable on this host.");
    return JSON.stringify([project.id, project.path]);
  }
  retainRepositoryWatch(value: WorkspaceTarget, signal: AbortSignal): Promise<RepositoryWatchLease> {
    const target = parseWorkspaceTarget(value);
    if ("filePath" in target) throw new WorkspaceError("WORKSPACE_CHANGED", "Repository watching requires a catalogued project or session.");
    return this.repositoryWatches.retain(target, signal);
  }
  private branchCurrent(entry: AdmittedBranchQuery): boolean {
    if (entry.ended) return false;
    let same = false;
    try { same = entry.stamp === this.ownerStamp(entry.target); } catch {}
    if (!this.branchQueriesStopped && !entry.abort.signal.aborted && same) return true;
    void this.releaseBranchQuery(entry).catch(error => console.error("Branch query owner cleanup failed:", error));
    return false;
  }
  private releaseBranchQuery(entry: AdmittedBranchQuery): Promise<void> {
    if (entry.release) return entry.release;
    entry.ended = true;
    entry.sourceSignal.removeEventListener("abort", entry.onAbort);
    // Unregister before abort releases the underlying watcher.
    entry.query?.dispose(); entry.abort.abort();
    entry.release = Promise.resolve().then(async () => {
      await entry.start.catch(() => {}); // Admission failure belongs to its caller.
      entry.query?.dispose();
      await entry.watch?.dispose();
    }).finally(() => { this.branchSubscriptions.delete(entry); entry.resolveClosed(); });
    return entry.release;
  }
  /** Internal subscription API. Public transport must separately bind peer/ID
   * history and derive local scheduling policy, never trust client paths. */
  async subscribeBranchQuery(value: WorkspaceTarget, rawQuery: WorkspaceQuery, signal: AbortSignal,
    emit: (update: BranchQueryUpdate) => void, local: boolean): Promise<BranchQueryLease> {
    const target = parseWorkspaceTarget(value), query = parseWorkspaceQuery(rawQuery);
    if ("filePath" in target || !["git.recent-branches", "git.default-branch", "git.base-branch"].includes(query.type))
      throw new WorkspaceError("INVALID_QUERY", "A catalogued owner and supported live branch query are required.");
    if (typeof local !== "boolean") throw new WorkspaceError("INVALID_QUERY", "A resolved host scheduling policy is required.");
    if (this.branchQueriesStopped || signal.aborted) throw new DOMException("Branch subscription ended.", "AbortError");
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const entry: AdmittedBranchQuery = { closed, resolveClosed, id: crypto.randomUUID(), target: { ...target }, stamp: this.ownerStamp(target),
      abort: new AbortController(), ended: false, sourceSignal: signal, start: Promise.resolve(),
      onAbort: () => { void this.releaseBranchQuery(entry).catch(error => console.error("Branch query release failed:", error)); } };
    const source = this.#resolve(entry.target);
    this.branchSubscriptions.add(entry);
    entry.start = Promise.resolve().then(async () => {
      if (!this.branchCurrent(entry)) throw new DOMException("Branch subscription ended.", "AbortError");
      entry.watch = await this.repositoryWatches.retain(entry.target, entry.abort.signal);
      if (!this.branchCurrent(entry)) throw new DOMException("Branch subscription ended.", "AbortError");
      const context = entry.watch.context;
      const reader = await source.gitRootService(entry.abort.signal), observed = await reader.repositoryWatchContext(entry.abort.signal);
      if (!this.branchCurrent(entry)) throw new DOMException("Branch subscription ended.", "AbortError");
      if (["root", "commonDir", "gitDir", "headPath", "indexPath"].some(key => observed[key as keyof typeof observed] !== context[key as keyof typeof context]))
        throw new WorkspaceError("WORKSPACE_CHANGED", "Repository metadata changed during branch query admission.");
      entry.reader = reader;
      entry.query = this.branchQueries.subscribe({ subscriptionId: entry.id,
        location: { hostId: this.store.host.id, root: context.root, commonDir: context.commonDir, local },
        query: query as BranchLiveQuery, requiresRecovery: entry.watch.error !== undefined,
        isCurrent: () => this.branchCurrent(entry), emit });
    });
    signal.addEventListener("abort", entry.onAbort, { once: true });
    if (signal.aborted) entry.onAbort();
    try { await entry.start; if (!this.branchCurrent(entry)) throw new DOMException("Branch subscription ended.", "AbortError"); }
    catch (error) { await this.releaseBranchQuery(entry); throw error; }
    return { subscriptionId: entry.id, closed, signal: entry.abort.signal, recover: () => this.branchCurrent(entry)
      ? this.branchQueries.recover(this.store.host.id, [entry.id]) : Promise.reject(new DOMException("Branch subscription ended.", "AbortError")),
      dispose: () => this.releaseBranchQuery(entry) };
  }
  async reconcileRepositoryWatchOwners(): Promise<void> {
    const releases: Promise<void>[] = [];
    for (const entry of this.branchSubscriptions) if (!this.branchCurrent(entry)) releases.push(this.releaseBranchQuery(entry));
    this.branchQueries.reconcileOwners();
    await Promise.all([this.repositoryWatches.reconcileOwners(), ...releases]);
  }
  shutdownRepositoryWatches(): Promise<void> {
    if (this.watchShutdown) return this.watchShutdown;
    this.branchQueriesStopped = true;
    const releases = [...this.branchSubscriptions].map(entry => this.releaseBranchQuery(entry));
    this.watchShutdown = Promise.allSettled([...releases, this.branchQueries.dispose(), this.repositoryWatches.dispose(), this.branchReads.dispose(), this.defaultReads.dispose()]).then(results => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Repository query/watch shutdown failed.");
    });
    return this.watchShutdown;
  }
  shutdownSubmissions(): Promise<void> { return this.submissions.shutdown(); }
  #resolve(target: WorkspaceTarget): WorkspaceService {
    if ("filePath" in target) return new WorkspaceService(dirname(parseStandaloneFilePath(target.filePath)));
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
    const workspace = await this.preparationWorkspace(projectId, context);
    try { return await workspace.createSessionWorktree(path, startingState); }
    finally { this.branchReads.invalidate(workspace.cwd); }
  }
  /** Resolve and create only from the original durable preparation, never caller labels. */
  async createPreparedSessionWorktree(preparationId: string, expectedRevision: number, signal?: AbortSignal): Promise<GitWorktree> {
    const record = this.store.environmentPreparations.get(preparationId);
    if (!record || record.hostId !== this.store.host.id || record.phase !== "worktree-creating" || record.revision !== expectedRevision)
      throw new WorkspaceError("PREPARATION_CHANGED", "An admitted worktree-creating preparation is required.");
    const assertCurrent = () => {
      signal?.throwIfAborted();
      const current = this.store.environmentPreparations.get(record.id), project = this.store.getProject(record.projectId);
      if (!current || current.revision !== record.revision || current.phase !== "worktree-creating"
        || current.hostId !== record.hostId || !project || project.hostId !== record.hostId || project.path !== record.sourceRoot)
        throw new WorkspaceError("PREPARATION_CHANGED", "The admitted worktree preparation or owning project changed.");
    };
    assertCurrent();
    const workspace = await this.preparationWorkspace(record.projectId, record.directories);
    assertCurrent();
    const name = `chat-${createHash("sha256").update(record.id).digest("hex")}`;
    const destination = await workspace.sessionWorktreeDestination(name);
    assertCurrent();
    if (destination !== record.worktreePath) throw new WorkspaceError("PREPARATION_CHANGED", "The admitted worktree destination changed.");
    try { return await workspace.createPreparedSessionWorktree(name, record.startingState, { destination: record.worktreePath, assertCurrent, signal }); }
    finally { this.branchReads.invalidate(workspace.cwd); }
  }

  async verifyPreparedWorktree(projectId: string, path: string, context: WorktreeDirectoryContext) {
    const workspace = await this.preparationWorkspace(projectId, context);
    const registered = (await workspace.worktrees()).find(tree => tree.path === path && tree.managed);
    if (!registered || registered.locked) throw new Error("The captured checkout is not an unlocked managed worktree of this project.");
    return verifyWorktreeDirectories(context, path);
  }
  async query(target: WorkspaceTarget, query: WorkspaceQuery): Promise<WorkspaceQueryResult> {
    if ("filePath" in target) {
      if (!["file.stat", "file.read", "file.open-options", "file.copy-info", "file.copy-chunk"].includes(query.type))
        throw new Error("A standalone file target does not grant directory, Git, terminal, or environment access.");
      if (!("path" in query) || query.path !== basename(parseStandaloneFilePath(target.filePath)))
        throw new Error("A standalone file target grants access only to its exact basename.");
    }
    if (query.type === "git.submission") {
      if ("filePath" in target) throw new Error("A standalone file cannot own a Git submission.");
      this.ownerStamp(target);
      return { type: query.type, receipt: this.store.getGitSubmission(target, query.commandId) ?? null };
    }
    const summaryOwner = query.type === "git.selection-summary" && !("filePath" in target) ? this.ownerStamp(target) : undefined;
    const reviewOwner = query.type === "git.review-summary" && !("filePath" in target) ? this.ownerStamp(target) : undefined;
    const branchSearchOwner = (query.type === "git.search-branches" || query.type === "git.search-starting-branches" || query.type === "git.resolve-revision" || query.type === "git.recent-branches" || query.type === "git.base-branch" || query.type === "git.default-branch" || query.type === "git.resolve-checkout") && !("filePath" in target) ? this.ownerStamp(target) : undefined;
    const isFileHistory = query.type === "git.file-inspect" || query.type === "git.file-history" || query.type === "git.file-revision";
    const fileHistoryOwner = isFileHistory && !("filePath" in target) ? this.ownerStamp(target) : undefined;
    const owner = this.#resolve(target);
    // Git controls intentionally address the containing repository; file controls stay project-confined.
    const workspace = query.type.startsWith("git.") && query.type !== "git.status" && !isFileHistory ? await owner.gitRootService() : owner;
    switch (query.type) {
      case "environment.actions": {
        if (!this.actions) throw new Error("Configured environment actions are unavailable on this host.");
        return { type: query.type, state: await this.actions.catalog(target) };
      }
      case "environment.output":
      case "environment.preparation": {
        if ("filePath" in target) throw new Error("A standalone file cannot own an environment preparation.");
        const projectId = 'projectId' in target ? target.projectId : this.store.getSession(target.sessionId)?.projectId;
        const preparation = this.store.environmentPreparations.get(query.preparationId);
        if (!preparation || preparation.projectId !== projectId) throw new Error('Preparation does not belong to this workspace.');
        if (query.type === "environment.output") return { type: query.type, output: this.store.environmentPreparations.getOutput(preparation.id) };
        return { type: query.type, preparation: this.store.environmentPreparations.public(preparation) };
      }
      case "environment.read": return { type: query.type, ...await new LocalEnvironmentStore(workspace.cwd).read(query.configPath) };
      case "environments.list": return { type: query.type, environments: await new LocalEnvironmentStore(workspace.cwd).catalog() };
      case "files.list": return { type: query.type, entries: await workspace.list(query.path) };
      case "files.search": return { type: query.type, ...await workspace.searchFiles(query.query, query.limit) };
      case "file.stat": return { type: query.type, entry: await workspace.stat(query.path) };
      case "file.operations": return { type: query.type, version: 1 };
      case "file.operation-context": return { type: query.type, context: await workspace.pathContext(query.path) };
      case "file.read": return { type: query.type, content: await workspace.readText(query.path) };
      case "file.open-options": {
        await workspace.externalFilePath(query.path);
        return this.fileOpen.options(query.path);
      }
      case "file.copy-info": return { type: query.type, path: query.path, ...await workspace.copyInfo(query.path) };
      case "file.copy-chunk": return { type: query.type, path: query.path, ...await workspace.copyChunk(query.path, query.revision, query.offset) };
      case "git.status": {
        if (await owner.gitRepositoryAvailability() === "not-repository") return { type: query.type, availability: "not-repository" };
        return { type: query.type, availability: "repository", status: await (await owner.gitRootService()).gitStatus() };
      }
      case "git.action-context": return { type: query.type, context: await readGitActionContext(workspace) };
      case "git.file-inspect": {
        const inspection = await owner.inspectGitFile(query.path, query.expression);
        if ("filePath" in target || fileHistoryOwner !== this.ownerStamp(target)) throw new WorkspaceError("WORKSPACE_CHANGED", "The file history owner changed during the read.");
        return { type: query.type, inspection };
      }
      case "git.file-history": {
        const history = await owner.gitFileHistory(query.origin, query.start);
        if ("filePath" in target || fileHistoryOwner !== this.ownerStamp(target)) throw new WorkspaceError("WORKSPACE_CHANGED", "The file history owner changed during the read.");
        return { type: query.type, history };
      }
      case "git.file-revision": {
        const revision = await owner.gitFileRevision(query.origin, query.location);
        if ("filePath" in target || fileHistoryOwner !== this.ownerStamp(target)) throw new WorkspaceError("WORKSPACE_CHANGED", "The file history owner changed during the read.");
        return { type: query.type, revision };
      }
      case "git.selection-summary": {
        if ("filePath" in target) throw new Error("A standalone file cannot own a Git selection.");
        const context = await readGitActionContext(workspace);
        if (context.revision !== query.contextRevision) throw new WorkspaceError("GIT_CHANGED", "Git state changed. Refresh the selected changes.");
        if (summaryOwner !== this.ownerStamp(target)) throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace owner changed before reading the selected changes.");
        const summary = await workspace.summarizeCommitSelection(query.selectionMode, context.status.revision);
        const after = await readGitActionContext(workspace);
        if (after.revision !== query.contextRevision) throw new WorkspaceError("GIT_CHANGED", "Git state changed while reading the selected changes.");
        if (summaryOwner !== this.ownerStamp(target)) throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace owner changed while reading the selected changes.");
        return { type: query.type, contextRevision: context.revision, summary };
      }
      case "git.branches": return { type: query.type, branches: await workspace.branches() };
      case "git.base-branch": {
        const base = await workspace.baseBranch(undefined, this.defaultReads);
        if ("filePath" in target || branchSearchOwner !== this.ownerStamp(target))
          throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace owner changed while discovering the base branch.");
        return { type: query.type, base };
      }
      case "git.default-branch": {
        const branch = await workspace.defaultBranch(undefined, { cache: this.branchReads, defaults: this.defaultReads });
        if ("filePath" in target || branchSearchOwner !== this.ownerStamp(target))
          throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace owner changed while discovering the default branch.");
        return { type: query.type, branch };
      }
      case "git.recent-branches": {
        const branches = await workspace.recentBranches(query.limit, undefined, { cache: this.branchReads });
        if ("filePath" in target || branchSearchOwner !== this.ownerStamp(target))
          throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace owner changed while reading recent branches.");
        return { type: query.type, branches };
      }
      case "git.resolve-checkout": {
        const resolved = await workspace.resolveCheckoutTarget(query.expression);
        if ("filePath" in target || branchSearchOwner !== this.ownerStamp(target))
          throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace owner changed while resolving the checkout target.");
        return { type: query.type, target: resolved };
      }
      case "git.resolve-revision": {
        const revision = await workspace.resolveRevision(query.expression);
        if ("filePath" in target || branchSearchOwner !== this.ownerStamp(target))
          throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace owner changed while resolving the Git revision.");
        return { type: query.type, revision };
      }
      case "git.search-branches":
      case "git.search-starting-branches": {
        const result = query.type === "git.search-starting-branches"
          ? await workspace.searchStartingBranches(query.query, query.limit)
          : await workspace.searchBranches(query.query, query.limit);
        if ("filePath" in target || branchSearchOwner !== this.ownerStamp(target))
          throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace owner changed while searching branches.");
        return { type: query.type, ...result };
      }
      case "git.diff": return { type: query.type, diff: await workspace.diff(query) };
      case "git.review-summary": {
        const summary = await workspace.reviewSummary(query.source);
        if ("filePath" in target || reviewOwner !== this.ownerStamp(target))
          throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace owner changed while reading review changes.");
        return { type: query.type, summary };
      }
      case "git.worktrees": return { type: query.type, worktrees: await workspace.worktrees() };
    }
  }
  async mutate(target: WorkspaceTarget, action: WorkspaceMutation, commandId?: string): Promise<WorkspaceMutationResult> {
    if ("filePath" in target) {
      if (action.type !== "file.write" && action.type !== "file.open")
        throw new Error("A standalone file target does not grant directory, Git, terminal, or environment access.");
      if (action.path !== basename(parseStandaloneFilePath(target.filePath)))
        throw new Error("A standalone file target grants access only to its exact basename.");
    }
    if (action.type === "git.submit" || action.type === "git.submit.cancel" || action.type === "git.submit.acknowledge") {
      if ("filePath" in target) throw new Error("A standalone file cannot own a Git submission.");
      this.ownerStamp(target);
      if (action.type === "git.submit.cancel") return { type: action.type, receipt: this.submissions.cancel(target, action.commandId) };
      if (action.type === "git.submit.acknowledge") return { type: action.type, receipt: this.store.acknowledgeGitSubmission(target, action.commandId) };
      const record = commandId && this.store.getCommand(commandId);
      if (!record || record.command?.type !== "workspace.mutate" || record.command.action.type !== "git.submit"
        || JSON.stringify(record.command.target) !== JSON.stringify(target) || JSON.stringify(record.command.action.intent) !== JSON.stringify(action.intent)) throw new Error("A Git submission requires its exact durable command claim.");
      return { type: action.type, receipt: await this.submissions.submit(record.id, record.requestHash, target, action.intent) };
    }
    const checkoutOwner = (action.type === "git.checkout-ref" || action.type === "git.checkout-revision") && !("filePath" in target) ? this.ownerStamp(target) : undefined;
    const owner = this.#resolve(target);
    const workspace = action.type.startsWith("git.") || action.type.startsWith("worktree.") ? await owner.gitRootService() : owner;
    try {
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
      case "file.create": return { type: action.type, context: await workspace.createFile(action.path) };
      case "directory.create": return { type: action.type, context: await workspace.createDirectory(action.path) };
      case "path.rename": return { type: action.type, previousPath: action.path, context: await workspace.renamePath(action.path, action.destination, action.expectedRevision) };
      case "path.delete": await workspace.deletePath(action.path, action.expectedRevision); return { type: action.type, deletedPath: action.path };
      case "file.open": return this.fileOpen.open(workspace.cwd, action.targetId, () => workspace.externalFilePath(action.path));
      case "git.stage": return { type: action.type, status: await workspace.stage(action.paths) };
      case "git.unstage": return { type: action.type, status: await workspace.unstage(action.paths, action.expectedRevision) };
      case "git.commit": return { type: action.type, ...await workspace.commit(action.message, action.expectedRevision) };
      case "git.checkout": {
        const release = this.reserveMutation(workspace.cwd);
        try { return { type: action.type, status: await workspace.checkout(action.branch, action.expectedRevision, action.create) }; }
        finally { release(); }
      }
      case "git.checkout-revision":
      case "git.checkout-ref": {
        const assertOwner = () => {
          if ("filePath" in target || checkoutOwner !== this.ownerStamp(target)) throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace owner changed before branch checkout.");
        };
        assertOwner();
        const release = this.reserveMutation(workspace.cwd);
        try {
          return action.type === "git.checkout-revision"
            ? { type: action.type, status: await workspace.checkoutRevision(action.revision, action.expectedRevision, assertOwner) }
            : { type: action.type, status: await workspace.checkoutRef(action.selection, action.expectedRevision, assertOwner) };
        }
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
    throw new Error("Unknown workspace mutation.");
    } finally {
      if (action.type.startsWith("git.") || action.type.startsWith("worktree.")) this.branchReads.invalidate(workspace.cwd);
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
  if ("filePath" in target) throw new Error("A standalone file cannot own a managed worktree.");
  const projectId = "projectId" in target ? target.projectId : store.getSession(target.sessionId)?.projectId;
  if (!projectId) throw new Error("A managed worktree must belong to a project.");
  return projectId;
}
