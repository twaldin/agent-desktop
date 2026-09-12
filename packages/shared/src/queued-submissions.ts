export const QUEUED_SUBMISSION_PROTOCOL_VERSION = 1;

export type FollowUpDelivery = "follow-up" | "steer";
export type QueuedSubmissionPhase = "admitting" | "queued" | "settled";
export type QueuedSubmissionOutcome = "pending" | "succeeded" | "not-recorded" | "unknown";

/**
 * Durable status for one active-turn submission. `commandId` is the stable
 * identity. Native queued-message IDs remain live worker locators and are not
 * persisted here.
 */
export interface QueuedSubmissionReceipt {
  version: typeof QUEUED_SUBMISSION_PROTOCOL_VERSION;
  commandId: string;
  hostId: string;
  sessionId: string;
  delivery: FollowUpDelivery;
  phase: QueuedSubmissionPhase;
  outcome: QueuedSubmissionOutcome;
  revision: number;
  entryId?: string;
  message?: string;
  createdAt: number;
  updatedAt: number;
}

export interface QueuedSubmissionResult {
  type: "session.follow-up";
  receipt: QueuedSubmissionReceipt;
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid queued-submission receipt");
  return value as Record<string, unknown>;
};
const string = (value: unknown, label: string, maximum = 4096): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new Error(`Invalid ${label}`);
  return value;
};

export function parseQueuedSubmissionReceipt(value: unknown): QueuedSubmissionReceipt {
  const item = record(value);
  if (Object.keys(item).some(key => !["version", "commandId", "hostId", "sessionId", "delivery", "phase", "outcome", "revision", "entryId", "message", "createdAt", "updatedAt"].includes(key))
    || item.version !== QUEUED_SUBMISSION_PROTOCOL_VERSION
    || (item.delivery !== "follow-up" && item.delivery !== "steer")
    || !["admitting", "queued", "settled"].includes(String(item.phase))
    || !["pending", "succeeded", "not-recorded", "unknown"].includes(String(item.outcome))
    || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1
    || !Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.updatedAt)
    || Number(item.createdAt) < 0 || Number(item.updatedAt) < Number(item.createdAt)) {
    throw new Error("Invalid queued-submission receipt");
  }
  const phase = item.phase as QueuedSubmissionPhase, outcome = item.outcome as QueuedSubmissionOutcome;
  if ((phase === "settled") !== (outcome !== "pending")) throw new Error("Queued-submission phase and outcome disagree");
  if ((outcome === "succeeded") !== (typeof item.entryId === "string")) throw new Error("Queued-submission entry receipt disagrees with its outcome");
  if ((outcome === "not-recorded" || outcome === "unknown") !== (typeof item.message === "string")) throw new Error("Queued-submission explanation disagrees with its outcome");
  return {
    version: 1,
    commandId: string(item.commandId, "queued-submission command ID", 200),
    hostId: string(item.hostId, "queued-submission host ID", 200),
    sessionId: string(item.sessionId, "queued-submission session ID", 200),
    delivery: item.delivery,
    phase,
    outcome,
    revision: Number(item.revision),
    ...(item.entryId === undefined ? {} : { entryId: string(item.entryId, "queued-submission entry ID", 500) }),
    ...(item.message === undefined ? {} : { message: string(item.message, "queued-submission message") }),
    createdAt: Number(item.createdAt),
    updatedAt: Number(item.updatedAt),
  };
}
