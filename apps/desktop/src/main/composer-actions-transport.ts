import { parseNativeSkillFileRef, parseNativeSkillFileDocument, type NativeSkillFileRef, type NativeSkillFileDocument, type WorkspaceQueryResult } from "@agent-desktop/shared";
import { COMPOSER_OWNER_HEADER, parseNativeSkillInventory, type ComposerActionsCatalog, type ComposerCompletionQuery, type ComposerCompletions, type ComposerSkillDetail, type NativeSkillInventory, type WorkspaceTarget } from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";

async function query(endpoint: HostEndpoint, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!endpoint.hostId) throw new Error("Select the owning host before querying native composer actions.");
  const input = JSON.stringify(body);
  if (Buffer.byteLength(input) > 16 * 1024) throw new Error("Composer query exceeds 16 KiB.");
  const response = await fetch(`${endpoint.origin}${path}`, { method: "POST", headers: {
    "Content-Type": "application/json", [COMPOSER_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
  }, body: input, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), redirect: "error" });
  if (response.ok && response.headers.get(COMPOSER_OWNER_HEADER) !== endpoint.hostId) { await response.body?.cancel(); throw new HostRequestError("Composer response belongs to a different host. Refresh hosts before retrying.", 409, "OWNER_MISMATCH"); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Composer response body is missing.");
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength;
    if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("Composer response exceeds 2 MiB."); } chunks.push(next.value); } }
  finally { reader.releaseLock(); }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok) throw new HostRequestError(typeof value?.error === "string" ? value.error : value?.error?.message ?? `Composer request failed (${response.status}).`, response.status, value?.error?.code ?? value?.code);
  if (path === "/v1/composer/skill-file-open-options") return value; // Validated by requestSkillFileOpenOptions.
  if (path === "/v1/composer/skill-file-copy") return value; // Shared save-copy validates each metadata/chunk response.
  if (path === "/v1/composer/skill-file-image") return value; // Stream validates metadata/chunk identity before exposing bytes.
  if (path === "/v1/composer/skill-file") {
    const file = parseNativeSkillFileDocument(value);
    const ref = parseNativeSkillFileRef((body as {ref:unknown}).ref);
    if (file.hostId !== endpoint.hostId || JSON.stringify(file.ref) !== JSON.stringify(ref)) throw new Error("Native skill file response belongs to a different owner or file.");
    return file;
  }
  const target = (body as { target?: WorkspaceTarget }).target;
  if (value?.hostId !== endpoint.hostId || value?.protocolVersion !== 1 || typeof value.cwd !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)
    || JSON.stringify(value.target) !== JSON.stringify(target)) throw new Error("Composer response does not match the selected host/workspace or protocol.");
  return value;
}
export async function requestComposerActions(endpoint: HostEndpoint, target?: WorkspaceTarget, refresh?: boolean): Promise<ComposerActionsCatalog | null> {
  try { return await query(endpoint, "/v1/composer/actions", { target, refresh }) as ComposerActionsCatalog; }
  catch (error) { if (error instanceof HostRequestError && error.status === 404 && !error.code) return null; throw error; }
}
export async function requestSkillInventory(endpoint: HostEndpoint, target?: WorkspaceTarget, refresh?: boolean): Promise<NativeSkillInventory | null> {
  try {
    const result = parseNativeSkillInventory(await query(endpoint, "/v1/composer/skill-inventory", { target, refresh }));
    if (result.hostId !== endpoint.hostId || JSON.stringify(result.target) !== JSON.stringify(target)) throw new Error("Native skill inventory response does not match the selected host/workspace.");
    return result;
  } catch (error) { if (error instanceof HostRequestError && error.status === 404 && !error.code) return null; throw error; }
}
export async function requestComposerCompletions(endpoint: HostEndpoint, input: ComposerCompletionQuery): Promise<ComposerCompletions> {
  return await query(endpoint, "/v1/composer/completions", input) as ComposerCompletions;
}
export async function requestSkillDetail(endpoint: HostEndpoint, target: WorkspaceTarget | undefined, skillId: string, catalogRevision: string, inventory = false): Promise<ComposerSkillDetail> {
  const value = await query(endpoint, "/v1/composer/skill-detail", { target, skillId, catalogRevision, ...(inventory ? { inventory: true } : {}) }) as ComposerSkillDetail;
  if (value.skillId !== skillId || value.revision !== catalogRevision || typeof value.content !== "string" || Buffer.byteLength(value.content, "utf8") > 1024 * 1024) throw new Error("Native skill detail response is invalid.");
  return value;
}

export async function requestSkillFile(endpoint: HostEndpoint, ref: NativeSkillFileRef): Promise<NativeSkillFileDocument> {
  return await query(endpoint, "/v1/composer/skill-file", {ref:parseNativeSkillFileRef(ref)}) as NativeSkillFileDocument;
}

// Serialize this desktop's skill-image reads per host so a document with many
// images cannot exhaust the host's separate image budget. Revoked queued work
// checks its signal before dispatch; control/file queries never enter this queue.
const skillImageReads = new Map<string, Promise<unknown>>();
export async function requestSkillImage(endpoint: HostEndpoint, ref: NativeSkillFileRef, path: string, chunk?: {revision:string;offset:number}, signal?: AbortSignal): Promise<WorkspaceQueryResult> {
  const owner = `${endpoint.origin}:${endpoint.hostId}`, previous = skillImageReads.get(owner) ?? Promise.resolve();
  const resource = parseNativeSkillFileRef(ref);
  const pending = previous.catch(()=>{}).then(async()=>{
    signal?.throwIfAborted();
    return await query(endpoint, "/v1/composer/skill-file-image", {ref:resource,path,...chunk}, signal) as WorkspaceQueryResult;
  });
  skillImageReads.set(owner,pending);
  try { return await pending; }
  finally { if(skillImageReads.get(owner)===pending)skillImageReads.delete(owner); }
}

export async function requestSkillFileOpenOptions(endpoint: HostEndpoint, ref: NativeSkillFileRef): Promise<import("@agent-desktop/shared").NativeSkillFileOpenOptions> {
  const resource = parseNativeSkillFileRef(ref);
  const value = await query(endpoint, "/v1/composer/skill-file-open-options", {ref:resource}) as import("@agent-desktop/shared").NativeSkillFileOpenOptions;
  if (value?.protocolVersion !== 1 || value.hostId !== endpoint.hostId || JSON.stringify(parseNativeSkillFileRef(value.ref)) !== JSON.stringify(resource)
    || value.options?.type !== "file.open-options" || value.options.path !== resource.sourcePath || !Array.isArray(value.options.targets) || value.options.targets.length > 100
    || value.options.targets.some(target => !target || typeof target.id !== "string" || !target.id || target.id.length > 200 || typeof target.label !== "string" || target.label.length > 200 || !["editor","terminal","file-manager"].includes(target.kind))
    || new Set(value.options.targets.map(target=>target.id)).size !== value.options.targets.length
    || value.options.preferredTargetId !== undefined && !value.options.targets.some(target=>target.id===value.options.preferredTargetId)
    || value.options.availabilityReason !== undefined && (typeof value.options.availabilityReason !== "string" || value.options.availabilityReason.length > 4096)) throw new Error("Native skill Open options belong to a different owner/file or are invalid.");
  return value;
}

export async function requestSkillFileCopy(endpoint: HostEndpoint, ref: NativeSkillFileRef, chunk?: {revision:string;offset:number}, signal?: AbortSignal): Promise<WorkspaceQueryResult> {
  return await query(endpoint, "/v1/composer/skill-file-copy", {ref:parseNativeSkillFileRef(ref),...chunk}, signal) as WorkspaceQueryResult;
}
