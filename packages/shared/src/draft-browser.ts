import { parseNativeBrowserTabMetadata, type NativeBrowserTabMetadata, type BrowserMetadataAvailability, type NativeBrowserFrame, type BrowserFrameTarget } from "./browser";
import type { BrowserCreateRequest, BrowserCreationTicket } from "./browser-create";
import type { BrowserControlRequest, BrowserControlReceipt } from "./browser-control";
import type { BrowserHistoryRequest, BrowserHistoryResult } from "./browser-history";
import type { BrowserAutocompleteRequest, BrowserAutocompleteResult } from "./browser-autocomplete";

export interface DraftBrowserReceiptIdentity {
  protocolVersion: 1;
  ownerKind: "draft";
  hostId: string;
  ownerId: string;
  requestId: string;
}
export type DraftBrowserCreationReceipt = DraftBrowserReceiptIdentity & (
  | { outcome: "completed"; workerPid: number; tab: NativeBrowserTabMetadata; targetDisposition: "created-page" | "created-surface" | "adopted-existing-target" }
  | { outcome: "rejected" | "unknown"; message: string; workerPid?: number }
);
export type DraftBrowserCreationObservation = DraftBrowserReceiptIdentity & (
  | { status: "pending" | "unavailable" }
  | { status: "settled"; receipt: DraftBrowserCreationReceipt }
);
export function parseDraftBrowserCreationReceipt(input: unknown, base: DraftBrowserReceiptIdentity): DraftBrowserCreationReceipt {
  const value = input as DraftBrowserCreationReceipt;
  if (!value || value.protocolVersion !== 1 || value.ownerKind !== "draft" || value.hostId !== base.hostId
    || value.ownerId !== base.ownerId || value.requestId !== base.requestId) throw new Error("Draft browser receipt does not match its owner/request");
  if (value.workerPid !== undefined && (!Number.isSafeInteger(value.workerPid) || value.workerPid <= 0)) throw new Error("Invalid draft browser worker PID");
  if (value.outcome === "unknown" || value.outcome === "rejected") {
    if (typeof value.message !== "string" || !value.message || value.message.length > 4096) throw new Error("Invalid draft browser outcome message");
    return { ...base, outcome: value.outcome, message: value.message, ...(value.workerPid === undefined ? {} : { workerPid: value.workerPid }) };
  }
  if (value.outcome !== "completed" || value.workerPid === undefined) throw new Error("Invalid draft browser completion");
  const tab = parseNativeBrowserTabMetadata(value.tab);
  const targetDisposition = tab.kindTag === "headless" ? "created-page" : tab.kindTag === "cmux" ? "created-surface" : "adopted-existing-target";
  if (tab.state !== "alive" || tab.name !== `desktop-${base.requestId}` || value.targetDisposition !== targetDisposition) throw new Error("Draft browser target does not match its request");
  return { ...base, outcome: "completed", workerPid: value.workerPid, tab, targetDisposition };
}

export interface DraftBrowserOwnerReference { ownerId: string; draftId: string; draftRevision: number }
export interface DraftBrowserOwnerSnapshot {
  protocolVersion: 1; hostId: string; ownerId: string;
  state: "absent" | "starting" | "ready" | "unavailable" | "retired";
  workerPid?: number; error?: string; ticket: BrowserCreationTicket;
}
export interface DraftBrowserIdentity { protocolVersion: 1; ownerKind: "draft"; hostId: string; ownerId: string }
export type DraftBrowserMetadataSnapshot = DraftBrowserIdentity & BrowserMetadataAvailability & { controlEpoch?: string };
export type DraftBrowserFrameSnapshot = DraftBrowserIdentity & NativeBrowserFrame & { workerPid: number; controlEpoch: string };
export type DraftBrowserControlReceipt = DraftBrowserIdentity & Omit<BrowserControlReceipt, "hostId" | "sessionId">;

/** Original durable draft binding, captured before asynchronous host selection. */
export function parseDraftBrowserOwnerReference(value: unknown): DraftBrowserOwnerReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Select the original draft browser owner.");
  const ref = value as DraftBrowserOwnerReference;
  const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v);
  if (!id(ref.ownerId) || !id(ref.draftId) || !Number.isSafeInteger(ref.draftRevision) || ref.draftRevision <= 0) throw new Error("Select the original draft browser owner.");
  return { ownerId: ref.ownerId, draftId: ref.draftId, draftRevision: ref.draftRevision };
}

/** Credentials and directory records stay in main/the owning host. Presence is
 * desktop transport support, not host capability or first-Send restoration. */
export interface DraftBrowserBridge {
  acquire(reference: DraftBrowserOwnerReference, hostId: string): Promise<DraftBrowserOwnerSnapshot>;
  status(reference: DraftBrowserOwnerReference, hostId: string): Promise<DraftBrowserOwnerSnapshot>;
  retire(reference: DraftBrowserOwnerReference, hostId: string): Promise<DraftBrowserOwnerSnapshot>;
  create(reference: DraftBrowserOwnerReference, request: BrowserCreateRequest, hostId: string): Promise<DraftBrowserCreationReceipt>;
  creationStatus(reference: DraftBrowserOwnerReference, request: BrowserCreateRequest, hostId: string): Promise<DraftBrowserCreationObservation>;
  metadata(reference: DraftBrowserOwnerReference, hostId: string): Promise<DraftBrowserMetadataSnapshot>;
  history?(reference: DraftBrowserOwnerReference, request: BrowserHistoryRequest, hostId: string): Promise<BrowserHistoryResult>;
  autocomplete?(reference: DraftBrowserOwnerReference, request: BrowserAutocompleteRequest, hostId: string): Promise<BrowserAutocompleteResult>;
  frame(reference: DraftBrowserOwnerReference, target: BrowserFrameTarget, hostId: string): Promise<DraftBrowserFrameSnapshot>;
  control(reference: DraftBrowserOwnerReference, request: BrowserControlRequest, hostId: string): Promise<DraftBrowserControlReceipt>;
}
