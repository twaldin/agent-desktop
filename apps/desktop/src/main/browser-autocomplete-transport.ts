import { BROWSER_AUTOCOMPLETE_OWNER_HEADER, parseBrowserAutocompleteRequest, parseBrowserAutocompleteResult,
  type BrowserAutocompleteRequest, type BrowserAutocompleteResult } from "@agent-desktop/shared";
import { readBrowserJSON } from "./browser-frame-transport";
import { HostRequestError, type HostEndpoint } from "./host-transport";

export async function requestBrowserAutocomplete(endpoint: HostEndpoint, sessionId: string, request: BrowserAutocompleteRequest): Promise<BrowserAutocompleteResult> {
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error("Select the browser owning session and host.");
  const input = parseBrowserAutocompleteRequest(request);
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/browser-autocomplete`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json", [BROWSER_AUTOCOMPLETE_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) },
    body: JSON.stringify(input),
  });
  if (response.headers.get(BROWSER_AUTOCOMPLETE_OWNER_HEADER) !== endpoint.hostId) { await response.body?.cancel(); throw new Error("Browser autocomplete belongs to another host."); }
  const value = await readBrowserJSON(response, response.ok ? 2 * 1024 * 1024 : 16_384);
  if (!response.ok) {
    const object = value && typeof value === "object" ? value as Record<string, unknown> : {}, detail = object.error && typeof object.error === "object" ? object.error as Record<string, unknown> : {};
    throw new HostRequestError(typeof detail.message === "string" ? detail.message : `Browser autocomplete failed (${response.status}).`, response.status, typeof detail.code === "string" ? detail.code : undefined);
  }
  return parseBrowserAutocompleteResult(value, endpoint.hostId, { kind: "session", id: sessionId }, input);
}
