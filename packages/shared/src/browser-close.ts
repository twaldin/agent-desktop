import { parseBrowserCreationTicket } from "./browser-create";
import { validBrowserFrameTarget } from "./browser-frame";
import type { BrowserFrameTarget } from "./browser";

export type BrowserCloseOwner = { kind: "session"; sessionId: string }
  | { kind: "draft"; ownerId: string; draftId: string; draftRevision: number };
export interface BrowserCloseRequest {
  requestId: string;
  controlEpoch: string;
  observedAt: number;
  target: BrowserFrameTarget;
}
interface CloseIdentity {
  protocolVersion: 1;
  hostId: string;
  owner: BrowserCloseOwner;
  requestId: string;
  target: BrowserFrameTarget;
}
export type BrowserCloseReceipt = CloseIdentity & (
  { outcome: "completed"; released: true } | { outcome: "rejected" | "unknown"; message: string }
);
export type BrowserCloseObservation = CloseIdentity & (
  { status: "unavailable" | "pending" } | { status: "settled"; receipt: BrowserCloseReceipt }
);
/** Presence means desktop transport support, not native host close readiness. */
export interface BrowserCloseBridge {
  close(owner: BrowserCloseOwner, request: BrowserCloseRequest, hostId: string): Promise<BrowserCloseReceipt>;
  status(owner: BrowserCloseOwner, request: BrowserCloseRequest, hostId: string): Promise<BrowserCloseObservation>;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid browser close fields.");
  return value as Record<string, unknown>;
}
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
export function parseBrowserCloseOwner(value: unknown): BrowserCloseOwner {
  const owner = object(value, ["kind", "sessionId", "ownerId", "draftId", "draftRevision"]);
  if (owner.kind === "session" && identity(owner.sessionId) && Object.keys(owner).length === 2) return { kind: "session", sessionId: owner.sessionId };
  if (owner.kind === "draft" && identity(owner.ownerId) && identity(owner.draftId) && Number.isSafeInteger(owner.draftRevision) && (owner.draftRevision as number) > 0 && Object.keys(owner).length === 4) {
    return { kind: "draft", ownerId: owner.ownerId, draftId: owner.draftId, draftRevision: owner.draftRevision as number };
  }
  throw new Error("Invalid browser close owner.");
}
export function parseBrowserCloseRequest(value: unknown): BrowserCloseRequest {
  const request = object(value, ["requestId", "controlEpoch", "observedAt", "target"]);
  if (typeof request.requestId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(request.requestId)) throw new Error("Invalid browser close request identity.");
  const ticket = parseBrowserCreationTicket({ controlEpoch: request.controlEpoch, observedAt: request.observedAt });
  object(request.target, ["workerPid", "name", "targetId"]);
  if (!validBrowserFrameTarget(request.target)) throw new Error("Invalid browser close target.");
  return { requestId: request.requestId, ...ticket, target: { workerPid: request.target.workerPid, name: request.target.name, targetId: request.target.targetId } };
}
export function browserCloseIdentity(hostId: string, owner: BrowserCloseOwner, request: BrowserCloseRequest): CloseIdentity {
  if (!identity(hostId)) throw new Error("Invalid browser close host.");
  const parsed = parseBrowserCloseRequest(request);
  return { protocolVersion: 1, hostId, owner: parseBrowserCloseOwner(owner), requestId: parsed.requestId, target: parsed.target };
}
function requireIdentity(receipt: Record<string, unknown>, base: CloseIdentity): void {
  object(receipt.target, ["workerPid", "name", "targetId"]);
  if (receipt.protocolVersion !== 1 || receipt.hostId !== base.hostId || receipt.requestId !== base.requestId
    || JSON.stringify(parseBrowserCloseOwner(receipt.owner)) !== JSON.stringify(base.owner)
    || !validBrowserFrameTarget(receipt.target) || receipt.target.workerPid !== base.target.workerPid
    || receipt.target.name !== base.target.name || receipt.target.targetId !== base.target.targetId) throw new Error("Browser close receipt identity changed.");
}
/** Only an exact original owner/PID/name/target confirmation can be completed. */
export function parseBrowserCloseReceipt(value: unknown, hostId: string, owner: BrowserCloseOwner, request: BrowserCloseRequest): BrowserCloseReceipt {
  const receipt = object(value, ["protocolVersion", "hostId", "owner", "requestId", "target", "outcome", "released", "message"]);
  const base = browserCloseIdentity(hostId, owner, request);
  requireIdentity(receipt, base);
  if (receipt.outcome === "completed" && receipt.released === true && receipt.message === undefined) return { ...base, outcome: "completed", released: true };
  if ((receipt.outcome === "unknown" || receipt.outcome === "rejected") && receipt.released === undefined
    && typeof receipt.message === "string" && receipt.message.length > 0 && receipt.message.length <= 4096) return { ...base, outcome: receipt.outcome, message: receipt.message };
  throw new Error("Invalid browser close outcome.");
}
export function parseBrowserCloseObservation(value: unknown, hostId: string, owner: BrowserCloseOwner, request: BrowserCloseRequest): BrowserCloseObservation {
  const observation = object(value, ["protocolVersion", "hostId", "owner", "requestId", "target", "status", "receipt"]);
  const base = browserCloseIdentity(hostId, owner, request);
  requireIdentity(observation, base);
  if (observation.status === "settled") return { ...base, status: "settled", receipt: parseBrowserCloseReceipt(observation.receipt, hostId, owner, request) };
  if ((observation.status === "unavailable" || observation.status === "pending") && observation.receipt === undefined) return { ...base, status: observation.status };
  throw new Error("Invalid browser close observation.");
}
