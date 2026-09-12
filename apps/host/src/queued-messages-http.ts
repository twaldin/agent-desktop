import {
  NATIVE_QUEUED_MESSAGES_OWNER_HEADER,
  NATIVE_QUEUED_MESSAGES_PROTOCOL_VERSION,
  parseNativeQueuedMessageMutation,
  type NativeQueuedMessageMutation,
  type NativeQueuedMessageMutationReceipt,
  type NativeQueuedMessagesSnapshot,
} from "../../../packages/shared/src/queued-messages";

class QueuedMessagesHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

interface QueueHandle {
  getQueuedMessages(): Promise<NativeQueuedMessagesSnapshot>;
  mutateQueuedMessages(mutation: NativeQueuedMessageMutation): Promise<NativeQueuedMessageMutationReceipt>;
}

export class QueuedMessagesHttp {
  constructor(private readonly options: {
    hostId: string;
    sessionExists(sessionId: string): boolean;
    getHandle(sessionId: string): Promise<QueueHandle>;
  }) {}

  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/queued-messages$/.exec(url.pathname);
    if (!match) return undefined;
    const headers = { "Cache-Control": "no-store", [NATIVE_QUEUED_MESSAGES_OWNER_HEADER]: this.options.hostId };
    try {
      if (request.headers.get(NATIVE_QUEUED_MESSAGES_OWNER_HEADER) !== this.options.hostId)
        throw new QueuedMessagesHttpError("The queued-message owner no longer matches this host.", 409, "OWNER_MISMATCH");
      const sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || sessionId.length > 200 || sessionId.includes("\0") || !this.options.sessionExists(sessionId))
        throw new QueuedMessagesHttpError("The selected conversation no longer exists on this host.", 409, "STALE_TARGET");
      const handle = await this.options.getHandle(sessionId);
      if (!this.options.sessionExists(sessionId)) throw new QueuedMessagesHttpError("The queued-message owner changed while loading.", 409, "STALE_TARGET");
      if (request.method === "GET") return Response.json({ protocolVersion: NATIVE_QUEUED_MESSAGES_PROTOCOL_VERSION,
        hostId: this.options.hostId, sessionId, ...await handle.getQueuedMessages() }, { headers });
      if (request.method !== "POST") throw new QueuedMessagesHttpError("Use GET or POST for queued messages.", 405, "INVALID_QUEUE_REQUEST");
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 32 * 1024) throw new QueuedMessagesHttpError("The queued-message mutation is too large.", 413, "INVALID_QUEUE_REQUEST");
      const receipt = await handle.mutateQueuedMessages(parseNativeQueuedMessageMutation(JSON.parse(raw)));
      if (!this.options.sessionExists(sessionId)) throw new QueuedMessagesHttpError("The queued-message owner changed during mutation.", 409, "STALE_TARGET");
      return Response.json({ protocolVersion: NATIVE_QUEUED_MESSAGES_PROTOCOL_VERSION, hostId: this.options.hostId, sessionId, ...receipt }, { headers });
    } catch (error) {
      const conflict = error instanceof Error && "code" in error && error.code === "QUEUE_CHANGED";
      return Response.json({ error: { code: error instanceof QueuedMessagesHttpError ? error.code : conflict ? "QUEUE_CHANGED" : "QUEUED_MESSAGES_FAILED",
        message: error instanceof Error ? error.message.slice(0, 4096) : "Native queued-message operation failed." } },
      { status: error instanceof QueuedMessagesHttpError ? error.status : conflict ? 409 : 400, headers });
    }
  }
}
