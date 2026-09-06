import type { BrowserDocumentContext } from './browser-control';
import type { BrowserCreationTicket } from "./browser-create";
/** Read-only native OMP browser metadata. Browser handles, debugger endpoints,
 * cookies, profiles, frames, and control operations never cross this contract. */
export const BROWSER_METADATA_PROTOCOL_VERSION = 1 as const;
export const BROWSER_METADATA_OWNER_HEADER = "x-agent-desktop-browser-owner";

export interface NativeBrowserTabMetadata {
  name: string;
  targetId: string;
  backend: "worker" | "cmux";
  kindTag: "headless" | "spawned" | "connected" | "relay" | "cmux";
  state: "alive" | "dead";
  url: string;
  title?: string;
  viewport: { width: number; height: number; deviceScaleFactor?: number };
}

const browserText = (value: unknown, limit: number, allowEmpty = false): value is string =>
  typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= limit && !value.includes("\0");
const browserNumber = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;

/** Project one native tab to the bounded metadata allowed across worker IPC. */
export function parseNativeBrowserTabMetadata(value: unknown): NativeBrowserTabMetadata {
  if (!value || typeof value !== "object") throw new Error("Invalid native browser tab metadata.");
  const source = value as Record<string, unknown>;
  const viewport = source.viewport;
  if (!browserText(source.name, 200) || !browserText(source.targetId, 200) || !browserText(source.url, 8_192)
    || (source.backend !== "worker" && source.backend !== "cmux")
    || !["headless", "spawned", "connected", "relay", "cmux"].includes(String(source.kindTag))
    || (source.state !== "alive" && source.state !== "dead")
    || (source.title !== undefined && !browserText(source.title, 1_024, true))
    || !viewport || typeof viewport !== "object") throw new Error("Invalid native browser tab metadata.");
  const size = viewport as Record<string, unknown>;
  if (!browserNumber(size.width, 1, 16_384) || !browserNumber(size.height, 1, 16_384)
    || (size.width as number) * (size.height as number) > 32_000_000
    || (size.deviceScaleFactor !== undefined && !browserNumber(size.deviceScaleFactor, Number.MIN_VALUE, 100))) {
    throw new Error("Invalid native browser tab viewport.");
  }
  return {
    name: source.name,
    targetId: source.targetId,
    backend: source.backend,
    kindTag: source.kindTag as NativeBrowserTabMetadata["kindTag"],
    state: source.state,
    url: source.url,
    ...(source.title === undefined ? {} : { title: source.title as string }),
    viewport: {
      width: size.width as number,
      height: size.height as number,
      ...(size.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: size.deviceScaleFactor as number }),
    },
  };
}

export type BrowserMetadataAvailability =
  | { availability: "not-started"; reason: string }
  | { availability: "unavailable"; reason: string }
  | { availability: "running"; workerPid: number; tabs: NativeBrowserTabMetadata[] };

export type BrowserMetadataSnapshot = BrowserMetadataAvailability & {
  protocolVersion: typeof BROWSER_METADATA_PROTOCOL_VERSION;
  hostId: string;
  sessionId: string;
  creationTicket?: BrowserCreationTicket;
};

/** An exact live native target; a name or URL alone is never sufficient. */
export interface BrowserFrameTarget {
  workerPid: number;
  name: string;
  targetId: string;
}

export const BROWSER_FRAME_PROTOCOL_VERSION = 1 as const;
export const BROWSER_FRAME_MAX_BYTES = 8 * 1024 * 1024;

/** Current viewport capture only. This is not a video stream or an input API. */
export interface NativeBrowserFrame {
  name: string;
  targetId: string;
  capturedAt: number;
  context?: BrowserDocumentContext;
  mimeType: "image/jpeg";
  data: string;
  width: number;
  height: number;
  url: string;
  title: string;
}

export interface BrowserFrameSnapshot extends NativeBrowserFrame {
  controlEpoch?: string;
  protocolVersion: typeof BROWSER_FRAME_PROTOCOL_VERSION;
  hostId: string;
  sessionId: string;
  workerPid: number;
}
