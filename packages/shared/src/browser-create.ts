import type { NativeBrowserTabMetadata } from "./browser";
import { parseBrowserNavigationUrl } from "./browser-control";

export const BROWSER_CREATE_PROTOCOL_VERSION = 1 as const;
export const BROWSER_CREATE_MAX_AGE_MS = 60_000;

export interface BrowserCreationTicket {
  controlEpoch: string;
  observedAt: number;
}

export interface BrowserCreateRequest extends BrowserCreationTicket {
  requestId: string;
  /** Explicit user navigation during native acquisition, never a pristine-state marker. */
  initialUrl?: string;
}

interface BrowserCreateReceiptBase {
  protocolVersion: typeof BROWSER_CREATE_PROTOCOL_VERSION;
  hostId: string;
  sessionId: string;
  requestId: string;
}

export type BrowserCreateReceipt =
  | BrowserCreateReceiptBase & {
      outcome: "completed";
      workerPid: number;
      tab: NativeBrowserTabMetadata;
      targetDisposition: "created-page" | "created-surface" | "adopted-existing-target";
    }
  | BrowserCreateReceiptBase & {
      outcome: "rejected" | "unknown";
      message: string;
      workerPid?: number;
    };

/** Observation of admission history, never permission to replay a missing request
 * or a claim that a previously acquired native target remains alive. */
export type BrowserCreateObservation = BrowserCreateReceiptBase & (
  | { status: "pending" | "unavailable" }
  | { status: "settled"; receipt: BrowserCreateReceipt }
);

const identity = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value);

export function parseBrowserCreationTicket(value: unknown): BrowserCreationTicket {
  if (!value || typeof value !== "object") throw new Error("Missing browser creation ticket.");
  const ticket = value as BrowserCreationTicket;
  if (!identity(ticket.controlEpoch) || !Number.isSafeInteger(ticket.observedAt) || ticket.observedAt <= 0) {
    throw new Error("Invalid browser creation ticket.");
  }
  return { controlEpoch: ticket.controlEpoch, observedAt: ticket.observedAt };
}

export function parseBrowserCreateRequest(value: unknown): BrowserCreateRequest {
  if (!value || typeof value !== "object") throw new Error("Missing browser creation request.");
  const request = value as BrowserCreateRequest;
  if (!identity(request.requestId)) throw new Error("Invalid browser creation request identity.");
  return { requestId: request.requestId, ...parseBrowserCreationTicket(request),
    ...(request.initialUrl === undefined ? {} : { initialUrl: parseBrowserNavigationUrl(request.initialUrl) }) };
}
