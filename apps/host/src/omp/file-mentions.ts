import { readNativeImage, type OmpRecordedImage } from "./images";

const SKIPPED_REASONS = new Set(["tooLarge", "binary"]);

type FileMentionFile = {
  path: string;
  content: string;
  lineCount?: number;
  byteSize?: number;
  skippedReason?: "tooLarge" | "binary";
  image?: unknown;
};

type FileMentionRecord = { role: "fileMention"; files: FileMentionFile[]; timestamp: number };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nativeFile(value: unknown): FileMentionFile | undefined {
  const file = record(value);
  if (!file || typeof file.path !== "string" || typeof file.content !== "string") return undefined;
  if (file.path.length === 0 || file.path.length > 32_768 || /[\x00-\x1f\x7f]/.test(file.path)) return undefined;
  if (file.lineCount !== undefined && !nonNegativeInteger(file.lineCount)) return undefined;
  if (file.byteSize !== undefined && !nonNegativeInteger(file.byteSize)) return undefined;
  if (file.skippedReason !== undefined && (typeof file.skippedReason !== "string" || !SKIPPED_REASONS.has(file.skippedReason))) return undefined;
  if (file.image !== undefined) {
    const image = record(file.image);
    if (!image || image.type !== "image" || typeof image.mimeType !== "string") return undefined;
  }
  return file as unknown as FileMentionFile;
}

function nativeMessage(value: unknown): FileMentionRecord | undefined {
  const message = record(value);
  if (!message || message.role !== "fileMention" || !Array.isArray(message.files) || !finiteTimestamp(message.timestamp)) return undefined;
  const files = Array.from(message.files, nativeFile);
  if (files.some(file => file === undefined)) return undefined;
  return { role: "fileMention", files: files as FileMentionFile[], timestamp: message.timestamp };
}

/** Display-safe metadata for native file mentions; image bytes and native extras are deliberately omitted. */
export const projectFileMentions = (value: unknown) => {
  const message = nativeMessage(value);
  if (!message) return undefined;
  const files = message.files.map((file, blockIndex) => {
    let image: { blockIndex: number; mimeType: string; bytes?: number; sha256?: string; error?: string } | undefined;
    if (file.image !== undefined) {
      try {
        const native = readNativeImage(file.image);
        image = { blockIndex, mimeType: native.mimeType, bytes: native.bytes, sha256: native.sha256 };
      } catch (error) {
        const nativeImage = record(file.image)!;
        image = { blockIndex, mimeType: nativeImage.mimeType as string,
          error: error instanceof Error ? error.message : "Native image bytes are unavailable" };
      }
    }
    return Object.freeze({
      path: file.path,
      content: file.content,
      ...(file.lineCount === undefined ? {} : { lineCount: file.lineCount }),
      ...(file.byteSize === undefined ? {} : { byteSize: file.byteSize }),
      ...(file.skippedReason === undefined ? {} : { skippedReason: file.skippedReason }),
      ...(image === undefined ? {} : { image: Object.freeze(image) }),
    });
  });
  return Object.freeze(files);
};

export type NativeFileReference = NonNullable<ReturnType<typeof projectFileMentions>>[number];

/** Resolve one native image by its original file index, retaining the native image bytes for admission. */
export function lookupFileMentionImage(value: unknown, index: number): OmpRecordedImage | undefined {
  const message = nativeMessage(value);
  if (!message || !Number.isSafeInteger(index) || index < 0 || index >= message.files.length) return undefined;
  const image = message.files[index]?.image;
  if (image === undefined) return undefined;
  try { return readNativeImage(image); } catch { return undefined; }
}
