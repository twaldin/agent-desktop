import { COMPOSER_OWNER_HEADER, parseNativeSkillInventory, type ComposerActionsCatalog, type ComposerCompletionQuery, type ComposerCompletions, type ComposerSkillDetail, type NativeSkillInventory, type WorkspaceTarget } from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";

async function query(endpoint: HostEndpoint, path: string, body: unknown): Promise<unknown> {
  if (!endpoint.hostId) throw new Error("Select the owning host before querying native composer actions.");
  const input = JSON.stringify(body);
  if (Buffer.byteLength(input) > 16 * 1024) throw new Error("Composer query exceeds 16 KiB.");
  const response = await fetch(`${endpoint.origin}${path}`, { method: "POST", headers: {
    "Content-Type": "application/json", [COMPOSER_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
  }, body: input, signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (response.ok && response.headers.get(COMPOSER_OWNER_HEADER) !== endpoint.hostId) { await response.body?.cancel(); throw new HostRequestError("Composer response belongs to a different host. Refresh hosts before retrying.", 409, "OWNER_MISMATCH"); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Composer response body is missing.");
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength;
    if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("Composer response exceeds 2 MiB."); } chunks.push(next.value); } }
  finally { reader.releaseLock(); }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok) throw new HostRequestError(typeof value?.error === "string" ? value.error : value?.error?.message ?? `Composer request failed (${response.status}).`, response.status, value?.error?.code ?? value?.code);
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
