export type LocalEnvironmentPreparationPhase =
  | "validated" | "worktree-creating" | "worktree-created"
  | "setup-running" | "setup-failed" | "setup-succeeded"
  | "native-creating" | "session-created"
  | "cleanup-running" | "cleanup-failed" | "cleanup-succeeded"
  | "removed" | "unknown";

export type LocalEnvironmentUncertainOperation = "worktree-create" | "setup" | "native-create" | "cleanup";

export interface LocalEnvironmentRunSummary {
  status: "succeeded" | "failed" | "cancelled";
  cancelReason?: "aborted" | "timed-out";
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  finishedAt: number;
  outputTruncated: boolean;
}

/** Value-redacted preparation state safe for an authenticated owning client. */
export interface LocalEnvironmentPreparationPublic {
  id: string;
  revision: number;
  hostId: string;
  projectId: string;
  worktreePath: string;
  phase: LocalEnvironmentPreparationPhase;
  uncertainOperation?: LocalEnvironmentUncertainOperation;
  needsAttention: boolean;
  environment: null | { configPath: string; revision: string; name: string };
  setup?: LocalEnvironmentRunSummary;
  cleanup?: LocalEnvironmentRunSummary;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LocalEnvironmentPreparationReceipt {
  type: "environment.preparation";
  preparation: LocalEnvironmentPreparationPublic;
}

/** Explicit authenticated output read; never part of ordinary preparation status or drafts. */
export interface LocalEnvironmentExecutionOutput {
  preparationId: string;
  runRevision: number;
  lifecycle: "setup" | "cleanup";
  sequence: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  cancellationRequested: boolean;
  finished: boolean;
}
