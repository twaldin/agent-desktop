import type { NativeTerminalInfo, NativeTerminalResult } from "./terminals";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type TerminalTarget = { projectId: string } | { sessionId: string };
export interface TerminalCreationRequest {
  version: 1;
  requestId: string;
  controlEpoch: string;
  target: TerminalTarget;
  cols: number;
  rows: number;
}
export type TerminalCreationReceipt =
  | { outcome: "completed"; terminalId: string }
  | { outcome: "not-submitted" | "unknown"; terminalId: string; message: string };
export type TerminalCreationObservation =
  | { status: "unavailable" }
  | { status: "pending"; terminalId: string }
  | { status: "settled"; receipt: TerminalCreationReceipt };

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))) throw new Error("Invalid terminal creation fields.");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new Error("Terminal creation requires a UUID identity.");
  return value;
}
function dimension(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65535)
    throw new Error("Invalid terminal creation dimensions.");
  return value as number;
}
/** Exact requested dimensions are bound before the native manager clamps them. */
export function parseTerminalCreationRequest(value: unknown): TerminalCreationRequest {
  const r = object(value, ["version", "requestId", "controlEpoch", "target", "cols", "rows"]);
  if (r.version !== 1) throw new Error("Unsupported terminal creation version.");
  const target = object(r.target, ["projectId", "sessionId"]);
  if (Object.keys(target).length !== 1) throw new Error("One terminal creation target is required.");
  return { version: 1, requestId: id(r.requestId), controlEpoch: id(r.controlEpoch),
    target: "projectId" in target ? { projectId: id(target.projectId) } : { sessionId: id(target.sessionId) },
    cols: dimension(r.cols), rows: dimension(r.rows) };
}
export function parseTerminalCreationReceipt(value: unknown, terminalId: string): TerminalCreationReceipt {
  const r = object(value, ["outcome", "terminalId", "message"]);
  if (id(r.terminalId) !== terminalId) throw new Error("Terminal receipt differs from its reserved identity.");
  if (r.outcome === "completed") {
    if (r.message !== undefined) throw new Error("Invalid terminal completion receipt.");
    return { outcome: "completed", terminalId };
  }
  if ((r.outcome !== "unknown" && r.outcome !== "not-submitted")
    || typeof r.message !== "string" || !r.message.trim() || r.message.length > 4096)
    throw new Error("Invalid terminal creation outcome.");
  return { outcome: r.outcome, terminalId, message: r.message };
}


export interface TerminalCreationCapabilities { version: 1; hostId: string; controlEpoch: string }
/** Recovery metadata is a bounded identity/state projection, not an attachment
 * lease or a complete validation of the native terminal catalogue. */
export interface TerminalCreationMetadata {
  id: string;
  target: TerminalTarget;
  cwd: string;
  protocol: "tmux-v1";
  serverGeneration: string;
  status: NativeTerminalInfo["status"];
  attachable?: boolean;
}
export type TerminalCreationResponse = { version: 1; hostId: string; requestId: string } & TerminalCreationObservation & { terminal?: TerminalCreationMetadata };

export function parseTerminalCreationCapabilities(value: unknown, hostId: string): TerminalCreationCapabilities {
  id(hostId);
  const r = object(value, ["version", "hostId", "controlEpoch"]);
  if (r.version !== 1 || r.hostId !== hostId) throw new Error("Terminal creation capability belongs to another host or version.");
  return { version: 1, hostId, controlEpoch: id(r.controlEpoch) };
}
export function parseTerminalCreationResponse(value: unknown, hostId: string, request: TerminalCreationRequest): TerminalCreationResponse {
  id(hostId);
  const input = parseTerminalCreationRequest(request);
  const r = object(value, ["version", "hostId", "requestId", "status", "terminalId", "receipt", "terminal"]);
  if (r.version !== 1 || r.hostId !== hostId || r.requestId !== input.requestId)
    throw new Error("Terminal creation response owner or request does not match.");
  const base = { version: 1 as const, hostId, requestId: input.requestId };
  let observation: TerminalCreationObservation;
  if (r.status === "unavailable") {
    if (r.receipt !== undefined || r.terminalId !== undefined || r.terminal !== undefined) throw new Error("Unavailable terminal request contains a result.");
    return { ...base, status: "unavailable" };
  } else if (r.status === "pending") {
    if (r.receipt !== undefined) throw new Error("Pending terminal request contains a receipt.");
    observation = { status: "pending", terminalId: id(r.terminalId) };
  } else if (r.status === "settled") {
    if (r.terminalId !== undefined) throw new Error("Settled terminal request contains a second identity.");
    const receipt = object(r.receipt, ["outcome", "terminalId", "message"]);
    observation = { status: "settled", receipt: parseTerminalCreationReceipt(receipt, id(receipt.terminalId)) };
  } else throw new Error("Invalid terminal creation status.");
  let terminal: TerminalCreationMetadata | undefined;
  if (r.terminal !== undefined) {
    if (!r.terminal || typeof r.terminal !== "object" || Array.isArray(r.terminal)) throw new Error("Invalid terminal recovery metadata.");
    const t = r.terminal as Record<string, unknown>, expectedId = observation.status === "pending" ? observation.terminalId : observation.receipt.terminalId;
    const target = object(t.target, ["projectId", "sessionId"]);
    if (Object.keys(target).length !== 1 || ("projectId" in input.target ? target.projectId !== input.target.projectId : target.sessionId !== input.target.sessionId)
      || t.id !== expectedId || t.protocol !== "tmux-v1" || typeof t.cwd !== "string" || !t.cwd.startsWith("/") || t.cwd.length > 16384 || t.cwd.includes("\0")
      || typeof t.status !== "string" || !["starting", "running", "closing", "exited", "error", "interrupted"].includes(t.status)
      || t.attachable !== undefined && typeof t.attachable !== "boolean"
      || t.attachable === true && t.status !== "running" && t.status !== "exited") throw new Error("Terminal recovery metadata does not match the reserved target.");
    terminal = { id: expectedId, target: input.target, cwd: t.cwd, protocol: "tmux-v1", serverGeneration: id(t.serverGeneration), status: t.status as NativeTerminalInfo["status"],
      ...(t.attachable === undefined ? {} : { attachable: t.attachable as boolean }) };
  }
  return { ...base, ...observation, ...(terminal ? { terminal } : {}) };
}
export interface TerminalCreationBridge {
  getTerminalCreationCapabilities(hostId: string): Promise<NativeTerminalResult<TerminalCreationCapabilities>>;
  createNativeTerminal(request: TerminalCreationRequest, hostId: string): Promise<NativeTerminalResult<TerminalCreationResponse>>;
  observeTerminalCreation(request: TerminalCreationRequest, hostId: string): Promise<NativeTerminalResult<TerminalCreationResponse>>;
}
