import type { LoginSnapshot, LoginResponse } from "./accounts";

export interface NativeMcpAuthorizationSnapshot {
  authorizationId: string;
  serverName: string;
  status: "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  phase: "queued" | "discovering" | "authorizing" | "saving" | "reconnecting" | "finished";
  credentialsStored: boolean;
  credentialWrite: "not-started" | "unknown" | "stored";
  configuration: "untouched" | "not-needed" | "saved" | "unknown";
  reconnected: boolean;
  login: LoginSnapshot;
  error?: string;
}


export interface NativeMcpAuthorizationReply {
  authorizationId: string;
  requestId: string;
  response: LoginResponse;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP authorization request.");
  return value as Record<string, unknown>;
};
export function parseNativeMcpAuthorizationId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || /[\0-\x1f\x7f]/.test(value)) throw new Error("Invalid MCP authorization identity.");
  return value;
}
/** Write-only callback response. It must never be persisted as a HostCommand. */
export function parseNativeMcpAuthorizationReply(value: unknown): NativeMcpAuthorizationReply {
  const input = record(value);
  if (Object.keys(input).some(key => !["authorizationId", "requestId", "response"].includes(key))) throw new Error("Unsupported MCP authorization response field.");
  const response = record(input.response);
  let parsed: LoginResponse;
  if (response.cancel === true && Object.keys(response).length === 1) parsed = { cancel: true };
  else if (typeof response.value === "string" && response.value.length <= 1024 * 1024 && Object.keys(response).length === 1) parsed = { value: response.value };
  else throw new Error("Invalid MCP authorization response.");
  return { authorizationId: parseNativeMcpAuthorizationId(input.authorizationId), requestId: parseNativeMcpAuthorizationId(input.requestId), response: parsed };
}
