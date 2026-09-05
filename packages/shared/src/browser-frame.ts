import { BROWSER_FRAME_MAX_BYTES, type BrowserFrameTarget, type NativeBrowserFrame } from "./browser";

const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("\0");
export function validBrowserFrameTarget(value: unknown): value is BrowserFrameTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as BrowserFrameTarget;
  return Number.isSafeInteger(target.workerPid) && target.workerPid > 0 && identity(target.name) && identity(target.targetId);
}

/** Read dimensions from the JPEG frame header without decoding a large bitmap. */
export function jpegViewportDimensions(bytes: Uint8Array): { width: number; height: number } {
  const invalid = () => new Error("The browser returned an invalid or oversized JPEG viewport.");
  if (bytes.length < 12 || bytes.length > BROWSER_FRAME_MAX_BYTES || bytes[0] !== 255 || bytes[1] !== 216
    || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw invalid();
  let offset = 2;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 255) throw invalid();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 218 || marker === 217) break;
    if (marker === 0 || marker === 216 || marker === 1 || (marker >= 208 && marker <= 215)) throw invalid();
    if (offset + 2 > bytes.length) throw invalid();
    const size = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (size < 2 || offset + size > bytes.length - 2) throw invalid();
    if (marker === 192 || marker === 193 || marker === 194) {
      if (size < 11 || bytes[offset + 2] !== 8) throw invalid();
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const components = bytes[offset + 7]!;
      if (components < 1 || components > 4 || size !== 8 + components * 3
        || !width || !height || width > 16_384 || height > 16_384 || width * height > 32_000_000) throw invalid();
      return { width, height };
    }
    offset += size;
  }
  throw invalid();
}

/** Reconstruct only the bounded fields allowed to cross into desktop chrome. */
export function parseNativeBrowserFrame(value: unknown, target: BrowserFrameTarget): NativeBrowserFrame {
  if (!validBrowserFrameTarget(target) || !value || typeof value !== "object") throw new Error("Invalid browser viewport response.");
  const frame = value as NativeBrowserFrame;
  if (frame.name !== target.name || frame.targetId !== target.targetId || frame.mimeType !== "image/jpeg"
    || !Number.isSafeInteger(frame.capturedAt) || frame.capturedAt <= 0
    || typeof frame.url !== "string" || frame.url.length > 8192 || !frame.url.length
    || typeof frame.title !== "string" || frame.title.length > 1024
    || typeof frame.data !== "string" || frame.data.length > Math.ceil(BROWSER_FRAME_MAX_BYTES / 3) * 4
    || frame.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)) throw new Error("Invalid browser viewport fields or target identity.");
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(frame.data), character => character.charCodeAt(0)); }
  catch { throw new Error("Invalid browser viewport encoding."); }
  const size = jpegViewportDimensions(bytes);
  if (size.width !== frame.width || size.height !== frame.height) throw new Error("Browser viewport dimensions do not match its image.");
  return { name: target.name, targetId: target.targetId, capturedAt: frame.capturedAt, mimeType: "image/jpeg", data: frame.data,
    ...size, url: frame.url, title: frame.title };
}
