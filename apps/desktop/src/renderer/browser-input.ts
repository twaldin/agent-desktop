import type { BrowserDocumentContext } from "../../../../packages/shared/src/protocol";

export interface BrowserImageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Maps a pointer in the rendered JPEG to viewport coordinates for its capture. */
export function framePoint(
  rect: BrowserImageRect,
  context: BrowserDocumentContext,
  clientX: number,
  clientY: number,
) {
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    context.width <= 0 ||
    context.height <= 0
  )
    return;

  const x = ((clientX - rect.left) * context.width) / rect.width;
  const y = ((clientY - rect.top) * context.height) / rect.height;
  // The native protocol accepts viewport coordinates only. Never clamp a point
  // from a letterbox margin or the image's exclusive right/bottom edge.
  if (x < 0 || y < 0 || x >= context.width || y >= context.height) return;
  return { x, y };
}
