export type TaskLocationKind = "local" | "worktree";
export type TaskLocationMoveStatus = "queued" | "running" | "succeeded" | "failed" | "unknown";
export type TaskLocationMoveStep =
  | "validate"
  | "capture-changes"
  | "prepare-destination"
  | "switch-git"
  | "move-session"
  | "record-result";

export interface TaskLocationDestination {
  kind: TaskLocationKind;
  label?: string;
  cwd: string;
  gitRoot: string;
  branch: string;
  managed: boolean;
  dirty?: boolean;
  conflicted?: boolean;
}

export interface TaskLocationAvailability {
  available: boolean;
  reason?: string;
  destination?: TaskLocationDestination;
}

export interface TaskLocationOperation {
  id: string;
  revision: number;
  sessionId: string;
  hostId: string;
  direction: "to-local" | "to-worktree";
  status: TaskLocationMoveStatus;
  step: TaskLocationMoveStep;
  source: TaskLocationDestination;
  destination?: TaskLocationDestination;
  message?: string;
  warnings: string[];
}

export interface TaskLocationSnapshot {
  version: 1;
  sessionId: string;
  hostId: string;
  revision: string;
  current: TaskLocationDestination;
  local: TaskLocationAvailability;
  worktree: TaskLocationAvailability;
  localCheckoutBranches: string[];
  operation?: TaskLocationOperation;
}

export type TaskLocationMoveTarget =
  | { kind: "local"; branch: string }
  | { kind: "worktree"; branch: string; localCheckoutBranch: string };

export interface TaskLocationMoveReceipt {
  type: "session.location.move";
  operation: TaskLocationOperation;
  session: import("./protocol").SessionSummary;
}
