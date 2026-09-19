import { exportId } from "@agent-desktop/shared";
import type { SessionExportService } from "./session-export";
export class SessionExportHttp {
  private reads = 0;
  constructor(private hostId: string, private exports: SessionExportService) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/exports\/([^/]+)(\/file)?$/.exec(url.pathname);
    if (!match) return;
    const headers = { "X-Agent-Host-Id": this.hostId, "Cache-Control": "no-store" };
    const fail = (status: number, message: string) => Response.json({ error: { message } }, { status, headers });
    if (request.headers.get("X-Agent-Host-Id") !== this.hostId) return fail(409, "The export belongs to a different host.");
    if (request.method !== "GET" || url.search) return fail(405, "Use an owner-bound export read.");
    try {
      const sessionId = exportId(decodeURIComponent(match[1]!)), commandId = exportId(decodeURIComponent(match[2]!));
      if (!match[3]) return Response.json(this.exports.status(sessionId, commandId), { headers });
      if (this.reads >= 4) return fail(429, "Export downloads are busy. Try reading the original receipt again.");
      this.reads++;
      try {
      const { receipt, bytes } = await this.exports.artifact(sessionId, commandId);
      return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="conversation.html"', "Content-Length": String(bytes.length), "X-Content-Type-Options": "nosniff", "X-Export-Sha256": receipt.sha256 } });
      } finally { this.reads--; }
    } catch { return fail(409, "The original export is unavailable or changed. Inspect its receipt before retrying."); }
  }
}
