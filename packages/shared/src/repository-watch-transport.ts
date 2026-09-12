import type { GitSubmissionTarget } from "./git-submissions";

export const REPOSITORY_WATCH_CAPABILITY = { version: 1 } as const;
export interface RepositoryWatchView {
  phase: "connecting" | "pending" | "ready" | "failed" | "disconnected" | "unsupported" | "released" | "unavailable";
  error?: string;
}
export interface RepositoryWatchObserverStatus {
  hostId: string;
  subscriptionId: string;
  target: GitSubmissionTarget;
  view: RepositoryWatchView;
}
export interface RepositoryWatchRequest {
  type: "repository-watch";
  version: 1;
  hostId: string;
  subscriptionId: string;
  action: "retain" | "inspect" | "release";
  target: GitSubmissionTarget;
}
/** Connection-local state, never a durable HostEvent or a replay cursor. */
export interface RepositoryWatchStatus {
  type: "repository-watch";
  version: 1;
  hostId: string;
  subscriptionId: string;
  target: GitSubmissionTarget;
  phase: "pending" | "ready" | "releasing" | "released" | "failed" | "unavailable";
  /** Ready means initial acquisition settled; this separately reports degraded coverage. */
  error?: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid repository watch request.");
  return value as Record<string, unknown>;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200 || /[\0\r\n]/.test(value)) throw new Error("Invalid repository watch identity.");
  return value;
}
export function parseRepositoryWatchRequest(value: unknown): RepositoryWatchRequest {
  const input = object(value), target = object(input.target);
  if (input.type !== "repository-watch" || input.version !== 1 || typeof input.action !== "string" || !["retain", "inspect", "release"].includes(input.action)
    || Object.keys(input).length !== 6 || Object.keys(target).length !== 1) throw new Error("Invalid repository watch request.");
  let owner: GitSubmissionTarget;
  if ("projectId" in target) owner = { projectId: identity(target.projectId) };
  else if ("sessionId" in target) owner = { sessionId: identity(target.sessionId) };
  else throw new Error("Repository watching requires a catalogued project or session.");
  return { type: "repository-watch", version: 1, hostId: identity(input.hostId), subscriptionId: identity(input.subscriptionId),
    action: input.action as RepositoryWatchRequest["action"], target: owner };
}

export function parseRepositoryWatchStatus(value: unknown): RepositoryWatchStatus {
  const input = object(value);
  if (!["pending", "ready", "releasing", "released", "failed", "unavailable"].includes(String(input.phase)) || typeof input.phase !== "string"
    || Object.keys(input).length !== (input.error === undefined ? 6 : 7)
    || input.error !== undefined && (typeof input.error !== "string" || !input.error || input.error.length > 1000)) throw new Error("Invalid repository watch status.");
  const request = parseRepositoryWatchRequest({ type: input.type, version: input.version, hostId: input.hostId, subscriptionId: input.subscriptionId, target: input.target, action: "inspect" });
  return { type: "repository-watch", version: 1, hostId: request.hostId, subscriptionId: request.subscriptionId,
    target: request.target, phase: input.phase as RepositoryWatchStatus["phase"], ...(input.error !== undefined ? { error: input.error as string } : {}) };
}
