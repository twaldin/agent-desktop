import { BROWSER_FRAME_MAX_BYTES, jpegViewportDimensions, parseNativeBrowserFrame, type BrowserFrameTarget, type NativeBrowserFrame } from "@agent-desktop/shared";

interface NativeViewportCapture {
  name: unknown;
  ownerSessionId: unknown;
  targetId: unknown;
  data: unknown;
  url: unknown;
  title: unknown;
}

/** Project the native capture into the bounded cross-process frame contract. */
export function projectNativeBrowserFrame(value: unknown, target: BrowserFrameTarget, ownerSessionId: string): NativeBrowserFrame {
  if (!value || typeof value !== "object") throw new Error("Pinned native browser capture returned an invalid frame.");
  const capture = value as NativeViewportCapture;
  if (capture.ownerSessionId !== ownerSessionId || capture.name !== target.name || capture.targetId !== target.targetId
    || !(capture.data instanceof Uint8Array) || capture.data.byteLength === 0 || capture.data.byteLength > BROWSER_FRAME_MAX_BYTES) {
    throw new Error("Pinned native browser capture returned an invalid owner, target, or payload.");
  }
  const dimensions = jpegViewportDimensions(capture.data);
  const frame = {
    name: target.name, targetId: target.targetId, capturedAt: Date.now(), mimeType: "image/jpeg" as const,
    data: Buffer.from(capture.data).toString("base64"), ...dimensions, url: capture.url, title: capture.title,
  };
  return parseNativeBrowserFrame(frame, target);
}
