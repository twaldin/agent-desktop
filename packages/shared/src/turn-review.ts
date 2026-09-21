export const TURN_REVIEW_OWNER_HEADER = "x-agent-desktop-turn-review-owner";
export type TurnReviewAvailability = "available" | "pending" | "partial" | "unavailable";
export type TurnReviewOutcome = "running" | "completed" | "aborted" | "error";
export interface TurnReviewFile {
  path: string;
  previousPath: string | null;
  kind: "A" | "D" | "M" | "R";
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** Recorded sections only; a file-type replacement may contain two sections. */
  patch: string;
}
export interface TurnReviewSelection {
  turnId: string;
  originSessionId: string;
  inputEntryIds: string[];
  cwd: string;
  source: "recorded" | "derived";
  outcome: TurnReviewOutcome;
  coverage: "foreground-cwd";
}
/** Conversation-owned read. An absent capture is never an available empty review. */
export interface TurnReview {
  sessionId: string;
  revision: string;
  state: TurnReviewAvailability;
  reason: string | null;
  selected: TurnReviewSelection | null;
  files: TurnReviewFile[];
  patch: string;
}
export interface TurnReviewOpenRequest {
  conversationId: string;
  path?: string;
}
export function parseTurnReview(value: unknown): TurnReview {
  const object = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid recorded review response.");
    return input as Record<string, unknown>;
  };
  const text = (input: unknown): string => { if (typeof input !== "string") throw new Error("Invalid recorded review text."); return input; };
  const member = <T extends string>(input: unknown, choices: readonly T[]): T => {
    if (typeof input !== "string" || !choices.includes(input as T)) throw new Error("Invalid recorded review state.");
    return input as T;
  };
  const count = (input: unknown): number | null => { if (input === null) return null; if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) throw new Error("Invalid recorded review count."); return input; };
  const row = object(value);
  if (!Array.isArray(row.files)) throw new Error("Invalid recorded file inventory.");
  const files = row.files.map(input => {
    const file = object(input);
    if (typeof file.binary !== "boolean") throw new Error("Invalid recorded binary state.");
    return { path: text(file.path), previousPath: file.previousPath === null ? null : text(file.previousPath), kind: member(file.kind, ["A", "D", "M", "R"] as const), additions: count(file.additions), deletions: count(file.deletions), binary: file.binary, patch: text(file.patch) };
  });
  let selected: TurnReviewSelection | null = null;
  if (row.selected !== null) {
    const item = object(row.selected);
    if (!Array.isArray(item.inputEntryIds)) throw new Error("Invalid recorded input identity.");
    selected = { turnId: text(item.turnId), originSessionId: text(item.originSessionId), inputEntryIds: item.inputEntryIds.map(text), cwd: text(item.cwd), source: member(item.source, ["recorded", "derived"] as const), outcome: member(item.outcome, ["running", "completed", "aborted", "error"] as const), coverage: member(item.coverage, ["foreground-cwd"] as const) };
  }
  const result: TurnReview = { sessionId: text(row.sessionId), revision: text(row.revision), state: member(row.state, ["available", "pending", "partial", "unavailable"] as const), reason: row.reason === null ? null : text(row.reason), selected, files, patch: text(row.patch) };
  if (result.state === "available" && !result.selected) throw new Error("Available recorded review has no original turn identity.");
  return result;
}
