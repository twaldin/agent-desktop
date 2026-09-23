/** Explicit inspection of original native sessions on one owning host. Writable
 * admission is a separate capability and never follows from a listing. */
export const SESSION_IMPORT_INSPECTION_CAPABILITY = { version: 1 } as const;
export const SESSION_IMPORT_ADMISSION_CAPABILITY = { version: 1 } as const;
export const SESSION_IMPORT_OWNER_HEADER = "X-Agent-Host-Id";
export const MAX_SESSION_IMPORT_REPLY_BYTES = 4 * 1024 * 1024;
export interface NativeImportCandidate {
  candidateId: string; sourcePath: string; nativeId?: string; title?: string; recordedCwd?: string;
  messageCountEstimate?: number; persistedStatus?: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown"; issue?: string;
}
export interface NativeImportInspection {
  candidateId: string; revision: string; originalFile: string; nativeId?: string; recordedCwd?: string; canonicalCwd?: string;
  nativeVersion?: number; entries: number; messages: number; malformedRecords: number; issues: string[];
  writeAdmission: { allowed: false; reason: "source-invalid" | "ownership-unverified" };
}
export interface NativeImportListing { version: 1; hostId: string; candidates: NativeImportCandidate[] }
export interface NativeImportInspectionReply { version: 1; hostId: string; inspection: NativeImportInspection }
export interface NativeImportOriginal { sessionId: string; originalFile: string; cwd: string }
export type NativeImportPreparation = { version: 1; hostId: string; candidateId: string; revision: string } & (
  | { state: "ready"; preparationId: string; original: NativeImportOriginal }
  | { state: "refused"; reason: string; message: string });
export type NativeImportOutcome = { version: 1; hostId: string; commandId: string } & (
  | { state: "absent" | "pending" }
  | { state: "imported"; original: NativeImportOriginal }
  | { state: "refused"; reason: string; message: string }
  | { state: "unknown"; message: string });
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native import reply.");
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 4096, allowEmpty = false): string => {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error("Invalid native import text.");
  return value;
};
const count = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid native import count.");
  return value as number;
};
export function nativeImportCandidateId(value: unknown): string {
  const id = text(value, 80); if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid native import candidate."); return id;
}
function owner(value: Record<string, unknown>, hostId: string) {
  if (value.version !== 1 || value.hostId !== hostId) throw new Error("The native import reply belongs to another host or protocol.");
}
function original(value: unknown): NativeImportOriginal {
  const v = object(value);
  return {sessionId:text(v.sessionId,200),originalFile:text(v.originalFile),cwd:text(v.cwd)};
}
export function nativeImportCommandId(value: unknown): string { return nativeImportCandidateId(value); }
export function parseNativeImportPreparationRequest(value:unknown):{candidateId:string;revision:string}{
  const v=object(value);if(Object.keys(v).some(key=>key!=="candidateId"&&key!=="revision"))throw new Error("Unexpected original import preparation field.");
  return {candidateId:nativeImportCandidateId(v.candidateId),revision:nativeImportCandidateId(v.revision)};
}
export function parseNativeImportAdmissionRequest(value:unknown):{commandId:string;preparationId:string}{
  const v=object(value);if(Object.keys(v).some(key=>key!=="commandId"&&key!=="preparationId"))throw new Error("Unexpected original import admission field.");
  return {commandId:nativeImportCommandId(v.commandId),preparationId:nativeImportCommandId(v.preparationId)};
}
export function parseNativeImportPreparation(value: unknown, hostId: string, candidateId: string, revision: string): NativeImportPreparation {
  const v=object(value);owner(v,hostId);
  if(v.candidateId!==candidateId||v.revision!==revision)throw new Error("The original import preparation changed its inspected source.");
  const base={version:1 as const,hostId,candidateId:nativeImportCandidateId(candidateId),revision:nativeImportCandidateId(revision)};
  if(v.state==="ready")return {...base,state:"ready",preparationId:nativeImportCommandId(v.preparationId),original:original(v.original)};
  if(v.state==="refused")return {...base,state:"refused",reason:text(v.reason,200),message:text(v.message)};
  throw new Error("Invalid original import preparation.");
}
export function parseNativeImportOutcome(value: unknown, hostId: string, commandId: string): NativeImportOutcome {
  const v=object(value);owner(v,hostId);
  if(v.commandId!==commandId)throw new Error("The original import outcome belongs to another command.");
  const base={version:1 as const,hostId,commandId:nativeImportCommandId(commandId)};
  if(v.state==="absent"||v.state==="pending")return {...base,state:v.state};
  if(v.state==="imported")return {...base,state:"imported",original:original(v.original)};
  if(v.state==="refused")return {...base,state:"refused",reason:text(v.reason,200),message:text(v.message)};
  if(v.state==="unknown")return {...base,state:"unknown",message:text(v.message)};
  throw new Error("Invalid original import outcome.");
}
export function parseNativeImportListing(value: unknown, hostId: string): NativeImportListing {
  const v = object(value); owner(v, hostId);
  if (!Array.isArray(v.candidates) || v.candidates.length > 10_000) throw new Error("Invalid native import listing.");
  const ids = new Set<string>();
  const candidates = Array.from(v.candidates, raw => {
    const row = object(raw), candidateId = nativeImportCandidateId(row.candidateId);
    if (ids.has(candidateId)) throw new Error("Duplicate native import candidate."); ids.add(candidateId);
    const item: NativeImportCandidate = { candidateId, sourcePath: text(row.sourcePath) };
    for (const key of ["nativeId", "title", "recordedCwd", "issue"] as const) if (row[key] !== undefined) item[key] = text(row[key], 4096, key === "title" || key === "recordedCwd");
    if (row.messageCountEstimate !== undefined) item.messageCountEstimate = count(row.messageCountEstimate);
    if (row.persistedStatus !== undefined) {
      if (!["complete", "interrupted", "aborted", "error", "pending", "unknown"].includes(String(row.persistedStatus))) throw new Error("Invalid saved native status.");
      item.persistedStatus = row.persistedStatus as NativeImportCandidate["persistedStatus"];
    }
    return item;
  });
  return { version: 1, hostId, candidates };
}
export function parseNativeImportInspection(value: unknown, hostId: string, candidateId: string): NativeImportInspectionReply {
  const v = object(value); owner(v, hostId); const row = object(v.inspection);
  if (row.candidateId !== candidateId) throw new Error("The original native inspection does not match its candidate.");
  const admission = object(row.writeAdmission);
  if (admission.allowed !== false || !["source-invalid", "ownership-unverified"].includes(String(admission.reason))) throw new Error("A readonly inspection cannot authorize a writer.");
  if (!Array.isArray(row.issues) || row.issues.length > 100) throw new Error("Invalid native source issues.");
  const inspection: NativeImportInspection = { candidateId: nativeImportCandidateId(candidateId), revision: nativeImportCandidateId(row.revision), originalFile: text(row.originalFile),
    entries: count(row.entries), messages: count(row.messages), malformedRecords: count(row.malformedRecords), issues: Array.from(row.issues, value => text(value)),
    writeAdmission: { allowed: false, reason: admission.reason as NativeImportInspection["writeAdmission"]["reason"] } };
  for (const key of ["nativeId", "recordedCwd", "canonicalCwd"] as const) if (row[key] !== undefined) inspection[key] = text(row[key], 4096, key === "recordedCwd");
  if (row.nativeVersion !== undefined) inspection.nativeVersion = count(row.nativeVersion);
  return { version: 1, hostId, inspection };
}
