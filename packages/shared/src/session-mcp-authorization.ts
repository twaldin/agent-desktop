import type { LoginSnapshot, LoginResponse } from "./accounts";
import { parseNativeSessionMcpReconnect, type NativeSessionMcpReceipt, type NativeSessionMcpReconnect } from "./session-mcp";

export interface NativeMcpAuthorizationSnapshot {
  authorizationId: string;
  commandId?: string;
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

export interface NativeMcpAuthorizationStart extends NativeSessionMcpReconnect { commandId?: string }


export interface NativeMcpAuthorizationReply {
  authorizationId: string;
  requestId: string;
  response: LoginResponse;
}

export interface NativeMcpAuthorizationResponse {
  protocolVersion: 1;
  hostId: string;
  sessionId: string;
  value: NativeMcpAuthorizationSnapshot | null;
  unavailable?: string;
  receipt?: NativeSessionMcpReceipt & { authorizationId?: string };
}

const encoder = new TextEncoder();
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP authorization request.");
  return value as Record<string, unknown>;
};
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], message: string): void => {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(message);
};
const text = (value: unknown, max: number, message = "Invalid MCP authorization text."): string => {
  if (typeof value !== "string" || !value || encoder.encode(value).byteLength > max || value.includes("\0")) throw new Error(message);
  return value;
};
const integer = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid MCP authorization timestamp.");
  return value;
};
const boolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new Error("Invalid MCP authorization flag.");
  return value;
};

function parseLoginSnapshot(value: unknown): LoginSnapshot {
  const login = record(value);
  exactKeys(login, ["loginId", "providerId", "status", "startedAt", "updatedAt", "cancellationRequested", "auth", "progress", "prompts", "identity", "error"], "Unsupported native login field.");
  const status = String(login.status);
  if (!["running", "cancelling", "succeeded", "no_credentials", "cancelled", "failed"].includes(status)) throw new Error("Invalid native login status.");
  if (!Array.isArray(login.prompts) || login.prompts.length > 256) throw new Error("Invalid native login prompts.");
  const prompts: LoginSnapshot["prompts"] = login.prompts.map(value => {
    const prompt = record(value);
    exactKeys(prompt, ["requestId", "kind", "message", "placeholder", "allowEmpty", "sensitive"], "Unsupported native login prompt field.");
    if (prompt.kind !== "prompt" && prompt.kind !== "manual-code") throw new Error("Invalid native login prompt kind.");
    if (prompt.sensitive !== true) throw new Error("Invalid native login prompt sensitivity.");
    return {
      requestId: parseNativeMcpAuthorizationId(prompt.requestId),
      kind: prompt.kind as "prompt" | "manual-code",
      message: text(prompt.message, 64 * 1024),
      ...(prompt.placeholder === undefined ? {} : { placeholder: text(prompt.placeholder, 16 * 1024) }),
      allowEmpty: boolean(prompt.allowEmpty),
      sensitive: true as const,
    };
  });
  let auth: LoginSnapshot["auth"];
  if (login.auth !== undefined) {
    const raw = record(login.auth);
    exactKeys(raw, ["url", "launchUrl", "instructions", "callbackOnOwningHost"], "Unsupported native login authorization field.");
    if (raw.callbackOnOwningHost !== true) throw new Error("Invalid native login callback ownership.");
    auth = {
      url: text(raw.url, 64 * 1024),
      ...(raw.launchUrl === undefined ? {} : { launchUrl: text(raw.launchUrl, 64 * 1024) }),
      ...(raw.instructions === undefined ? {} : { instructions: text(raw.instructions, 64 * 1024) }),
      callbackOnOwningHost: true,
    };
  }
  let identity: LoginSnapshot["identity"];
  if (login.identity !== undefined) {
    const raw = record(login.identity);
    exactKeys(raw, ["type", "email", "accountId", "projectId", "orgId", "orgName"], "Unsupported native login identity field.");
    if (raw.type !== "oauth" && raw.type !== "api_key") throw new Error("Invalid native login identity.");
    identity = {
      type: raw.type,
      ...(raw.email === undefined ? {} : { email: text(raw.email, 4096) }),
      ...(raw.accountId === undefined ? {} : { accountId: text(raw.accountId, 4096) }),
      ...(raw.projectId === undefined ? {} : { projectId: text(raw.projectId, 4096) }),
      ...(raw.orgId === undefined ? {} : { orgId: text(raw.orgId, 4096) }),
      ...(raw.orgName === undefined ? {} : { orgName: text(raw.orgName, 4096) }),
    };
  }
  let error: LoginSnapshot["error"];
  if (login.error !== undefined) {
    const raw = record(login.error);
    exactKeys(raw, ["code", "message", "status"], "Unsupported native login error field.");
    error = {
      code: text(raw.code, 1024),
      message: text(raw.message, 16 * 1024),
      ...(raw.status === undefined ? {} : { status: integer(raw.status) }),
    };
  }
  return {
    loginId: parseNativeMcpAuthorizationId(login.loginId),
    providerId: text(login.providerId, 1024),
    status: status as LoginSnapshot["status"],
    startedAt: integer(login.startedAt),
    updatedAt: integer(login.updatedAt),
    cancellationRequested: boolean(login.cancellationRequested),
    ...(auth ? { auth } : {}),
    ...(login.progress === undefined ? {} : { progress: text(login.progress, 64 * 1024) }),
    prompts,
    ...(identity ? { identity } : {}),
    ...(error ? { error } : {}),
  };
}

export function parseNativeMcpAuthorizationSnapshot(value: unknown): NativeMcpAuthorizationSnapshot {
  const input = record(value);
  exactKeys(input, ["authorizationId", "commandId", "serverName", "status", "phase", "credentialsStored", "credentialWrite", "configuration", "reconnected", "login", "error"], "Unsupported MCP authorization snapshot field.");
  const status = String(input.status);
  const phase = String(input.phase);
  const credentialWrite = String(input.credentialWrite);
  const configuration = String(input.configuration);
  if (!["running", "cancelling", "succeeded", "failed", "cancelled"].includes(status)) throw new Error("Invalid MCP authorization status.");
  if (!["queued", "discovering", "authorizing", "saving", "reconnecting", "finished"].includes(phase)) throw new Error("Invalid MCP authorization phase.");
  if (!["not-started", "unknown", "stored"].includes(credentialWrite)) throw new Error("Invalid MCP credential write state.");
  if (!["untouched", "not-needed", "saved", "unknown"].includes(configuration)) throw new Error("Invalid MCP configuration write state.");
  const authorizationId = parseNativeMcpAuthorizationId(input.authorizationId);
  const login = parseLoginSnapshot(input.login);
  if (login.loginId !== authorizationId) throw new Error("MCP authorization and login identities do not match.");
  const parsed: NativeMcpAuthorizationSnapshot = {
    authorizationId,
    ...(input.commandId === undefined ? {} : { commandId: parseCommandId(input.commandId) }),
    serverName: text(input.serverName, 1024),
    status: status as NativeMcpAuthorizationSnapshot["status"],
    phase: phase as NativeMcpAuthorizationSnapshot["phase"],
    credentialsStored: boolean(input.credentialsStored),
    credentialWrite: credentialWrite as NativeMcpAuthorizationSnapshot["credentialWrite"],
    configuration: configuration as NativeMcpAuthorizationSnapshot["configuration"],
    reconnected: boolean(input.reconnected),
    login,
    ...(input.error === undefined ? {} : { error: text(input.error, 16 * 1024) }),
  };
  if (encoder.encode(JSON.stringify(parsed)).byteLength > MAX_SNAPSHOT_BYTES) throw new Error("MCP authorization snapshot exceeds its 2 MiB response limit.");
  return parsed;
}
export function parseNativeMcpAuthorizationId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || /[\0-\x1f\x7f]/.test(value)) throw new Error("Invalid MCP authorization identity.");
  return value;
}
const parseCommandId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new Error("Invalid MCP authorization command identity.");
  return value;
};
export function parseNativeMcpAuthorizationStart(value: unknown): NativeMcpAuthorizationStart {
  const input = record(value);
  exactKeys(input, ["epoch", "expectedRevision", "serverName", "commandId"], "Unsupported MCP authorization start field.");
  return {
    ...parseNativeSessionMcpReconnect({ epoch: input.epoch, expectedRevision: input.expectedRevision, serverName: input.serverName }),
    ...(input.commandId === undefined ? {} : { commandId: parseCommandId(input.commandId) }),
  };
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

export function parseNativeMcpAuthorizationResponse(value: unknown, hostId: string, sessionId: string, commandId?: string): NativeMcpAuthorizationResponse {
  const input = record(value);
  exactKeys(input, ["protocolVersion", "hostId", "sessionId", "value", "unavailable", "receipt"], "Unsupported MCP authorization response field.");
  if (input.protocolVersion !== 1 || input.hostId !== hostId || input.sessionId !== sessionId) throw new Error("MCP authorization response owner does not match the selected session.");
  const snapshot = input.value === null ? null : parseNativeMcpAuthorizationSnapshot(input.value);
  let receipt: NativeMcpAuthorizationResponse["receipt"];
  if (input.receipt !== undefined) {
    const raw = record(input.receipt);
    exactKeys(raw, ["commandId", "state", "message", "authorizationId"], "Unsupported MCP authorization receipt field.");
    if (!commandId || raw.commandId !== commandId || !["absent", "pending", "unknown", "succeeded", "failed"].includes(String(raw.state))) {
      throw new Error("MCP authorization receipt owner does not match the requested command.");
    }
    const authorizationId = raw.authorizationId === undefined ? undefined : parseNativeMcpAuthorizationId(raw.authorizationId);
    const sameFlow = snapshot && (snapshot.commandId === commandId
      || (snapshot.commandId === undefined && authorizationId === snapshot.authorizationId));
    if (sameFlow && authorizationId && authorizationId !== snapshot.authorizationId) {
      throw new Error("MCP authorization receipt identity does not match its snapshot.");
    }
    receipt = {
      commandId,
      state: raw.state as NativeSessionMcpReceipt["state"],
      ...(raw.message === undefined ? {} : { message: text(raw.message, 4096) }),
      ...(authorizationId ? { authorizationId } : {}),
    };
  }
  if (commandId && !receipt) throw new Error("Missing MCP authorization command receipt.");
  return {
    protocolVersion: 1,
    hostId,
    sessionId,
    value: snapshot,
    ...(input.unavailable === undefined ? {} : { unavailable: text(input.unavailable, 4096) }),
    ...(receipt ? { receipt } : {}),
  };
}
