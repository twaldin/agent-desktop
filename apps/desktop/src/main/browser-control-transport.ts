import { BROWSER_METADATA_OWNER_HEADER, parseBrowserControlRequest, parseBrowserDocumentContext, type BrowserControlRequest, type BrowserControlReceipt } from '@agent-desktop/shared';
import type { HostEndpoint } from './host-transport';
import { readBrowserJSON } from './browser-frame-transport';

/** One submission only. A transport failure never retries a click or keystroke. */
export async function requestBrowserControl(endpoint: HostEndpoint, sessionId: string, request: BrowserControlRequest): Promise<BrowserControlReceipt> {
  const input = parseBrowserControlRequest(request);
  if (!endpoint.hostId || typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || sessionId.includes('\0')) throw new Error('Select the browser owning session.');
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/browser-control`, {
    method: 'POST', body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', [BROWSER_METADATA_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) },
  });
  if (response.headers.get(BROWSER_METADATA_OWNER_HEADER) !== endpoint.hostId) { await response.body?.cancel(); throw new Error('Browser action response belongs to another host; its outcome is unknown.'); }
  const value = await readBrowserJSON(response, 32768) as Partial<BrowserControlReceipt>;
  if (!response.ok) throw new Error(`Browser action could not be confirmed (${response.status}). Inspect the page before acting again.`);
  if (!value || value.protocolVersion !== 1 || value.hostId !== endpoint.hostId || value.sessionId !== sessionId || value.requestId !== input.requestId
    || value.workerPid !== input.target.workerPid || value.name !== input.target.name || value.targetId !== input.target.targetId
    || !['completed', 'rejected', 'unknown'].includes(value.outcome ?? '')
    || value.message !== undefined && (typeof value.message !== 'string' || value.message.length > 4096)) throw new Error('Browser action receipt is invalid; its outcome is unknown.');
  const receipt: BrowserControlReceipt = { protocolVersion: 1, hostId: endpoint.hostId, sessionId, requestId: input.requestId,
    workerPid: input.target.workerPid, name: input.target.name, targetId: input.target.targetId, outcome: value.outcome!, ...(value.message ? { message: value.message } : {}) };
  if (value.outcome === 'completed') {
    if (typeof value.url !== 'string' || value.url.length > 8192 || typeof value.title !== 'string' || value.title.length > 1024) throw new Error('Browser action result is invalid; inspect the page before acting again.');
    return { ...receipt, context: parseBrowserDocumentContext(value.context), url: value.url, title: value.title };
  }
  return receipt;
}
