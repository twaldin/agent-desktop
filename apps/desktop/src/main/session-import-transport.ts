import { MAX_SESSION_IMPORT_REPLY_BYTES, SESSION_IMPORT_OWNER_HEADER, nativeImportCandidateId, nativeImportCommandId, parseNativeImportInspection, parseNativeImportListing,
  parseNativeImportAdmissionRequest,parseNativeImportPreparationRequest,parseNativeImportPreparation,parseNativeImportOutcome } from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";

async function requestImport(endpoint: HostEndpoint, suffix: string, signal: AbortSignal, input?: unknown): Promise<unknown> {
  if (!endpoint.hostId) throw new Error("Choose the original native session's owning host.");
  const response = await fetch(`${endpoint.origin}/v1/session-imports${suffix}`, { method:input===undefined?"GET":"POST", headers: {
    [SESSION_IMPORT_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
    ...(input===undefined?{}:{"Content-Type":"application/json"}),
  }, body:input===undefined?undefined:JSON.stringify(input),signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: "error" });
  const owner = response.headers.get(SESSION_IMPORT_OWNER_HEADER);
  if (response.ok ? owner !== endpoint.hostId : owner !== null && owner !== endpoint.hostId) {
    await response.body?.cancel(); throw new HostRequestError("Native session inspection belongs to a different host.", 409, "IMPORT_OWNER_CHANGED");
  }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Native session inspection returned no body.");
  const chunks: Uint8Array[] = []; let size = 0;
  let value: unknown;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > (response.ok ? MAX_SESSION_IMPORT_REPLY_BYTES : 16_384)) throw new Error("Native session inspection exceeds its reply limit.");
      chunks.push(part.value);
    }
    value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  signal.throwIfAborted();
  if (!response.ok) {
    const outer = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const detail = outer.error && typeof outer.error === "object" ? outer.error as Record<string, unknown> : {};
    const code = typeof detail.code === "string" ? detail.code : undefined;
    if (response.status === 404 && !code) throw new HostRequestError("Update the owning host to inspect native sessions.", 404, "SESSION_IMPORT_UNSUPPORTED");
    throw new HostRequestError(typeof detail.message === "string" ? detail.message : `Native session inspection failed (${response.status}).`, response.status, code);
  }
  return value;
}
export async function requestNativeImportListing(endpoint: HostEndpoint, signal: AbortSignal) {
  return parseNativeImportListing(await requestImport(endpoint, "", signal), endpoint.hostId);
}
export async function requestNativeImportInspection(endpoint: HostEndpoint, candidateId: string, signal: AbortSignal) {
  candidateId=nativeImportCandidateId(candidateId);
  return parseNativeImportInspection(await requestImport(endpoint, "/"+encodeURIComponent(candidateId), signal), endpoint.hostId, candidateId);
}
export async function requestNativeImportPreparation(endpoint:HostEndpoint,input:unknown,signal:AbortSignal){
  const parsed=parseNativeImportPreparationRequest(input);
  return parseNativeImportPreparation(await requestImport(endpoint,"/prepare",signal,parsed),endpoint.hostId,parsed.candidateId,parsed.revision);
}
export async function requestNativeImportAdmission(endpoint:HostEndpoint,input:unknown,signal:AbortSignal){
  const parsed=parseNativeImportAdmissionRequest(input);
  return parseNativeImportOutcome(await requestImport(endpoint,"/admit",signal,parsed),endpoint.hostId,parsed.commandId);
}
export async function requestNativeImportStatus(endpoint:HostEndpoint,commandId:string,signal:AbortSignal){
  commandId=nativeImportCommandId(commandId);
  return parseNativeImportOutcome(await requestImport(endpoint,"/outcomes/"+encodeURIComponent(commandId),signal),endpoint.hostId,commandId);
}
