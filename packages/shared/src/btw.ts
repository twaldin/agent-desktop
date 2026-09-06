export type NativeBtwStatus = "running" | "complete" | "cancelled" | "failed";

export interface NativeBtwSnapshot {
  runId: string;
  sessionId: string;
  question: string;
  status: NativeBtwStatus;
  answer: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

export interface NativeBtwStart {
  runId: string;
  question: string;
}

export const BTW_PROTOCOL_VERSION = 1 as const;
export const BTW_OWNER_HEADER = "X-Agent-Host-Id";

/** Match the pinned native /btw parser: the slash must be the first byte and
 * command spelling is case-sensitive. Native trims the remaining question. */
export function nativeBtwQuestion(text: string): string | undefined {
  if (!/^\/btw(?:\s+|$)/.test(text)) return undefined;
  return text.slice("/btw".length).trim();
}

export interface NativeBtwResponse {
  protocolVersion: typeof BTW_PROTOCOL_VERSION;
  hostId: string;
  sessionId: string;
  value: NativeBtwSnapshot | null;
  /** Start receipts atomically consume an exact submitted draft revision. */
  draftConsumption?: true;
  unavailable?: string;
}

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const text = (value: unknown, label: string, maxBytes: number): string => {
  if (typeof value !== "string" || !value || bytes(value) > maxBytes) throw new Error(`Invalid native btw ${label}.`);
  return value;
};
const timestamp = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid native btw timestamp.");
  return value;
};

export function parseNativeBtwSnapshot(value: unknown): NativeBtwSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native btw snapshot.");
  const source = value as Record<string, unknown>;
  if (!(["running", "complete", "cancelled", "failed"] as unknown[]).includes(source.status)) throw new Error("Invalid native btw status.");
  const result: NativeBtwSnapshot = {
    runId: text(source.runId, "run identity", 200), sessionId: text(source.sessionId, "session identity", 200),
    question: text(source.question, "question", 32 * 1024), status: source.status as NativeBtwStatus,
    answer: typeof source.answer === "string" && bytes(source.answer) <= 1024 * 1024 ? source.answer : (() => { throw new Error("Invalid native btw answer."); })(),
    startedAt: timestamp(source.startedAt), updatedAt: timestamp(source.updatedAt),
  };
  if (result.updatedAt < result.startedAt) throw new Error("Invalid native btw update time.");
  if (source.error !== undefined) result.error = text(source.error, "error", 4 * 1024);
  if (result.status === "failed" && !result.error) throw new Error("Failed native btw snapshots require an error.");
  if (result.status !== "failed" && result.error !== undefined) throw new Error("Only failed native btw snapshots may contain an error.");
  return result;
}

export function parseNativeBtwResponse(value: unknown, owner: { hostId: string; sessionId: string }): NativeBtwResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native btw response.");
  const source = value as Record<string, unknown>;
  if (source.protocolVersion !== BTW_PROTOCOL_VERSION || source.hostId !== owner.hostId || source.sessionId !== owner.sessionId) {
    throw new Error("Native btw response ownership or protocol changed.");
  }
  const snapshot = source.value === null ? null : parseNativeBtwSnapshot(source.value);
  if (snapshot && snapshot.sessionId !== owner.sessionId) throw new Error("Native btw snapshot belongs to another session.");
  const unavailable = source.unavailable === undefined ? undefined : text(source.unavailable, "unavailable reason", 4 * 1024);
  if (source.draftConsumption !== undefined && source.draftConsumption !== true) throw new Error('Invalid native btw draft capability.');
  return { protocolVersion: BTW_PROTOCOL_VERSION, hostId: owner.hostId, sessionId: owner.sessionId, value: snapshot, ...(unavailable ? { unavailable } : {}), ...(source.draftConsumption ? { draftConsumption: true } : {}) };
}
