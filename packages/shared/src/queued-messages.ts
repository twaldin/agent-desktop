export type NativeQueuedMessageLane = "steer" | "follow-up";
export const NATIVE_QUEUED_MESSAGES_PROTOCOL_VERSION = 1;
export const NATIVE_QUEUED_MESSAGES_OWNER_HEADER = "X-Agent-Queue-Host-Id";

/**
 * A live OMP queue identity. `id` is stable only for the lifetime of the owning
 * worker and must always be paired with the snapshot revision.
 */
export interface NativeQueuedMessage {
  id: string;
  lane: NativeQueuedMessageLane;
  text: string;
  imageCount: number;
  position: number;
  ownership: "desktop-pending" | "native";
  editable: boolean;
  removable: boolean;
  promotable: boolean;
}

export interface NativeQueuedMessagesSnapshot {
  revision: number;
  streaming: boolean;
  messages: NativeQueuedMessage[];
}

export type NativeQueuedMessageMutation =
  | { type: "remove"; expectedRevision: number; messageId: string }
  | { type: "reorder"; expectedRevision: number; messageIds: string[] }
  | { type: "promote"; expectedRevision: number; messageId: string };

export interface NativeQueuedMessageMutationReceipt {
  type: "native-queued-messages";
  mutation: NativeQueuedMessageMutation["type"];
  messageId?: string;
  snapshot: NativeQueuedMessagesSnapshot;
}

export interface NativeQueuedMessagesResponse extends NativeQueuedMessagesSnapshot {
  protocolVersion: typeof NATIVE_QUEUED_MESSAGES_PROTOCOL_VERSION;
  hostId: string;
  sessionId: string;
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, label: string, max = 500_000): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new Error(`Invalid ${label}`);
  return value;
};
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Invalid queued-message revision");
  return Number(value);
};

export function parseNativeQueuedMessageMutation(value: unknown): NativeQueuedMessageMutation {
  const input = record(value, "queued-message mutation");
  const type = input.type;
  const expectedRevision = revision(input.expectedRevision);
  if (type === "remove" || type === "promote") return { type, expectedRevision,
    messageId: text(input.messageId, "queued-message identity", 200) };
  if (type === "reorder") {
    if (!Array.isArray(input.messageIds) || input.messageIds.length > 256) throw new Error("Invalid queued-message order");
    const messageIds: string[] = [];
    for (let index = 0; index < input.messageIds.length; index++) {
      if (!Object.hasOwn(input.messageIds, index)) throw new Error("Invalid queued-message order");
      messageIds.push(text(input.messageIds[index], "queued-message identity", 200));
    }
    if (new Set(messageIds).size !== messageIds.length) throw new Error("Duplicate queued-message identity");
    return { type, expectedRevision, messageIds };
  }
  throw new Error("Unknown queued-message mutation");
}

export function parseNativeQueuedMessagesSnapshot(value: unknown): NativeQueuedMessagesSnapshot {
  const input = record(value, "queued-message snapshot");
  if (typeof input.streaming !== "boolean" || !Array.isArray(input.messages) || input.messages.length > 256)
    throw new Error("Invalid queued-message snapshot");
  const messages: NativeQueuedMessage[] = [];
  for (let index = 0; index < input.messages.length; index++) {
    if (!Object.hasOwn(input.messages, index)) throw new Error("Invalid queued-message snapshot");
    const value = input.messages[index];
    const item = record(value, "queued message");
    if ((item.lane !== "steer" && item.lane !== "follow-up") || (item.ownership !== "desktop-pending" && item.ownership !== "native")
      || typeof item.text !== "string" || item.text.length > 500_000 || !Number.isSafeInteger(item.imageCount) || Number(item.imageCount) < 0
      || item.position !== index || typeof item.editable !== "boolean" || typeof item.removable !== "boolean" || typeof item.promotable !== "boolean")
      throw new Error("Invalid queued message");
    messages.push({ id: text(item.id, "queued-message identity", 200), lane: item.lane, text: item.text,
      imageCount: Number(item.imageCount), position: index, ownership: item.ownership,
      editable: item.editable, removable: item.removable, promotable: item.promotable });
  }
  if (new Set(messages.map(message => message.id)).size !== messages.length) throw new Error("Duplicate queued-message identity");
  return { revision: revision(input.revision), streaming: input.streaming, messages };
}
