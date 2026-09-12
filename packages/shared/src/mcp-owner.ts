import { cloneMcpJson, parseNativeMcpAppRequest, parseNativeMcpAppResponse, type NativeMcpAppRequest, type NativeMcpAppResponse } from "./session-mcp-app";
import { parseNativeSessionMcpSnapshot, type NativeSessionMcpSnapshot } from "./session-mcp";
import type { OmpInteraction, OmpInteractionResponse } from "./interactions";

export interface McpOwnerTarget { projectId: string | null; expectedDirectory?: string }
export interface McpOwnerBinding { ownerId: string; epoch: string }
export type McpOwnerRequest =
  | { type: "acquire"; ownerId: string; target: McpOwnerTarget }
  | { type: "retire"; ownerId: string; target: McpOwnerTarget }
  | ({ type: "read" | "close" } & McpOwnerBinding)
  | ({ type: "app"; request: NativeMcpAppRequest } & McpOwnerBinding)
  | ({ type: "answer"; interactionId: string; response: OmpInteractionResponse } & McpOwnerBinding);
export interface McpOwnerSnapshot extends McpOwnerBinding {
  cwd: string;
  projectId: string | null;
  catalogue: NativeSessionMcpSnapshot;
  interactions: OmpInteraction[];
}
export type McpOwnerResult = McpOwnerSnapshot | { closed: true } | NativeMcpAppResponse;
export interface McpOwnerBridge { request(hostId: string, request: McpOwnerRequest): Promise<McpOwnerResult> }
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP owner object."); return value as Record<string, unknown>; };
const text = (value: unknown, max = 200): string => { if (typeof value !== "string" || !value || value.length > max || /[\0-\x1f\x7f]/.test(value)) throw new Error("Invalid MCP owner identity."); return value; };
const keys = (value: Record<string, unknown>, allowed: string[]) => { if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unsupported MCP owner field."); };
export function parseMcpOwnerRequest(value: unknown): McpOwnerRequest {
  const input = object(value), ownerId = text(input.ownerId);
  if (!/^[a-zA-Z0-9-]+$/.test(ownerId)) throw new Error("Invalid MCP owner ID.");
  if (input.type === "acquire" || input.type === "retire") {
    keys(input, ["type", "ownerId", "target"]); const target = object(input.target); keys(target, ["projectId", "expectedDirectory"]);
    return { type: input.type, ownerId, target: { projectId: target.projectId === null ? null : text(target.projectId),
      ...(target.expectedDirectory === undefined ? {} : { expectedDirectory: text(target.expectedDirectory, 16_384) }) } };
  }
  const epoch = text(input.epoch);
  if (input.type === "read" || input.type === "close") { keys(input, ["type", "ownerId", "epoch"]); return { type: input.type, ownerId, epoch }; }
  if (input.type === "app") { keys(input, ["type", "ownerId", "epoch", "request"]); return { type: "app", ownerId, epoch, request: parseNativeMcpAppRequest(input.request) }; }
  if (input.type === "answer") {
    keys(input, ["type", "ownerId", "epoch", "interactionId", "response"]); const response = object(input.response);
    if (Object.keys(response).length !== 1 || !(response.cancel === true || typeof response.value === "string" || typeof response.value === "boolean" || ["left", "right", "externalEditor", "timeoutReset"].includes(String(response.action)))) throw new Error("Invalid MCP owner interaction answer.");
    return { type: "answer", ownerId, epoch, interactionId: text(input.interactionId), response: structuredClone(response) as OmpInteractionResponse };
  }
  throw new Error("Unsupported MCP owner operation.");
}
function interaction(value: unknown, ownerId: string): OmpInteraction {
  const input = object(value);
  keys(input, ["id", "sessionId", "method", "notificationKind", "title", "message", "options", "placeholder", "prefill", "promptStyle", "createdAt", "expiresAt", "initialIndex", "outline", "helpText", "selectionMarker", "checkedIndices", "markableCount", "actions"]);
  if (input.sessionId !== ownerId || !["select", "confirm", "input", "editor"].includes(String(input.method)) || !Number.isFinite(input.createdAt)) throw new Error("Invalid MCP owner interaction binding.");
  text(input.id); text(input.title, 16_384);
  if (!Array.isArray(input.actions) || input.actions.some(action => !["left", "right", "externalEditor", "timeoutReset"].includes(action))) throw new Error("Invalid interaction actions.");
  if (input.options !== undefined && (!Array.isArray(input.options) || input.options.length > 256 || input.options.some(option => typeof option !== "object" || !option || typeof option.label !== "string"))) throw new Error("Invalid interaction options.");
  for (const field of ["message", "placeholder", "prefill", "helpText"]) if (input[field] !== undefined && typeof input[field] !== "string") throw new Error("Invalid interaction text.");
  if (input.notificationKind !== undefined && !["question", "permission"].includes(String(input.notificationKind))) throw new Error("Invalid interaction notification.");
  if (input.selectionMarker !== undefined && !["radio", "checkbox"].includes(String(input.selectionMarker))) throw new Error("Invalid interaction selection.");
  for (const field of ["expiresAt", "initialIndex", "markableCount"]) if (input[field] !== undefined && !Number.isFinite(input[field])) throw new Error("Invalid interaction count.");
  for (const field of ["promptStyle", "outline"]) if (input[field] !== undefined && typeof input[field] !== "boolean") throw new Error("Invalid interaction option.");
  if (input.checkedIndices !== undefined && (!Array.isArray(input.checkedIndices) || input.checkedIndices.some(index => !Number.isSafeInteger(index) || index < 0))) throw new Error("Invalid checked options.");
  return cloneMcpJson(input, 128 * 1024) as unknown as OmpInteraction;
}
export function parseMcpOwnerResult(value: unknown, request: McpOwnerRequest): McpOwnerResult {
  if (request.type === "app") return parseNativeMcpAppResponse(value, request.request);
  const input = object(value);
  if (request.type === "close" || request.type === "retire") { keys(input, ["closed"]); if (input.closed !== true) throw new Error("MCP owner retirement was not confirmed."); return { closed: true }; }
  keys(input, ["ownerId", "epoch", "cwd", "projectId", "catalogue", "interactions"]);
  if (input.ownerId !== request.ownerId || request.type !== "acquire" && input.epoch !== request.epoch) throw new Error("MCP owner generation changed.");
  const cwd = text(input.cwd, 16_384), projectId = input.projectId === null ? null : text(input.projectId);
  if (request.type === "acquire" && (projectId !== request.target.projectId || request.target.expectedDirectory !== undefined && cwd !== request.target.expectedDirectory)) throw new Error("MCP owner directory changed.");
  if (!Array.isArray(input.interactions) || input.interactions.length > 128) throw new Error("MCP owner interaction limit exceeded.");
  const interactions: OmpInteraction[] = []; for (let i = 0; i < input.interactions.length; i++) interactions.push(interaction(input.interactions[i], request.ownerId));
  return { ownerId: request.ownerId, epoch: text(input.epoch), cwd, projectId, catalogue: parseNativeSessionMcpSnapshot(input.catalogue), interactions };
}
