/** Project-scoped native daemon processes, distinct from session Jobs. A loaded
 * session authorizes access; each target additionally binds the original broker
 * incarnation and launch generation. No command, environment or credentials
 * are included in process rows. */
export const SESSION_PROCESSES_PROTOCOL_VERSION = 1 as const;
export const SESSION_PROCESSES_MAX_ROWS = 128;
export const SESSION_PROCESSES_MAX_LOG_CHARS = 65_536;
export const SESSION_PROCESSES_MAX_INPUT_CHARS = 8_192;

export interface SessionProcessesOwner { nativeSessionId: string; epoch: string; projectDir: string }
export interface SessionProcessTarget { brokerId: string; name: string; id: string; generation: number }
export type SessionProcessState = "starting" | "running" | "ready" | "restarting" | "stopping" | "exited" | "failed";
export interface SessionProcessRow {
  target: SessionProcessTarget;
  state: SessionProcessState;
  pid?: number;
  createdAt: number;
  startedAt: number;
  readyAt?: number;
  exitedAt?: number;
  exitCode?: number;
  restartCount: number;
  outputBytes: number;
  nativeOwner?: string;
  readyPending: ("log" | "port")[];
  persist: boolean;
  detached: boolean;
}
export interface SessionProcessesSnapshot { owner: SessionProcessesOwner; brokerId: string; rows: SessionProcessRow[] }
export type SessionProcessMutation =
  | { action: "stop" | "restart"; operationId: string; owner: SessionProcessesOwner; target: SessionProcessTarget }
  | { action: "input"; operationId: string; owner: SessionProcessesOwner; target: SessionProcessTarget; text: string };
export type SessionProcessesRequest =
  | { action: "read"; owner?: SessionProcessesOwner }
  | { action: "logs"; owner: SessionProcessesOwner; target: SessionProcessTarget }
  | SessionProcessMutation
  | { action: "receipt"; operationId: string };
/** Only a durable receipt confirms a mutation. Pending/unknown never authorize
 * automatic retry, target rebinding, or an assumption that nothing happened. */
export type SessionProcessReceipt = {
  operationId: string;
  action: SessionProcessMutation["action"];
  owner: SessionProcessesOwner;
  target: SessionProcessTarget;
} & (
  | { status: "pending" | "unknown" }
  | { status: "completed"; row: SessionProcessRow }
  | { status: "rejected"; message: string }
);
export type SessionProcessesResult =
  | { action: "read"; snapshot: SessionProcessesSnapshot }
  | { action: "logs"; owner: SessionProcessesOwner; target: SessionProcessTarget; text: string; truncated: boolean }
  | { action: "mutation"; receipt: SessionProcessReceipt }
  | { action: "receipt"; receipt: SessionProcessReceipt | null };
/** Worker responses are observations, never durable host receipts. */
export type SessionProcessNativeRequest = Exclude<SessionProcessesRequest, { action: "receipt" }>;
export type SessionProcessNativeReply = Extract<SessionProcessesResult, { action: "read" | "logs" }>
  | { action: "mutation"; row: SessionProcessRow };
export interface SessionProcessesEnvelope {
  protocolVersion: typeof SESSION_PROCESSES_PROTOCOL_VERSION;
  hostId: string;
  sessionId: string;
  result: SessionProcessesResult;
}

function invalid(field: string): never { throw new Error(`Invalid native processes ${field}.`); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(key);
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  return typeof value === "string" && value.length <= max ? value : invalid("text");
}
function identity(value: unknown, max = 200): string {
  const result = text(value, max);
  if (!result.length || /[\u0000-\u001f\u007f]/.test(result)) invalid("identity");
  return result;
}
function integer(value: unknown, min = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : invalid("integer");
}
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : invalid("boolean"); }
function list<T>(value: unknown, max: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) invalid("list");
  // Array.from visits holes: sparse caller-owned arrays cannot survive as null
  // after the request/receipt is serialized.
  return Array.from(value, parse);
}
function operationId(value: unknown): string {
  const result = identity(value, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/.test(result)) invalid("operation id");
  return result;
}
export function parseSessionProcessesOwner(value: unknown): SessionProcessesOwner {
  const v = record(value, ["nativeSessionId", "epoch", "projectDir"]);
  return { nativeSessionId: identity(v.nativeSessionId), epoch: identity(v.epoch), projectDir: identity(v.projectDir, 4096) };
}
export function parseSessionProcessTarget(value: unknown): SessionProcessTarget {
  const v = record(value, ["brokerId", "name", "id", "generation"]), name = identity(v.name, 48);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(name)) invalid("process name");
  return { brokerId: identity(v.brokerId), name, id: identity(v.id), generation: integer(v.generation) };
}
export function parseSessionProcessRow(value: unknown): SessionProcessRow {
  const v = record(value, ["target", "state", "pid", "createdAt", "startedAt", "readyAt", "exitedAt", "exitCode", "restartCount", "outputBytes", "nativeOwner", "readyPending", "persist", "detached"]);
  if (!["starting", "running", "ready", "restarting", "stopping", "exited", "failed"].includes(String(v.state))) invalid("state");
  const readyPending = list(v.readyPending, 2, item => item === "log" || item === "port" ? item : invalid("readiness"));
  if (new Set(readyPending).size !== readyPending.length || (readyPending.length && v.state !== "starting")) invalid("readiness state");
  return { target: parseSessionProcessTarget(v.target), state: v.state as SessionProcessState,
    createdAt: integer(v.createdAt), startedAt: integer(v.startedAt), restartCount: integer(v.restartCount), outputBytes: integer(v.outputBytes),
    ...(v.pid === undefined ? {} : { pid: integer(v.pid, 1) }),
    ...(v.readyAt === undefined ? {} : { readyAt: integer(v.readyAt) }),
    ...(v.exitedAt === undefined ? {} : { exitedAt: integer(v.exitedAt) }),
    ...(v.exitCode === undefined ? {} : { exitCode: integer(v.exitCode, -2_147_483_648) }),
    ...(v.nativeOwner === undefined ? {} : { nativeOwner: identity(v.nativeOwner, 1000) }),
    readyPending, persist: bool(v.persist), detached: bool(v.detached) };
}
export function parseSessionProcessesSnapshot(value: unknown): SessionProcessesSnapshot {
  const v = record(value, ["owner", "brokerId", "rows"]), brokerId = identity(v.brokerId);
  const rows = list(v.rows, SESSION_PROCESSES_MAX_ROWS, parseSessionProcessRow);
  if (rows.some(row => row.target.brokerId !== brokerId) || new Set(rows.map(row => row.target.name)).size !== rows.length) invalid("snapshot identity");
  return { owner: parseSessionProcessesOwner(v.owner), brokerId, rows };
}
export function parseSessionProcessesRequest(value: unknown): SessionProcessesRequest {
  const v = record(value, ["action", "owner", "target", "text", "operationId"]);
  if (v.action === "read") {
    if (v.target !== undefined || v.text !== undefined || v.operationId !== undefined) invalid("read fields");
    return { action: "read", ...(v.owner === undefined ? {} : { owner: parseSessionProcessesOwner(v.owner) }) };
  }
  if (v.action === "receipt") {
    if (v.target !== undefined || v.text !== undefined || v.owner !== undefined) invalid("receipt fields");
    return { action: "receipt", operationId: operationId(v.operationId) };
  }
  const owner = parseSessionProcessesOwner(v.owner), target = parseSessionProcessTarget(v.target);
  if (v.action === "logs") {
    if (v.text !== undefined || v.operationId !== undefined) invalid("logs fields");
    return { action: "logs", owner, target };
  }
  const id = operationId(v.operationId);
  if (v.action === "input") {
    const input = text(v.text, SESSION_PROCESSES_MAX_INPUT_CHARS);
    if (!input.length) invalid("empty input");
    return { action: "input", operationId: id, owner, target, text: input };
  }
  if ((v.action !== "stop" && v.action !== "restart") || v.text !== undefined) invalid("action");
  return { action: v.action, operationId: id, owner, target };
}
export function sameSessionProcessesOwner(a: SessionProcessesOwner, b: SessionProcessesOwner): boolean {
  return a.nativeSessionId === b.nativeSessionId && a.epoch === b.epoch && a.projectDir === b.projectDir;
}
export function sameSessionProcessTarget(a: SessionProcessTarget, b: SessionProcessTarget): boolean {
  return a.brokerId === b.brokerId && a.name === b.name && a.id === b.id && a.generation === b.generation;
}
export function parseSessionProcessReceipt(value: unknown): SessionProcessReceipt {
  const v = record(value, ["operationId", "action", "owner", "target", "status", "row", "message"]);
  if (v.action !== "stop" && v.action !== "restart" && v.action !== "input") invalid("receipt action");
  const base: Pick<SessionProcessReceipt, "operationId" | "action" | "owner" | "target"> = {
    operationId: operationId(v.operationId), action: v.action, owner: parseSessionProcessesOwner(v.owner), target: parseSessionProcessTarget(v.target),
  };
  if (v.status === "completed") {
    if (v.message !== undefined) invalid("completed fields");
    const row = parseSessionProcessRow(v.row), expected = { ...base.target, generation: base.target.generation + (v.action === "restart" ? 1 : 0) };
    if (!sameSessionProcessTarget(row.target, expected)) invalid("completed target");
    return { ...base, status: "completed", row };
  }
  if (v.row !== undefined) invalid("unconfirmed row");
  if (v.status === "rejected") return { ...base, status: "rejected", message: identity(v.message, 4096) };
  if ((v.status !== "pending" && v.status !== "unknown") || v.message !== undefined) invalid("receipt status");
  return { ...base, status: v.status };
}
export function parseSessionProcessesResult(value: unknown): SessionProcessesResult {
  const v = record(value, ["action", "snapshot", "owner", "target", "text", "truncated", "receipt"]);
  if (v.action === "read") {
    for (const key of ["owner", "target", "text", "truncated", "receipt"]) if (v[key] !== undefined) invalid("read result");
    return { action: "read", snapshot: parseSessionProcessesSnapshot(v.snapshot) };
  }
  if (v.snapshot !== undefined) invalid("result snapshot");
  if (v.action === "logs") {
    if (v.receipt !== undefined) invalid("logs receipt");
    return { action: "logs", owner: parseSessionProcessesOwner(v.owner), target: parseSessionProcessTarget(v.target), text: text(v.text, SESSION_PROCESSES_MAX_LOG_CHARS), truncated: bool(v.truncated) };
  }
  for (const key of ["owner", "target", "text", "truncated"]) if (v[key] !== undefined) invalid("receipt result");
  if (v.action === "receipt") return { action: "receipt", receipt: v.receipt === null ? null : parseSessionProcessReceipt(v.receipt) };
  if (v.action !== "mutation") invalid("result action");
  return { action: "mutation", receipt: parseSessionProcessReceipt(v.receipt) };
}
export function assertSessionProcessesResultMatches(request: SessionProcessesRequest, result: SessionProcessesResult): void {
  if (request.action === "read") {
    if (result.action !== "read" || (request.owner && !sameSessionProcessesOwner(request.owner, result.snapshot.owner))) invalid("read reply");
  } else if (request.action === "logs") {
    if (result.action !== "logs" || !sameSessionProcessesOwner(request.owner, result.owner) || !sameSessionProcessTarget(request.target, result.target)) invalid("logs reply");
  } else if (request.action === "receipt") {
    if (result.action !== "receipt" || (result.receipt && result.receipt.operationId !== request.operationId)) invalid("receipt reply");
  } else {
    if (result.action !== "mutation" || result.receipt.operationId !== request.operationId || result.receipt.action !== request.action
      || !sameSessionProcessesOwner(request.owner, result.receipt.owner) || !sameSessionProcessTarget(request.target, result.receipt.target)) invalid("mutation reply");
  }
}
export function parseSessionProcessesEnvelope(value: unknown, hostId: string, sessionId: string): SessionProcessesEnvelope {
  const v = record(value, ["protocolVersion", "hostId", "sessionId", "result"]);
  if (v.protocolVersion !== SESSION_PROCESSES_PROTOCOL_VERSION || v.hostId !== hostId || v.sessionId !== sessionId) invalid("envelope owner");
  const result = parseSessionProcessesResult(v.result);
  const owner = result.action === "read" ? result.snapshot.owner : result.action === "logs" ? result.owner : result.receipt?.owner;
  if (owner && owner.nativeSessionId !== sessionId) invalid("native owner");
  return { protocolVersion: SESSION_PROCESSES_PROTOCOL_VERSION, hostId, sessionId, result };
}

export function parseSessionProcessNativeReply(value: unknown, request: SessionProcessNativeRequest, sessionId: string): SessionProcessNativeReply {
  if (request.action === "stop" || request.action === "restart" || request.action === "input") {
    const v = record(value, ["action", "row"]);
    if (v.action !== "mutation" || request.owner.nativeSessionId !== sessionId) invalid("mutation reply");
    const row = parseSessionProcessRow(v.row), expected = { ...request.target, generation: request.target.generation + (request.action === "restart" ? 1 : 0) };
    if (!sameSessionProcessTarget(row.target, expected)) invalid("completed target");
    return { action: "mutation", row };
  }
  const result = parseSessionProcessesResult(value);
  assertSessionProcessesResultMatches(request, result);
  if (result.action !== "read" && result.action !== "logs") invalid("native reply");
  const owner = result.action === "read" ? result.snapshot.owner : result.owner;
  if (owner.nativeSessionId !== sessionId) throw new Error("The native process reply belongs to another session.");
  return result;
}
