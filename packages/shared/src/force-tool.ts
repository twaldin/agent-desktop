export type ForceToolTicket = { epoch: string; revision: number };
export type ForceToolAvailability = {
  state: "supported" | "degraded" | "unsupported";
  reason: string;
  thinkingNote?: string;
};
export type ForceToolDirective = {
  id: string;
  toolName: string;
  commandId?: string;
  phase: "pending-tool" | "tool-in-flight" | "pending-final-response" | "final-response-in-flight";
  requeued: boolean;
};
export type ForceToolState = ForceToolTicket & {
  nativeSessionId: string;
  model: { provider: string; id: string; api: string } | null;
  availability: ForceToolAvailability;
  tools: Array<{ name: string; available: boolean; reason?: string }>;
  directives: ForceToolDirective[];
  canArm: boolean;
  canCancel: boolean;
  busyReason?: string;
};
export type ForceToolReceipt = {
  commandId: string;
  epoch: string;
  directiveId?: string;
  /** Empty only for a definite not-armed native usage refusal with no tool argument. */
  toolName: string;
  arm: "not-armed" | "armed" | "unknown";
  prompt: "not-requested" | "recorded" | "not-recorded" | "unknown";
  promptEntryId?: string;
  message?: string;
};
export type ForceToolJournalReceipt = {
  commandId: string;
  state: "pending" | "succeeded" | "failed" | "unknown" | "absent";
  forceToolReceipt?: ForceToolReceipt;
};
export type ForceToolRecovery = { epoch: string; expectedRevision: number; directiveId: string };
export type ForceToolGuard = { epoch: string; expectedRevision: number; toolName: string };
export type ForceToolCancel = { sessionId: string; ticket: ForceToolTicket; directiveId: string };
export type ForceToolCancelResult = { state: ForceToolState; cancelledDirectiveId: string };
export type ForceToolResponse = {
  protocolVersion: 1;
  hostId: string;
  sessionId: string;
  value: ForceToolState | null;
  unavailable?: string;
  receipt?: ForceToolJournalReceipt;
};
export const SESSION_FORCE_TOOL_OWNER_HEADER = "X-Agent-Force-Tool-Host-Id";

const encoder = new TextEncoder();
const invalid = (field: string): never => { throw new Error(`Invalid native force-tool ${field}.`); };
const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("object");
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid("keys");
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 1024, empty = false): string => {
  if (typeof value !== "string" || (!empty && !value.length) || value.includes("\0") || encoder.encode(value).byteLength > max) return invalid("text");
  return value;
};
const id = (value: unknown): string => text(value, 200);
export function parseForceToolCommandId(value: unknown): string {
  const result = id(value);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) return invalid("command identity");
  return result;
}
const revision = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid("revision");
  return value;
};
const bool = (value: unknown): boolean => typeof value === "boolean" ? value : invalid("boolean");
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T => {
  if (typeof value !== "string" || !values.includes(value as T)) return invalid("state");
  return value as T;
};
const optionalText = (key: string, value: unknown, max = 4096): Record<string, string> => value === undefined ? {} : { [key]: text(value, max) };
const list = <T>(value: unknown, max: number, parse: (value: unknown) => T, identity: (value: T) => string): T[] => {
  if (!Array.isArray(value) || value.length > max) return invalid("list");
  const seen = new Set<string>();
  return Array.from(value, entry => {
    const parsed = parse(entry), key = identity(parsed);
    if (seen.has(key)) return invalid("duplicate identity");
    seen.add(key);
    return parsed;
  });
};
export function parseForceToolTicket(value: unknown): ForceToolTicket {
  const input = record(value, ["epoch", "revision"]);
  return { epoch: id(input.epoch), revision: revision(input.revision) };
}
export function parseForceToolGuard(value: unknown): ForceToolGuard {
  const input = record(value, ["epoch", "expectedRevision", "toolName"]);
  return { epoch: id(input.epoch), expectedRevision: revision(input.expectedRevision), toolName: text(input.toolName) };
}
export function parseForceToolRecovery(value: unknown): ForceToolRecovery {
  const input = record(value, ["epoch", "expectedRevision", "directiveId"]);
  return { epoch: id(input.epoch), expectedRevision: revision(input.expectedRevision), directiveId: id(input.directiveId) };
}
/** The existing prompt parser uses this before admitting either operation. */
export function parseForceToolPromptFields(input: { forceTool?: unknown; forceRecovery?: unknown }): { forceTool?: ForceToolGuard; forceRecovery?: ForceToolRecovery } {
  if (input.forceTool !== undefined && input.forceRecovery !== undefined) return invalid("mutually exclusive prompt operations");
  return { ...(input.forceTool === undefined ? {} : { forceTool: parseForceToolGuard(input.forceTool) }),
    ...(input.forceRecovery === undefined ? {} : { forceRecovery: parseForceToolRecovery(input.forceRecovery) }) };
}
export function parseForceToolState(value: unknown): ForceToolState {
  const input = record(value, ["epoch", "revision", "nativeSessionId", "model", "availability", "tools", "directives", "canArm", "canCancel", "busyReason"]);
  const availability = record(input.availability, ["state", "reason", "thinkingNote"]);
  const availabilityState = oneOf(availability.state, ["supported", "degraded", "unsupported"] as const);
  const model = input.model === null ? null : record(input.model, ["provider", "id", "api"]);
  const tools = list(input.tools, 16384, value => {
    const tool = record(value, ["name", "available", "reason"]);
    return { name: text(tool.name), available: bool(tool.available), ...optionalText("reason", tool.reason) };
  }, tool => tool.name);
  const commandIds = new Set<string>();
  const directives = list(input.directives, 4096, value => {
    const directive = record(value, ["id", "toolName", "commandId", "phase", "requeued"]);
    const commandId = directive.commandId === undefined ? undefined : parseForceToolCommandId(directive.commandId);
    if (commandId !== undefined) {
      if (commandIds.has(commandId)) return invalid("duplicate command identity");
      commandIds.add(commandId);
    }
    return { id: id(directive.id), toolName: text(directive.toolName), ...(commandId === undefined ? {} : { commandId }),
      phase: oneOf(directive.phase, ["pending-tool", "tool-in-flight", "pending-final-response", "final-response-in-flight"] as const), requeued: bool(directive.requeued) };
  }, directive => directive.id);
  const result: ForceToolState = {
    epoch: id(input.epoch), revision: revision(input.revision), nativeSessionId: id(input.nativeSessionId),
    model: model === null ? null : { provider: text(model.provider), id: text(model.id), api: text(model.api) },
    availability: { state: availabilityState, reason: text(availability.reason, 4096, availabilityState === "supported"), ...optionalText("thinkingNote", availability.thinkingNote) },
    tools, directives, canArm: bool(input.canArm), canCancel: bool(input.canCancel), ...optionalText("busyReason", input.busyReason),
  };
  // Degraded native-accepted routes remain armable. Pending directives can
  // outlive a model/tool change; do not demand membership in today's registry.
  if (result.canArm && (!result.model || availabilityState === "unsupported" || !tools.some(tool => tool.available) || result.busyReason)) return invalid("arm availability");
  if (result.canCancel && (result.busyReason || !directives.some(directive => directive.phase === "pending-tool" || directive.phase === "pending-final-response"))) return invalid("cancel availability");
  return result;
}
export function parseForceToolReceipt(value: unknown, commandId?: string): ForceToolReceipt {
  const input = record(value, ["commandId", "epoch", "directiveId", "toolName", "arm", "prompt", "promptEntryId", "message"]);
  const parsedId = parseForceToolCommandId(input.commandId);
  if (commandId !== undefined && parsedId !== parseForceToolCommandId(commandId)) return invalid("receipt command owner");
  const result: ForceToolReceipt = { commandId: parsedId, epoch: id(input.epoch), toolName: text(input.toolName, 1024, input.arm === "not-armed"),
    arm: oneOf(input.arm, ["not-armed", "armed", "unknown"] as const), prompt: oneOf(input.prompt, ["not-requested", "recorded", "not-recorded", "unknown"] as const),
    ...optionalText("directiveId", input.directiveId, 200), ...optionalText("promptEntryId", input.promptEntryId, 200), ...optionalText("message", input.message) };
  if ((result.arm === "armed" && !result.directiveId) || (result.arm === "not-armed" && result.directiveId)) return invalid("arm receipt consistency");
  if (result.prompt === "recorded" && result.promptEntryId === undefined
    || result.promptEntryId !== undefined && result.prompt !== "recorded" && result.prompt !== "unknown") return invalid("prompt receipt consistency");
  if (result.arm === "not-armed" && result.prompt === "recorded") return invalid("unarmed prompt receipt");
  return result;
}
export function parseForceToolJournalReceipt(value: unknown, commandId: string): ForceToolJournalReceipt {
  const input = record(value, ["commandId", "state", "forceToolReceipt"]);
  if (parseForceToolCommandId(input.commandId) !== parseForceToolCommandId(commandId)) return invalid("journal command owner");
  const state = oneOf(input.state, ["pending", "succeeded", "failed", "unknown", "absent"] as const);
  const receipt = input.forceToolReceipt === undefined ? undefined : parseForceToolReceipt(input.forceToolReceipt, commandId);
  if (state === "absent" && receipt) return invalid("absent journal receipt");
  if (state === "succeeded" && receipt && (receipt.arm !== "armed" || !["recorded", "not-requested"].includes(receipt.prompt))) return invalid("successful journal receipt");
  return { commandId, state, ...(receipt === undefined ? {} : { forceToolReceipt: receipt }) };
}
export function parseForceToolCancel(value: unknown): ForceToolCancel {
  const input = record(value, ["sessionId", "ticket", "directiveId"]);
  return { sessionId: id(input.sessionId), ticket: parseForceToolTicket(input.ticket), directiveId: id(input.directiveId) };
}
export function parseForceToolCancelResult(value: unknown): ForceToolCancelResult {
  const input = record(value, ["state", "cancelledDirectiveId"]);
  const state = parseForceToolState(input.state), cancelledDirectiveId = id(input.cancelledDirectiveId);
  if (state.directives.some(directive => directive.id === cancelledDirectiveId)) return invalid("cancelled directive still present");
  return { state, cancelledDirectiveId };
}
export function parseForceToolResponse(value: unknown, hostId: string, sessionId: string, commandId?: string): ForceToolResponse {
  const input = record(value, ["protocolVersion", "hostId", "sessionId", "value", "unavailable", "receipt"]);
  if (input.protocolVersion !== 1 || id(input.hostId) !== id(hostId) || id(input.sessionId) !== id(sessionId)) return invalid("response owner");
  if (commandId === undefined && input.receipt !== undefined) return invalid("unsolicited journal receipt");
  const receipt = commandId === undefined ? undefined : parseForceToolJournalReceipt(input.receipt, commandId);
  const live = input.value === null ? null : parseForceToolState(input.value);
  if ((live === null) !== (input.unavailable !== undefined)) return invalid("live availability");
  return { protocolVersion: 1, hostId, sessionId, value: live, ...optionalText("unavailable", input.unavailable), ...(receipt === undefined ? {} : { receipt }) };
}
