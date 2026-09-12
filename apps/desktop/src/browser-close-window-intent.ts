import { browserCloseIdentity, parseBrowserCloseOwner, parseBrowserCloseRequest, parseBrowserCloseReceipt,
  type BrowserCloseOwner, type BrowserCloseRequest, type BrowserCloseReceipt } from "../../../packages/shared/src/browser-close";
import { draftBrowserDockTarget } from "./renderer/dock-state";
import type { DockPresentationRef } from "./renderer/dock-presentations";

/** Window-local recovery history. A saved presentation incarnation is never authority to remove a restored tab. */
export interface BrowserCloseWindowIntent {
  version: 1;
  hostId: string;
  owner: BrowserCloseOwner;
  source: DockPresentationRef;
  request: BrowserCloseRequest;
  receipt?: BrowserCloseReceipt;
}
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
export function parseBrowserCloseWindowIntent(value: unknown): BrowserCloseWindowIntent {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["version", "hostId", "owner", "source", "request", "receipt"].includes(key))) throw new Error("Invalid saved browser close intent.");
  const intent = value as BrowserCloseWindowIntent;
  const owner = parseBrowserCloseOwner(intent.owner), request = parseBrowserCloseRequest(intent.request);
  browserCloseIdentity(intent.hostId, owner, request);
  const source = intent.source, target = owner.kind === "session" ? `session:${owner.sessionId}` : draftBrowserDockTarget(owner.draftId);
  if (intent.version !== 1 || !source || typeof source !== "object" || Array.isArray(source)
    || Object.keys(source).some(key => !["tabId", "instanceId", "destination", "hostId", "target", "kind"].includes(key))
    || source.kind !== "browser" || source.hostId !== intent.hostId || source.target !== target
    || !["right", "bottom"].includes(source.destination) || !text(source.tabId, 8192) || !text(source.instanceId, 32768)) throw new Error("Saved close presentation does not match its original browser owner.");
  return { version: 1, hostId: intent.hostId, owner, request,
    source: { tabId: source.tabId, instanceId: source.instanceId, destination: source.destination, hostId: source.hostId, target: source.target, kind: "browser" },
    ...(intent.receipt === undefined ? {} : { receipt: parseBrowserCloseReceipt(intent.receipt, intent.hostId, owner, request) }) };
}
export function browserCloseIntentKey(intent: BrowserCloseWindowIntent): string {
  return JSON.stringify([intent.hostId, intent.owner.kind, intent.owner.kind === "session" ? intent.owner.sessionId : intent.owner.ownerId, intent.request.requestId]);
}
/** Never trim unresolved requests to fit. The existing complete window byte limit still applies. */
export function parseBrowserCloseWindowIntents(value: unknown): BrowserCloseWindowIntent[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Too many saved browser close requests.");
  const keys = new Set<string>();
  const intents: BrowserCloseWindowIntent[] = [];
  for (let index = 0; index < value.length; index++) {
    const intent = parseBrowserCloseWindowIntent(value[index]), key = browserCloseIntentKey(intent);
    if (keys.has(key)) throw new Error("Duplicate saved browser close request.");
    keys.add(key); intents.push(intent);
  }
  return intents;
}
