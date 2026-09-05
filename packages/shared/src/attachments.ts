/** Application ingress limits; provider limits and native normalization are separate. */
export const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_BATCH_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_ATTACHMENT_PIXELS = 16_777_216;
/** Byte transfers bind a cached network origin to the selected durable host. */
export const IMAGE_ATTACHMENT_OWNER_HEADER = "X-Agent-Host-Id";
export const IMAGE_ATTACHMENT_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageAttachmentMimeType = typeof IMAGE_ATTACHMENT_MIME_TYPES[number];

export interface ImageAttachmentCapabilities {
  protocolVersion: 1;
  commandVersion: 3;
  maxImages: number;
  maxImageBytes: number;
  maxBatchBytes: number;
  maxImagePixels: number;
  mimeTypes: readonly ImageAttachmentMimeType[];
}

export interface UploadedImageMetadata {
  sha256: string;
  bytes: number;
  mimeType: ImageAttachmentMimeType;
  width: number;
  height: number;
}

export interface RecordedImageBytes {
  data: Uint8Array;
  sha256: string;
  bytes: number;
  mimeType: ImageAttachmentMimeType;
}

/** Metadata only. Original bytes stay in the owning host's attachment store. */
export interface ImageAttachmentRef {
  id: string;
  hostId: string;
  kind: "image";
  sha256: string;
  name: string;
  bytes: number;
  mimeType: ImageAttachmentMimeType;
}

export interface DraftConsumption {
  commandId: string;
  submittedRevision: number;
}

const referenceKeys = new Set(["id", "hostId", "kind", "sha256", "name", "bytes", "mimeType"]);
const boundedText = (value: unknown, maximum: number) => typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");

/** Copy and validate transport/cache metadata; this does not establish that bytes exist. */
export function parseImageAttachments(value: unknown, expectedHostId?: string): ImageAttachmentRef[] {
  if (!Array.isArray(value) || value.length > MAX_IMAGE_ATTACHMENTS) throw new Error(`A draft supports at most ${MAX_IMAGE_ATTACHMENTS} images.`);
  const ids = new Set<string>();
  let total = 0;
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !referenceKeys.has(key))) throw new Error("Invalid image attachment metadata.");
    const item = raw as Record<string, unknown>;
    if (!boundedText(item.id, 200) || !boundedText(item.hostId, 200) || !boundedText(item.name, 500)
      || item.kind !== "image" || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)
      || !Number.isSafeInteger(item.bytes) || (item.bytes as number) <= 0 || (item.bytes as number) > MAX_IMAGE_ATTACHMENT_BYTES
      || !IMAGE_ATTACHMENT_MIME_TYPES.includes(item.mimeType as ImageAttachmentMimeType)) throw new Error("Invalid image attachment metadata.");
    if (expectedHostId !== undefined && item.hostId !== expectedHostId) throw new Error("The image belongs to another host.");
    if (ids.has(item.id as string)) throw new Error("Image attachment identities must be distinct.");
    ids.add(item.id as string);
    total += item.bytes as number;
    if (total > MAX_IMAGE_ATTACHMENT_BATCH_BYTES) throw new Error("Attached images exceed the 20 MiB total limit.");
    return { id: item.id as string, hostId: item.hostId as string, kind: "image", sha256: item.sha256,
      name: item.name as string, bytes: item.bytes as number, mimeType: item.mimeType as ImageAttachmentMimeType };
  });
}

export function sameImageAttachments(left?: readonly ImageAttachmentRef[], right?: readonly ImageAttachmentRef[]): boolean {
  // Presence is a persistent protocol marker, including after the final chip is removed.
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((a, index) => {
    const b = right[index]!;
    return a.id === b.id && a.hostId === b.hostId && a.kind === b.kind && a.sha256 === b.sha256
      && a.name === b.name && a.bytes === b.bytes && a.mimeType === b.mimeType;
  });
}
