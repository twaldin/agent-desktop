import { EXTENSION_UI_OWNER_HEADER, parseExtensionUiResult, type ExtensionUiResult } from "../../../../packages/shared/src/extension-ui";
import type { HostEndpoint } from "./host-transport";
export async function requestExtensionUi(endpoint: HostEndpoint, sessionId: string): Promise<ExtensionUiResult | null> {
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error("Select the owning session before reading extension display.");
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/extension-ui`, { headers: {
    [EXTENSION_UI_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
  }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok || response.headers.get(EXTENSION_UI_OWNER_HEADER) !== endpoint.hostId) {
    await response.body?.cancel(); throw new Error("The owning host could not provide its extension display.");
  }
  return parseExtensionUiResult(await response.json(), endpoint.hostId, sessionId);
}
