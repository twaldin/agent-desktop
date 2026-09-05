import { IMAGE_ATTACHMENT_MIME_TYPES, MAX_IMAGE_ATTACHMENT_BYTES, parseImageAttachments, type DesktopBridge, type ImageAttachmentMimeType, type ImageAttachmentRef, type RecordedImageBytes } from "@agent-desktop/shared";
import type { AttachmentCache } from "./attachment-cache";

export interface AttachmentMediaContext {
  bridge: Pick<DesktopBridge, "getImageAttachment" | "getTranscriptImage">;
  cache: AttachmentCache;
}
export type AttachmentMediaSource =
  | { kind: "attachment"; attachment: ImageAttachmentRef }
  | { kind: "transcript"; sessionId: string; nativeEntryId: string; blockIndex: number; sha256?: string; mimeType?: string; bytes?: number };
export interface AttachmentMedia { blob: Blob; sha256: string; mimeType: ImageAttachmentMimeType; bytes: number }

export function attachmentSourceKey(source: AttachmentMediaSource): string {
  return source.kind === "attachment" ? JSON.stringify([source.kind, source.attachment]) : JSON.stringify([source.kind, source.sessionId, source.nativeEntryId, source.blockIndex, source.sha256, source.mimeType, source.bytes]);
}
function validateMetadata(value: { sha256?: string; mimeType?: string; bytes?: number }) {
  if (value.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("Invalid image identity.");
  if (value.mimeType !== undefined && !IMAGE_ATTACHMENT_MIME_TYPES.includes(value.mimeType as ImageAttachmentMimeType)) throw new Error("Unsupported image type.");
  if (value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_IMAGE_ATTACHMENT_BYTES)) throw new Error("Invalid image size.");
}

/** Every lookup names the owning host and immutable hash or exact native block. No URL inputs. */
export async function loadAttachmentMedia(media: AttachmentMediaContext, source: AttachmentMediaSource, hostId: string, connected: boolean): Promise<AttachmentMedia> {
  source = structuredClone(source);
  const expected = source.kind === "attachment" ? parseImageAttachments([source.attachment], hostId)[0]! : source;
  validateMetadata(expected);
  if (source.kind === "transcript" && (!source.sessionId || !source.nativeEntryId || !Number.isSafeInteger(source.blockIndex) || source.blockIndex < 0)) throw new Error("This image has no durable native entry yet.");
  if (expected.sha256 && expected.mimeType) {
    const blob = await media.cache.get({ hostId, sha256: expected.sha256 });
    if (blob) {
      if (expected.bytes !== undefined && blob.size !== expected.bytes) throw new Error("Cached image size differs from its saved metadata.");
      return { blob: blob.slice(0, blob.size, expected.mimeType), sha256: expected.sha256, mimeType: expected.mimeType as ImageAttachmentMimeType, bytes: blob.size };
    }
  }
  if (!connected) throw new Error("This image is not cached on this device. Reconnect to its owning host to load it.");
  let recorded: RecordedImageBytes;
  if (source.kind === "attachment") {
    if (!media.bridge.getImageAttachment) throw new Error("Update this desktop to load attached images.");
    recorded = await media.bridge.getImageAttachment(source.attachment.sha256, hostId);
  } else {
    if (!media.bridge.getTranscriptImage) throw new Error("Update this desktop to load native transcript images.");
    recorded = await media.bridge.getTranscriptImage(source.sessionId, source.nativeEntryId, source.blockIndex, hostId);
  }
  validateMetadata(recorded);
  if (!(recorded.data instanceof Uint8Array) || recorded.data.byteLength !== recorded.bytes || !recorded.sha256 || !recorded.mimeType
    || expected.sha256 !== undefined && recorded.sha256 !== expected.sha256 || expected.mimeType !== undefined && recorded.mimeType !== expected.mimeType
    || expected.bytes !== undefined && recorded.bytes !== expected.bytes) throw new Error("The host image differs from its saved metadata.");
  recorded = { ...recorded, data: new Uint8Array(recorded.data) };
  // The cache verifies the actual bytes before committing and surfaces failed writes.
  await media.cache.put({ hostId, sha256: recorded.sha256 }, recorded.data);
  return { blob: new Blob([new Uint8Array(recorded.data)], { type: recorded.mimeType }), sha256: recorded.sha256, mimeType: recorded.mimeType, bytes: recorded.bytes };
}

export function formatImageBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
