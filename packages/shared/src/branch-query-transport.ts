import { parseRepositoryWatchRequest } from "./repository-watch-transport";
import type { GitSubmissionTarget } from "./git-submissions";
import type { WorkspaceQuery, WorkspaceQueryResult } from "./workspace-protocol";

export const BRANCH_QUERY_CAPABILITY = { version: 1 } as const;
export type LiveBranchQuery = Extract<WorkspaceQuery, { type: "git.recent-branches" | "git.default-branch" | "git.base-branch" }>;
export type LiveBranchResult = Extract<WorkspaceQueryResult, { type: LiveBranchQuery["type"] }>;
export interface BranchQueryRequest {
  type: "branch-query"; version: 1; hostId: string; subscriptionId: string;
  target: GitSubmissionTarget; query: LiveBranchQuery;
  action: "retain" | "inspect" | "release" | "recover";
}
export type BranchQueryResultUpdate = { generation: number; requiresRecovery: boolean } & (
  { phase: "complete"; result: LiveBranchResult } | { phase: "failed"; error: string });
/** Connection-local messages: never persisted in the HostEvent replay log. */
export type BranchQueryMessage = Omit<BranchQueryRequest, "action"> & (
  { event: "status"; phase: "pending" | "ready" | "releasing" | "released" | "failed" | "unavailable"; error?: string }
  | { event: "result"; update: BranchQueryResultUpdate });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid branch query object.");
  return value as Record<string, unknown>;
}
function keys(input: Record<string, unknown>, names: string[]) {
  if (Object.keys(input).length !== names.length || names.some(name => !Object.hasOwn(input, name))) throw new Error("Invalid branch query fields.");
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== "string" || !value || value.length > max || /[\0\r\n]/.test(value)) throw new Error("Invalid branch query text.");
  return value;
}
function errorText(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1000) throw new Error("Invalid branch error.");
  return value;
}
function query(value: unknown): LiveBranchQuery {
  const input = object(value);
  if (input.type === "git.recent-branches") {
    keys(input, input.limit === undefined ? ["type"] : ["type", "limit"]);
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100)) throw new Error("Invalid branch limit.");
    return { type: input.type, ...(input.limit === undefined ? {} : { limit: input.limit as number }) };
  }
  keys(input, ["type"]);
  if (input.type !== "git.default-branch" && input.type !== "git.base-branch") throw new Error("Unsupported live branch query.");
  return { type: input.type };
}
export function parseBranchQueryRequest(value: unknown): BranchQueryRequest {
  const input = object(value);
  keys(input, ["type", "version", "hostId", "subscriptionId", "target", "query", "action"]);
  if (input.type !== "branch-query" || input.version !== 1 || !["retain", "inspect", "release", "recover"].includes(String(input.action)) || typeof input.action !== "string") throw new Error("Invalid branch query request.");
  const owner = parseRepositoryWatchRequest({ type: "repository-watch", version: 1, hostId: input.hostId, subscriptionId: input.subscriptionId, target: input.target, action: "inspect" });
  return { type: "branch-query", version: 1, hostId: owner.hostId, subscriptionId: owner.subscriptionId, target: owner.target,
    query: query(input.query), action: input.action as BranchQueryRequest["action"] };
}
export function parseBranchQueryUpdate(value: unknown, expected: LiveBranchQuery): BranchQueryResultUpdate {
  const input = object(value);
  keys(input, ["generation", "requiresRecovery", "phase", input.phase === "complete" ? "result" : "error"]);
  if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 1 || typeof input.requiresRecovery !== "boolean") throw new Error("Invalid branch generation or recovery state.");
  const common = { generation: input.generation as number, requiresRecovery: input.requiresRecovery };
  if (input.phase === "failed") return { ...common, phase: "failed", error: errorText(input.error) };
  if (input.phase !== "complete") throw new Error("Invalid branch result phase.");
  const result = object(input.result);
  if (result.type !== expected.type) throw new Error("Branch result method changed.");
  let parsed: LiveBranchResult;
  if (result.type === "git.recent-branches") {
    keys(result, ["type", "branches"]);
    if (!Array.isArray(result.branches) || result.branches.length > (expected.type === "git.recent-branches" ? expected.limit ?? 100 : 100)) throw new Error("Invalid branch results.");
    parsed = { type: result.type, branches: result.branches.map(value => text(value)) };
  } else if (result.type === "git.default-branch") {
    keys(result, ["type", "branch"]); parsed = { type: result.type, branch: result.branch === null ? null : text(result.branch) };
  } else {
    keys(result, ["type", "base"]);
    if (result.base === null) parsed = { type: "git.base-branch", base: null };
    else { const base = object(result.base); keys(base, ["local", "remote"]); parsed = { type: "git.base-branch", base: { local: text(base.local), remote: text(base.remote) } }; }
  }
  return { ...common, phase: "complete", result: parsed };
}
export function parseBranchQueryMessage(value: unknown): BranchQueryMessage {
  const input = object(value);
  keys(input, ["type", "version", "hostId", "subscriptionId", "target", "query", "event", ...(input.event === "result" ? ["update"] : input.error === undefined ? ["phase"] : ["phase", "error"])]);
  const { action: _, ...request } = parseBranchQueryRequest({ type: input.type, version: input.version, hostId: input.hostId, subscriptionId: input.subscriptionId, target: input.target, query: input.query, action: "inspect" });
  if (input.event === "result") return { ...request, event: "result", update: parseBranchQueryUpdate(input.update, request.query) };
  if (input.event !== "status" || typeof input.phase !== "string" || !["pending", "ready", "releasing", "released", "failed", "unavailable"].includes(input.phase)) throw new Error("Invalid branch status.");
  return { ...request, event: "status", phase: input.phase as Extract<BranchQueryMessage, { event: "status" }>["phase"], ...(input.error === undefined ? {} : { error: errorText(input.error) }) };
}

/** Logical desktop observer state. A query failure remains an admitted ready
 * subscription with update.phase=failed; admission/lifetime failure does not. */
export type BranchQueryView =
  | { phase: "connecting" | "pending" | "failed" | "disconnected" | "unsupported"; error?: string }
  | { phase: "ready"; error?: string; update?: BranchQueryResultUpdate };

export type BranchQueryObserverView = BranchQueryView | { phase: "unavailable" | "released" };
export interface BranchQueryObserverStatus {
  hostId: string; subscriptionId: string; target: GitSubmissionTarget;
  query: LiveBranchQuery; view: BranchQueryObserverView;
}

/** Main-to-renderer delivery, with window-local IDs rather than socket IDs. */
export function parseBranchQueryObserverStatus(value: unknown): BranchQueryObserverStatus {
  const input = object(value);
  keys(input, ["hostId", "subscriptionId", "target", "query", "view"]);
  const owner = parseBranchQueryRequest({ type: "branch-query", version: 1, hostId: input.hostId,
    subscriptionId: input.subscriptionId, target: input.target, query: input.query, action: "inspect" });
  const view = object(input.view);
  keys(view, ["phase", ...(view.error === undefined ? [] : ["error"]), ...(view.update === undefined ? [] : ["update"])]);
  const error = view.error === undefined ? {} : { error: errorText(view.error) };
  let parsed: BranchQueryObserverView;
  if (view.phase === "ready") parsed = { phase: "ready", ...error,
    ...(view.update === undefined ? {} : { update: parseBranchQueryUpdate(view.update, owner.query) }) };
  else {
    if (view.update !== undefined || typeof view.phase !== "string" || !["connecting", "pending", "failed", "disconnected", "unsupported", "released", "unavailable"].includes(view.phase)) throw new Error("Invalid branch observer phase.");
    if (view.phase === "released" || view.phase === "unavailable") {
      if (view.error !== undefined) throw new Error("Invalid retired branch observer fields.");
      parsed = { phase: view.phase };
    } else parsed = { phase: view.phase as "connecting" | "pending" | "failed" | "disconnected" | "unsupported", ...error };
  }
  return { hostId: owner.hostId, subscriptionId: owner.subscriptionId, target: owner.target, query: owner.query, view: parsed };
}
