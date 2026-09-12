/** A mark refers to one host's durable activity cursor, not a wall-clock timestamp. */
export interface SessionReadMark { sequence: number; unread: boolean }
export type SessionReadKey = `session.read.${string}.${string}`;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const keyPattern = new RegExp(`^session\\.read\\.(${uuid})\\.(${uuid})$`);
export function isSessionReadKey(value: string): value is SessionReadKey { return keyPattern.test(value); }
export function sessionReadKey(hostId: string, sessionId: string): SessionReadKey {
  const key = `session.read.${hostId}.${sessionId}`;
  if (!isSessionReadKey(key)) throw new Error("Session read state requires the original host and session UUIDs.");
  return key;
}
export function parseSessionReadMark(value: unknown): SessionReadMark {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Invalid session read mark.");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => key !== "sequence" && key !== "unread") || !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 0 || typeof item.unread !== "boolean") throw new Error("Invalid session read mark.");
  return { sequence: item.sequence as number, unread: item.unread };
}
export function sessionHasUnreadActivity(sequence: number | undefined, mark: SessionReadMark | undefined): boolean {
  return Boolean(mark?.unread || (sequence ?? 0) > (mark?.sequence ?? 0));
}
/** Native OMP output/completion and requests, not title, model or catalog changes. */
export function isUnreadSessionEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const value = event as { type?: string; message?: { role?: string } };
  return value.type === "agent_end" || value.type === "extension_interaction_requested"
    || value.type === "message_end" && value.message?.role === "assistant";
}
