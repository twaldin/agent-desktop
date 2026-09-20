/** Native background jobs of one loaded native session. Jobs are ephemeral SDK
 * state: no desktop store, no cold restoration, no history. The owner binds
 * every target to one adapter generation; the guard binds a target to one live
 * native job object even when its id and startTime are reused. */
export const SESSION_JOBS_PROTOCOL_VERSION = 1 as const;
/** Retained resultText/errorText bound per field; longer bodies are cut and flagged. */
export const SESSION_JOBS_MAX_OUTPUT_CHARS = 16_384;
export const SESSION_JOBS_MAX_RUNNING = 100;
export const SESSION_JOBS_MAX_RECENT = 20;
export const SESSION_JOBS_MAX_PENDING_IDS = 100;
export const SESSION_JOBS_MAX_ID_CHARS = 1000;

export interface SessionJobsOwner { nativeSessionId: string; epoch: string; agentId?: string }
export interface SessionJobTarget { id: string; startTime: number; guard: string }
export type SessionJobType = "bash" | "task" | "eval";
export type SessionJobStatus = "running" | "completed" | "failed" | "cancelled";
export interface SessionJobRow {
  target: SessionJobTarget;
  type: SessionJobType;
  status: SessionJobStatus;
  label: string;
  /** Parked behind a native gate; only meaningful while status is running. */
  queued: boolean;
  agentId?: string;
}
export interface SessionJobsDelivery { queued: number; delivering: boolean; nextRetryAt?: number; pendingJobIds: string[] }
export type SessionJobsSnapshot =
  | { owner: SessionJobsOwner; availability: "unavailable"; reason: string }
  | { owner: SessionJobsOwner; availability: "available"; running: SessionJobRow[]; recent: SessionJobRow[]; delivery: SessionJobsDelivery };
export type SessionJobsRequest =
  | { action: "read"; owner?: SessionJobsOwner }
  | { action: "inspect" | "cancel"; owner: SessionJobsOwner; job: SessionJobTarget };
export interface SessionJobDetail { target: SessionJobTarget; resultText?: string; errorText?: string; truncated: boolean; consumed: boolean }
export type SessionJobsResult =
  | { action: "read"; snapshot: SessionJobsSnapshot }
  | { action: "inspect"; snapshot: SessionJobsSnapshot; detail: SessionJobDetail }
  /** `requested` means the native manager accepted the abort request; the body may still be running. */
  | { action: "cancel"; snapshot: SessionJobsSnapshot; requested: boolean };
export interface SessionJobsEnvelope { protocolVersion: typeof SESSION_JOBS_PROTOCOL_VERSION; hostId: string; sessionId: string; result: SessionJobsResult }

const JOB_TYPES: readonly string[] = ["bash", "task", "eval"];
const JOB_STATUSES: readonly string[] = ["running", "completed", "failed", "cancelled"];
function invalid(field: string): never { throw new Error(`Invalid native jobs ${field}.`); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(key);
  return value as Record<string, unknown>;
}
function identity(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return invalid("identity");
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) return invalid("text");
  return value;
}
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : invalid("boolean"); }
function count(value: unknown): number { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : invalid("count"); }
function list(value: unknown, max: number): unknown[] { return Array.isArray(value) && value.length <= max ? value : invalid("list"); }

export function parseSessionJobsOwner(value: unknown): SessionJobsOwner {
  const v = record(value, ["nativeSessionId", "epoch", "agentId"]);
  return { nativeSessionId: identity(v.nativeSessionId), epoch: identity(v.epoch), ...(v.agentId === undefined ? {} : { agentId: identity(v.agentId) }) };
}
export function parseSessionJobTarget(value: unknown): SessionJobTarget {
  const v = record(value, ["id", "startTime", "guard"]);
  return { id: identity(v.id, SESSION_JOBS_MAX_ID_CHARS), startTime: count(v.startTime), guard: identity(v.guard) };
}
export function parseSessionJobRow(value: unknown): SessionJobRow {
  const v = record(value, ["target", "type", "status", "label", "queued", "agentId"]);
  if (!JOB_TYPES.includes(String(v.type))) invalid("type");
  if (!JOB_STATUSES.includes(String(v.status))) invalid("status");
  const queued = bool(v.queued);
  // Native queued is a flag on a running row, never a fifth status.
  if (queued && v.status !== "running") invalid("queued state");
  return { target: parseSessionJobTarget(v.target), type: v.type as SessionJobType, status: v.status as SessionJobStatus, label: text(v.label, 500), queued,
    ...(v.agentId === undefined ? {} : { agentId: identity(v.agentId) }) };
}
export function parseSessionJobsSnapshot(value: unknown): SessionJobsSnapshot {
  const v = record(value, ["owner", "availability", "reason", "running", "recent", "delivery"]);
  const owner = parseSessionJobsOwner(v.owner);
  if (v.availability === "unavailable") {
    if (v.running !== undefined || v.recent !== undefined || v.delivery !== undefined) invalid("unavailable fields");
    const reason = text(v.reason, 4096); if (!reason.trim()) invalid("reason");
    return { owner, availability: "unavailable", reason };
  }
  if (v.availability !== "available" || v.reason !== undefined) invalid("availability");
  const rows = (raw: unknown, max: number, running: boolean) => list(raw, max).map(item => {
    const row = parseSessionJobRow(item);
    if ((row.status === "running") !== running) invalid("row placement");
    return row;
  });
  const running = rows(v.running, SESSION_JOBS_MAX_RUNNING, true), recent = rows(v.recent, SESSION_JOBS_MAX_RECENT, false);
  const ids = new Set<string>();
  for (const row of [...running, ...recent]) { if (ids.has(row.target.id)) invalid("duplicate job"); ids.add(row.target.id); }
  const d = record(v.delivery, ["queued", "delivering", "nextRetryAt", "pendingJobIds"]);
  const delivery: SessionJobsDelivery = { queued: count(d.queued), delivering: bool(d.delivering),
    ...(d.nextRetryAt === undefined ? {} : { nextRetryAt: count(d.nextRetryAt) }),
    pendingJobIds: list(d.pendingJobIds, SESSION_JOBS_MAX_PENDING_IDS).map(id => identity(id, SESSION_JOBS_MAX_ID_CHARS)) };
  return { owner, availability: "available", running, recent, delivery };
}
export function parseSessionJobsRequest(value: unknown): SessionJobsRequest {
  const v = record(value, ["action", "owner", "job"]);
  if (v.action === "read") {
    if (v.job !== undefined) invalid("read fields");
    return { action: "read", ...(v.owner === undefined ? {} : { owner: parseSessionJobsOwner(v.owner) }) };
  }
  if (v.action !== "inspect" && v.action !== "cancel") invalid("action");
  return { action: v.action, owner: parseSessionJobsOwner(v.owner), job: parseSessionJobTarget(v.job) };
}
export function parseSessionJobsResult(value: unknown): SessionJobsResult {
  const v = record(value, ["action", "snapshot", "detail", "requested"]);
  const snapshot = parseSessionJobsSnapshot(v.snapshot);
  if (v.action === "read") {
    if (v.detail !== undefined || v.requested !== undefined) invalid("read result");
    return { action: "read", snapshot };
  }
  // A control result needs the job manager the target came from.
  if (snapshot.availability !== "available") invalid("control snapshot");
  if (v.action === "inspect") {
    if (v.requested !== undefined) invalid("inspect result");
    const d = record(v.detail, ["target", "resultText", "errorText", "truncated", "consumed"]);
    return { action: "inspect", snapshot, detail: { target: parseSessionJobTarget(d.target),
      ...(d.resultText === undefined ? {} : { resultText: text(d.resultText, SESSION_JOBS_MAX_OUTPUT_CHARS) }),
      ...(d.errorText === undefined ? {} : { errorText: text(d.errorText, SESSION_JOBS_MAX_OUTPUT_CHARS) }),
      truncated: bool(d.truncated), consumed: bool(d.consumed) } };
  }
  if (v.action !== "cancel" || v.detail !== undefined) invalid("action");
  return { action: "cancel", snapshot, requested: bool(v.requested) };
}
export function parseSessionJobsEnvelope(value: unknown, expectedHostId: string, expectedSessionId: string): SessionJobsEnvelope {
  const v = record(value, ["protocolVersion", "hostId", "sessionId", "result"]);
  if (v.protocolVersion !== SESSION_JOBS_PROTOCOL_VERSION) invalid("protocol");
  if (v.hostId !== expectedHostId || v.sessionId !== expectedSessionId) invalid("envelope owner");
  const result = parseSessionJobsResult(v.result);
  if (result.snapshot.owner.nativeSessionId !== expectedSessionId) invalid("native owner");
  return { protocolVersion: SESSION_JOBS_PROTOCOL_VERSION, hostId: expectedHostId, sessionId: expectedSessionId, result };
}
export function sameSessionJobsOwner(a: SessionJobsOwner, b: SessionJobsOwner): boolean {
  return a.nativeSessionId === b.nativeSessionId && a.epoch === b.epoch && a.agentId === b.agentId;
}
export function sameSessionJobTarget(a: SessionJobTarget, b: SessionJobTarget): boolean {
  return a.id === b.id && a.startTime === b.startTime && a.guard === b.guard;
}
/** A result answers exactly the request it was dispatched for: same action, the
 * requested owner when one was named, and the requested target for controls. */
export function assertSessionJobsResultMatches(request: SessionJobsRequest, result: SessionJobsResult): void {
  if (result.action !== request.action) invalid("result action");
  if (request.owner && !sameSessionJobsOwner(request.owner, result.snapshot.owner)) invalid("result owner");
  if (request.action === "inspect" && (result.action !== "inspect" || !sameSessionJobTarget(request.job, result.detail.target))) invalid("result target");
}
