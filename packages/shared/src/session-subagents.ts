import type { TranscriptMessage } from "./protocol";
import { IMAGE_ATTACHMENT_MIME_TYPES, type ImageAttachmentMimeType } from "./attachments";

/** Read-only browsing, always addressed through the original loaded root. */
export const SESSION_SUBAGENTS_PROTOCOL_VERSION = 1 as const;
export const SESSION_SUBAGENTS_MAX_ROWS = 100;
export const SESSION_SUBAGENTS_MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
export const SESSION_SUBAGENTS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const SESSION_SUBAGENTS_MAX_FILE_BYTES = 256 * 1024;
export const SESSION_SUBAGENTS_MAX_PATH_CHARS = 4096;
/** Envelope, owner, target and metadata headroom inside every response budget. */
export const SESSION_SUBAGENTS_RESPONSE_RESERVE_BYTES = 64 * 1024;
/** Raw image bytes whose base64 form still fits the response budget beside its envelope. */
export const SESSION_SUBAGENTS_MAX_IMAGE_BYTES = Math.floor((SESSION_SUBAGENTS_MAX_RESPONSE_BYTES - SESSION_SUBAGENTS_RESPONSE_RESERVE_BYTES) / 4) * 3;
export interface SessionSubagentsOwner { nativeSessionId: string; epoch: string }
/** guard binds the registry ref, attached session generation and journal, not just id. */
export interface SessionSubagentTarget { id: string; sessionId: string; guard: string }
export type SessionSubagentStatus = "running" | "idle" | "parked" | "aborted";
export interface SessionSubagentRow {
  target: SessionSubagentTarget;
  displayName: string;
  status: SessionSubagentStatus;
  running: boolean;
  createdAt: number;
  lastActivity: number;
  activity?: string;
}
export type SessionSubagentsRequest =
  | { action: "list"; owner?: SessionSubagentsOwner }
  | { action: "transcript"; owner: SessionSubagentsOwner; target: SessionSubagentTarget }
  | { action: "validate"; owner: SessionSubagentsOwner; target: SessionSubagentTarget }
  | { action: "image"; owner: SessionSubagentsOwner; target: SessionSubagentTarget; nativeEntryId: string; blockIndex: number; source?: "generated" }
  | { action: "file"; owner: SessionSubagentsOwner; target: SessionSubagentTarget; path: string };
export type SessionSubagentsResult =
  | { action: "list"; owner: SessionSubagentsOwner; availability: "available" | "unavailable"; rows: SessionSubagentRow[]; omitted: number; reason?: string }
  | { action: "transcript"; owner: SessionSubagentsOwner; target: SessionSubagentTarget; availability: "available" | "missing" | "unavailable"; messages: TranscriptMessage[]; cwd?: string; truncated: boolean; reason?: string }
  | { action: "image"; owner: SessionSubagentsOwner; target: SessionSubagentTarget; image: { base64: string; mimeType: ImageAttachmentMimeType; bytes: number; sha256: string } }
  | { action: "file"; owner: SessionSubagentsOwner; target: SessionSubagentTarget; path: string; text: string; truncated: boolean }
  | { action: "validate"; owner: SessionSubagentsOwner; target: SessionSubagentTarget };
export interface SessionSubagentsEnvelope { protocolVersion: typeof SESSION_SUBAGENTS_PROTOCOL_VERSION; hostId: string; sessionId: string; result: SessionSubagentsResult }
export function sameSessionSubagentsOwner(a: SessionSubagentsOwner, b: SessionSubagentsOwner): boolean { return a.nativeSessionId === b.nativeSessionId && a.epoch === b.epoch; }
export function sameSessionSubagentTarget(a: SessionSubagentTarget, b: SessionSubagentTarget): boolean { return a.id === b.id && a.sessionId === b.sessionId && a.guard === b.guard; }

const STATUSES: readonly string[] = ["running", "idle", "parked", "aborted"];
const BASE64_MAX_CHARS = Math.ceil(SESSION_SUBAGENTS_MAX_IMAGE_BYTES / 3) * 4;
function invalid(field: string): never { throw new Error(`Invalid native subagents ${field}.`); }
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
function reason(value: unknown): string { const value_ = text(value, 4096); if (!value_.trim()) invalid("reason"); return value_; }
/** A child-relative file path: lexically inside the child cwd. The adapter still confines the real path. */
export function parseSessionSubagentFilePath(value: unknown): string {
  const path = text(value, SESSION_SUBAGENTS_MAX_PATH_CHARS);
  if (!path.length || /[\u0000-\u001f\u007f]/.test(path) || path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path)) invalid("file path");
  if (path.split(/[\\/]/).some(segment => segment === "..")) invalid("file path");
  return path;
}

export function parseSessionSubagentsOwner(value: unknown): SessionSubagentsOwner {
  const v = record(value, ["nativeSessionId", "epoch"]);
  return { nativeSessionId: identity(v.nativeSessionId), epoch: identity(v.epoch) };
}
export function parseSessionSubagentTarget(value: unknown): SessionSubagentTarget {
  const v = record(value, ["id", "sessionId", "guard"]);
  return { id: identity(v.id), sessionId: identity(v.sessionId), guard: identity(v.guard) };
}
export function parseSessionSubagentRow(value: unknown): SessionSubagentRow {
  const v = record(value, ["target", "displayName", "status", "running", "createdAt", "lastActivity", "activity"]);
  if (!STATUSES.includes(String(v.status))) invalid("status");
  const running = bool(v.running);
  // Native `running` is a corroborated flag on a running ref, never a fifth status.
  if (running && v.status !== "running") invalid("running state");
  return { target: parseSessionSubagentTarget(v.target), displayName: text(v.displayName, 500), status: v.status as SessionSubagentStatus, running,
    createdAt: count(v.createdAt), lastActivity: count(v.lastActivity), ...(v.activity === undefined ? {} : { activity: text(v.activity, 500) }) };
}
export function parseSessionSubagentsRequest(value: unknown): SessionSubagentsRequest {
  const v = record(value, ["action", "owner", "target", "nativeEntryId", "blockIndex", "source", "path"]);
  const only = (keys: readonly string[]) => { for (const key of Object.keys(v)) if (!keys.includes(key)) invalid(`${String(v.action)} fields`); };
  if (v.action === "list") {
    only(["action", "owner"]);
    return { action: "list", ...(v.owner === undefined ? {} : { owner: parseSessionSubagentsOwner(v.owner) }) };
  }
  if (v.action === "transcript" || v.action === "validate") {
    only(["action", "owner", "target"]);
    return { action: v.action, owner: parseSessionSubagentsOwner(v.owner), target: parseSessionSubagentTarget(v.target) };
  }
  if (v.action === "image") {
    only(["action", "owner", "target", "nativeEntryId", "blockIndex", "source"]);
    if (v.source !== undefined && v.source !== "generated") invalid("image source");
    return { action: "image", owner: parseSessionSubagentsOwner(v.owner), target: parseSessionSubagentTarget(v.target), nativeEntryId: identity(v.nativeEntryId), blockIndex: count(v.blockIndex),
      ...(v.source === undefined ? {} : { source: "generated" }) };
  }
  if (v.action !== "file") return invalid("action");
  only(["action", "owner", "target", "path"]);
  return { action: "file", owner: parseSessionSubagentsOwner(v.owner), target: parseSessionSubagentTarget(v.target), path: parseSessionSubagentFilePath(v.path) };
}
/** Transcript rows come from the host's own projection; only the identity shell is re-validated here. */
function transcriptMessage(value: unknown): TranscriptMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("message");
  const message = value as Record<string, unknown>;
  identity(message.id); text(message.role, 100); if (typeof message.text !== "string") invalid("message text");
  return message as unknown as TranscriptMessage;
}
export function parseSessionSubagentsResult(value: unknown): SessionSubagentsResult {
  const v = record(value, ["action", "owner", "target", "availability", "rows", "omitted", "reason", "messages", "cwd", "truncated", "image", "path", "text"]);
  const only = (keys: readonly string[]) => { for (const key of Object.keys(v)) if (!keys.includes(key)) invalid(`${String(v.action)} result`); };
  const owner = parseSessionSubagentsOwner(v.owner);
  if (v.action === "list") {
    only(["action", "owner", "availability", "rows", "omitted", "reason"]);
    const rows = list(v.rows, SESSION_SUBAGENTS_MAX_ROWS).map(parseSessionSubagentRow), omitted = count(v.omitted);
    const ids = new Set<string>();
    for (const row of rows) { if (ids.has(row.target.id)) invalid("duplicate row"); ids.add(row.target.id); }
    if (v.availability === "unavailable") {
      if (rows.length || omitted) invalid("unavailable rows");
      return { action: "list", owner, availability: "unavailable", rows, omitted, reason: reason(v.reason) };
    }
    if (v.availability !== "available" || v.reason !== undefined) invalid("availability");
    return { action: "list", owner, availability: "available", rows, omitted };
  }
  const target = parseSessionSubagentTarget(v.target);
  if (v.action === "transcript") {
    only(["action", "owner", "target", "availability", "messages", "cwd", "truncated", "reason"]);
    const messages = list(v.messages, 100_000).map(transcriptMessage), truncated = bool(v.truncated);
    const cwd = v.cwd === undefined ? undefined : identity(v.cwd, SESSION_SUBAGENTS_MAX_PATH_CHARS);
    if (v.availability === "missing" || v.availability === "unavailable") {
      if (messages.length || truncated || cwd !== undefined) invalid(`${v.availability} transcript`);
      return { action: "transcript", owner, target, availability: v.availability, messages, truncated, reason: reason(v.reason) };
    }
    if (v.availability !== "available" || v.reason !== undefined) invalid("availability");
    return { action: "transcript", owner, target, availability: "available", messages, ...(cwd === undefined ? {} : { cwd }), truncated };
  }
  if (v.action === "image") {
    only(["action", "owner", "target", "image"]);
    const i = record(v.image, ["base64", "mimeType", "bytes", "sha256"]);
    const base64 = text(i.base64, BASE64_MAX_CHARS), bytes = count(i.bytes), sha256 = text(i.sha256, 64);
    if (!base64.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) invalid("image data");
    if (!bytes || bytes > SESSION_SUBAGENTS_MAX_IMAGE_BYTES || Math.ceil(bytes / 3) * 4 !== base64.length) invalid("image size");
    if (!/^[a-f0-9]{64}$/.test(sha256)) invalid("image digest");
    if (!IMAGE_ATTACHMENT_MIME_TYPES.includes(i.mimeType as ImageAttachmentMimeType)) invalid("image type");
    return { action: "image", owner, target, image: { base64, mimeType: i.mimeType as ImageAttachmentMimeType, bytes, sha256 } };
  }
  if (v.action === "file") {
    only(["action", "owner", "target", "path", "text", "truncated"]);
    return { action: "file", owner, target, path: parseSessionSubagentFilePath(v.path), text: text(v.text, SESSION_SUBAGENTS_MAX_FILE_BYTES), truncated: bool(v.truncated) };
  }
  if (v.action !== "validate") return invalid("action");
  only(["action", "owner", "target"]);
  return { action: "validate", owner, target };
}
export function parseSessionSubagentsEnvelope(value: unknown, expectedHostId: string, expectedSessionId: string): SessionSubagentsEnvelope {
  const v = record(value, ["protocolVersion", "hostId", "sessionId", "result"]);
  if (v.protocolVersion !== SESSION_SUBAGENTS_PROTOCOL_VERSION) invalid("protocol");
  if (v.hostId !== expectedHostId || v.sessionId !== expectedSessionId) invalid("envelope owner");
  const result = parseSessionSubagentsResult(v.result);
  if (result.owner.nativeSessionId !== expectedSessionId) invalid("native owner");
  return { protocolVersion: SESSION_SUBAGENTS_PROTOCOL_VERSION, hostId: expectedHostId, sessionId: expectedSessionId, result };
}
/** A result answers exactly the request it was dispatched for: same action, the
 * requested owner when one was named, the requested child for every targeted read. */
export function assertSessionSubagentsResultMatches(request: SessionSubagentsRequest, result: SessionSubagentsResult): void {
  if (result.action !== request.action) invalid("result action");
  if (request.owner && !sameSessionSubagentsOwner(request.owner, result.owner)) invalid("result owner");
  if (request.action !== "list" && (result.action === "list" || !sameSessionSubagentTarget(request.target, result.target))) invalid("result target");
  if (request.action === "file" && (result.action !== "file" || result.path !== request.path)) invalid("result path");
}
