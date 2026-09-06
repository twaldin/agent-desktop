import { LocalEnvironmentStore } from "./local-environments";
import { join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import type { WorkspaceMutation, WorkspaceMutationResult, WorkspaceQuery, WorkspaceQueryResult, WorkspaceTarget } from "@agent-desktop/shared";
import type { HostStore } from "./store";
import { WorkspaceService } from "./workspace";
import type { WorktreeStartingState, GitWorktree } from '@agent-desktop/shared';

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
    case "file.stat": case "file.read": return { type: query.type, path: text(query.path) };
    case "environments.list": case "git.status": case "git.branches": case "git.worktrees": return { type: query.type };
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
    private removal?: { before(path: string): Promise<void>; after(path: string): void }) {}
  #resolve(target: WorkspaceTarget): WorkspaceService {
    const session = "sessionId" in target ? this.store.getSession(target.sessionId) : undefined;
    const projectId = "projectId" in target ? target.projectId : session?.projectId;
    const project = projectId ? this.store.getProject(projectId) : undefined;
    const cwd = session?.cwd ?? project?.path;
    if (!cwd) throw new Error("The workspace owner does not exist on this host.");
    return new WorkspaceService(cwd, { worktreeRoot: join(this.dataDirectory, "worktrees", project?.id ?? session!.id) });
  }
  sessionWorktreeDestination(projectId: string, path: string): Promise<string> {
    return this.#resolve({ projectId }).sessionWorktreeDestination(path);
  }
  createSessionWorktree(projectId: string, path: string, startingState: WorktreeStartingState): Promise<GitWorktree> {
    return this.#resolve({ projectId }).createSessionWorktree(path, startingState);
  }
  async query(target: WorkspaceTarget, query: WorkspaceQuery): Promise<WorkspaceQueryResult> {
    const workspace = this.#resolve(target);
    switch (query.type) {
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
      case "git.status": return { type: query.type, status: await workspace.gitStatus() };
      case "git.branches": return { type: query.type, branches: await workspace.branches() };
      case "git.diff": return { type: query.type, diff: await workspace.diff(query) };
      case "git.worktrees": return { type: query.type, worktrees: await workspace.worktrees() };
    }
  }
  async mutate(target: WorkspaceTarget, action: WorkspaceMutation): Promise<WorkspaceMutationResult> {
    const workspace = this.#resolve(target);
    switch (action.type) {
      case "environment.save": return { type: action.type, result: await new LocalEnvironmentStore(workspace.cwd).save(action) };
      case "file.write": return { type: action.type, result: await workspace.writeText(action.path, action) };
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
        const path = await realpath(candidate);
        if (!path.startsWith(root + sep)) throw new Error("Only a managed worktree can be removed.");
        const release = this.reserveMutation(path);
        try {
          const registered = (await workspace.worktrees()).find(tree => tree.path === path && tree.managed);
          if (!registered || registered.locked) throw new Error("Only an unlocked registered managed worktree can be removed.");
          await this.removal?.before(path);
          await workspace.removeWorktree(action.path);
          this.removal?.after(path);
          return { type: action.type };
        }
        finally { release(); }
      }
    }
  }
}
