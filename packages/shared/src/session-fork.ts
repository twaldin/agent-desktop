import type { NewChatExecution } from "./new-chat";

export const SESSION_FORK_CAPABILITY = { version: 1, commandVersion: 16 } as const;

export interface SessionForkOperation {
  commandId: string;
  execution: NewChatExecution;
  state: "preparing" | "forking" | "binding" | "complete" | "failed" | "unknown";
  canResume: boolean;
  error?: string;
  sessionId?: string;
  sessionFile?: string;
  worktreePath?: string;
}

export interface SessionForkSnapshot {
  version: 1;
  hostId: string;
  sessionId: string;
  revision: string;
  local: { available: boolean; reason?: string; cwd: string; isWorktree: boolean };
  worktree: { available: boolean; reason?: string };
  operation?: SessionForkOperation;
}

export interface SessionForkRequest {
  sessionId: string;
  expectedRevision: string;
  execution: NewChatExecution;
}

export interface SessionForkReceipt {
  type: "session.forked";
  commandId: string;
  sourceSessionId: string;
  session: import("./protocol").SessionSummary;
}

/** Malformed fork requests still require the new transport before validation. */
export function hasSessionForkIntent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "session.fork" || type === "session.fork.resume";
}
