import type { BrowserDocumentContext } from './browser-control';
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

export type BrowserMetadataAvailability =
  | { availability: "not-started"; reason: string }
  | { availability: "unavailable"; reason: string }
  | { availability: "running"; workerPid: number; tabs: NativeBrowserTabMetadata[] };

export type BrowserMetadataSnapshot = BrowserMetadataAvailability & {
  protocolVersion: typeof BROWSER_METADATA_PROTOCOL_VERSION;
  hostId: string;
  sessionId: string;
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
