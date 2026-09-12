import { validBrowserFrameTarget } from "./browser-frame";
import type { BrowserFrameTarget } from "./browser";

export const BROWSER_AUTOCOMPLETE_PROTOCOL_VERSION = 1 as const;
export const BROWSER_AUTOCOMPLETE_OWNER_HEADER = "X-Agent-Browser-Autocomplete-Host" as const;

export type BrowserAutocompleteOwner = { kind: "session" | "draft"; id: string };
export interface BrowserAutocompleteIdentity {
  editingSessionId: string;
  requestId: string;
  target: BrowserFrameTarget;
}
export type BrowserAutocompleteRequest =
  | (BrowserAutocompleteIdentity & { action: "start"; query: string; cursorPosition: number; preventInlineAutocomplete: boolean })
  | (BrowserAutocompleteIdentity & { action: "stop" })
  | (BrowserAutocompleteIdentity & { action: "accept"; acceptToken: string })
  | (BrowserAutocompleteIdentity & { action: "delete"; deleteToken: string });

export interface BrowserAutocompleteMatch {
  id: string;
  type: "history" | "search-what-you-typed";
  destinationURL: string;
  fillIntoEdit: string;
  title: string;
  description?: string;
  inlineAutocompletion: string;
  isSearch: boolean;
  deletable: boolean;
  canBeDefault: boolean;
  acceptToken?: string;
  deleteToken?: string;
}

export interface BrowserAutocompleteResult {
  protocolVersion: typeof BROWSER_AUTOCOMPLETE_PROTOCOL_VERSION;
  hostId: string;
  owner: BrowserAutocompleteOwner;
  editingSessionId: string;
  requestId: string;
  target: BrowserFrameTarget;
  state: "matches" | "stopped" | "accepted" | "deleted";
  revision: string;
  matches?: BrowserAutocompleteMatch[];
}

const text = (value: unknown, maximum: number, empty = false): value is string =>
  typeof value === "string" && (empty || value.length > 0) && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const exact = (value: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
};
const target = (value: unknown): BrowserFrameTarget => {
  if (!validBrowserFrameTarget(value) || Object.keys(value).some(key => !["workerPid", "name", "targetId"].includes(key)))
    throw new Error("Invalid browser autocomplete target.");
  return { workerPid: value.workerPid, name: value.name, targetId: value.targetId };
};

export function parseBrowserAutocompleteRequest(value: unknown): BrowserAutocompleteRequest {
  const input = exact(value, ["action", "editingSessionId", "requestId", "target", "query", "cursorPosition", "preventInlineAutocomplete", "acceptToken", "deleteToken"], "browser autocomplete request");
  if (!text(input.editingSessionId, 100) || !text(input.requestId, 100)) throw new Error("Invalid browser autocomplete identity.");
  const identity = { editingSessionId: input.editingSessionId, requestId: input.requestId, target: target(input.target) };
  if (input.action === "start") {
    if (!text(input.query, 8192, true) || !Number.isSafeInteger(input.cursorPosition) || (input.cursorPosition as number) < 0 || (input.cursorPosition as number) > input.query.length || typeof input.preventInlineAutocomplete !== "boolean" || input.acceptToken !== undefined || input.deleteToken !== undefined)
      throw new Error("Invalid browser autocomplete query.");
    return { ...identity, action: "start", query: input.query as string, cursorPosition: input.cursorPosition as number, preventInlineAutocomplete: input.preventInlineAutocomplete };
  }
  if (input.action === "accept") {
    if (!text(input.acceptToken, 200) || input.query !== undefined || input.cursorPosition !== undefined || input.preventInlineAutocomplete !== undefined || input.deleteToken !== undefined) throw new Error("Invalid browser autocomplete acceptance.");
    return { ...identity, action: "accept", acceptToken: input.acceptToken };
  }
  if (input.action === "delete") {
    if (!text(input.deleteToken, 200) || input.query !== undefined || input.cursorPosition !== undefined || input.preventInlineAutocomplete !== undefined || input.acceptToken !== undefined) throw new Error("Invalid browser autocomplete deletion.");
    return { ...identity, action: "delete", deleteToken: input.deleteToken };
  }
  if (input.action === "stop") {
    if ([input.query, input.cursorPosition, input.preventInlineAutocomplete, input.acceptToken, input.deleteToken].some(item => item !== undefined)) throw new Error("Invalid browser autocomplete lifecycle request.");
    return { ...identity, action: input.action };
  }
  throw new Error("Invalid browser autocomplete action.");
}

function parseMatch(value: unknown): BrowserAutocompleteMatch {
  const input = exact(value, ["id", "type", "destinationURL", "fillIntoEdit", "title", "description", "inlineAutocompletion", "isSearch", "deletable", "canBeDefault", "acceptToken", "deleteToken"], "browser autocomplete match");
  if (!text(input.id, 200) || !["history", "search-what-you-typed"].includes(String(input.type)) || !text(input.destinationURL, 8192) || !text(input.fillIntoEdit, 8192) || !text(input.title, 1024, true) || !text(input.inlineAutocompletion, 8192, true)
    || input.description !== undefined && !text(input.description, 1024, true) || typeof input.isSearch !== "boolean" || typeof input.deletable !== "boolean" || typeof input.canBeDefault !== "boolean"
    || input.acceptToken !== undefined && !text(input.acceptToken, 200) || input.deleteToken !== undefined && !text(input.deleteToken, 200)
    || input.deletable !== (input.deleteToken !== undefined) || input.type === "search-what-you-typed" && (!input.isSearch || input.deletable)) throw new Error("Invalid browser autocomplete match.");
  return { id: input.id, type: input.type as BrowserAutocompleteMatch["type"], destinationURL: input.destinationURL, fillIntoEdit: input.fillIntoEdit,
    title: input.title, ...(input.description === undefined ? {} : { description: input.description }), inlineAutocompletion: input.inlineAutocompletion,
    isSearch: input.isSearch, deletable: input.deletable, canBeDefault: input.canBeDefault,
    ...(input.acceptToken === undefined ? {} : { acceptToken: input.acceptToken }), ...(input.deleteToken === undefined ? {} : { deleteToken: input.deleteToken }) } as BrowserAutocompleteMatch;
}

export function parseBrowserAutocompleteResult(value: unknown, hostId: string, owner: BrowserAutocompleteOwner, request: BrowserAutocompleteRequest): BrowserAutocompleteResult {
  const input = exact(value, ["protocolVersion", "hostId", "owner", "editingSessionId", "requestId", "target", "state", "revision", "matches"], "browser autocomplete result");
  const receivedOwner = exact(input.owner, ["kind", "id"], "browser autocomplete owner");
  if (input.protocolVersion !== BROWSER_AUTOCOMPLETE_PROTOCOL_VERSION || input.hostId !== hostId || receivedOwner.kind !== owner.kind || receivedOwner.id !== owner.id
    || input.editingSessionId !== request.editingSessionId || input.requestId !== request.requestId || JSON.stringify(target(input.target)) !== JSON.stringify(request.target)
    || !["matches", "stopped", "accepted", "deleted"].includes(String(input.state)) || !text(input.revision, 128))
    throw new Error("Browser autocomplete result changed its owner, request, or target.");
  const rawMatches = Array.isArray(input.matches) ? input.matches : undefined;
  if ((input.state === "matches") !== Boolean(rawMatches) || rawMatches && rawMatches.length > 8) throw new Error("Invalid browser autocomplete result state.");
  const expectedState = request.action === "start" ? "matches" : request.action === "stop" ? "stopped" : request.action === "accept" ? "accepted" : "deleted";
  if (input.state !== expectedState) throw new Error("Browser autocomplete result changed its requested action.");
  const matches = rawMatches ? Array.from({ length: rawMatches.length }, (_, index) => parseMatch(rawMatches[index])) : undefined;
  if (matches && new Set(matches.map(match => match.id)).size !== matches.length) throw new Error("Browser autocomplete returned duplicate matches.");
  return { protocolVersion: BROWSER_AUTOCOMPLETE_PROTOCOL_VERSION, hostId, owner: { ...owner }, editingSessionId: request.editingSessionId,
    requestId: request.requestId, target: { ...request.target }, state: input.state as BrowserAutocompleteResult["state"], revision: input.revision as string,
    ...(matches ? { matches } : {}) };
}
