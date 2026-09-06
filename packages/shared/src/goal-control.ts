import type { NativeGoalActivity } from "./session-activity";

export const GOAL_CONTROL_PROTOCOL_VERSION = 1 as const;
export const GOAL_CONTROL_MAX_AGE_MS = 60_000;

export interface GoalControlTicket {
  controlEpoch: string;
  observedAt: number;
  /** SHA-256 of goalControlState. Usage accounting is not a configuration edit. */
  goalFingerprint: string;
}

export type GoalMutation =
  | { type: "create" | "replace"; objective: string; tokenBudget?: number }
  | { type: "pause" | "resume" | "drop" }
  | { type: "setBudget"; tokenBudget?: number };

export interface GoalMutationRequest extends GoalControlTicket {
  requestId: string;
  /** updatedAt is observation metadata; native usage also advances this timestamp. */
  expectedGoal: { id: string; updatedAt: number } | null;
  mutation: GoalMutation;
}

interface GoalMutationReceiptBase {
  protocolVersion: typeof GOAL_CONTROL_PROTOCOL_VERSION;
  hostId: string;
  sessionId: string;
  requestId: string;
}

export type GoalMutationReceipt =
  | GoalMutationReceiptBase & { outcome: "completed"; goal: NativeGoalActivity | null }
  | GoalMutationReceiptBase & { outcome: "rejected" | "unknown"; message: string; goal?: NativeGoalActivity | null };

const identity = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value);
const budget = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Canonical native identity and effective configuration. The host and worker
 * both compare this immediately before dispatch. OMP updates usage/time and
 * updatedAt even while merely observing a running goal; those must not make
 * Pause impossible. Returning to an identical configuration is equivalent. */
export function goalControlState(value: NativeGoalActivity | null): string {
  if (value === null) return 'null';
  const { id, objective, status, enabled, mode, reason, tokenBudget, createdAt } = parseNativeGoalActivity(value);
  return JSON.stringify({ id, objective, status, enabled, mode, reason, tokenBudget, createdAt });
}

export function parseGoalControlTicket(value: unknown): GoalControlTicket {
  if (!value || typeof value !== "object") throw new Error("Missing goal control ticket.");
  const ticket = value as GoalControlTicket;
  if (!identity(ticket.controlEpoch) || !Number.isSafeInteger(ticket.observedAt) || ticket.observedAt <= 0
    || typeof ticket.goalFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(ticket.goalFingerprint)) {
    throw new Error("Invalid goal control ticket.");
  }
  return { controlEpoch: ticket.controlEpoch, observedAt: ticket.observedAt, goalFingerprint: ticket.goalFingerprint };
}

function parseGoalMutation(value: unknown): GoalMutation {
  if (!value || typeof value !== "object") throw new Error("Missing goal mutation.");
  const mutation = value as GoalMutation;
  if (mutation.type === "create" || mutation.type === "replace") {
    if (typeof mutation.objective !== "string" || !mutation.objective.trim() || mutation.objective.length > 16_384 || mutation.objective.includes("\0")
      || mutation.tokenBudget !== undefined && !budget(mutation.tokenBudget)) throw new Error("Invalid goal objective or token budget.");
    return { type: mutation.type, objective: mutation.objective, ...(mutation.tokenBudget === undefined ? {} : { tokenBudget: mutation.tokenBudget }) };
  }
  if (mutation.type === "setBudget") {
    if (mutation.tokenBudget !== undefined && !budget(mutation.tokenBudget)) throw new Error("Invalid goal token budget.");
    return { type: mutation.type, ...(mutation.tokenBudget === undefined ? {} : { tokenBudget: mutation.tokenBudget }) };
  }
  if (mutation.type === "pause" || mutation.type === "resume" || mutation.type === "drop") return { type: mutation.type };
  throw new Error("Unsupported goal mutation.");
}

export function parseGoalMutationRequest(value: unknown): GoalMutationRequest {
  if (!value || typeof value !== "object") throw new Error("Missing goal mutation request.");
  const request = value as GoalMutationRequest;
  if (!identity(request.requestId)) throw new Error("Invalid goal mutation request identity.");
  let expectedGoal: GoalMutationRequest["expectedGoal"];
  if (request.expectedGoal === null) expectedGoal = null;
  else {
    const expected = request.expectedGoal as GoalMutationRequest["expectedGoal"];
    if (!expected || !identity(expected.id) || !Number.isSafeInteger(expected.updatedAt) || expected.updatedAt <= 0) {
      throw new Error("Invalid expected goal revision.");
    }
    expectedGoal = { id: expected.id, updatedAt: expected.updatedAt };
  }
  const mutation = parseGoalMutation(request.mutation);
  if (expectedGoal === null && mutation.type !== "create") throw new Error("Only goal creation may expect no current goal.");
  return { requestId: request.requestId, ...parseGoalControlTicket(request), expectedGoal, mutation };
}

export function parseNativeGoalActivity(value: unknown): NativeGoalActivity {
  if (!value || typeof value !== "object") throw new Error("Invalid native goal activity.");
  const goal = value as NativeGoalActivity;
  if (!identity(goal.id) || typeof goal.objective !== "string" || goal.objective.length > 16_384 || goal.objective.includes("\0")
    || !["active", "paused", "budget-limited", "complete", "dropped"].includes(goal.status)
    || typeof goal.enabled !== "boolean" || !["active", "exiting"].includes(goal.mode)
    || goal.reason !== undefined && goal.reason !== "completed"
    || goal.tokenBudget !== undefined && !budget(goal.tokenBudget)
    || !nonNegativeInteger(goal.tokensUsed) || !nonNegativeInteger(goal.timeUsedSeconds)
    || !Number.isSafeInteger(goal.createdAt) || goal.createdAt <= 0
    || !Number.isSafeInteger(goal.updatedAt) || goal.updatedAt <= 0) throw new Error("Invalid native goal activity.");
  return {
    id: goal.id, objective: goal.objective, status: goal.status, enabled: goal.enabled, mode: goal.mode,
    ...(goal.reason ? { reason: goal.reason } : {}), ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
    tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds, createdAt: goal.createdAt, updatedAt: goal.updatedAt,
  };
}

export function parseGoalMutationReceipt(value: unknown, expected: { hostId: string; sessionId: string; requestId: string }): GoalMutationReceipt {
  if (!value || typeof value !== "object") throw new Error("Invalid goal mutation receipt.");
  const receipt = value as GoalMutationReceipt;
  if (receipt.protocolVersion !== GOAL_CONTROL_PROTOCOL_VERSION || receipt.hostId !== expected.hostId
    || receipt.sessionId !== expected.sessionId || receipt.requestId !== expected.requestId
    || !["completed", "rejected", "unknown"].includes(receipt.outcome)) throw new Error("Invalid goal mutation receipt.");
  const base = { protocolVersion: GOAL_CONTROL_PROTOCOL_VERSION, hostId: expected.hostId, sessionId: expected.sessionId, requestId: expected.requestId };
  if (receipt.outcome === "completed") {
    return { ...base, outcome: receipt.outcome, goal: receipt.goal === null ? null : parseNativeGoalActivity(receipt.goal) };
  }
  if (typeof receipt.message !== "string" || !receipt.message.trim() || receipt.message.length > 4_096) throw new Error("Invalid goal mutation receipt.");
  return { ...base, outcome: receipt.outcome, message: receipt.message,
    ...(receipt.goal === undefined ? {} : { goal: receipt.goal === null ? null : parseNativeGoalActivity(receipt.goal) }) };
}
