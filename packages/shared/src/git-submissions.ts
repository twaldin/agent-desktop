import type { GitPushDestination, WorkspaceTarget } from "./workspace";

export type GitSubmissionTarget = Exclude<WorkspaceTarget, { filePath: string }>;
/** Host-prepared selection totals, tied to the reviewed Git state and exact tree. */
export interface GitSelectionSummary {
  selectionMode: "staged" | "include-unstaged";
  reviewedRevision: string;
  selectedTree: string;
  additions: number;
  deletions: number;
  binaryFiles: number;
  files: number;
}
export interface GitSubmissionIntent {
  operation: "commit" | "commit-and-push" | "push";
  contextRevision: string;
  selectionMode: "staged" | "include-unstaged";
  /** Empty means native generation on explicit submission, never on opening. */
  message: string;
  branch?: { name: string; create: boolean };
  /** A branch change may explicitly name its new same-name ref; revision still
   * binds the reviewed remote, and upstream setup must be requested. */
  destination?: Pick<GitPushDestination, "remote" | "targetRef" | "revision" | "requiresUpstreamSetup">;
}

export interface GitSubmissionCommit {
  commit: string;
  summary: string;
  reviewedTree: string;
  committedTree: string;
  publishedIndexTree: string;
}
export interface GitSubmissionPush {
  outcome: "succeeded" | "failed" | "unknown";
  sourceCommit: string;
  remote: string;
  targetRef: string;
  upstreamRequested: boolean;
  applied: {
    remote: "confirmed" | "rejected" | "unknown";
    upstream: "not-requested" | "configured" | "failed" | "unknown";
  };
  summary: string;
  errorCode?: string;
}
export type GitSubmissionPhase = "queued" | "branch" | "preparing" | "generating" | "committing" | "pushing" | "completed";
export interface GitSubmissionReceipt {
  commandId: string;
  hostId: string;
  target: GitSubmissionTarget;
  operation: GitSubmissionIntent["operation"];
  revision: number;
  phase: GitSubmissionPhase;
  outcome: "pending" | "succeeded" | "failed" | "cancelled" | "unknown";
  cancelRequested: boolean;
  progress?: string;
  generatedMessage?: string;
  branch?: { before: string | null; after: string; head: string | null };
  commit?: GitSubmissionCommit;
  push?: GitSubmissionPush;
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
  /** Explicit inspection acknowledgement allows a new command, never replay. */
  acknowledgedAt?: number;
}
