import { createHash } from "node:crypto";
import { exportId, MAX_SESSION_EXPORT_BYTES, parseSessionExportReceipt, type SessionExportReceipt, type SessionExportStatus } from "@agent-desktop/shared";
import type { HostEndpoint } from "./host-transport";
import { saveWorkspaceCopy } from "./workspace-save-copy";
export async function requestSessionExport(endpoint: HostEndpoint, sessionId: string, commandId: string, file = false): Promise<Buffer> {
  exportId(endpoint.hostId); exportId(sessionId); exportId(commandId);
  const response = await fetch(`${endpoint.origin}/v1/sessions/${encodeURIComponent(sessionId)}/exports/${encodeURIComponent(commandId)}${file ? "/file" : ""}`, {
    headers: { "X-Agent-Host-Id": endpoint.hostId, ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) }, redirect: "error", signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || response.headers.get("X-Agent-Host-Id") !== endpoint.hostId) { await response.body?.cancel(); throw new Error("The original host export is unavailable. Inspect its status before retrying."); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Empty export response.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > (file ? MAX_SESSION_EXPORT_BYTES : 16_384)) { await reader.cancel(); throw new Error("The export response exceeds its limit."); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export async function sessionExportStatus(endpoint: HostEndpoint, sessionId: string, commandId: string): Promise<SessionExportStatus> {
  const value = JSON.parse((await requestSessionExport(endpoint, sessionId, commandId)).toString("utf8")) as SessionExportStatus;
  if (value.hostId !== endpoint.hostId || value.sessionId !== sessionId || commandId !== "latest" && value.commandId !== commandId
    || !["absent", "pending", "unknown", "failed", "complete"].includes(value.state)) throw new Error("The export status has a different owner.");
  return { hostId: endpoint.hostId, sessionId, commandId: exportId(value.commandId), state: value.state,
    ...(value.state === "complete" ? { receipt: parseSessionExportReceipt(value.receipt, endpoint.hostId, sessionId, value.commandId) } : {}),
    ...(typeof value.message === "string" ? { message: value.message.slice(0, 4096) } : {}) };
}
/** Reuses the native Save as transaction. The authenticated host supplies bytes, never a client-local source path. */
export async function saveSessionExport(receipt: SessionExportReceipt, runtime: { endpoint(): Promise<HostEndpoint>; choose(name: string): Promise<string | null>; current(): void }): Promise<{ path: string | null }> {
  const captured = parseSessionExportReceipt(receipt, receipt.hostId, receipt.sessionId), path = "conversation.html";
  return saveWorkspaceCopy({ target: { sessionId: captured.sessionId }, path, hostId: captured.hostId }, {
    choose: runtime.choose,
    source: async () => {
      runtime.current(); const endpoint = await runtime.endpoint(); runtime.current();
      if (endpoint.hostId !== captured.hostId) throw new Error("The export host changed.");
      const bytes = await requestSessionExport(endpoint, captured.sessionId, captured.commandId, true); runtime.current();
      if (bytes.length !== captured.bytes || createHash("sha256").update(bytes).digest("hex") !== captured.sha256) throw new Error("The downloaded HTML does not match the export receipt.");
      return { local: false, query: async query => {
        runtime.current();
        if (query.type === "file.copy-info") return { type: "file.copy-info", path, absolutePath: `/session-export/${captured.artifactId}.html`, size: captured.bytes, revision: captured.sha256 };
        if (query.type !== "file.copy-chunk" || query.revision !== captured.sha256 || query.offset < 0 || query.offset > bytes.length) throw new Error("Invalid export copy range.");
        return { type: "file.copy-chunk", path, revision: captured.sha256, size: captured.bytes, offset: query.offset, dataBase64: bytes.subarray(query.offset, query.offset + 1024 * 1024).toString("base64") };
      } };
    },
  });
}
