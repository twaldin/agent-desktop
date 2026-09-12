import { parseTerminalCreationRequest, type TerminalCreationRequest } from "@agent-desktop/shared";
import { dockTabId } from "./renderer/dock-state";

/** A saved request is unresolved, never proof of dispatch or permission to repeat
 * it. Native receipt history belongs to the owning host, not this window list. */
export interface TerminalWindowIntent {
  version: 1;
  hostId: string;
  request: TerminalCreationRequest;
  source: { kind: "dock"; destination: "right" | "bottom" } | {
    kind: "browser"; tabId: string; browserInstanceId: string; title: string; draft?: string;
  };
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new Error("Invalid terminal window intent fields.");
  return value as Record<string, unknown>;
}
export function parseTerminalWindowIntent(value: unknown): TerminalWindowIntent {
  const r = object(value, ["version", "hostId", "request", "source"]);
  if (r.version !== 1 || typeof r.hostId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.hostId))
    throw new Error("Invalid terminal intent owner or version.");
  const request = parseTerminalCreationRequest(r.request), base = { version: 1 as const, hostId: r.hostId, request };
  const source = object(r.source, ["kind", "destination", "tabId", "browserInstanceId", "title", "draft"]);
  if (source.kind === "dock") {
    if ((source.destination !== "right" && source.destination !== "bottom") || Object.keys(source).some(key => key !== "kind" && key !== "destination"))
      throw new Error("Invalid terminal dock origin.");
    return { ...base, source: { kind: "dock", destination: source.destination } };
  }
  if (source.kind !== "browser" || !("sessionId" in request.target) || source.destination !== undefined
    || typeof source.browserInstanceId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(source.browserInstanceId)
    || typeof source.title !== "string" || !source.title || source.title.length > 1000 || source.title.includes("\0")
    || source.draft !== undefined && (typeof source.draft !== "string" || source.draft.length > 8192 || source.draft.includes("\0")))
    throw new Error("Invalid terminal browser origin.");
  const expectedId = dockTabId({ kind: "browser", hostId: r.hostId, target: `session:${request.target.sessionId}`, browserInstanceId: source.browserInstanceId });
  if (source.tabId !== expectedId) throw new Error("Terminal intent source does not match its owner.");
  return { ...base, source: { kind: "browser", tabId: expectedId, browserInstanceId: source.browserInstanceId, title: source.title,
    ...(source.draft === undefined ? {} : { draft: source.draft as string }) } };
}
/** Bound unresolved intents without dropping old requests to admit another. */
export function parseTerminalWindowIntents(value: unknown): TerminalWindowIntent[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("Too many unresolved terminal requests in this window.");
  const seen = new Set<string>();
  return value.map(raw => {
    const intent = parseTerminalWindowIntent(raw), key = `${intent.hostId}:${intent.request.requestId}`;
    if (seen.has(key)) throw new Error("Duplicate terminal window request.");
    seen.add(key); return intent;
  });
}
