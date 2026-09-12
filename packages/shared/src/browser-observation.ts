import { parseBrowserCloseOwner, type BrowserCloseOwner } from "./browser-close";
import { validBrowserFrameTarget } from "./browser-frame";
import type { BrowserFrameTarget } from "./browser";

/** The owner identity is shared with close; observation grants no close authority. */
export type BrowserObservationOwner = BrowserCloseOwner;
export interface BrowserTargetObservation extends BrowserFrameTarget {
  protocolVersion: 1;
  hostId: string;
  owner: BrowserObservationOwner;
  ownerId: string;
  kindTag: "headless" | "spawned" | "connected" | "relay" | "cmux";
  presence: "present" | "absent";
}
/** Desktop transport availability, not native support or physical-close authority. */
export interface BrowserObservationBridge {
  inspect(owner: BrowserObservationOwner, target: BrowserFrameTarget, hostId: string): Promise<BrowserTargetObservation>;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid browser observation fields.");
  return value as Record<string, unknown>;
}
export function parseBrowserObservationOwner(value: unknown): BrowserObservationOwner {
  return parseBrowserCloseOwner(value);
}
export function parseBrowserObservationTarget(value: unknown): BrowserFrameTarget {
  object(value, ["workerPid", "name", "targetId"]);
  if (!validBrowserFrameTarget(value)) throw new Error("Choose the original browser observation target.");
  return { workerPid: value.workerPid, name: value.name, targetId: value.targetId };
}
export function parseBrowserTargetObservation(value: unknown, hostId: string, owner: BrowserObservationOwner, target: BrowserFrameTarget): BrowserTargetObservation {
  if (typeof hostId !== "string" || !hostId || hostId.length > 200 || /[\u0000-\u001f\u007f]/.test(hostId)) throw new Error("Invalid browser observation host.");
  const source = object(value, ["protocolVersion", "hostId", "owner", "workerPid", "name", "targetId", "ownerId", "kindTag", "presence"]);
  const original = parseBrowserObservationOwner(owner), received = parseBrowserObservationOwner(source.owner), input = parseBrowserObservationTarget(target);
  if (source.protocolVersion !== 1 || source.hostId !== hostId || JSON.stringify(received) !== JSON.stringify(original)
    || source.workerPid !== input.workerPid || source.name !== input.name || source.targetId !== input.targetId
    || source.ownerId !== (original.kind === "session" ? original.sessionId : original.ownerId)
    || !["headless", "spawned", "connected", "relay", "cmux"].includes(source.kindTag as string)
    || source.presence !== "present" && source.presence !== "absent" || source.kindTag === "cmux" && source.presence === "absent") {
    throw new Error("Browser observation changed its original owner, target, protocol or supported presence.");
  }
  return { protocolVersion: 1, hostId, owner: original, ...input, ownerId: source.ownerId as string,
    kindTag: source.kindTag as BrowserTargetObservation["kindTag"], presence: source.presence };
}
