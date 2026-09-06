import { SESSION_MCP_OWNER_HEADER, type NativeSessionMcpSnapshot, type NativeSessionMcpReceipt, type NativeSessionMcpResponse } from "@agent-desktop/shared";

/** A status read never creates a worker or connects an MCP server. */
export class SessionMcpHttp {
  constructor(private readonly options: {
    hostId: string;
    receipt?: (sessionId: string, commandId: string) => NativeSessionMcpReceipt;
    sessionExists: (id: string) => boolean;
    existing: (id: string) => Promise<{ getSessionMcp(): Promise<NativeSessionMcpSnapshot> } | undefined>;
  }) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/mcp$/.exec(url.pathname);
    if (!match) return;
    const headers = { "Cache-Control": "no-store", [SESSION_MCP_OWNER_HEADER]: this.options.hostId };
    const fail = (status: number, code: string, message: string) => Response.json({error:{code,message}}, {status,headers});
    try {
      if (request.headers.get(SESSION_MCP_OWNER_HEADER) !== this.options.hostId) return fail(409,"OWNER_MISMATCH","The selected session owner no longer matches this endpoint.");
      const sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || sessionId.length > 200 || sessionId.includes('\0') || !this.options.sessionExists(sessionId)) return fail(409,"STALE_TARGET","The selected session no longer exists on this host.");
      if (request.method !== "GET") return fail(405,"INVALID_MCP_REQUEST","Use GET for live MCP state.");
      const commandId = url.searchParams.get('commandId');
      if (commandId !== null && (!/^[a-zA-Z0-9_-]{1,200}$/.test(commandId) || !this.options.receipt)) return fail(400,'INVALID_MCP_REQUEST','Invalid MCP receipt request.');
      const receipt = commandId ? this.options.receipt!(sessionId,commandId) : undefined;
      const handle = await this.options.existing(sessionId);
      const value = handle ? await handle.getSessionMcp() : null;
      return Response.json({protocolVersion:1,hostId:this.options.hostId,sessionId,value,...(receipt ? {receipt} : {}),
        ...(!handle ? {unavailable:"This session has no loaded native runtime. Its saved server configuration is shown separately."} : {})} satisfies NativeSessionMcpResponse,{headers});
    } catch { return fail(503,"MCP_STATE_UNAVAILABLE","The native session MCP state could not be read. Refresh after its worker reconnects."); }
  }
}
