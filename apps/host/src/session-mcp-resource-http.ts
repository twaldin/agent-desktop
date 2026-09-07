import { SESSION_MCP_OWNER_HEADER, parseNativeSessionMcpResourceRequest, parseNativeSessionMcpResourceResult, type NativeSessionMcpResourceRequest, type NativeSessionMcpResourceResult } from "@agent-desktop/shared";

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing resource request.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 5000);
  try {
    for (;;) {
      const part = await reader.read();
      if (expired) throw new Error("Resource request timed out.");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32 * 1024) throw new Error("Resource request is too large.");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Explicit reads use only the loaded owner's native connection. No polling or retry. */
export class SessionMcpResourceHttp {
  constructor(private readonly options: {
    hostId: string;
    sessionExists(id: string): boolean;
    existing(id: string): Promise<{readSessionMcpResource(request: NativeSessionMcpResourceRequest): Promise<NativeSessionMcpResourceResult>} | undefined>;
  }) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/mcp\/resource$/.exec(url.pathname);
    if (!match) return;
    const headers = {"Cache-Control":"no-store", [SESSION_MCP_OWNER_HEADER]:this.options.hostId};
    const fail = (status:number,code:string,message:string) => Response.json({error:{code,message}}, {status,headers});
    if (request.headers.get(SESSION_MCP_OWNER_HEADER) !== this.options.hostId) return fail(409,"OWNER_MISMATCH","The selected session owner no longer matches this endpoint.");
    if (request.method !== "POST") return fail(405,"INVALID_MCP_REQUEST","Use POST to explicitly read a resource.");
    let sessionId:string, input:NativeSessionMcpResourceRequest;
    try {
      sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || sessionId.length > 200 || sessionId.includes("\0") || !this.options.sessionExists(sessionId)) return fail(409,"STALE_TARGET","The selected session no longer exists on this host.");
      input = parseNativeSessionMcpResourceRequest(await readBody(request));
    } catch { return fail(400,"INVALID_MCP_REQUEST","Invalid MCP resource request."); }
    try {
      const handle = await this.options.existing(sessionId);
      if (!handle) return fail(409,"MCP_NOT_LOADED","This session has no loaded native runtime. No resource read started a worker.");
      const value = parseNativeSessionMcpResourceResult(await handle.readSessionMcpResource(input));
      return Response.json({protocolVersion:1,hostId:this.options.hostId,sessionId,value}, {headers});
    } catch { return fail(503,"MCP_RESOURCE_UNAVAILABLE","The native resource could not be read. Inspect the server state before trying again."); }
  }
}
