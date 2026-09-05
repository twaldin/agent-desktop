import { BROWSER_FRAME_MAX_BYTES, BROWSER_FRAME_PROTOCOL_VERSION, BROWSER_METADATA_OWNER_HEADER, parseNativeBrowserFrame, validBrowserFrameTarget,
  type BrowserFrameSnapshot, type BrowserFrameTarget } from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";

async function readJSON(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error("The browser viewport response is empty.");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error("The browser viewport response exceeds its limit.");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

export async function requestBrowserFrame(endpoint: HostEndpoint, sessionId: string, target: BrowserFrameTarget): Promise<BrowserFrameSnapshot> {
  if (!endpoint.hostId || typeof sessionId !== "string" || !sessionId || sessionId.length > 200 || sessionId.includes("\0") || !validBrowserFrameTarget(target)) throw new Error("Select an exact live browser target on its owning host.");
  const query = new URLSearchParams({ workerPid: String(target.workerPid), name: target.name, targetId: target.targetId });
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/browser-frame?${query}`, {
    headers: { [BROWSER_METADATA_OWNER_HEADER]: endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) },
    signal: AbortSignal.timeout(20_000), redirect: "error",
  });
  if (response.ok && response.headers.get(BROWSER_METADATA_OWNER_HEADER) !== endpoint.hostId) {
    await response.body?.cancel(); throw new HostRequestError("Browser viewport belongs to another host.", 409, "OWNER_MISMATCH");
  }
  const value = await readJSON(response, response.ok ? Math.ceil(BROWSER_FRAME_MAX_BYTES / 3) * 4 + 32_768 : 16_384);
  if (!response.ok) {
    const detail = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {};
    throw new HostRequestError(typeof detail.message === "string" ? detail.message : response.status === 404 ? "Update this host to preview native browser tabs." : `Browser viewport failed (${response.status}).`, response.status, typeof detail.code === "string" ? detail.code : undefined);
  }
  if (!value || typeof value !== "object") throw new Error("Invalid browser viewport response.");
  const source = value as BrowserFrameSnapshot;
  if (source.protocolVersion !== BROWSER_FRAME_PROTOCOL_VERSION || source.hostId !== endpoint.hostId || source.sessionId !== sessionId || source.workerPid !== target.workerPid) throw new Error("Browser viewport does not match the selected owner, worker or protocol.");
  return { ...parseNativeBrowserFrame(source, target), protocolVersion: BROWSER_FRAME_PROTOCOL_VERSION, hostId: endpoint.hostId, sessionId, workerPid: target.workerPid };
}
