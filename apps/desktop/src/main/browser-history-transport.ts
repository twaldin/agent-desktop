import { BROWSER_METADATA_OWNER_HEADER, parseBrowserHistoryRequest, parseBrowserHistoryResult, type BrowserHistoryRequest, type BrowserHistoryResult } from "@agent-desktop/shared";
import { readBrowserJSON } from "./browser-frame-transport";
import { HostRequestError, type HostEndpoint } from "./host-transport";

export async function requestBrowserHistory(endpoint: HostEndpoint, sessionId: string, request: BrowserHistoryRequest): Promise<BrowserHistoryResult> {
  if (!endpoint.hostId || !sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error("Select the browser owning session and host.");
  const input = parseBrowserHistoryRequest(request), response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/browser-history`, { method:"POST",redirect:"error",signal:AbortSignal.timeout(20_000),headers:{"Content-Type":"application/json",[BROWSER_METADATA_OWNER_HEADER]:endpoint.hostId,...(endpoint.token?{Authorization:`Bearer ${endpoint.token}`}:{})},body:JSON.stringify(input) });
  if (response.headers.get(BROWSER_METADATA_OWNER_HEADER) !== endpoint.hostId) { await response.body?.cancel(); throw new Error("Browser history belongs to another host."); }
  const value = await readBrowserJSON(response, response.ok ? 2 * 1024 * 1024 : 16_384);
  if (!response.ok) { const object=value&&typeof value==="object"?value as Record<string,unknown>:{};const detail=object.error&&typeof object.error==="object"?object.error as Record<string,unknown>:{}; throw new HostRequestError(typeof detail.message==="string"?detail.message:`Browser history failed (${response.status}).`,response.status,typeof detail.code==="string"?detail.code:undefined); }
  return parseBrowserHistoryResult(value,endpoint.hostId,{kind:"session",id:sessionId},input);
}
