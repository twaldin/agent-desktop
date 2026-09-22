import { parseSessionProcessesOwner, parseSessionProcessTarget, parseSessionProcessesRequest,
  type SessionProcessesOwner, type SessionProcessTarget } from "../../../packages/shared/src/session-processes";

export interface ProcessJournalScope { hostId: string; sessionId: string }
export interface ProcessOperationMetadata {
  operationId: string; action: "stop" | "restart" | "input";
  owner: SessionProcessesOwner; target: SessionProcessTarget;
}
export interface ProcessJournalRecord extends ProcessJournalScope { entries: ProcessOperationMetadata[] }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid process operation record.");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error("Invalid process operation scope.");
  return value;
}
export function parseProcessJournalScope(value: unknown): ProcessJournalScope {
  const v = object(value, ["hostId", "sessionId"]);
  return { hostId: id(v.hostId), sessionId: id(v.sessionId) };
}
/** Reject unknown fields rather than accidentally retaining stdin, logs or credentials. */
export function parseProcessOperationEntries(value: unknown): ProcessOperationMetadata[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid process operation list.");
  const entries = Array.from(value, (item): ProcessOperationMetadata => {
    const v = object(item, ["operationId", "action", "owner", "target"]);
    const request = parseSessionProcessesRequest({ action: "receipt", operationId: v.operationId });
    if (request.action !== "receipt" || (v.action !== "stop" && v.action !== "restart" && v.action !== "input"))
      throw new Error("Invalid process operation identity.");
    return { operationId: request.operationId, action: v.action,
      owner: parseSessionProcessesOwner(v.owner), target: parseSessionProcessTarget(v.target) };
  });
  if (new Set(entries.map(entry => entry.operationId)).size !== entries.length) throw new Error("Repeated process operation identity.");
  return entries;
}
export function parseProcessJournalRecords(value: unknown): ProcessJournalRecord[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("Invalid process operation scopes.");
  const records = Array.from(value, item => {
    const v = object(item, ["hostId", "sessionId", "entries"]);
    return { hostId: id(v.hostId), sessionId: id(v.sessionId), entries: parseProcessOperationEntries(v.entries) };
  });
  if (new Set(records.map(record => JSON.stringify([record.hostId, record.sessionId]))).size !== records.length)
    throw new Error("Repeated process operation scope.");
  return records;
}
