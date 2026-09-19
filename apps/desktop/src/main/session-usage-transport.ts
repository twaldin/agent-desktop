import { SESSION_USAGE_HEADER, SESSION_USAGE_MAX_BYTES, type SessionUsageResponse, type UsageRefresh } from "../../../../packages/shared/src/session-usage";
import { validateSessionUsageResponse } from "../../../../packages/shared/src/session-usage-validation";
export { validateSessionUsageResponse } from "../../../../packages/shared/src/session-usage-validation";
import type { CommandEnvelope, CommandResult } from "@agent-desktop/shared";
import { parseUsageCommand, usageIdentity } from "../../../../packages/shared/src/session-usage";
import type { HostEndpoint } from "./host-transport";
const MAX_IDENTITY_LENGTH = 200;
const string = (value: unknown, max: number) => typeof value === "string" && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : undefined;

async function readBody(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && Number.isFinite(Number(declared)) && Number(declared) > SESSION_USAGE_MAX_BYTES) { await response.body?.cancel(); throw new Error("Session usage response is oversized."); }
  if (!response.body) throw new Error("Session usage response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > SESSION_USAGE_MAX_BYTES) { await reader.cancel(); throw new Error("Session usage response is oversized."); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); } catch { throw new Error("Invalid session usage response."); }
}

function requestHeaders(endpoint: HostEndpoint): Record<string, string> {
  return { [SESSION_USAGE_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) };
}

export async function requestSessionUsage(endpoint: HostEndpoint, sessionId: string, mode: UsageRefresh = "cached", commandId?: string): Promise<SessionUsageResponse> {
  if (!endpoint.hostId || endpoint.hostId.length > MAX_IDENTITY_LENGTH || /[\u0000-\u001f]/.test(endpoint.hostId)) throw new Error("Invalid session usage host.");
  if (!sessionId || sessionId.length > MAX_IDENTITY_LENGTH || /[\u0000-\u001f]/.test(sessionId)) throw new Error("Invalid session usage session.");
  if (mode !== "cached" && mode !== "reports" && mode !== "credits") throw new Error("Invalid session usage refresh mode.");
  if (commandId !== undefined && (mode !== "cached" || !string(commandId, MAX_IDENTITY_LENGTH))) throw new Error("Invalid session usage command id.");
  const isCached = mode === "cached";
  const suffix = commandId === undefined ? "" : `?commandId=${encodeURIComponent(commandId)}`;
  let response: Response;
  try {
    response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/usage${suffix}`, {
      method: isCached ? "GET" : "POST", headers: { ...requestHeaders(endpoint), ...(isCached ? {} : { "Content-Type": "application/json" }) },
      ...(isCached ? {} : { body: JSON.stringify({ mode }) }), redirect: "error", signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new Error("Session usage request failed."); }
  let value: unknown;
  try { value = await readBody(response); } catch (error) { if (!response.ok) throw new Error("Session usage request failed."); throw error; }
  if (!response.ok) throw new Error("Session usage request failed.");
  if (response.headers.get(SESSION_USAGE_HEADER) !== endpoint.hostId) throw new Error("Session usage response owner mismatch.");
  try {
    const validated = validateSessionUsageResponse(value, endpoint, sessionId, commandId);
    if (commandId !== undefined && (!validated.command || validated.command.id !== commandId)) throw new Error("Command identity mismatch.");
    if (commandId === undefined && validated.command !== undefined) throw new Error("Unexpected session usage command receipt.");
    return validated;
  } catch { throw new Error("Invalid session usage response."); }
}

/** Reset answers carry owning-host admission before the shared durable journal. */
export async function requestSessionUsageCommand(endpoint: HostEndpoint, envelope: CommandEnvelope): Promise<CommandResult> {
  usageIdentity(endpoint.hostId); usageIdentity(envelope.id);
  const command = parseUsageCommand({ ...envelope.command });
  if (envelope.commandVersion !== 20) throw new Error("Provider usage requires command version 20.");
  let response: Response;
  try {
    response = await fetch(`${endpoint.origin}/v20/commands`, { method: "POST",
      headers: { ...requestHeaders(endpoint), "Content-Type": "application/json" },
      body: JSON.stringify({ id: envelope.id, commandVersion: 20, command }), redirect: "error", signal: AbortSignal.timeout(60_000) });
  } catch { throw new Error("Reset request outcome could not be confirmed."); }
  if (!response.ok || response.headers.get(SESSION_USAGE_HEADER) !== endpoint.hostId) {
    await response.body?.cancel(); throw new Error("Reset request outcome could not be confirmed.");
  }
  const value = await readBody(response) as Partial<CommandResult>;
  if (!value || value.commandId !== envelope.id) throw new Error("Reset command identity mismatch.");
  if (value.ok === false) return { ok: false, commandId: envelope.id, error: {
    code: value.error?.code === "USAGE_REJECTED" ? "USAGE_REJECTED" : "OUTCOME_UNKNOWN",
    message: "The original reset request could not be confirmed. Inspect its saved receipt." } };
  if (value.ok !== true || !value.value || !("type" in value.value) || value.value.type !== "session.usage.reset") throw new Error("Invalid reset command receipt.");
  const receipt = validateSessionUsageResponse({ version: 1, hostId: endpoint.hostId, sessionId: command.sessionId,
    snapshot: null, reset: value.value.receipt }, endpoint, command.sessionId).reset;
  if (!receipt || receipt.operationId !== (command.type === "session.usage.reset.prepare" ? envelope.id : command.operationId)) throw new Error("Reset operation identity mismatch.");
  return { ok: true, commandId: envelope.id, value: { type: "session.usage.reset", receipt } };
}
