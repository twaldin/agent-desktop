import type {
  NativeMarketplaceCatalog,
  NativePluginAcquisition,
  NativePluginAcquisitionReceipt,
  NativePluginAcquisitionRequest,
  WorkspaceTarget,
} from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";
import { parseMarketplaceSourceOptions } from "../../../../packages/shared/src/plugin-acquisition";

const MAX_RESPONSE = 2 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plugin acquisition response.");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Invalid plugin acquisition response.");
}
function string(value: unknown, max = 8192): string {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) throw new Error("Invalid plugin acquisition response.");
  return value;
}
function operation(value: unknown): NativePluginAcquisition["operation"] {
  if (!["marketplace.add", "marketplace.update", "marketplace.remove", "plugin.install", "plugin.uninstall"].includes(String(value))) {
    throw new Error("Invalid plugin acquisition response.");
  }
  return value as NativePluginAcquisition["operation"];
}
function requestId(value: string): void {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) throw new Error("Invalid plugin acquisition request.");
}
function revision(value: string): void {
  if (!value || value.length > 200 || value.includes("\0")) throw new Error("Invalid plugin acquisition request.");
}
function sameTarget(left: WorkspaceTarget | undefined, right: WorkspaceTarget | undefined): boolean {
  if (!left || !right) return left === right;
  return "projectId" in left && "projectId" in right ? left.projectId === right.projectId
    : "sessionId" in left && "sessionId" in right && left.sessionId === right.sessionId;
}
function target(value: unknown): WorkspaceTarget | undefined {
  if (value === undefined) return undefined;
  const item = object(value);
  if (Object.keys(item).length !== 1) throw new Error("Invalid plugin acquisition response.");
  if ("projectId" in item) return { projectId: string(item.projectId, 200) };
  if ("sessionId" in item) return { sessionId: string(item.sessionId, 200) };
  throw new Error("Invalid plugin acquisition response.");
}
function receipt(value: unknown): NativePluginAcquisitionReceipt {
  const row = object(value);
  exact(row, ["id", "operation", "target", "state", "createdAt", "updatedAt", "message"]);
  const id = string(row.id, 36);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id) ||
    !["running", "succeeded", "needs-review", "reviewed"].includes(String(row.state)) ||
    typeof row.createdAt !== "number" || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 ||
    typeof row.updatedAt !== "number" || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < row.createdAt ||
    (row.message !== undefined && (typeof row.message !== "string" || row.message.length > 4096))) {
    throw new Error("Invalid plugin acquisition response.");
  }
  return { id, operation: operation(row.operation), ...(row.target !== undefined ? { target: target(row.target) } : {}),
    state: row.state as NativePluginAcquisitionReceipt["state"], createdAt: row.createdAt, updatedAt: row.updatedAt,
    ...(row.message !== undefined ? { message: row.message as string } : {}) };
}
function catalog(value: unknown): NativeMarketplaceCatalog {
  const root = object(value);
  exact(root, ["revision", "projectScopeAvailable", "marketplaces", "installed"]);
  string(root.revision, 200);
  if (typeof root.projectScopeAvailable !== "boolean" || !Array.isArray(root.marketplaces) || root.marketplaces.length > 256 ||
    !Array.isArray(root.installed) || root.installed.length > 4096) throw new Error("Invalid plugin acquisition response.");
  for (const item of root.marketplaces) {
    const market = object(item); exact(market, ["name", "sourceType", "sourceOptions", "catalogAvailable", "description", "plugins"]);
    if (market.sourceOptions !== undefined) parseMarketplaceSourceOptions(market.sourceOptions);
    string(market.name, 64);
    if (!["github", "git", "url", "local"].includes(String(market.sourceType)) || typeof market.catalogAvailable !== "boolean" ||
      (market.description !== undefined && (typeof market.description !== "string" || market.description.length > 8192)) ||
      !Array.isArray(market.plugins) || market.plugins.length > 4096) throw new Error("Invalid plugin acquisition response.");
    for (const item of market.plugins) {
      const plugin = object(item); exact(plugin, ["name", "description", "version", "installable", "unavailabilityReason"]);
      string(plugin.name, 64);
      if (typeof plugin.installable !== "boolean" ||
        (plugin.description !== undefined && (typeof plugin.description !== "string" || plugin.description.length > 8192)) ||
        (plugin.version !== undefined && (typeof plugin.version !== "string" || plugin.version.length > 256)) ||
        (plugin.unavailabilityReason !== undefined && (typeof plugin.unavailabilityReason !== "string" || plugin.unavailabilityReason.length > 4096))) {
        throw new Error("Invalid plugin acquisition response.");
      }
    }
  }
  for (const item of root.installed) {
    const installed = object(item); exact(installed, ["id", "scope", "version", "enabled"]);
    string(installed.id, 129); string(installed.version, 256);
    if (!["user", "project"].includes(String(installed.scope)) || typeof installed.enabled !== "boolean") throw new Error("Invalid plugin acquisition response.");
  }
  return root as unknown as NativeMarketplaceCatalog;
}

async function responseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Invalid plugin acquisition response.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE) throw new Error("Plugin acquisition response is too large.");
      chunks.push(part.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); } catch { throw new Error("Invalid plugin acquisition response."); }
}

async function post(endpoint: HostEndpoint, method: string, body: unknown, afterDispatch = false): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${endpoint.origin}/v1/integrations/acquisition/${method}`, {
      method: "POST", headers: {
        "Content-Type": "application/json", "Cache-Control": "no-store",
        ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000), redirect: "error",
    });
  } catch {
    throw new HostRequestError(afterDispatch ? "The plugin operation response was lost. Inspect its status before continuing." : "Plugin acquisition is unavailable.", 503, afterDispatch ? "OUTCOME_UNKNOWN" : undefined);
  }
  let value: unknown;
  try { value = await responseJson(response); }
  catch {
    throw new HostRequestError(afterDispatch ? "The plugin operation response was invalid. Inspect its status before continuing." : "Plugin acquisition returned an invalid response.", 502, afterDispatch ? "OUTCOME_UNKNOWN" : undefined);
  }
  if (!response.ok) {
    const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    if (!body || typeof body.error !== "string") {
      throw new HostRequestError(afterDispatch ? "The plugin operation response was invalid. Inspect its status before continuing." : "Plugin acquisition returned an invalid response.", response.status, afterDispatch ? "OUTCOME_UNKNOWN" : undefined);
    }
    if (afterDispatch) throw new HostRequestError("The plugin operation outcome could not be confirmed. Inspect its status before continuing.", response.status, "OUTCOME_UNKNOWN");
    throw new HostRequestError(body.error, response.status);
  }
  return value;
}

export async function requestMarketplaceCatalog(endpoint: HostEndpoint, target?: WorkspaceTarget): Promise<NativeMarketplaceCatalog> {
  return catalog(await post(endpoint, "catalog", { target }));
}
export async function startPluginAcquisition(endpoint: HostEndpoint, target: WorkspaceTarget | undefined, request: NativePluginAcquisitionRequest): Promise<NativePluginAcquisitionReceipt> {
  requestId(request.id); revision(request.expectedRevision);
  const result = receipt(await post(endpoint, "start", { target, request }, true));
  if (result.id !== request.id || result.operation !== request.action.operation || !sameTarget(result.target, target)) throw new HostRequestError("The plugin operation response did not match its request.", 409, "OUTCOME_UNKNOWN");
  return result;
}
export async function requestPluginAcquisitionOperations(endpoint: HostEndpoint): Promise<NativePluginAcquisitionReceipt[]> {
  const value = await post(endpoint, "operations", {});
  if (!Array.isArray(value) || value.length > 4096) throw new Error("Invalid plugin acquisition response.");
  return value.map(receipt);
}
export async function reviewPluginAcquisition(endpoint: HostEndpoint, target: WorkspaceTarget | undefined, id: string, expectedRevision: string): Promise<NativePluginAcquisitionReceipt> {
  requestId(id); revision(expectedRevision);
  const result = receipt(await post(endpoint, "review", { target, id, expectedRevision }, true));
  if (result.id !== id || !sameTarget(result.target, target)) throw new HostRequestError("The plugin review response did not match its request.", 409, "OUTCOME_UNKNOWN");
  return result;
}
export async function closePluginAcquisitionRequest(endpoint: HostEndpoint, target: WorkspaceTarget | undefined, request: { id: string; operation: NativePluginAcquisition["operation"] }): Promise<NativePluginAcquisitionReceipt> {
  requestId(request.id); operation(request.operation);
  const result = receipt(await post(endpoint, "close-request", { target, ...request }, true));
  if (result.id !== request.id || result.operation !== request.operation || !sameTarget(result.target, target)) throw new HostRequestError("The plugin close response did not match its request.", 409, "OUTCOME_UNKNOWN");
  return result;
}
